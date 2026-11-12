import {admitSourceRefresh} from "../lib/source-store";
/** Hosted API/Workflow/SQL proof. Google authorization stays deferred. */
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import { writeFile } from "node:fs/promises";
import { Pool } from "pg";
import { betterAuth } from "better-auth";
import { artifactDigest } from "../lib/agent-hash";
import { transaction } from "../lib/agent-store";
import { authPool } from "../lib/auth";
import { reserveConnectorBudget } from "../lib/connector-budget";
const base = new URL(process.argv[2] || "http://localhost:3000"),
  live = process.argv.includes("--live");
if (
  !process.env.DATABASE_URL ||
  !process.env.BETTER_AUTH_SECRET ||
  !process.env.SUME_DEMO_CODE
)
  throw new Error("Matching target environment required");
const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 3 });
const auth = betterAuth({
  secret: process.env.BETTER_AUTH_SECRET,
  baseURL: base.origin,
  database: pool,
  user: { modelName: "auth_users" },
  session: { modelName: "auth_sessions" },
  account: { modelName: "auth_accounts" },
  verification: { modelName: "auth_verifications" },
  emailAndPassword: { enabled: true },
});
const headers = {
  Origin: base.origin,
  "Content-Type": "application/json",
  "x-demo-code": process.env.SUME_DEMO_CODE,
};
const checks: string[] = [];
let stage = "authentication";
let instructionProbe:null|{expected:string;observed:boolean;note:string}=null;
function pass(s: string) {
  checks.push(s);
  console.log("PASS", s);
}
function redacted(v: unknown) {
  assert.doesNotMatch(
    JSON.stringify(v),
    /synthetic-fixture-only\.|Bearer\s|access_token|refresh_token|session_token|"stack"\s*:/i,
  );
}
async function account() {
  const r = await auth.api.signUpEmail({
    body: {
      email: `knowledge-${randomUUID()}@example.invalid`,
      password: randomUUID() + randomUUID(),
      name: "Knowledge verifier",
    },
    headers: new Headers(headers),
    asResponse: true,
  });
  assert.equal(r.status, 200);
  const cookie = r.headers
    .getSetCookie()
    .filter((c) => c.split("=")[0].includes("session_token"))
    .map((c) => c.split(";")[0])
    .join("; ");
  const user = (await r.json()).user;
  return { cookie, id: user.id };
}
async function call(
  path: string,
  cookie?: string,
  body?: unknown,
  method?: string,
) {
  const r = await fetch(new URL(path, base), {
    method: method ?? (body === undefined ? "GET" : "POST"),
    headers: { ...headers, ...(cookie ? { Cookie: cookie } : {}) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const raw = await r.text();
  let data: any = null;
  try {
    data = raw ? JSON.parse(raw) : null;
  } catch {
    throw new Error("NonJSON response " + r.status + " " + path);
  }
  redacted(data);
  return { status: r.status, data };
}
async function json(
  path: string,
  cookie: string,
  body?: unknown,
  status = 200,
  method?: string,
) {
  const r = await call(path, cookie, body, method);
  assert.equal(r.status, status, path + " " + JSON.stringify(r.data));
  return r.data;
}
async function wait<T>(
  read: () => Promise<T>,
  ready: (v: T) => boolean,
  label: string,
) {
  for (let i = 0; i < 240; i++) {
    const value = await read();
    if (ready(value)) return value;
    await delay(1000);
  }
  throw new Error("Timeout " + label);
}
async function terminal(id: string, sequence: number) {
  const t = await wait(
    async () =>
      (
        await pool.query(
          "SELECT * FROM conversation_turns WHERE conversation_id=$1 AND sequence=$2",
          [id, sequence],
        )
      ).rows[0],
    (v) => v && ["completed", "failed", "cancelled"].includes(v.status),
    "turn",
  );
  assert.equal(t.status, "completed", t.error_code);
  return t;
}
async function checkpoint(cookie: string) {
  const id = randomUUID();
  await json(
    "/api/conversations",
    cookie,
    {
      id,
      messageId: randomUUID(),
      text: "Checkpoint.",
      source: "Synthetic source proof only.",
      executionMode: "checkpoint",
    },
    201,
  );
  await terminal(id, 1);
  await wait(
    async () =>
      (
        await pool.query(
          "SELECT worker_run_id FROM agent_conversations WHERE id=$1",
          [id],
        )
      ).rows[0],
    (v) => !v.worker_run_id,
    "worker release",
  );
  return id;
}
async function message(
  cookie: string,
  id: string,
  tool: string,
  input: unknown,
) {
  const d = await json(
    "/api/conversations/" + id,
    cookie,
    {
      action: "message",
      messageId: randomUUID(),
      text: "Run the owner-configured deterministic capability check.",
      executionMode: "capability_check",
      capabilityRequest: { tool, input },
    },
    201,
  );
  await terminal(id, d.sequence);
  return d.sequence;
}
async function refresh(
  cookie: string,
  connection: any,
  revision = 1,
  id = randomUUID(),
) {
  await json(
    "/api/sources",
    cookie,
    {
      id,
      connectionId: connection.id,
      expectedVersion: connection.version,
      resourceId: "doc-alpha",
      fixtureRevision: revision,
    },
    202,
  );
  const row = await wait(
    async () =>
      (await pool.query("SELECT * FROM source_refreshes WHERE id=$1", [id]))
        .rows[0],
    (r) => r && ["completed", "failed"].includes(r.state),
    "durable source refresh",
  );
  assert.equal(row.state, "completed", row.error_code);
  return row;
}
async function main() {
  const owner = await account(),
    other = await account();
  for (const path of [
    "/api/sources?query=marker",
    "/api/agent-config",
    "/api/conversations/" + randomUUID() + "/history",
    "/api/conversations/" + randomUUID() + "/operations",
  ])
    assert.equal((await call(path)).status, 401);
  pass(
    "new knowledge, configuration, history and operations APIs require ordinary signed sessions",
  );
  const id = await checkpoint(owner.cookie),
    otherId = await checkpoint(other.cookie);
  const path = "/api/conversations/" + id;
  assert.equal((await call(path + "/operations", other.cookie)).status, 404);
  assert.equal((await call(path + "/history", other.cookie)).status, 404);
  const foreign = await fetch(new URL("/api/sources", base), {
    method: "POST",
    headers: {
      ...headers,
      Cookie: owner.cookie,
      Origin: "https://foreign.invalid",
    },
    body: "{}",
  });
  assert.equal(foreign.status, 403);
  pass(
    "owner and same-origin boundaries protect source ingestion, history and operational repair",
  );
  stage = "source refresh";
  const connection = (
    await json(
      "/api/connections",
      owner.cookie,
      { provider: "fixture", resourceIds: ["doc-alpha"] },
      201,
    )
  ).connection;
  const importId=randomUUID();const payload={id:importId,connectionId:connection.id,expectedVersion:1,resourceId:'doc-alpha',fixtureRevision:1};
  const simultaneous=await Promise.all([json('/api/sources',owner.cookie,payload,202),json('/api/sources',owner.cookie,payload,202)]);assert.equal(simultaneous[0].workflowRunId,simultaneous[1].workflowRunId);
  const imported = await refresh(owner.cookie, connection,1,importId);
  const expiredId=randomUUID();await assert.rejects(admitSourceRefresh(owner.id,{...payload,id:expiredId},'explicit-expired-admission-fixture',Date.now()-1000),e=>e instanceof Error&&e.message==='ADMISSION_WINDOW_EXPIRED');assert.equal((await pool.query('SELECT count(*) FROM source_refreshes WHERE id=$1',[expiredId])).rows[0].count,'0');

  const first = (
    await pool.query("SELECT * FROM source_records WHERE id=$1", [
      imported.source_id,
    ])
  ).rows[0];
  assert.equal(first.version, 1);
  assert.ok(first.content.includes("DELTA77"));
  assert.ok(imported.workflow_run_id);
  pass(
    "actual durable source Workflow normalizes fixture content, exact version, URL, content hash and freshness without browser polling",
  );
  const before = (
    await pool.query(
      "SELECT requests,bytes FROM connector_usage WHERE budget_key=$1",
      ["connection:" + connection.id],
    )
  ).rows[0];
  await refresh(owner.cookie, connection, 1, imported.id);
  assert.deepEqual(
    (
      await pool.query(
        "SELECT requests,bytes FROM connector_usage WHERE budget_key=$1",
        ["connection:" + connection.id],
      )
    ).rows[0],
    before,
  );
  assert.equal(
    +(
      await pool.query(
        "SELECT count(*) FROM source_versions WHERE source_id=$1",
        [first.id],
      )
    ).rows[0].count,
    1,
  );
  assert.equal((await call('/api/sources',owner.cookie,{id:imported.id,connectionId:connection.id,expectedVersion:1,resourceId:'doc-alpha',fixtureRevision:2})).status,409);
  pass(
    "concurrent and repeated refresh identity preserves one intent/version/reservation; expired private admission cannot commit",
  );
  const search = await json(
    "/api/sources?query=verification%20marker",
    owner.cookie,
  );
  assert.equal(search.sources.length, 1);
  assert.equal(search.sources[0].citation, `[source:${first.id}@1]`);
  assert.match(search.sources[0].excerpt, /DELTA77/);
  assert.equal(
    (await json("/api/sources?query=marker", other.cookie)).sources.length,
    0,
  );
  const denied = await call("/api/sources", other.cookie, {
    id: randomUUID(),
    connectionId: connection.id,
    expectedVersion: 1,
    resourceId: "doc-alpha",
  });
  assert.equal(denied.status, 404);
  pass(
    "SQL full-text retrieval returns independently known fixture facts and exact citations without cross-owner leakage",
  );
  const seq = await message(owner.cookie, id, "search_sources", {
    query: "verification marker",
    limit: 1,
  });
  const refs = (
    await pool.query(
      "SELECT context_snapshot FROM conversation_turns WHERE conversation_id=$1 AND sequence=$2",
      [id, seq],
    )
  ).rows[0].context_snapshot.sourceReferences;
  assert.deepEqual(refs, [{ id: first.id, version: 1 }]);
  pass(
    "registered source search runs through real conversation Workflow and pins source dependencies before reply",
  );
  stage = "stale approval";
  const draft = {
    title: "Explicit SQL approval fixture",
    markdown: "Synthetic draft references DELTA77.",
  };
  const digest = artifactDigest(draft.title, draft.markdown);
  await pool.query(
    "INSERT INTO conversation_revisions(conversation_id,revision,title,markdown,digest) VALUES($1,$2,$3,$4,$5)",
    [id, seq, draft.title, draft.markdown, digest],
  );
  await pool.query(
    "INSERT INTO conversation_approvals(conversation_id,revision,digest) VALUES($1,$2,$3)",
    [id, seq, digest],
  );
  await pool.query(
    "UPDATE agent_conversations SET latest_revision=$2 WHERE id=$1",
    [id, seq],
  );
  await refresh(owner.cookie, connection, 2);
  assert.equal(
    (
      await pool.query("SELECT version FROM source_records WHERE id=$1", [
        first.id,
      ])
    ).rows[0].version,
    2,
  );
  const decision = await call(path, owner.cookie, {
    action: "decision",
    revision: seq,
    digest,
    decision: "approve",
  });
  assert.equal(decision.status, 409);
  assert.equal(
    (
      await pool.query(
        "SELECT state FROM conversation_approvals WHERE conversation_id=$1 AND revision=$2",
        [id, seq],
      )
    ).rows[0].state,
    "superseded",
  );
  pass(
    "refresh changes source version and invalidates an otherwise exact old approval; historical source revision remains immutable",
  );
  const updated = await json(
    "/api/sources?query=verification%20marker",
    owner.cookie,
  );
  assert.match(updated.sources[0].excerpt, /DELTA88/);
  assert.equal(updated.sources[0].version, 2);
  await assert.rejects(
    pool.query("UPDATE source_versions SET metadata='{}' WHERE source_id=$1", [
      first.id,
    ]),
  );
  stage = "freshness and monotonic provider versions";
  await pool.query(
    "UPDATE source_records SET expires_at=now()-interval '1 second' WHERE id=$1",
    [first.id],
  );
  assert.equal(
    (await json("/api/sources?query=marker", owner.cookie)).sources.length,
    0,
  );
  await refresh(owner.cookie, connection, 2);
  const olderId = randomUUID();
  await json(
    "/api/sources",
    owner.cookie,
    {
      id: olderId,
      connectionId: connection.id,
      expectedVersion: 1,
      resourceId: "doc-alpha",
      fixtureRevision: 1,
    },
    202,
  );
  const rejected = await wait(
    async () =>
      (
        await pool.query(
          "SELECT state,error_code FROM source_refreshes WHERE id=$1",
          [olderId],
        )
      ).rows[0],
    (r) => r && r.state === "failed",
    "stale provider version",
  );
  assert.equal(rejected.error_code, "SOURCE_STALE_READ");
  assert.equal(
    (
      await pool.query("SELECT version FROM source_records WHERE id=$1", [
        first.id,
      ])
    ).rows[0].version,
    2,
  );
  pass(
    "expired source lease denies cached reads and late older provider versions cannot overwrite a newer source",
  );
  stage = "long conversation";
  await wait(
    async () =>
      (
        await pool.query(
          "SELECT worker_run_id FROM agent_conversations WHERE id=$1",
          [id],
        )
      ).rows[0],
    (r) => !r.worker_run_id,
    "worker release",
  );
  for (let n = 3; n <= 125; n++) {
    const text =
      n === 3
        ? "History code TEMPO42."
        : n === 60
          ? "Correction: history code TEMPO43 supersedes TEMPO42."
          : "History fixture " + n + " " + ".".repeat(700);
    await pool.query(
      "INSERT INTO conversation_turns(conversation_id,sequence,message_id,text,status,model,execution_mode,config_version) VALUES($1,$2,$3,$4,'completed','amazon/nova-micro','checkpoint',1)",
      [id, n, randomUUID(), text],
    );
    await pool.query(
      "INSERT INTO conversation_messages(conversation_id,sequence,message_key,role,content) VALUES($1,$2,$3,'user',$4)",
      [id, n, "user:" + n, text],
    );
  }
  await pool.query(
    "UPDATE agent_conversations SET requested_sequence=125,processed_sequence=125 WHERE id=$1",
    [id],
  );
  const history = await json(
    path + "/history?query=TEMPO&limit=10",
    owner.cookie,
  );
  assert.equal(history.messages.length, 2);
  assert.match(history.messages.at(-1).content, /TEMPO43/);
  const seen = new Set<string>();
  let cursor: string | null = null;
  do {
    const page = await json(
      path + "/history?limit=10" + (cursor ? "&beforeCursor=" + cursor : ""),
      owner.cookie,
    );
    for (const m of page.messages) {
      assert.equal(seen.has(m.id), false);
      seen.add(m.id);
    }
    cursor = page.nextCursor;
  } while (cursor);
  assert.equal(
    seen.size,
    +(
      await pool.query(
        "SELECT count(*) FROM conversation_messages WHERE conversation_id=$1 AND role IN ('user','assistant','system')",
        [id],
      )
    ).rows[0].count,
  );
  pass(
    "125-turn SQL history fixture preserves exact older facts/corrections and paginates message cursors without gaps or duplicates",
  );
  const longSeq = await message(owner.cookie, id, "read_history", {
    query: "TEMPO",
    limit: 5,
  });
  assert.equal(longSeq, 126);
  const context = (
    await pool.query(
      "SELECT context_snapshot FROM conversation_turns WHERE conversation_id=$1 AND sequence=$2",
      [id, longSeq],
    )
  ).rows[0].context_snapshot;
  assert.ok(
    Buffer.byteLength(JSON.stringify(context.userInstructions)) <= 16000,
  );
  assert.ok(!JSON.stringify(context.userInstructions).includes("TEMPO"));
  const longReply = (
    await pool.query(
      "SELECT content FROM conversation_messages WHERE conversation_id=$1 AND sequence=$2 AND role='assistant'",
      [id, longSeq],
    )
  ).rows[0].content;
  assert.match(longReply, /TEMPO43/);
  pass(
    "real follow-up beyond previous50-turn ceiling retrieves omitted older corrections while automatic instruction context stays byte-bounded",
  );
  stage = "configuration";
  const initial = await json("/api/agent-config", owner.cookie);
  assert.equal(initial.version, 1);
  const config = {
    expectedVersion: 1,
    instructions:
      "Include exact token CONFIG42 in every reply. Answer with exact source citations.",
    tools: ["read_context", "reply", "read_history", "search_sources"],
    contextBytes: 8000,
    maxOutputTokens: 1000,
  };
  const edits = await Promise.all([
    call("/api/agent-config", owner.cookie, config, "PUT"),
    call("/api/agent-config", owner.cookie, config, "PUT"),
  ]);
  assert.deepEqual(edits.map((r) => r.status).sort(), [200, 409]);
  await assert.rejects(
    pool.query(
      "UPDATE agent_config_versions SET instructions='mutated' WHERE agent_id=$1",
      [initial.agent_id],
    ),
  );
  assert.equal(
    (
      await pool.query(
        "SELECT config_version FROM conversation_turns WHERE conversation_id=$1 AND sequence=$2",
        [id, longSeq],
      )
    ).rows[0].config_version,
    1,
  );
  const newSeq = await message(owner.cookie, id, "search_sources", {
    query: "verification marker",
    limit: 1,
  });
  assert.equal(
    (
      await pool.query(
        "SELECT config_version FROM conversation_turns WHERE conversation_id=$1 AND sequence=$2",
        [id, newSeq],
      )
    ).rows[0].config_version,
    2,
  );
  const illegal = await call(
    "/api/agent-config",
    owner.cookie,
    {
      ...config,
      expectedVersion: 2,
      tools: ["read_context", "reply", "send_email"],
    },
    "PUT",
  );
  assert.equal(illegal.status, 400);
  pass(
    "configuration CAS and immutable revisions pin old turns, apply new tools/context/output limits to new turns and reject invented capabilities",
  );
  if (live) {
    stage = "live source reasoning";
    const msg = await json(
      path,
      owner.cookie,
      {
        action: "message",
        messageId: randomUUID(),
        text: "Search the authorized cached sources for the verification marker. Reply with the current marker and the exact source citation. Do not use read_fixture_document or assume a marker. Keep it under60 words.",
      },
      201,
    );
    await terminal(id, msg.sequence);
    const reply = (
      await pool.query(
        "SELECT content FROM conversation_messages WHERE conversation_id=$1 AND sequence=$2 AND role='assistant'",
        [id, msg.sequence],
      )
    ).rows[0].content;
    assert.match(reply, /DELTA88/);
    instructionProbe={expected:"CONFIG42",observed:reply.includes("CONFIG42"),note:"Optional custom-instruction adherence probe, not a configuration persistence or permission oracle. A failed probe is retained and not silently retried."};
    assert.ok(reply.includes(`[source:${first.id}@2]`));
    assert.ok(
      (
        await pool.query(
          "SELECT 1 FROM agent_capability_invocations WHERE conversation_id=$1 AND sequence=$2 AND tool_id='search_sources' AND state='completed'",
          [id, msg.sequence],
        )
      ).rowCount,
    );
    pass(
      "live Nova Micro retrieves latest cached evidence through registered tool and replies with independently verified fact and exact citation",
    );
  }
  const inherited=await message(owner.cookie,id,'read_history',{query:'DELTA88',limit:3});
  const inheritedRefs=(await pool.query('SELECT context_snapshot FROM conversation_turns WHERE conversation_id=$1 AND sequence=$2',[id,inherited])).rows[0].context_snapshot.sourceReferences;assert.deepEqual(inheritedRefs,[{id:first.id,version:2}]);
  pass('explicit historical retrieval inherits current source dependencies rather than laundering cited content into an untracked reply');
  stage = "operations";
  const op = await json(path + "/operations", owner.cookie);
  assert.equal(op.correlationId, id);
  assert.ok(op.invocations.some((i: any) => i.tool_id === "search_sources"));
  assert.ok(
    op.turns.some((t: any) => t.source_references?.[0]?.id === first.id),
  );
  assert.ok(
    op.usage.some((u: any) => u.budget_key === "connection:" + connection.id),
  );
  assert.equal("content" in op.invocations[0], false);
  pass(
    "redacted operations correlate conversation/turn/config/workflow/tool/source references and connector reservations",
  );
  // Explicit privileged exhausted-worker fixture, then ordinary owner repair API.
  const repairId = await checkpoint(owner.cookie);
  await pool.query(
    "UPDATE conversation_turns SET status='failed',attempt=3,error_code='MODEL_BUDGET_BLOCKED' WHERE conversation_id=$1 AND sequence=1",
    [repairId],
  );
  await pool.query(
    "DELETE FROM conversation_messages WHERE conversation_id=$1 AND role='assistant'",
    [repairId],
  );
  await pool.query(
    "UPDATE agent_conversations SET status='failed' WHERE id=$1",
    [repairId],
  );
  const requestId = randomUUID();
  const repaired = await json(
    "/api/conversations/" + repairId + "/operations",
    owner.cookie,
    { operation: "retry_exhausted", requestId },
    201,
  );
  await terminal(repairId, repaired.sequence);
  await json(
    "/api/conversations/" + repairId + "/operations",
    owner.cookie,
    { operation: "retry_exhausted", requestId },
    200,
  );
  assert.equal(
    +(
      await pool.query(
        "SELECT count(*) FROM agent_repairs WHERE conversation_id=$1",
        [repairId],
      )
    ).rows[0].count,
    1,
  );
  assert.equal(
    (
      await pool.query(
        "SELECT status FROM conversation_turns WHERE conversation_id=$1 AND sequence=1",
        [repairId],
      )
    ).rows[0].status,
    "failed",
  );
  pass(
    "authenticated exhausted-work repair admits one fresh bounded turn, preserves original failure and deduplicates operator retries",
  );
  stage = "disconnect";
  await json(
    "/api/connections/" + connection.id,
    owner.cookie,
    { action: "disconnect", expectedVersion: 1 },
    200,
    "PATCH",
  );
  assert.equal(
    (await json("/api/sources?query=marker", owner.cookie)).sources.length,
    0,
  );
  const disconnected = await call("/api/sources", owner.cookie, {
    id: randomUUID(),
    connectionId: connection.id,
    expectedVersion: 1,
    resourceId: "doc-alpha",
  });
  assert.equal(disconnected.status, 409);
  const afterDisconnect = await message(owner.cookie, id, "read_history", {
    query: "DELTA",
    limit: 5,
  });
  const answer = (
    await pool.query(
      "SELECT content FROM conversation_messages WHERE conversation_id=$1 AND sequence=$2 AND role='assistant'",
      [id, afterDisconnect],
    )
  ).rows[0].content;
  assert.doesNotMatch(answer, /DELTA77|DELTA88/);
  pass(
    "disconnect denies cached source use and historical generated source answers cannot reintroduce revoked facts",
  );
  stage = "concurrent quotas";
  const budgetConnection = (
    await json("/api/connections", owner.cookie, { provider: "fixture" }, 201)
  ).connection;
  await pool.query(
    "INSERT INTO connector_usage VALUES((now() AT TIME ZONE 'UTC')::date,$1,48,0)",
    ["connection:" + budgetConnection.id],
  );
  const quotas = await Promise.allSettled([
    transaction((c) =>
      reserveConnectorBudget(c, owner.id, budgetConnection.id),
    ),
    transaction((c) =>
      reserveConnectorBudget(c, owner.id, budgetConnection.id),
    ),
  ]);
  assert.equal(quotas.filter((q) => q.status === "fulfilled").length, 1);
  assert.equal(
    (
      await pool.query(
        "SELECT requests FROM connector_usage WHERE budget_key=$1",
        ["connection:" + budgetConnection.id],
      )
    ).rows[0].requests,
    60,
  );
  pass(
    "concurrent shared connector reservations cannot exceed request quota; failed reservation rolls back owner allowance atomically",
  );
  stage = "Google boundary";
  const google = (
    await json("/api/connections", owner.cookie, { provider: "google" }, 201)
  ).connection;
  assert.equal(google.status, "requires_authorization");
  assert.equal(
    (
      await call("/api/sources", owner.cookie, {
        id: randomUUID(),
        connectionId: google.id,
        expectedVersion: 1,
        resourceId: "selected_file",
      })
    ).status,
    409,
  );
  assert.equal(
    (
      await call("/api/drive", other.cookie, {
        action: "authorize",
        connectionId: google.id,
        expectedVersion: 1,
      })
    ).status,
    404,
  );
  assert.equal(
    (await call("/api/drive/callback?state=invalid&code=invalid", owner.cookie))
      .status,
    400,
  );
  assert.equal(
    +(
      await pool.query(
        "SELECT count(*) FROM drive_credentials WHERE owner_id=$1",
        [owner.id],
      )
    ).rows[0].count,
    0,
  );
  pass(
    "Google remains consent-required; cross-owner authorization and invalid callback state fail without installing any provider credential",
  );
  const usage = (
    await pool.query(
      "SELECT detail FROM conversation_events WHERE conversation_id=$1 AND kind='model_usage'",
      [id],
    )
  ).rows.map((r) => r.detail);
  const evidence = {
    completedAt: new Date().toISOString(),
    target: base.origin,
    success: true,
    checks,
    conversationId: id,
    sourceId: first.id,
    instructionProbe,
    modelUsage: usage,
    estimatedInferenceUsd: usage.reduce((n, v) => n + v.estimatedUsd, 0),
    googleOAuth:
      "Deferred; no consent, Picker selection, live token refresh or real Drive call was performed.",
    fixtures:
      "Synthetic provider documents. Explicit SQL injects125 completed history turns, one pending artifact and one exhausted worker. Normal sessions/API/Workflow handle source refreshes, followups, configuration, revocation and repair.",
    limitations: [
      "Fixture retrieval correctness is not a semantic search benchmark.",
      "Unit tests mock official Drive HTTP transport; live provider verification awaits Google consent and Picker setup.",
      "Inference estimates exclude Workflow/hosting/database/account costs.",
      "Historical owner-readable records persist; model retrieval redacts stale generated content and propagates valid dependencies.",
    ],
    noPayments: true,
  };
  if (process.env.AGENT_EVIDENCE_PATH)
    await writeFile(
      process.env.AGENT_EVIDENCE_PATH,
      JSON.stringify(evidence, null, 2) + "\n",
    );
  console.log(JSON.stringify(evidence, null, 2));
}
try {
  await main();
} catch (e) {
  console.error(
    JSON.stringify({
      error: "KNOWLEDGE_VERIFICATION_FAILED",
      stage,
      type: e instanceof Error ? e.name : "unknown",
      message: e instanceof Error ? e.message : "unknown",
    }),
  );
  process.exitCode = 1;
} finally {
  await pool.end();
  await authPool.end();
}
