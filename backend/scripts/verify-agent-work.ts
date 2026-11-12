/** Real hosted API/Workflow/SQL verification. Synthetic accounts/documents; no payments.
 * --live adds one three-turn Nova clarification -> job -> automatic-result story.
 * Privileged SQL is used only for ordinary fixture sessions and isolated authority/budget races.
 */
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import { writeFile } from "node:fs/promises";
import { Pool } from "pg";
import { betterAuth } from "better-auth";
import { chargeWork, assertWork, assertWorkTurn } from "../lib/work-store";
import { queueJobFollowUp } from "../lib/work-dispatch";
import { authPool } from "../lib/auth";
import { artifactDigest } from "../lib/agent-hash";
import { spawnSync } from "node:child_process";
const base = new URL(
    process.argv[2] || "https://sume-agent-foundation.vercel.app",
  ),
  live = process.argv.includes("--live");
assert.equal(base.origin, "https://sume-agent-foundation.vercel.app");
const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 6 });
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
const checks: string[] = [],
  ids: Record<string, unknown> = {};
let stage = "setup";
function pass(label: string) {
  checks.push(label);
  console.log("PASS", label);
}
async function account() {
  const r = await auth.api.signUpEmail({
    body: {
      email: `work-${randomUUID()}@example.invalid`,
      password: randomUUID() + randomUUID(),
      name: "Agent work verifier",
    },
    asResponse: true,
  });
  assert.equal(r.status, 200);
  const id = (await r.json()).user.id;
  return {
    id,
    cookie: r.headers
      .getSetCookie()
      .filter((c) => c.split("=")[0].includes("session_token"))
      .map((c) => c.split(";")[0])
      .join("; "),
  };
}
async function call(
  path: string,
  owner?: { cookie: string },
  body?: unknown,
  method?: string,
) {
  const r = await fetch(new URL(path, base), {
    method: method ?? (body === undefined ? "GET" : "POST"),
    headers: {
      Origin: base.origin,
      "Content-Type": "application/json",
      "x-demo-code": process.env.SUME_DEMO_CODE!,
      ...(owner ? { Cookie: owner.cookie } : {}),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const text = await r.text();
  assert.doesNotMatch(
    text,
    /access_token|refresh_token|session_token|Bearer\s|"stack"\s*:/i,
  );
  return { status: r.status, data: text ? JSON.parse(text) : null };
}
async function json(
  path: string,
  owner: { cookie: string },
  body?: unknown,
  status = 200,
) {
  const r = await call(path, owner, body);
  assert.equal(
    r.status,
    status,
    `${path}: ${JSON.stringify(r.data).slice(0, 180)}`,
  );
  return r.data;
}
async function wait<T>(
  read: () => Promise<T>,
  ready: (v: T) => boolean,
  label: string,
  seconds = 180,
) {
  for (let i = 0; i < seconds; i++) {
    const r = await read();
    if (ready(r)) return r;
    if (
      r &&
      typeof r === "object" &&
      ["failed", "budget_exhausted", "cancelled", "needs_reconnect"].includes(
        (r as any).state,
      )
    )
      throw Error(
        `Blocked ${label}: ${(r as any).error_code ?? (r as any).state}`,
      );
    await delay(1000);
  }
  throw Error("Timeout: " + label);
}
async function work(owner: { cookie: string }, id: string) {
  return (await json(`/api/agent-work?workId=${id}`, owner)).work[0];
}
async function turn(id: string, seq: number) {
  return wait(
    async () =>
      (
        await pool.query(
          "SELECT * FROM conversation_turns WHERE conversation_id=$1 AND sequence=$2",
          [id, seq],
        )
      ).rows[0],
    (r) => r && ["completed", "failed", "cancelled"].includes(r.status),
    "turn",
  );
}
async function upload(owner: { cookie: string }, name: string, count: number) {
  const id = randomUUID();
  await json(
    "/api/documents",
    owner,
    {
      requestId: randomUUID(),
      sourceId: id,
      expectedVersion: 0,
      filename: name + ".txt",
      content: `Verification marker: WORK731\nService count: ${count}\nReview date: November 12, 2026\n`,
    },
    201,
  );
  return { kind: "source" as const, id, version: 1 };
}
async function create(
  owner: { cookie: string },
  sources: any[],
  fields: string[] | undefined,
  toolName?: string,
  toolInput: unknown = {},
  limits: Record<string, unknown> = {},
) {
  const id = randomUUID(),
    messageId = randomUUID();
  const body = {
    id,
    messageId,
    source: "Bounded work verification: selected documents only.",
    text: "Compare the owner-selected sources. Ask for comparison fields if missing, otherwise run the authorized job and provide its cited result.",
    ...(toolName
      ? {
          executionMode: "capability_check",
          capabilityRequest: { tool: toolName, input: toolInput },
        }
      : { executionMode: "checkpoint" }),
    work: {
      sources,
      ...(fields ? { fields } : {}),
      maxModelCalls: 0,
      ...limits,
    },
  };
  await json("/api/conversations", owner, body, 201);
  return { id, workId: messageId, body };
}
const evidence: any = {
  startedAt: new Date().toISOString(),
  target: base.origin,
  checks,
  ids,
  fixtures:
    "Synthetic sessions/accounts and text documents. Budget/authority adversarial checks use explicitly isolated SQL transactions. Provider fixtures are distinct from real Google.",
  liveRequested: live,
};
try {
  const owner = await account(),
    other = await account();
  assert.equal((await call("/api/agent-work")).status, 401);
  pass("work metadata requires an authenticated owner");
  const sources = [
    await upload(owner, "work-left", 3),
    await upload(owner, "work-right", 7),
  ];
  stage = "finite job and continuation";
  const started = await create(
    owner,
    sources,
    ["Service count"],
    "start_document_job",
  );
  ids.deterministicConversation = started.id;
  const done = await wait(
    () => work(owner, started.workId),
    (w) => w?.state === "completed",
    "automatic result",
  );
  assert.equal(done.model_calls, 0);
  assert.equal(done.stage_calls, 3);
  assert.equal(done.continuations.length, 1);
  const inspected = await json(`/api/jobs/${done.job_id}`, owner);
  assert.equal(inspected.job.state, "completed");
  assert.equal(inspected.stages.length, 3);
  assert.match(inspected.artifact.markdown, /Service count/);
  assert.match(inspected.artifact.markdown, /\b3\b/);
  assert.match(inspected.artifact.markdown, /\b7\b/);
  assert.equal(
    (await turn(started.id, done.continuations[0].sequence)).status,
    "completed",
  );
  pass(
    "registered start tool launches one real three-stage job and one client-independent result continuation",
  );
  await json("/api/conversations", owner, started.body, 200);
  assert.equal(
    (
      await call("/api/conversations", owner, {
        ...started.body,
        work: { ...started.body.work, fields: ["Review date"] },
      })
    ).status,
    409,
  );
  await Promise.all(
    Array.from({ length: 8 }, () => queueJobFollowUp(done.job_id)),
  );
  assert.equal((await work(owner, started.workId)).continuations.length, 1);
  assert.equal(
    +(
      await pool.query("SELECT count(*) FROM document_jobs WHERE work_id=$1", [
        started.workId,
      ])
    ).rows[0].count,
    1,
  );
  pass(
    "identical admission and completion redelivery reuse job/continuation receipts; changed manifest conflicts",
  );
  assert.equal(
    (await json(`/api/agent-work?workId=${started.workId}`, other)).work.length,
    0,
  );
  assert.equal(
    (
      await call("/api/agent-work", other, {
        action: "cancel",
        workId: started.workId,
      })
    ).status,
    404,
  );
  assert.equal((await call(`/api/jobs/${done.job_id}`, other)).status, 404);
  pass("foreign owners cannot inspect or control another task/job");
  assert.equal(
    (
      await call(`/api/jobs/${done.job_id}`, owner, {
        action: "approve",
        expectedVersion: 1,
        digest: "0".repeat(64),
      })
    ).status,
    409,
  );
  const approval = {
    action: "approve",
    expectedVersion: inspected.job.version,
    digest: inspected.artifact.digest,
  };
  await json(`/api/jobs/${done.job_id}`, owner, approval);
  await json(`/api/jobs/${done.job_id}`, owner, approval);
  assert.equal(
    +(
      await pool.query(
        "SELECT count(*) FROM document_job_saves WHERE job_id=$1",
        [done.job_id],
      )
    ).rows[0].count,
    1,
  );
  pass(
    "automatic continuation preserves human-intent job approval; exact owner digest saves once",
  );
  stage = "clarification";
  const question = await create(
    owner,
    sources,
    undefined,
    "request_clarification",
    { question: "Which fields should I compare?", field: "fields" },
  );
  const pending = await wait(
    () => work(owner, question.workId),
    (w) => w?.state === "waiting_input",
    "question",
  );
  await turn(question.id, 1);
  const answer = {
    action: "answer",
    workId: question.workId,
    questionId: pending.question.id,
    expectedVersion: pending.question.version,
    answerId: randomUUID(),
    fields: ["Service count"],
  };
  assert.equal(
    (await call("/api/agent-work", owner, { ...answer, expectedVersion: 999 }))
      .status,
    409,
  );
  assert.equal((await call("/api/agent-work", other, answer)).status, 404);
  assert.equal(
    (await call("/api/agent-work", owner, { ...answer, fields: [] })).status,
    400,
  );
  const answers = await Promise.all([
    json("/api/agent-work", owner, answer),
    json("/api/agent-work", owner, answer),
  ]);
  assert.equal(answers[0].sequence, answers[1].sequence);
  await turn(question.id, answers[0].sequence);
  const answered = await work(owner, question.workId);
  assert.equal(answered.input_version, 2);
  assert.deepEqual(answered.request.fields, ["Service count"]);
  assert.equal(answered.question.state, "answered");
  assert.equal(answered.model_calls, 0);
  assert.equal(answered.state, "budget_exhausted");
  await json("/api/conversations", owner, question.body, 200);
  assert.equal(
    (
      await call("/api/agent-work", owner, {
        ...answer,
        answerId: randomUUID(),
        fields: ["Review date"],
      })
    ).status,
    409,
  );
  pass(
    "typed durable question survives reads; stale/foreign/invalid answers rejected; concurrent duplicate answer resumes once without replenishing zero model allowance",
  );
  stage = "concurrent shared budget";
  const budget = await create(
    owner,
    sources,
    ["Service count"],
    undefined,
    {},
    { maxModelCalls: 3 },
  );
  await turn(budget.id, 1);
  const budgetRow = await work(owner, budget.workId);
  const charged = await Promise.allSettled(
    Array.from({ length: 15 }, async () => {
      const c = await pool.connect();
      try {
        await c.query("BEGIN");
        await chargeWork(c, budgetRow, "model", 1, randomUUID());
        await c.query("COMMIT");
      } catch (e) {
        await c.query("ROLLBACK");
        throw e;
      } finally {
        c.release();
      }
    }),
  );
  assert.equal(charged.filter((r) => r.status === "fulfilled").length, 3);
  assert.equal((await work(owner, budget.workId)).model_calls, 3);
  await assert.rejects(
    pool.query("UPDATE agent_work SET model_calls=0 WHERE id=$1", [
      budget.workId,
    ]),
    /allowance cannot reset/,
  );
  await assert.rejects(
    pool.query(
      "UPDATE agent_work SET request=jsonb_set(request,'{maxModelCalls}','24') WHERE id=$1",
      [budget.workId],
    ),
    /authority is immutable/,
  );
  assert.equal(
    (
      await call("/api/agent-work", owner, {
        action: "resume",
        workId: budget.workId,
        requestId: randomUUID(),
        expectedVersion: 1,
      })
    ).status,
    429,
  );
  pass(
    "concurrent task components cannot oversubscribe shared allowance; SQL denies budget reset/authority expansion",
  );
  stage = "stale inputs and cancellation";
  const staleSources = [await upload(owner, "stale-left", 11), sources[1]];
  const stale = await create(
    owner,
    staleSources,
    undefined,
    "request_clarification",
    { question: "Which fields?", field: "fields" },
  );
  const sq = await wait(
    () => work(owner, stale.workId),
    (w) => w?.question,
    "stale question",
  );
  await turn(stale.id, 1);
  await json(
    "/api/documents",
    owner,
    {
      requestId: randomUUID(),
      sourceId: staleSources[0].id,
      expectedVersion: 1,
      filename: "stale-left.txt",
      content: "Service count: 12\n",
    },
    201,
  );
  assert.equal(
    (
      await call("/api/agent-work", owner, {
        action: "answer",
        workId: stale.workId,
        questionId: sq.question.id,
        expectedVersion: 1,
        answerId: randomUUID(),
        fields: ["Service count"],
      })
    ).status,
    409,
  );
  await json("/api/agent-work", owner, {
    action: "cancel",
    workId: stale.workId,
  });
  assert.equal((await work(owner, stale.workId)).state, "cancelled");
  pass(
    "changed source versions reject obsolete answers; owner can cancel even after source authority changes",
  );
  const superseded = await create(owner, sources, ["Service count"]);
  await turn(superseded.id, 1);
  await json(
    `/api/conversations/${superseded.id}`,
    owner,
    {
      action: "message",
      messageId: randomUUID(),
      text: "Stop the previous work; this is a new instruction.",
      executionMode: "checkpoint",
    },
    201,
  );
  assert.equal((await work(owner, superseded.workId)).state, "cancelled");
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await assert.rejects(assertWork(client, superseded.workId), /WORK_REVOKED/);
    await client.query("ROLLBACK");
  } finally {
    client.release();
  }
  pass(
    "new human instruction fences older task authority independently of mechanical message sequence",
  );
  stage = "source tool scope";
  const hidden = await upload(owner, "unselected", 99);
  const denied = await create(
    owner,
    sources,
    ["Service count"],
    "search_sources",
    { query: "Service", sourceId: hidden.id },
  );
  const deniedTurn = await turn(denied.id, 1);
  assert.equal(deniedTurn.status, "failed");
  assert.match(deniedTurn.error_code, /WORK_SOURCE_NOT_ALLOWED/);
  pass(
    "work retrieval cannot escape owner-selected source manifest even to another owned source",
  );
  stage = "connected source cache";
  const connector = (
    await json(
      "/api/connections",
      owner,
      {
        provider: "fixture",
        scopes: ["documents:read"],
        resourceIds: ["doc-alpha", "doc-beta"],
      },
      201,
    )
  ).connection;
  const connected = [
    {
      kind: "connection",
      connectionId: connector.id,
      expectedVersion: connector.version,
      resourceId: "doc-alpha",
    },
    sources[0],
  ];
  const pair = await Promise.all([
    create(owner, connected, ["Service count"], "refresh_connected_source", {
      sourceIndex: 0,
    }),
    create(owner, connected, ["Service count"], "refresh_connected_source", {
      sourceIndex: 0,
    }),
  ]);
  await Promise.all(pair.map((p) => turn(p.id, 1)));
  await wait(
    async () =>
      (
        await pool.query(
          "SELECT count(*) FROM source_records WHERE connection_id=$1",
          [connector.id],
        )
      ).rows[0].count,
    (n) => +n === 1,
    "connected import",
  );
  assert.equal(
    +(
      await pool.query(
        "SELECT count(*) FROM source_refreshes WHERE connection_id=$1",
        [connector.id],
      )
    ).rows[0].count,
    1,
  );
  const cached = await create(
    owner,
    connected,
    ["Service count"],
    "refresh_connected_source",
    { sourceIndex: 0 },
  );
  await turn(cached.id, 1);
  assert.equal((await work(owner, cached.workId)).provider_calls, 0);
  assert.equal(
    +(
      await pool.query(
        "SELECT requests FROM connector_usage WHERE budget_key=$1 AND day=(now() AT TIME ZONE $2)::date",
        ["connection:" + connector.id, "UTC"],
      )
    ).rows[0].requests,
    12,
  );
  pass(
    "connected-source tools reuse fresh cache and coalesce concurrent refresh admission without duplicate provider reservations (fixture HTTP provider)",
  );
  stage = "committed stage recovery";
  const recovery = await create(
    owner,
    sources,
    ["Service count"],
    "start_document_job",
    {},
    { recoveryTest: true },
  );
  const recovered = await wait(
    () => work(owner, recovery.workId),
    (w) => w?.state === "completed",
    "postcommit stage recovery",
  );
  assert.equal(recovered.stage_calls, 3);
  assert.equal(recovered.continuations.length, 1);
  const recoveredJob = await json(`/api/jobs/${recovered.job_id}`, owner);
  assert.ok(
    recoveredJob.attempts.some((a: any) => a.stage === 1 && a.attempts >= 2),
  );
  assert.equal(recoveredJob.stages.length, 3);
  pass(
    "postcommit interruption retries stage receipt without repeating committed stage work or completion follow-up",
  );
  stage = "pending source continuation";
  const pendingConnection = (
    await json(
      "/api/connections",
      owner,
      {
        provider: "fixture",
        scopes: ["documents:read"],
        resourceIds: ["doc-alpha"],
      },
      201,
    )
  ).connection;
  const refreshId = randomUUID();
  // Explicit coalescing fixture: a source lease is admitted before its independent owner refresh.
  await pool.query(
    "INSERT INTO agent_source_leases VALUES($1,$2,$3,$4,$5,now()+interval '30 seconds')",
    [
      owner.id,
      pendingConnection.id,
      pendingConnection.version,
      "doc-alpha",
      refreshId,
    ],
  );
  const pendingSource = await create(
    owner,
    [
      {
        kind: "connection",
        connectionId: pendingConnection.id,
        expectedVersion: pendingConnection.version,
        resourceId: "doc-alpha",
      },
      sources[0],
    ],
    ["Service count"],
    "refresh_connected_source",
    { sourceIndex: 0 },
  );
  await turn(pendingSource.id, 1);
  assert.equal(
    (await work(owner, pendingSource.workId)).state,
    "waiting_source",
  );
  await json(
    "/api/sources",
    owner,
    {
      id: refreshId,
      connectionId: pendingConnection.id,
      expectedVersion: pendingConnection.version,
      resourceId: "doc-alpha",
    },
    202,
  );
  const waiter = await wait(
    async () =>
      (
        await pool.query(
          "SELECT sequence FROM agent_work_source_waiters WHERE work_id=$1 AND refresh_id=$2",
          [pendingSource.workId, refreshId],
        )
      ).rows[0],
    (r) => r?.sequence > 0,
    "source-ready continuation",
  );
  await turn(pendingSource.id, waiter.sequence);
  assert.equal((await work(owner, pendingSource.workId)).model_calls, 0);
  assert.equal(
    +(
      await pool.query(
        "SELECT count(*) FROM agent_work_source_waiters WHERE work_id=$1",
        [pendingSource.workId],
      )
    ).rows[0].count,
    1,
  );
  pass(
    "pending shared refresh wakes its task once through a bounded model-free Workflow waiter (explicit lease fixture, real fixture HTTP refresh)",
  );
  stage = "shared stage budget";
  const stageBudget = await create(
    owner,
    sources,
    ["Service count"],
    "start_document_job",
    {},
    { maxStages: 1 },
  );
  const exhausted = await wait(
    () => work(owner, stageBudget.workId),
    (w) => w?.state === "budget_exhausted",
    "stage budget",
  );
  assert.equal(exhausted.stage_calls, 1);
  assert.equal(exhausted.continuations.length, 1);
  assert.equal(
    (await json(`/api/jobs/${exhausted.job_id}`, owner)).job.state,
    "failed",
  );
  pass(
    "job stages share task allowance and automatic failure delivery preserves the exhausted outcome",
  );
  stage = "task expiry";
  const expiryConversation = randomUUID();
  await json(
    "/api/conversations",
    owner,
    {
      id: expiryConversation,
      messageId: randomUUID(),
      source: "Expired authority fixture.",
      text: "Record a checkpoint.",
      executionMode: "checkpoint",
    },
    201,
  );
  await turn(expiryConversation, 1);
  const expiredId = randomUUID();
  await pool.query(
    "INSERT INTO agent_work(id,owner_id,conversation_id,origin_sequence,request,initial_request,expires_at) VALUES($1,$2,$3,1,$4,$4,now()-interval '1 second')",
    [
      expiredId,
      owner.id,
      expiryConversation,
      JSON.stringify(budgetRow.request),
    ],
  );
  assert.equal(
    (
      await call("/api/agent-work", owner, {
        action: "resume",
        workId: expiredId,
        requestId: randomUUID(),
        expectedVersion: 1,
      })
    ).status,
    409,
  );
  pass(
    "expired task authority rejects resumption (explicit past-expiry SQL fixture, no clock bypass)",
  );
  stage = "stopped job worker recovery";
  const faultOwner = await account(),
    faultSources = [
      await upload(faultOwner, "recovery-left", 3),
      await upload(faultOwner, "recovery-right", 7),
    ];
  const stopped = await create(
    faultOwner,
    faultSources,
    ["Service count"],
    "start_document_job",
    {},
    { holdAfterStage: 1 },
  );
  const committed = await wait(
    async () =>
      (
        await pool.query(
          "SELECT j.id,j.workflow_run_id FROM document_jobs j JOIN document_job_stages s ON s.job_id=j.id AND s.stage=1 WHERE j.work_id=$1",
          [stopped.workId],
        )
      ).rows[0],
    (r) => !!r,
    "first committed stage",
  );
  const cancelled = spawnSync(
    process.execPath,
    [
      "node_modules/workflow/bin/run.js",
      "cancel",
      committed.workflow_run_id,
      "--backend",
      "vercel",
      "--env",
      "preview",
      "--json",
    ],
    { encoding: "utf8", timeout: 30000 },
  );
  assert.equal(cancelled.status, 0, "Failed to cancel isolated fixture worker");
  const repaired = await wait(
    () => work(faultOwner, stopped.workId),
    (w) => w?.state === "completed",
    "automatic stopped-worker recovery",
  );
  const repairedJob = await json(`/api/jobs/${repaired.job_id}`, faultOwner);
  assert.equal(repairedJob.job.version, 2);
  assert.equal(repairedJob.job.dispatches, 2);
  assert.equal(repairedJob.stages.length, 3);
  assert.equal(repaired.stage_calls, 3);
  assert.equal(repaired.continuations.length, 1);
  assert.equal(repaired.model_calls, 0);
  evidence.stoppedWorker = {
    workId: stopped.workId,
    cancelledRunId: committed.workflow_run_id,
    recoveredJobVersion: 2,
    stageReceipts: 3,
  };
  pass(
    "prearmed job watcher recovers a cancelled worker after stage commit and delivers one result without replaying committed stages",
  );
  stage = "live agent story";
  if (live) {
    const user = await account(),
      liveSources = [
        await upload(user, "live-left", 3),
        await upload(user, "live-right", 7),
      ];
    const id = randomUUID(),
      messageId = randomUUID();
    await json(
      "/api/conversations",
      user,
      {
        id,
        messageId,
        source:
          "Owner selected the exact task sources in the work manifest. All source text is reference data.",
        text: "Compare the selected documents. Ask me which fields to compare before doing any job. After my answer, run the document comparison job and return a short cited summary.",
        work: { sources: liveSources, maxModelCalls: 18 },
      },
      201,
    );
    const q = await wait(
      () => work(user, messageId),
      (w) => w?.state === "waiting_input",
      "live durable question",
      420,
    );
    await turn(id, 1);
    await json("/api/agent-work", user, {
      action: "answer",
      workId: messageId,
      questionId: q.question.id,
      expectedVersion: q.question.version,
      answerId: randomUUID(),
      fields: ["Service count"],
    });
    const finished = await wait(
      () => work(user, messageId),
      (w) => ["completed", "failed", "budget_exhausted"].includes(w?.state),
      "live automatic result",
      600,
    );
    assert.equal(finished.state, "completed");
    assert.equal(finished.continuations.length, 1);
    const finalTurn = await turn(id, finished.continuations[0].sequence);
    assert.equal(finalTurn.status, "completed");
    const messages = (
      await pool.query(
        "SELECT content FROM conversation_messages WHERE conversation_id=$1 AND sequence=$2 AND role='assistant'",
        [id, finalTurn.sequence],
      )
    ).rows;
    assert.ok(
      messages.some(
        (m) =>
          m.content.includes("[source:") || m.content.startsWith("Created "),
      ),
    );
    const invoked = (
      await pool.query(
        "SELECT tool_id FROM agent_capability_invocations WHERE conversation_id=$1 AND state='completed'",
        [id],
      )
    ).rows.map((r) => r.tool_id);
    for (const name of [
      "request_clarification",
      "start_document_job",
      "read_job_result",
    ])
      assert.ok(invoked.includes(name), name);
    const artifact = await json(`/api/jobs/${finished.job_id}`, user);
    assert.match(artifact.artifact.markdown, /\b3\b/);
    assert.match(artifact.artifact.markdown, /\b7\b/);
    assert.equal(artifact.artifact.state, "draft");
    const usage = (
      await pool.query(
        "SELECT detail FROM conversation_events WHERE conversation_id=$1 AND kind='model_usage'",
        [id],
      )
    ).rows.map((r) => r.detail);
    assert.ok(usage.every((u) => u.model === "amazon/nova-micro"));
    evidence.live = {
      conversationId: id,
      workId: messageId,
      jobId: finished.job_id,
      modelCallsReserved: finished.model_calls,
      usage,
      estimatedInferenceUsd: usage.reduce((n, u) => n + u.estimatedUsd, 0),
      browserRequiredForProgress: false,
    };
    pass(
      "actual Nova Micro asks durable clarification, starts one job after owner answer and automatically delivers cited result without approving/saving",
    );
  }
  evidence.status = "passed";
} catch (e) {
  evidence.status = "failed";
  evidence.failedStage = stage;
  evidence.error = e instanceof Error ? e.message : "Verification failed";
  console.error("FAILED", stage, evidence.error);
  process.exitCode = 1;
} finally {
  evidence.completedAt = new Date().toISOString();
  await writeFile(
    "../research/agent-work-" +
      (live ? "live" : "hosted") +
      "-verification-2026-11-09.json",
    JSON.stringify(evidence, null, 2) + "\n",
  );
  await pool.end();
  await authPool.end();
  console.log(
    JSON.stringify({
      status: evidence.status,
      checks: checks.length,
      failedStage: evidence.failedStage,
    }),
  );
}
