import type { PoolClient } from "pg";
import type { z } from "zod";
import { transaction } from "./agent-store";
import { authPool } from "./auth";
import { CapabilityError } from "./capability-contracts";
import { assertAdmissionWindow } from "./admission-window";
import { assertSourceReferences } from "./source-store";
import { currentConfig } from "./agent-config";
import { lockConversation } from "./conversation-store";
import { jobInput, extractFields, renderComparison } from "./document-policy";
import { inputHash, resultEvent, workQuota } from "./result-store";
import { artifactDigest } from "./agent-hash";
import { appendSourceCitations } from "./source-citations";
import { publishStructuredResults } from "./evidence-store";
import { assertWork, assertWorkTurn, chargeWork } from "./work-store";
export async function jobByOwner(c: PoolClient, owner: string, id: string) {
  const r = (
    await c.query("SELECT * FROM document_jobs WHERE id=$1 AND owner_id=$2", [
      id,
      owner,
    ])
  ).rows[0];
  if (!r) throw new CapabilityError("JOB_NOT_FOUND", 404);
  return r;
}
async function jobConversation(c: PoolClient, owner: string, id: string) {
  const r = (
    await c.query(
      "SELECT id FROM agent_conversations WHERE id=$1 AND owner_id=$2 FOR UPDATE",
      [id, owner],
    )
  ).rows[0];
  if (!r) throw new CapabilityError("CONVERSATION_NOT_FOUND", 404);
  const conv = await lockConversation(c, id, undefined, "read_context");
  if (!conv.permissions.includes("create_draft"))
    throw new CapabilityError("JOB_PERMISSION_DENIED", 403);
  return conv;
}
export async function jobAuthority(c: PoolClient, job: any, conv: any) {
  if (
    !conv.grants_active ||
    !conv.enabled ||
    (!job.work_id && conv.requested_sequence !== job.conversation_sequence)
  )
    throw new CapabilityError("JOB_CONVERSATION_CHANGED", 409);
  if (job.work_id) await assertWork(c, job.work_id, job.owner_id);
  await assertSourceReferences(c, job.owner_id, job.source_refs);
  if (
    (
      await c.query(
        "SELECT 1 FROM structured_results WHERE job_id=$1 AND revision>1 LIMIT 1",
        [job.id],
      )
    ).rowCount
  )
    throw new CapabilityError("JOB_RESULT_SUPERSEDED", 409);
}
export async function admitJob(
  owner: string,
  input: z.infer<typeof jobInput>,
  runId: string,
  deadline: number,
  origin?: {
    workId: string;
    sequence: number;
    workerRunId: string;
    recoveryRunId: string;
  },
) {
  return transaction(async (c) => {
    await assertAdmissionWindow(c, deadline);
    const conv = await jobConversation(c, owner, input.conversationId);
    await c.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", [
      "job:" + input.id,
    ]);
    const prior = (
      await c.query("SELECT * FROM document_jobs WHERE id=$1", [input.id])
    ).rows[0];
    const digest = inputHash(input);
    if (prior) {
      if (prior.owner_id !== owner || prior.input_digest !== digest)
        throw new CapabilityError("JOB_ID_CONFLICT", 409);
      return prior;
    }
    const config = await currentConfig(c, conv.agent_id, owner);
    if (origin) {
      if (conv.worker_run_id !== origin.workerRunId)
        throw new CapabilityError("WORK_WORKER_REVOKED", 409);
      const turn = (
        await c.query(
          "SELECT work_id,internal_kind FROM conversation_turns WHERE conversation_id=$1 AND sequence=$2",
          [conv.id, origin.sequence],
        )
      ).rows[0];
      const w = await assertWork(c, origin.workId, owner);
      if (
        turn?.work_id !== w.id ||
        turn.internal_kind === "job_result" ||
        w.conversation_id !== conv.id ||
        w.state !== "active" ||
        w.job_id ||
        inputHash(input.sources) !==
          inputHash(
            w.resolved_sources.map((s: any) => ({
              id: s.id,
              version: s.version,
            })),
          ) ||
        inputHash(input.fields) !== inputHash(w.request.fields) ||
        input.extractionMode !== w.request.extractionMode
      )
        throw new CapabilityError("WORK_JOB_NOT_AUTHORIZED", 403);
      await chargeWork(c, w, "dispatch", 1, `job:${input.id}`);
    }
    if (
      !config.tools.includes("search_sources") ||
      !config.tools.includes("create_draft")
    )
      throw new CapabilityError("CONFIG_TOOL_DENIED", 403);
    await assertSourceReferences(c, owner, input.sources);
    if (
      +(
        await c.query("SELECT count(*) FROM document_jobs WHERE owner_id=$1", [
          owner,
        ])
      ).rows[0].count >= 100
    )
      throw new CapabilityError("JOB_LIMIT", 429);
    await workQuota(c, owner, "jobs", 20);
    await workQuota(c, owner, "job_dispatches", 40);
    const row = (
      await c.query(
        "INSERT INTO document_jobs(id,owner_id,conversation_id,conversation_sequence,agent_config_version,input_digest,request,source_refs,state,workflow_run_id) VALUES($1,$2,$3,$4,$5,$6,$7,$8,'queued',$9) RETURNING *",
        [
          input.id,
          owner,
          input.conversationId,
          conv.requested_sequence,
          config.version,
          digest,
          JSON.stringify(input),
          JSON.stringify(input.sources),
          runId,
        ],
      )
    ).rows[0];
    if (origin) {
      await c.query(
        "UPDATE document_jobs SET work_id=$2,work_recovery_run_id=$3 WHERE id=$1",
        [input.id, origin.workId, origin.recoveryRunId],
      );
      await c.query(
        "UPDATE agent_work SET job_id=$2,state='waiting_job' WHERE id=$1",
        [origin.workId, input.id],
      );
    }
    await resultEvent(
      c,
      owner,
      "job:" + input.id + ":admitted",
      "job.admitted",
      { jobId: input.id, version: 1, stages: 3 },
      conv.id,
      input.id,
    );
    await assertAdmissionWindow(c, deadline);
    return row;
  });
}
export async function executeJobStage(
  owner: string,
  id: string,
  version: number,
  runId: string,
  stage: number,
) {
  return transaction(async (c) => {
    await c.query("SET LOCAL statement_timeout='5s'");
    const initial = await jobByOwner(c, owner, id);
    const conv = await jobConversation(c, owner, initial.conversation_id);
    const job = (
      await c.query("SELECT * FROM document_jobs WHERE id=$1 FOR UPDATE", [id])
    ).rows[0];
    if (
      job.version === version &&
      job.workflow_run_id === runId &&
      job.state === "completed" &&
      (
        await c.query(
          "SELECT 1 FROM document_job_stages WHERE job_id=$1 AND stage=$2",
          [id, stage],
        )
      ).rowCount
    )
      return { cached: true, injectRecovery: false, hold: false };
    if (
      job.version !== version ||
      job.workflow_run_id !== runId ||
      !["queued", "running"].includes(job.state)
    )
      throw new CapabilityError("JOB_WORKER_REVOKED", 409);
    await jobAuthority(c, job, conv);
    await c.query(
      "INSERT INTO document_job_attempts VALUES($1,$2,$3,1) ON CONFLICT(job_id,version,stage) DO UPDATE SET attempts=document_job_attempts.attempts+1",
      [id, version, stage],
    );
    const existing = (
      await c.query(
        "SELECT * FROM document_job_stages WHERE job_id=$1 AND stage=$2",
        [id, stage],
      )
    ).rows[0];
    if (existing) {
      if (stage === 3 && job.state !== "completed")
        await c.query(
          "UPDATE document_jobs SET state='completed' WHERE id=$1",
          [id],
        );
      return {
        cached: true,
        injectRecovery: false,
        hold: job.request.holdAfterStage === stage,
      };
    }
    if (
      stage > 1 &&
      !(
        await c.query(
          "SELECT 1 FROM document_job_stages WHERE job_id=$1 AND stage=$2",
          [id, stage - 1],
        )
      ).rowCount
    )
      throw new CapabilityError("JOB_STAGE_ORDER", 409);
    let output: any;
    if (job.work_id) {
      const w = await assertWork(c, job.work_id, owner);
      await chargeWork(c, w, "stage", 1, `stage:${id}:${stage}`);
    }
    let digest = job.input_digest;
    if (stage === 1) {
      const sources = [];
      for (const ref of job.source_refs) {
        const r = (
          await c.query(
            "SELECT id,version,title,content FROM source_records WHERE id=$1 AND owner_id=$2",
            [ref.id, owner],
          )
        ).rows[0];
        sources.push(r);
      }
      output = { sources };
    } else {
      const prior = (
        await c.query(
          "SELECT * FROM document_job_stages WHERE job_id=$1 AND stage=$2",
          [id, stage - 1],
        )
      ).rows[0];
      digest = prior.output_digest;
      if (stage === 2) {
        if (job.request.extractionMode === "ai") {
          const extractions = (
            await c.query(
              "SELECT output FROM evidence_extractions WHERE job_id=$1 AND state='completed' ORDER BY source_index",
              [id],
            )
          ).rows;
          if (extractions.length !== job.source_refs.length)
            throw new CapabilityError("EXTRACTION_NOT_READY", 409);
          output = { rows: extractions.map((r) => r.output) };
        } else
          output = {
            rows: extractFields(prior.output.sources, job.request.fields),
          };
        await publishStructuredResults(c, job, output.rows);
      } else {
        const title = "Document comparison";
        const markdown = appendSourceCitations(
          renderComparison(prior.output.rows, job.request.fields),
          job.source_refs,
          20000,
        );
        output = { title, markdown, digest: artifactDigest(title, markdown) };
        await c.query(
          "INSERT INTO document_job_artifacts(job_id,title,markdown,digest) VALUES($1,$2,$3,$4)",
          [id, title, markdown, output.digest],
        );
      }
    }
    await c.query(
      "INSERT INTO document_job_stages(job_id,stage,input_digest,output,output_digest) VALUES($1,$2,$3,$4,$5)",
      [id, stage, digest, JSON.stringify(output), inputHash(output)],
    );
    await c.query(
      "UPDATE document_jobs SET state=$2,error_code=NULL,updated_at=now() WHERE id=$1",
      [id, stage === 3 ? "completed" : "running"],
    );
    await resultEvent(
      c,
      owner,
      `job:${id}:stage:${stage}`,
      "job.stage_completed",
      { stage, version },
      conv.id,
      id,
    );
    if (stage === 3)
      await resultEvent(
        c,
        owner,
        "job:" + id + ":completed",
        "job.completed",
        { stages: 3, digest: output.digest },
        conv.id,
        id,
      );
    return {
      cached: false,
      injectRecovery: job.request.recoveryTest && stage === 1,
      hold: job.request.holdAfterStage === stage,
    };
  });
}
export async function failJob(
  owner: string,
  id: string,
  version: number,
  runId: string,
  code: string,
) {
  await transaction(async (c) => {
    const initial = await jobByOwner(c, owner, id);
    await c.query("SELECT id FROM agent_conversations WHERE id=$1 FOR UPDATE", [
      initial.conversation_id,
    ]);
    const r = await c.query(
      "UPDATE document_jobs SET state='failed',error_code=$5,updated_at=now() WHERE id=$1 AND owner_id=$2 AND version=$3 AND workflow_run_id=$4 AND state IN ('queued','running') RETURNING id",
      [id, owner, version, runId, code],
    );
    if (r.rowCount)
      await resultEvent(
        c,
        owner,
        `job:${id}:failed:${version}`,
        "job.failed",
        { code, version },
        initial.conversation_id,
        id,
      );
  });
}
export async function inspectJob(c: PoolClient, owner: string, id: string) {
  const job = await jobByOwner(c, owner, id);
  const stages = (
    await c.query(
      "SELECT stage,input_digest,output_digest,created_at FROM document_job_stages WHERE job_id=$1 ORDER BY stage",
      [id],
    )
  ).rows;
  let artifact = null,
    blockedReason: string | null = null;
  try {
    const conv = await jobConversation(c, owner, job.conversation_id);
    await jobAuthority(c, job, conv);
    if (job.state !== "cancelled")
      artifact =
        (
          await c.query(
            "SELECT * FROM document_job_artifacts WHERE job_id=$1",
            [id],
          )
        ).rows[0] ?? null;
  } catch (e) {
    blockedReason =
      e instanceof CapabilityError ? e.code : "JOB_AUTHORITY_CHANGED";
  }
  const attempts = (
    await c.query(
      "SELECT version,stage,attempts FROM document_job_attempts WHERE job_id=$1 ORDER BY version,stage",
      [id],
    )
  ).rows;
  return { job, stages, attempts, artifact, blockedReason };
}
export async function controlJob(
  owner: string,
  id: string,
  input: { action: string; expectedVersion: number; digest?: string },
  resumption?: { runId: string; deadline: number; recoveryRunId?: string },
  origin?: { conversationId: string; sequence: number; workerRunId: string },
) {
  return transaction(async (c) => {
    if (resumption) await assertAdmissionWindow(c, resumption.deadline);
    const initial = await jobByOwner(c, owner, id);
    await c.query(
      "SELECT id FROM agent_conversations WHERE id=$1 AND owner_id=$2 FOR UPDATE",
      [initial.conversation_id, owner],
    );
    const job = (
      await c.query(
        "SELECT * FROM document_jobs WHERE id=$1 AND owner_id=$2 FOR UPDATE",
        [id, owner],
      )
    ).rows[0];
    if (origin) {
      const conv = await lockConversation(
        c,
        origin.conversationId,
        origin.workerRunId,
        "read_context",
      );
      const work = await assertWorkTurn(
        c,
        origin.conversationId,
        origin.sequence,
      );
      if (
        !work ||
        work.job_id !== id ||
        job.work_id !== work.id ||
        conv.id !== job.conversation_id ||
        work.internal_kind === "job_result"
      )
        throw new CapabilityError("WORK_JOB_NOT_AUTHORIZED", 403);
    }
    if (input.action === "approve") {
      const receipt = (
        await c.query("SELECT * FROM document_job_saves WHERE job_id=$1", [id])
      ).rows[0];
      if (receipt) {
        if (receipt.digest !== input.digest)
          throw new CapabilityError("JOB_DIGEST_CONFLICT", 409);
        return { receipt, replayed: true };
      }
    }
    if (job.version !== input.expectedVersion)
      throw new CapabilityError("JOB_VERSION_CONFLICT", 409);
    if (input.action === "approve") {
      const conv = await jobConversation(c, owner, job.conversation_id);
      if (!conv.permissions.includes("save_approved_artifact"))
        throw new CapabilityError("JOB_PERMISSION_DENIED", 403);
      await jobAuthority(c, job, conv);
      const a = (
        await c.query(
          "SELECT * FROM document_job_artifacts WHERE job_id=$1 FOR UPDATE",
          [id],
        )
      ).rows[0];
      if (job.state !== "completed" || !a || a.digest !== input.digest)
        throw new CapabilityError("JOB_APPROVAL_NOT_CURRENT", 409);
      const receipt = (
        await c.query(
          "INSERT INTO document_job_saves(job_id,owner_id,digest,job_version) VALUES($1,$2,$3,$4) RETURNING *",
          [id, owner, a.digest, job.version],
        )
      ).rows[0];
      await c.query(
        "UPDATE document_job_artifacts SET state='saved',saved_at=now() WHERE job_id=$1",
        [id],
      );
      await resultEvent(
        c,
        owner,
        "job:" + id + ":saved",
        "job.saved",
        { digest: a.digest },
        job.conversation_id,
        id,
      );
      return { receipt, replayed: false };
    }
    if (
      (input.action === "pause" &&
        !["queued", "running"].includes(job.state)) ||
      (input.action === "resume" &&
        !["paused", "failed"].includes(job.state)) ||
      (input.action === "cancel" && job.state === "cancelled")
    )
      throw new CapabilityError("JOB_STATE_CONFLICT", 409);
    if (input.action === "resume") {
      await workQuota(c, owner, "job_dispatches", 40);
      if (!resumption || job.dispatches >= 3)
        throw new CapabilityError("JOB_RESUME_LIMIT", 409);
      const conv = await jobConversation(c, owner, job.conversation_id);
      await jobAuthority(c, job, conv);
      if (job.work_id) {
        const w = await assertWork(c, job.work_id, owner);
        await chargeWork(
          c,
          w,
          "dispatch",
          1,
          `job-resume:${id}:${job.version}`,
        );
        await c.query("UPDATE agent_work SET state='waiting_job' WHERE id=$1", [
          w.id,
        ]);
      }
    }
    const version = job.version + 1;
    await c.query(
      "UPDATE document_jobs SET version=$2,state=$3,workflow_run_id=COALESCE($4,workflow_run_id),dispatches=dispatches+$5,work_recovery_run_id=COALESCE($6,work_recovery_run_id),updated_at=now() WHERE id=$1",
      [
        id,
        version,
        input.action === "pause"
          ? "paused"
          : input.action === "cancel"
            ? "cancelled"
            : "queued",
        resumption?.runId ?? null,
        resumption ? 1 : 0,
        resumption?.recoveryRunId ?? null,
      ],
    );
    await resultEvent(
      c,
      owner,
      `job:${id}:control:${version}`,
      "job." + input.action,
      { version },
      job.conversation_id,
      id,
    );
    if (resumption) await assertAdmissionWindow(c, resumption.deadline);
    return {
      id,
      version,
      state:
        input.action === "pause"
          ? "paused"
          : input.action === "cancel"
            ? "cancelled"
            : "queued",
    };
  });
}

export async function readJobForAgent(
  c: PoolClient,
  owner: string,
  conversationId: string,
  id: string,
) {
  const job = await jobByOwner(c, owner, id);
  if (job.conversation_id !== conversationId)
    throw new CapabilityError("JOB_NOT_FOUND", 404);
  if (job.state !== "completed")
    throw new CapabilityError("JOB_NOT_COMPLETED", 409);
  await jobAuthority(
    c,
    job,
    await jobConversation(c, owner, job.conversation_id),
  );
  const resultReferences = (
    await c.query(
      "SELECT id,revision FROM structured_results WHERE job_id=$1",
      [id],
    )
  ).rows;
  const artifact = (
    await c.query(
      "SELECT title,markdown,digest,state FROM document_job_artifacts WHERE job_id=$1",
      [id],
    )
  ).rows[0];
  return {
    ...artifact,
    jobId: id,
    templateVersion: job.template_version,
    contextReferences: [
      {
        resultReferences,
        sourceReferences: job.source_refs,
        memoryReferences: [],
        connectionReferences: [],
      },
    ],
  };
}
