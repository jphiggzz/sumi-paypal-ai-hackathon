import { waitForModelCapacity } from "./model-capacity";
import {
  getWorkflowMetadata,
  sleep,
  RetryableError,
  FatalError,
} from "workflow";
import { authPool } from "./auth";
import { extractJobSource } from "./evidence-store";
import { executeJobStage, failJob } from "./job-store";
import { CapabilityError } from "./capability-contracts";
import { start, getRun } from "workflow/api";
import { transaction } from "./agent-store";
import { assertWork } from "./work-store";
import { controlJob } from "./job-store";
import { queueJobFollowUp, recordWorkBlocked } from "./work-dispatch";
export async function documentJobWorkflow(
  owner: string,
  id: string,
  version: number,
) {
  "use workflow";
  const runId = getWorkflowMetadata().workflowRunId;
  for (let i = 0; i < 30; i++) {
    const state = await jobAdmission(owner, id, version, runId);
    if (state === "other") return;
    if (state === "ready") {
      try {
        for (let stage = 1; stage <= 3; stage++) {
          if (stage === 2) {
            const n = await aiSourceCount(owner, id);
            for (let sourceIndex = 0; sourceIndex < n; sourceIndex++) {
              let done = false;
              for (let attempt = 0; attempt < 3; attempt++) {
                await waitForModelCapacity("amazon/nova-micro");
                if (
                  await extractionStep(owner, id, version, runId, sourceIndex)
                ) {
                  done = true;
                  break;
                }
              }
              if (!done) {
                await failStep(owner, id, version, runId, "EXTRACTION_FAILED");
                await notifyJobWork(id);
                return;
              }
            }
          }
          const result = await stageStep(owner, id, version, runId, stage);
          if (!result.ok) {
            await failStep(owner, id, version, runId, result.code);
            await notifyJobWork(id);
            return;
          }
          if (result.hold) await sleep("5s");
        }
      } catch {
        await failStep(owner, id, version, runId, "JOB_RETRIES_EXHAUSTED");
      }
      await notifyJobWork(id);
      return;
    }
    if (i < 29) await sleep("2s");
  }
}
async function jobAdmission(
  owner: string,
  id: string,
  version: number,
  runId: string,
) {
  "use step";
  const r = (
    await authPool.query(
      "SELECT version,workflow_run_id FROM document_jobs WHERE id=$1 AND owner_id=$2",
      [id, owner],
    )
  ).rows[0];
  return !r
    ? "missing"
    : r.version < version
      ? "missing"
      : r.version === version && r.workflow_run_id === runId
        ? "ready"
        : "other";
}
async function stageStep(
  owner: string,
  id: string,
  version: number,
  runId: string,
  stage: number,
) {
  "use step";
  let result;
  try {
    result = await executeJobStage(owner, id, version, runId, stage);
  } catch (e) {
    if (e instanceof CapabilityError)
      return { ok: false as const, code: e.code };
    throw new RetryableError("Transient job stage failure", {
      retryAfter: "2s",
    });
  }
  if (result.injectRecovery)
    throw new RetryableError("Synthetic interruption after committed stage", {
      retryAfter: "1s",
    });
  return { ok: true as const, hold: result.hold };
}
stageStep.maxRetries = 2;
async function failStep(
  owner: string,
  id: string,
  version: number,
  runId: string,
  code: string,
) {
  "use step";
  await failJob(owner, id, version, runId, code);
}
async function notifyJobWork(jobId: string) {
  "use step";
  try {
    return await queueJobFollowUp(jobId);
  } catch (e) {
    if (e instanceof CapabilityError && e.status !== 503) {
      const row = (
        await authPool.query("SELECT work_id FROM document_jobs WHERE id=$1", [
          jobId,
        ])
      ).rows[0];
      if (row?.work_id) await recordWorkBlocked(row.work_id, e.code);
      return { skipped: true, reason: e.code };
    }
    throw e;
  }
}
export async function workJobRecoveryWorkflow(owner: string, id: string) {
  "use workflow";
  const runId = getWorkflowMetadata().workflowRunId;
  await sleep("2s");
  for (let i = 0; i < 90; i++) {
    const state = await recoverLinkedJob(owner, id, runId);
    if (state === "done" || (state === "missing" && i >= 8)) return;
    await sleep(i < 5 ? "2s" : "10s");
  }
  await linkedRecoveryExhausted(owner, id, runId);
}
async function recoverLinkedJob(
  owner: string,
  id: string,
  recoveryRunId: string,
) {
  "use step";
  const job = (
    await authPool.query(
      "SELECT * FROM document_jobs WHERE id=$1 AND owner_id=$2",
      [id, owner],
    )
  ).rows[0];
  if (!job) return "missing";
  if (
    !job.work_id ||
    job.work_recovery_run_id !== recoveryRunId ||
    job.state === "paused"
  )
    return "done";
  const authority = await transaction(async (c) => {
    try {
      await c.query(
        "SELECT id FROM agent_conversations WHERE id=$1 FOR UPDATE",
        [job.conversation_id],
      );
      await assertWork(c, job.work_id, owner);
      return true;
    } catch (e) {
      if (e instanceof CapabilityError) return false;
      throw e;
    }
  });
  if (!authority) {
    await recordWorkBlocked(job.work_id, "WORK_AUTHORITY_CHANGED");
    return "done";
  }
  if (["completed", "failed", "cancelled"].includes(job.state)) {
    await queueJobFollowUp(id);
    return "done";
  }
  const state = await getRun(job.workflow_run_id).status;
  if (!["completed", "failed", "cancelled"].includes(state)) return "waiting";
  await failJob(owner, id, job.version, job.workflow_run_id, "WORKER_RECOVERY");
  const current = (
    await authPool.query(
      "SELECT state,version FROM document_jobs WHERE id=$1",
      [id],
    )
  ).rows[0];
  if (current.state !== "failed" || current.version !== job.version)
    return "waiting";
  if (job.dispatches >= 3) {
    await queueJobFollowUp(id);
    return "done";
  }
  const deadline = Date.now() + 30000,
    run = await start(documentJobWorkflow, [owner, id, job.version + 1]);
  try {
    await controlJob(
      owner,
      id,
      { action: "resume", expectedVersion: job.version },
      { runId: run.runId, deadline, recoveryRunId },
    );
  } catch (e) {
    if (!(e instanceof CapabilityError) || e.code !== "JOB_VERSION_CONFLICT")
      throw e;
  }
  return "waiting";
}
async function linkedRecoveryExhausted(
  owner: string,
  id: string,
  runId: string,
) {
  "use step";
  const job = (
    await authPool.query(
      "SELECT work_id FROM document_jobs WHERE id=$1 AND owner_id=$2 AND work_recovery_run_id=$3",
      [id, owner, runId],
    )
  ).rows[0];
  if (job?.work_id)
    await recordWorkBlocked(job.work_id, "WORK_RECOVERY_EXHAUSTED");
}

async function aiSourceCount(owner: string, id: string) {
  "use step";
  const j = (
    await authPool.query(
      "SELECT request,source_refs FROM document_jobs WHERE id=$1 AND owner_id=$2",
      [id, owner],
    )
  ).rows[0];
  return j?.request.extractionMode === "ai" ? j.source_refs.length : 0;
}
async function extractionStep(
  owner: string,
  id: string,
  version: number,
  runId: string,
  index: number,
) {
  "use step";
  try {
    await extractJobSource(owner, id, version, runId, index);
    return true;
  } catch (e) {
    if (e instanceof CapabilityError && e.status !== 503)
      throw new FatalError(e.code);
    return false;
  }
}
extractionStep.maxRetries = 0;
