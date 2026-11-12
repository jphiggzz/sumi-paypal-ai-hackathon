import { randomUUID } from "node:crypto";
import { generateText, Output } from "ai";
import { transaction } from "./agent-store";
import { authPool } from "./auth";
import { jobByOwner, jobAuthority } from "./job-store";
import { lockConversation } from "./conversation-store";
import { assertWork, chargeWork, workUuid } from "./work-store";
import { CapabilityError } from "./capability-contracts";
import { reserveModelBudget } from "./model-budget";
import {
  EXTRACTION_SYSTEM,
  extractionOutput,
  validateExtraction,
  type EvidenceFact,
} from "./evidence-policy";
import { resultEvent } from "./result-store";

async function authorized(
  c: any,
  owner: string,
  id: string,
  version: number,
  runId: string,
) {
  const initial = await jobByOwner(c, owner, id);
  const conv = await lockConversation(
    c,
    initial.conversation_id,
    undefined,
    "read_context",
  );
  const job = (
    await c.query("SELECT * FROM document_jobs WHERE id=$1 FOR UPDATE", [id])
  ).rows[0];
  if (
    job.version !== version ||
    job.workflow_run_id !== runId ||
    !["queued", "running"].includes(job.state)
  )
    throw new CapabilityError("JOB_WORKER_REVOKED", 409);
  await jobAuthority(c, job, conv);
  return job;
}
export async function extractJobSource(
  owner: string,
  id: string,
  version: number,
  runId: string,
  index: number,
) {
  const claim = randomUUID();
  const prepared = await transaction(async (c) => {
    const job = await authorized(c, owner, id, version, runId);
    if (job.request.extractionMode !== "ai") return null;
    if (!job.work_id) throw new CapabilityError("AI_WORK_REQUIRED", 403);
    const prior = (
      await c.query(
        "SELECT * FROM evidence_extractions WHERE job_id=$1 AND source_index=$2 FOR UPDATE",
        [id, index],
      )
    ).rows[0];
    if (prior?.state === "completed") return null;
    if (prior?.lease_until && new Date(prior.lease_until) > new Date())
      throw new CapabilityError("EXTRACTION_BUSY", 503);
    if ((prior?.attempts ?? 0) >= 3)
      throw new CapabilityError("EXTRACTION_ATTEMPTS_EXHAUSTED", 409);
    const snapshot = (
      await c.query(
        "SELECT output FROM document_job_stages WHERE job_id=$1 AND stage=1",
        [id],
      )
    ).rows[0]?.output;
    const source = snapshot?.sources[index];
    if (!source) throw new CapabilityError("JOB_STAGE_ORDER", 409);
    const w = await assertWork(c, job.work_id, owner);
    await chargeWork(c, w, "model", 1);
    await c.query(
      "INSERT INTO evidence_extractions(job_id,source_index,state,attempts,claim_id,lease_until) VALUES($1,$2,'running',1,$3,now()+interval '55 seconds') ON CONFLICT(job_id,source_index) DO UPDATE SET state='running',attempts=evidence_extractions.attempts+1,claim_id=$3,lease_until=now()+interval '55 seconds'",
      [id, index, claim],
    );
    return { source, fields: job.request.fields };
  });
  if (!prepared) return;
  try {
    await reserveModelBudget("amazon/nova-micro");
    const result = await generateText({
      model: "amazon/nova-micro",
      maxRetries: 0,
      maxOutputTokens: 2500,
      abortSignal: AbortSignal.timeout(35000),
      output: Output.object({ schema: extractionOutput }),
      system: EXTRACTION_SYSTEM,
      prompt: JSON.stringify({
        fields: prepared.fields,
        document: prepared.source.content,
      }),
    });
    const facts = validateExtraction(
      prepared.source.content,
      prepared.fields,
      result.output,
    );
    const usage = {
      model: "amazon/nova-micro",
      inputTokens: result.usage.inputTokens ?? 0,
      outputTokens: result.usage.outputTokens ?? 0,
      estimatedUsd:
        ((result.usage.inputTokens ?? 0) * 0.035 +
          (result.usage.outputTokens ?? 0) * 0.14) /
        1e6,
      estimate: true,
    };
    await transaction(async (c) => {
      await authorized(c, owner, id, version, runId);
      const r = await c.query(
        "UPDATE evidence_extractions SET state='completed',output=$4,usage=$5,lease_until=NULL WHERE job_id=$1 AND source_index=$2 AND claim_id=$3 AND state='running' RETURNING job_id",
        [
          id,
          index,
          claim,
          JSON.stringify({ ...prepared.source, facts }),
          JSON.stringify(usage),
        ],
      );
      if (!r.rowCount)
        throw new CapabilityError("EXTRACTION_CLAIM_REVOKED", 409);
    });
  } catch (e) {
    await authPool.query(
      "UPDATE evidence_extractions SET state='failed',lease_until=NULL WHERE job_id=$1 AND source_index=$2 AND claim_id=$3 AND state='running'",
      [id, index, claim],
    );
    throw e;
  }
}
export async function publishStructuredResults(c: any, job: any, rows: any[]) {
  if (!job.work_id) return;
  for (let index = 0; index < rows.length; index++) {
    const r = rows[index],
      id = workUuid(`result:${job.id}:${index}`);
    await c.query(
      "INSERT INTO structured_results(id,owner_id,work_id,job_id,source_id,source_version,source_index,title,facts) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9) ON CONFLICT(job_id,source_index) DO NOTHING",
      [
        id,
        job.owner_id,
        job.work_id,
        job.id,
        r.id,
        r.version,
        index,
        r.title,
        JSON.stringify(r.facts),
      ],
    );
    await c.query(
      "INSERT INTO structured_result_versions(result_id,revision,facts,origin) VALUES($1,1,$2,'extraction') ON CONFLICT DO NOTHING",
      [id, JSON.stringify(r.facts)],
    );
  }
}
export async function correctResult(
  owner: string,
  input: {
    resultId: string;
    expectedRevision: number;
    field: string;
    status: string;
    value: string | null;
    quote: string;
  },
) {
  return transaction(async (c) => {
    const initial = (
      await c.query(
        "SELECT work_id FROM structured_results WHERE id=$1 AND owner_id=$2",
        [input.resultId, owner],
      )
    ).rows[0];
    if (!initial) throw new CapabilityError("RESULT_NOT_FOUND", 404);
    await c.query(
      "SELECT id FROM agent_conversations WHERE id=(SELECT conversation_id FROM agent_work WHERE id=$1) FOR UPDATE",
      [initial.work_id],
    );
    const r = (
      await c.query(
        "SELECT * FROM structured_results WHERE id=$1 AND owner_id=$2 FOR UPDATE",
        [input.resultId, owner],
      )
    ).rows[0];
    if (!r) throw new CapabilityError("RESULT_NOT_FOUND", 404);
    await c.query(
      "SELECT id FROM agent_conversations WHERE id=(SELECT conversation_id FROM agent_work WHERE id=$1) FOR UPDATE",
      [r.work_id],
    );
    await assertWork(c, r.work_id, owner);
    if (r.revision !== input.expectedRevision)
      throw new CapabilityError("RESULT_REVISION_CONFLICT", 409);
    if (!r.facts.some((f: EvidenceFact) => f.field === input.field))
      throw new CapabilityError("RESULT_FIELD_UNKNOWN", 400);
    const source = (
      await c.query(
        "SELECT content FROM source_records WHERE id=$1 AND version=$2",
        [r.source_id, r.source_version],
      )
    ).rows[0];
    if (!source) throw new CapabilityError("SOURCE_VERSION_CHANGED", 409);
    const facts = validateExtraction(source.content, [input.field], {
      facts: [
        {
          field: input.field,
          status: input.status,
          value: input.value,
          quotes: input.quote ? [input.quote] : [],
        },
      ],
    });
    if (facts[0].status !== input.status || facts[0].value !== input.value)
      throw new CapabilityError("RESULT_EVIDENCE_INVALID", 400);
    const next = r.facts.map((f: EvidenceFact) =>
        f.field === input.field ? { ...facts[0], origin: "owner" } : f,
      ),
      revision = r.revision + 1;
    await c.query(
      "UPDATE structured_results SET facts=$2,revision=$3 WHERE id=$1",
      [r.id, JSON.stringify(next), revision],
    );
    await c.query(
      "INSERT INTO structured_result_versions(result_id,revision,facts,origin) VALUES($1,$2,$3,'owner')",
      [r.id, revision, JSON.stringify(next)],
    );
    await c.query(
      "UPDATE agent_conversations SET approval_sequence=NULL WHERE id=(SELECT conversation_id FROM agent_work WHERE id=$1)",
      [r.work_id],
    );
    await c.query(
      "UPDATE conversation_approvals a SET state='superseded' WHERE conversation_id=(SELECT conversation_id FROM agent_work WHERE id=$1) AND state IN ('pending','approved') AND NOT EXISTS(SELECT 1 FROM conversation_revisions v WHERE v.conversation_id=a.conversation_id AND v.revision=a.revision AND v.state='saved')",
      [r.work_id],
    );
    await c.query(
      "UPDATE sandbox_payment_proposals SET state='blocked',error_code='RESULT_REVISION_CHANGED' WHERE result_id=$1 AND state IN ('pending','approved')",
      [r.id],
    );
    await resultEvent(
      c,
      owner,
      `result:${r.id}:${revision}`,
      "result.corrected",
      { resultId: r.id, revision },
      (
        await c.query("SELECT conversation_id FROM agent_work WHERE id=$1", [
          r.work_id,
        ])
      ).rows[0].conversation_id,
      r.job_id,
    );
    return { resultId: r.id, revision };
  });
}
