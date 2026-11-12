import type { PoolClient } from "pg";
import { createHash } from "node:crypto";
import { CapabilityError } from "./capability-contracts";
import { workInput, comparisonFields } from "./work-policy";
import { assertSourceReferences } from "./source-store";
import { authorizeConnectionUse } from "./connection-store";
import { inputHash, resultEvent } from "./result-store";

export function workUuid(key: string) {
  const b = createHash("sha256").update(key).digest().subarray(0, 16);
  b[6] = (b[6] & 15) | 128;
  b[8] = (b[8] & 63) | 128;
  const h = b.toString("hex");
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}
export async function createWorkForTurn(
  c: PoolClient,
  owner: string,
  conversationId: string,
  sequence: number,
  id: string,
  raw: unknown,
) {
  const request = workInput.parse(raw),
    resolved = [];
  const identities = new Set<string>();
  for (let index = 0; index < request.sources.length; index++) {
    const source = request.sources[index];
    let identity: string;
    if (source.kind === "source") {
      await assertSourceReferences(c, owner, [
        { id: source.id, version: source.version },
      ]);
      resolved.push({ index, id: source.id, version: source.version });
      const row = (
        await c.query(
          "SELECT connection_id,resource_id FROM source_records WHERE id=$1",
          [source.id],
        )
      ).rows[0];
      identity = row.connection_id
        ? `${row.connection_id}:${row.resource_id}`
        : source.id;
    } else {
      await authorizeConnectionUse(c, owner, source.connectionId, {
        expectedVersion: source.expectedVersion,
        resourceId: source.resourceId,
        requiredScopes: ["documents:read"],
      });
      identity = `${source.connectionId}:${source.resourceId}`;
    }
    if (identities.has(identity))
      throw new CapabilityError("WORK_DUPLICATE_SOURCE", 400);
    identities.add(identity);
  }
  await c.query(
    `INSERT INTO agent_work(id,owner_id,conversation_id,origin_sequence,request,initial_request,resolved_sources,expires_at) VALUES($1,$2,$3,$4,$5,$5,$6,now()+$7*interval '1 minute')`,
    [
      id,
      owner,
      conversationId,
      sequence,
      JSON.stringify(request),
      JSON.stringify(resolved),
      request.expiresInMinutes,
    ],
  );
  await c.query(
    "UPDATE conversation_turns SET work_id=$3 WHERE conversation_id=$1 AND sequence=$2",
    [conversationId, sequence, id],
  );
}
export async function assertWork(c: PoolClient, id: string, owner?: string) {
  const w = (
    await c.query(
      `SELECT w.*,a.human_sequence,a.grants_active,p.enabled FROM agent_work w JOIN agent_conversations a ON a.id=w.conversation_id JOIN agent_profiles p ON p.id=a.agent_id WHERE w.id=$1 FOR UPDATE OF w`,
      [id],
    )
  ).rows[0];
  if (!w || (owner && w.owner_id !== owner))
    throw new CapabilityError("WORK_NOT_FOUND", 404);
  if (
    !w.grants_active ||
    !w.enabled ||
    w.human_sequence !== w.origin_sequence ||
    w.state === "cancelled"
  )
    throw new CapabilityError("WORK_REVOKED", 409);
  if (new Date(w.expires_at).getTime() <= Date.now())
    throw new CapabilityError("WORK_EXPIRED", 409);
  // Validate selected connection generations even when no content has been read yet.
  for (const s of w.request.sources)
    if (s.kind === "connection")
      await authorizeConnectionUse(c, w.owner_id, s.connectionId, {
        expectedVersion: s.expectedVersion,
        resourceId: s.resourceId,
        requiredScopes: ["documents:read"],
      });
    else
      await assertSourceReferences(c, w.owner_id, [
        { id: s.id, version: s.version },
      ]);
  return w;
}
export async function assertWorkTurn(
  c: PoolClient,
  conversationId: string,
  sequence: number,
) {
  const t = (
    await c.query(
      "SELECT work_id,internal_kind,work_job_version FROM conversation_turns WHERE conversation_id=$1 AND sequence=$2",
      [conversationId, sequence],
    )
  ).rows[0];
  if (!t?.work_id) return null;
  const work = await assertWork(c, t.work_id);
  if (
    t.internal_kind === "job_result" &&
    (
      await c.query("SELECT version FROM document_jobs WHERE id=$1", [
        work.job_id,
      ])
    ).rows[0]?.version !== t.work_job_version
  )
    throw new CapabilityError("WORK_JOB_VERSION_CHANGED", 409);
  return { ...work, internal_kind: t.internal_kind };
}
export async function chargeWork(
  c: PoolClient,
  work: any,
  kind: "model" | "tool" | "provider" | "bytes" | "dispatch" | "stage",
  amount: number,
  receipt?: string,
) {
  if (!Number.isInteger(amount) || amount < 0)
    throw new CapabilityError("WORK_INVALID_CHARGE", 400);
  if (receipt) {
    const prior = (
      await c.query(
        "SELECT kind,amount FROM agent_work_charges WHERE work_id=$1 AND receipt=$2",
        [work.id, receipt],
      )
    ).rows[0];
    if (prior) {
      if (prior.kind !== kind || prior.amount !== amount)
        throw new CapabilityError("WORK_CHARGE_CONFLICT");
      return;
    }
  }
  const columns = {
    model: ["model_calls", "maxModelCalls"],
    tool: ["tool_calls", "maxTools"],
    provider: ["provider_calls", "maxProviderCalls"],
    bytes: ["source_bytes", "maxSourceBytes"],
    stage: ["stage_calls", "maxStages"],
    dispatch: ["dispatches", "maxDispatches"],
  } as const;
  const [column, limitKey] = columns[kind],
    limit =
      work.request[limitKey] ??
      (kind === "stage" ? 9 : kind === "dispatch" ? 5 : 0);
  const r = await c.query(
    `UPDATE agent_work SET ${column}=${column}+$2,updated_at=now() WHERE id=$1 AND ${column}+$2<=$3 RETURNING id`,
    [work.id, amount, limit],
  );
  if (!r.rowCount) throw new CapabilityError("WORK_BUDGET_EXHAUSTED", 429);
  if (receipt)
    await c.query(
      "INSERT INTO agent_work_charges(work_id,receipt,kind,amount) VALUES($1,$2,$3,$4)",
      [work.id, receipt, kind, amount],
    );
}
export async function workContext(c: PoolClient, id: string, sequence: number) {
  const w = await assertWorkTurn(c, id, sequence);
  if (!w) return null;
  const q = w.question_id
    ? (
        await c.query(
          "SELECT id,version,question,schema,state,expires_at,answer FROM agent_work_questions WHERE id=$1",
          [w.question_id],
        )
      ).rows[0]
    : null;
  return {
    id: w.id,
    state: w.state,
    errorCode: w.error_code,
    inputVersion: w.input_version,
    sources: w.request.sources,
    resolvedSources: w.resolved_sources,
    fields: w.request.fields ?? null,
    extractionMode: w.request.extractionMode ?? "literal",
    payment: w.request.payment ?? null,
    paymentResult: (await c.query("SELECT id,state,payload,digest,item_id,error_code FROM sandbox_payment_proposals WHERE work_id=$1",[w.id])).rows[0] ?? null,
    question: q,
    jobId: w.job_id,
    internalKind: w.internal_kind,
    expiresAt: w.expires_at,
    budget: {
      modelCalls: w.model_calls,
      maxModelCalls: w.request.maxModelCalls,
      tools: w.tool_calls,
      maxTools: w.request.maxTools,
      providerCalls: w.provider_calls,
      maxProviderCalls: w.request.maxProviderCalls,
    },
  };
}
export async function askWorkQuestion(
  c: PoolClient,
  conversationId: string,
  sequence: number,
  question: string,
) {
  const w = await assertWorkTurn(c, conversationId, sequence);
  if (!w) throw new CapabilityError("WORK_AUTHORIZATION_REQUIRED", 403);
  if (w.job_id || w.internal_kind === "job_result" || w.request.fields)
    throw new CapabilityError("WORK_QUESTION_NOT_ALLOWED", 409);
  const id = workUuid(`question:${w.id}:${w.input_version}`);
  await c.query(
    `INSERT INTO agent_work_questions(id,work_id,version,question,schema,expires_at) VALUES($1,$2,$3,$4,$5,$6) ON CONFLICT DO NOTHING`,
    [
      id,
      w.id,
      w.input_version,
      question,
      JSON.stringify({
        field: "fields",
        type: "array",
        items: "field label",
        minItems: 1,
        maxItems: 8,
      }),
      w.expires_at,
    ],
  );
  await c.query(
    "UPDATE agent_work SET state='waiting_input',question_id=$2 WHERE id=$1",
    [w.id, id],
  );
  const { conversationMessage } = await import("./conversation-store");
  const stored = (
    await c.query("SELECT question FROM agent_work_questions WHERE id=$1", [id])
  ).rows[0];
  await conversationMessage(
    c,
    conversationId,
    sequence,
    `reply:${sequence}`,
    "assistant",
    stored.question,
  );
  await resultEvent(
    c,
    w.owner_id,
    `work:${w.id}:question:${w.input_version}`,
    "work.needs_input",
    { workId: w.id, questionId: id, version: w.input_version },
    conversationId,
  );
  return {
    workId: w.id,
    questionId: id,
    version: w.input_version,
    state: "waiting_input",
    schema: { field: "fields", type: "array" },
  };
}
export async function acceptWorkAnswer(
  c: PoolClient,
  owner: string,
  workId: string,
  input: {
    questionId: string;
    expectedVersion: number;
    answerId: string;
    fields: string[];
  },
  deadline: number,
) {
  const raw = (
    await c.query(
      "SELECT conversation_id FROM agent_work WHERE id=$1 AND owner_id=$2",
      [workId, owner],
    )
  ).rows[0];
  if (!raw) throw new CapabilityError("WORK_NOT_FOUND", 404);
  await c.query("SELECT id FROM agent_conversations WHERE id=$1 FOR UPDATE", [
    raw.conversation_id,
  ]);
  const w = await assertWork(c, workId, owner);
  const q = (
    await c.query(
      "SELECT * FROM agent_work_questions WHERE id=$1 AND work_id=$2 FOR UPDATE",
      [input.questionId, workId],
    )
  ).rows[0];
  if (!q || q.version !== input.expectedVersion)
    throw new CapabilityError("QUESTION_VERSION_CONFLICT", 409);
  const fields = comparisonFields.parse(input.fields);
  if (q.state === "answered") {
    if (
      q.answer_id !== input.answerId ||
      inputHash(q.answer) !== inputHash({ fields })
    )
      throw new CapabilityError("ANSWER_CONFLICT", 409);
    return { sequence: q.answer_sequence, replayed: true };
  }
  if (
    w.state !== "waiting_input" ||
    w.question_id !== q.id ||
    q.version !== w.input_version ||
    new Date(q.expires_at) <= new Date()
  )
    throw new CapabilityError("QUESTION_NOT_CURRENT", 409);
  const request = { ...w.request, fields };
  await c.query(
    "UPDATE agent_work SET request=$2,input_version=input_version+1,state='active' WHERE id=$1",
    [workId, JSON.stringify(request)],
  );
  const { appendTurn } = await import("./conversation-store");
  const result = await appendTurn(
    c,
    raw.conversation_id,
    owner,
    {
      messageId: input.answerId,
      text: `Owner answered the comparison fields: ${JSON.stringify(fields)}. Continue the authorized work.`,
      recoveryTest: false,
      executionMode: "assistant",
      dispatchRecoveryTest: false,
    },
    { workId, internalKind: "clarification_answer", mode: "assistant" },
    deadline,
  );
  if (![200, 201].includes(result.status))
    throw new CapabilityError("ANSWER_ADMISSION_FAILED", result.status);
  await c.query(
    "UPDATE agent_work_questions SET state='answered',answer_id=$2,answer=$3,answer_sequence=$4 WHERE id=$1",
    [q.id, input.answerId, JSON.stringify({ fields }), result.sequence],
  );
  return { sequence: result.sequence, replayed: false };
}
