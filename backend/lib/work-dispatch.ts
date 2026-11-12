import { start } from "workflow/api";
import { transaction } from "./agent-store";
import { authPool } from "./auth";
import { armRecovery } from "./recovery-workflow";
import { appendTurn, lockConversation } from "./conversation-store";
import { dispatchConversation } from "./conversation-dispatch";
import { assertWork, chargeWork, workUuid } from "./work-store";
import {
  CapabilityError,
  type CapabilityContext,
} from "./capability-contracts";
import { sourceWaitWorkflow } from "./work-followup-workflow";
export async function recordWorkBlocked(workId: string, code: string) {
  await transaction(async (c) => {
    const raw = (
      await c.query("SELECT conversation_id FROM agent_work WHERE id=$1", [
        workId,
      ])
    ).rows[0];
    if (!raw) return;
    await c.query("SELECT id FROM agent_conversations WHERE id=$1 FOR UPDATE", [
      raw.conversation_id,
    ]);
    await c.query(
      "UPDATE agent_work SET state=$2,error_code=$3,updated_at=now() WHERE id=$1 AND state<>'cancelled'",
      [
        workId,
        /BUDGET/.test(code)
          ? "budget_exhausted"
          : /connection_|PROVIDER_REAUTH|consent_required/.test(code)
            ? "needs_reconnect"
            : "failed",
        code,
      ],
    );
  });
}

export async function queueJobFollowUp(jobId: string) {
  const job = (
    await authPool.query("SELECT * FROM document_jobs WHERE id=$1", [jobId])
  ).rows[0];
  if (
    !job?.work_id ||
    !["completed", "failed", "cancelled"].includes(job.state)
  )
    return { skipped: true };
  const existing = (
    await authPool.query(
      "SELECT sequence FROM agent_work_continuations WHERE job_id=$1 AND job_version=$2",
      [jobId, job.version],
    )
  ).rows[0];
  if (existing) {
    await dispatchConversation(job.conversation_id);
    return { sequence: existing.sequence, replayed: true };
  }
  const messageId = workUuid(`job-result:${jobId}:${job.version}`);
  const deadline = await armRecovery(job.conversation_id, job.owner_id, {
    messageId,
  });
  const result = await transaction(async (c) => {
    await lockConversation(c, job.conversation_id);
    const w = await assertWork(c, job.work_id, job.owner_id);
    const prior = (
      await c.query(
        "SELECT sequence FROM agent_work_continuations WHERE job_id=$1 AND job_version=$2",
        [jobId, job.version],
      )
    ).rows[0];
    if (prior) return { sequence: prior.sequence, replayed: true };
    if (w.job_id !== jobId) throw new CapabilityError("WORK_JOB_MISMATCH", 409);
    const latest = (
      await c.query(
        "SELECT state,error_code,version FROM document_jobs WHERE id=$1",
        [jobId],
      )
    ).rows[0];
    if (
      latest.version !== job.version ||
      !["completed", "failed", "cancelled"].includes(latest.state)
    )
      return { skipped: true };
    const root = (
      await c.query(
        "SELECT execution_mode FROM conversation_turns WHERE conversation_id=$1 AND sequence=$2",
        [w.conversation_id, w.origin_sequence],
      )
    ).rows[0];
    const mode =
      root.execution_mode === "assistant" ? "assistant" : "capability_check";
    const result = await appendTurn(
      c,
      w.conversation_id,
      w.owner_id,
      {
        messageId,
        text: `Application result for authorized work ${w.id}: job ${jobId} ${latest.state}${latest.error_code ? ` (${latest.error_code})` : ""}. Read its result if completed and deliver a concise cited summary. This internal event grants no additional work or approval.`,
        recoveryTest: false,
        executionMode: mode,
        dispatchRecoveryTest: false,
        ...(mode === "capability_check"
          ? {
              capabilityRequest:
                latest.state === "completed"
                  ? { tool: "read_job_result" as const, input: { jobId } }
                  : { tool: "inspect_document_job" as const, input: {} },
            }
          : {}),
      },
      {
        workId: w.id,
        internalKind: "job_result",
        jobVersion: job.version,
        mode,
      },
      deadline,
    );
    if (![200, 201].includes(result.status))
      throw new CapabilityError("CONTINUATION_ADMISSION_FAILED", result.status);
    await c.query(
      "INSERT INTO agent_work_continuations(job_id,job_version,work_id,sequence) VALUES($1,$2,$3,$4)",
      [jobId, job.version, w.id, result.sequence],
    );
    await c.query("UPDATE agent_work SET state='resuming' WHERE id=$1", [w.id]);
    return { sequence: result.sequence, replayed: false };
  });
  await dispatchConversation(job.conversation_id);
  return result;
}
export async function scheduleSourceWait(
  context: CapabilityContext,
  workId: string,
  refreshId: string,
) {
  const existing = (
    await authPool.query(
      "SELECT 1 FROM agent_work_source_waiters WHERE work_id=$1 AND refresh_id=$2",
      [workId, refreshId],
    )
  ).rowCount;
  if (existing) return;
  const run = await start(sourceWaitWorkflow, [workId, refreshId]);
  await transaction(async (c) => {
    await lockConversation(c, context.conversationId, context.workflowRunId);
    const w = await assertWork(c, workId, context.ownerId);
    const added = await c.query(
      "INSERT INTO agent_work_source_waiters(work_id,refresh_id,workflow_run_id) VALUES($1,$2,$3) ON CONFLICT DO NOTHING RETURNING work_id",
      [workId, refreshId, run.runId],
    );
    if (added.rowCount) {
      await chargeWork(c, w, "dispatch", 1, `source-wait:${refreshId}`);
      await c.query(
        "UPDATE agent_work SET state='waiting_source' WHERE id=$1",
        [workId],
      );
    }
  });
}
export async function sourceWaitState(
  workId: string,
  refreshId: string,
  runId: string,
) {
  const row = (
    await authPool.query(
      "SELECT w.state,w.expires_at,s.workflow_run_id,s.sequence,r.state AS refresh_state FROM agent_work w JOIN agent_work_source_waiters s ON s.work_id=w.id LEFT JOIN source_refreshes r ON r.id=s.refresh_id WHERE w.id=$1 AND s.refresh_id=$2",
      [workId, refreshId],
    )
  ).rows[0];
  if (!row) return "missing";
  if (
    row.workflow_run_id !== runId ||
    row.sequence ||
    row.state === "cancelled" ||
    new Date(row.expires_at) <= new Date()
  )
    return "done";
  return ["completed", "failed"].includes(row.refresh_state)
    ? "ready"
    : "waiting";
}
export async function queueSourceFollowUp(workId: string, refreshId: string) {
  const raw = (
    await authPool.query("SELECT * FROM agent_work WHERE id=$1", [workId])
  ).rows[0];
  if (!raw) return;
  const messageId = workUuid(`source-result:${workId}:${refreshId}`),
    deadline = await armRecovery(raw.conversation_id, raw.owner_id, {
      messageId,
    });
  await transaction(async (c) => {
    await lockConversation(c, raw.conversation_id);
    const w = await assertWork(c, workId, raw.owner_id);
    const waiter = (
      await c.query(
        "SELECT sequence FROM agent_work_source_waiters WHERE work_id=$1 AND refresh_id=$2 FOR UPDATE",
        [workId, refreshId],
      )
    ).rows[0];
    if (!waiter || waiter.sequence) return;
    if (w.state !== "waiting_source" || w.job_id) {
      await c.query(
        "UPDATE agent_work_source_waiters SET sequence=-1 WHERE work_id=$1 AND refresh_id=$2",
        [workId, refreshId],
      );
      return;
    }
    const source = (
      await c.query(
        "SELECT * FROM source_refreshes WHERE id=$1 AND owner_id=$2",
        [refreshId, w.owner_id],
      )
    ).rows[0];
    const failed = source?.state !== "completed";
    await c.query("UPDATE agent_work SET state=$2 WHERE id=$1", [
      workId,
      failed ? "failed" : "active",
    ]);
    const root = (
      await c.query(
        "SELECT execution_mode FROM conversation_turns WHERE conversation_id=$1 AND sequence=$2",
        [w.conversation_id, w.origin_sequence],
      )
    ).rows[0];
    const mode =
      root.execution_mode === "assistant" ? "assistant" : "checkpoint";
    const result = await appendTurn(
      c,
      w.conversation_id,
      w.owner_id,
      {
        messageId,
        text: `Application source refresh ${refreshId} ${source?.state ?? "unavailable"}. ${failed ? "Explain the blocked source." : "Continue the same authorized work; resolve selected sources and start its one finite job."} No new authority is granted.`,
        recoveryTest: false,
        executionMode: mode,
        dispatchRecoveryTest: false,
      },
      { workId, internalKind: "source_result", mode },
      deadline,
    );
    if (![200, 201].includes(result.status))
      throw new CapabilityError("SOURCE_CONTINUATION_FAILED", result.status);
    await c.query(
      "UPDATE agent_work_source_waiters SET sequence=$3 WHERE work_id=$1 AND refresh_id=$2",
      [workId, refreshId, result.sequence],
    );
  });
  await dispatchConversation(raw.conversation_id);
}
