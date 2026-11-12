import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import { writeFile } from "node:fs/promises";
import { betterAuth } from "better-auth";
import { Pool } from "pg";
import { fireRoutine, assertTurnAuthority } from "../lib/routine-store";
import { reserveModelBudget } from "../lib/model-budget";
import { authPool } from "../lib/auth";

const base = new URL(process.argv[2] || "http://localhost:3000");
if (
  !process.env.DATABASE_URL ||
  !process.env.BETTER_AUTH_SECRET ||
  !process.env.SUME_DEMO_CODE
)
  throw new Error(
    "Load matching target database, auth secret and preview code.",
  );
const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 2 });
const fixtureAuth = betterAuth({
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
  "Content-Type": "application/json",
  Origin: base.origin,
  "x-demo-code": process.env.SUME_DEMO_CODE,
};
const checks: string[] = [];
function passed(text: string) {
  checks.push(text);
  console.log("PASS", text);
}
async function account() {
  const response = await fixtureAuth.api.signUpEmail({
    body: {
      email: `routine-verifier-${randomUUID()}@example.invalid`,
      password: randomUUID() + randomUUID(),
      name: "Routine verifier",
    },
    headers: new Headers(headers),
    asResponse: true,
  });
  assert.equal(response.status, 200);
  const cookie = response.headers
    .getSetCookie()
    .filter((v) => v.split("=")[0].includes("session_token"))
    .map((v) => v.split(";")[0])
    .join("; ");
  assert.ok(cookie);
  return cookie;
}
async function call(
  path: string,
  session?: string,
  body?: unknown,
  extra = {},
) {
  return fetch(new URL(path, base), {
    method: body === undefined ? "GET" : "POST",
    headers: { ...headers, ...(session ? { Cookie: session } : {}), ...extra },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}
async function json(
  path: string,
  session: string,
  body?: unknown,
  status = 200,
) {
  const r = await call(path, session, body);
  assert.equal(r.status, status, `${path}: ${await r.clone().text()}`);
  return r.json();
}
async function waitDb<T>(
  read: () => Promise<T>,
  ready: (v: T) => boolean,
  label: string,
  seconds = 160,
) {
  for (let i = 0; i < seconds; i++) {
    const value = await read();
    if (ready(value)) return value;
    await delay(1000);
  }
  throw new Error("Timed out: " + label);
}
async function turns(id: string) {
  return (
    await pool.query(
      "SELECT * FROM conversation_turns WHERE conversation_id=$1 ORDER BY sequence",
      [id],
    )
  ).rows;
}
function input(patch = {}) {
  return {
    id: randomUUID(),
    action: "create",
    instruction: "Record a checkpoint.",
    executionMode: "checkpoint",
    dueAt: new Date(Date.now() + 7000).toISOString(),
    timezone: "America/New_York",
    intervalSeconds: null,
    maxRuns: 1,
    expiresAt: new Date(Date.now() + 180000).toISOString(),
    ...patch,
  };
}
let conversationId = "";
try {
  const budgetBefore = (
    await pool.query(
      "SELECT * FROM agent_model_budget WHERE day=(now() AT TIME ZONE 'UTC')::date",
    )
  ).rows[0];
  const first = await account(),
    other = await account();
  assert.equal(
    (await call("/api/conversations/" + randomUUID() + "/routines")).status,
    401,
  );
  passed("unauthenticated routine access denied");
  conversationId = randomUUID();
  const path = "/api/conversations/" + conversationId;
  await json(
    "/api/conversations",
    first,
    {
      id: conversationId,
      messageId: randomUUID(),
      text: "Record a checkpoint.",
      source: "WAKE42. Seven workers. Review November 12, 2026.",
      executionMode: "checkpoint",
      dispatchRecoveryTest: true,
    },
    201,
  );
  // No more app requests until SQL independently observes completion. The
  // foreground handler deliberately omitted dispatch after committing its inbox.
  await waitDb(
    () => turns(conversationId),
    (v) => v[0]?.status === "completed",
    "automatic post-commit dispatch recovery",
  );
  assert.equal(
    (
      await pool.query(
        "SELECT state FROM agent_dispatch_outbox WHERE conversation_id=$1",
        [conversationId],
      )
    ).rows[0].state === "failed",
    false,
  );
  passed(
    "post-commit foreground dispatch gap recovers without browser or API polling",
  );
  assert.equal((await call(path + "/routines", other)).status, 404);
  assert.equal((await call(path + "/routines", other, input())).status, 404);
  passed("cross-owner routine read and mutation denied");
  const origin = await call(path + "/routines", first, input(), {
    Origin: "https://foreign.invalid",
  });
  assert.ok([403, 404].includes(origin.status));
  passed("foreign-origin routine mutation denied");
  assert.equal(
    (
      await call(
        path + "/routines",
        first,
        input({ maxRuns: 11, intervalSeconds: 60 }),
      )
    ).status,
    400,
  );
  assert.equal(
    (await call(path + "/routines", first, input({ timezone: "Fake/Zone" })))
      .status,
    400,
  );
  passed("unbounded schedules and invalid timezone refused");

  const recurring = input({ intervalSeconds: 60, maxRuns: 2 });
  const duplicate = await Promise.all([
    call(path + "/routines", first, recurring),
    call(path + "/routines", first, recurring),
  ]);
  assert.deepEqual(duplicate.map((r) => r.status).sort(), [200, 201]);
  passed("concurrent duplicate schedule creation is idempotent");
  const paused = input({ dueAt: new Date(Date.now() + 14000).toISOString() });
  await json(path + "/routines", first, paused, 201);
  await json(path + "/routines", first, {
    action: "pause",
    id: paused.id,
    version: 1,
  });
  const cancelled = input({
    dueAt: new Date(Date.now() + 14000).toISOString(),
  });
  await json(path + "/routines", first, cancelled, 201);
  await json(path + "/routines", first, {
    action: "cancel",
    id: cancelled.id,
    version: 1,
  });
  const edited = input({ dueAt: new Date(Date.now() + 13000).toISOString() });
  await json(path + "/routines", first, edited, 201);
  const edit = {
    ...edited,
    action: "edit",
    version: 1,
    instruction: "Edited checkpoint instruction.",
    dueAt: new Date(Date.now() + 18000).toISOString(),
  };
  await json(path + "/routines", first, edit);
  assert.equal((await call(path + "/routines", first, edit)).status, 409);
  passed("schedule edits use optimistic versions and reject stale edits");
  const expiry = input({ dueAt: new Date(Date.now() + 12000).toISOString() });
  await json(path + "/routines", first, expiry, 201);
  await pool.query(
    "UPDATE agent_routines SET expires_at=now()-interval '1 second' WHERE id=$1",
    [expiry.id],
  );
  // While timer workflows are sleeping, test the fail-closed spend gate without
  // issuing inference or mutating the hosted project's budget configuration.
  const configured = process.env.AGENT_MODEL_DAILY_USD;
  process.env.AGENT_MODEL_DAILY_USD = "0";
  await assert.rejects(
    () => reserveModelBudget("amazon/nova-micro"),
    /MODEL_DAILY_BUDGET_EXHAUSTED/,
  );
  if (configured === undefined) delete process.env.AGENT_MODEL_DAILY_USD;
  else process.env.AGENT_MODEL_DAILY_USD = configured;
  await assert.rejects(
    () => reserveModelBudget("openai/gpt-5.4"),
    /MODEL_NOT_ALLOWED/,
  );
  passed(
    "zero inference budget and non-allowlisted model fail closed without inference",
  );

  await waitDb(
    async () =>
      (
        await pool.query(
          "SELECT * FROM routine_occurrences WHERE routine_id=$1",
          [edited.id],
        )
      ).rows,
    (v) => v.some((x) => x.version === 2),
    "edited timer",
  );
  assert.equal(
    (
      await pool.query(
        "SELECT count(*) FROM routine_occurrences WHERE routine_id=ANY($1::uuid[])",
        [[paused.id, cancelled.id, expiry.id]],
      )
    ).rows[0].count,
    "0",
  );
  assert.equal(
    (
      await pool.query(
        "SELECT count(*) FROM routine_occurrences WHERE routine_id=$1 AND version=1",
        [edited.id],
      )
    ).rows[0].count,
    "0",
  );
  passed("paused, cancelled, expired and superseded timers cannot admit turns");
  const occurrence = await waitDb(
    async () =>
      (
        await pool.query(
          "SELECT * FROM routine_occurrences WHERE routine_id=$1 ORDER BY due_at",
          [recurring.id],
        )
      ).rows,
    (v) => v.length >= 1,
    "first timer occurrence",
  );
  const repeated = await Promise.all([
    fireRoutine(recurring.id, 1, new Date(occurrence[0].due_at).toISOString()),
    fireRoutine(recurring.id, 1, new Date(occurrence[0].due_at).toISOString()),
  ]);
  assert.ok(repeated.every((x) => x?.duplicate));
  assert.equal(
    (
      await pool.query(
        "SELECT count(*) FROM routine_occurrences WHERE routine_id=$1 AND due_at=$2",
        [recurring.id, occurrence[0].due_at],
      )
    ).rows[0].count,
    "1",
  );
  passed(
    "repeated timer delivery admits exactly one occurrence and conversation turn",
  );

  await waitDb(
    async () =>
      (
        await pool.query(
          "SELECT * FROM routine_occurrences WHERE routine_id=$1 ORDER BY due_at",
          [recurring.id],
        )
      ).rows,
    (v) => v.length === 2 && v.every((x) => x.status === "completed"),
    "bounded recurring checkpoint completion",
    150,
  );
  // One live model turn, using the configured cheap model; other lifecycle tests
  // are real SQL/Workflow checkpoint operations and never simulate AI output.
  await json(
    path,
    first,
    {
      action: "message",
      messageId: randomUUID(),
      text: "Create a Markdown artifact titled Wake-up proof. Include exactly WAKE42 and the original worker count and review date. Keep it under 100 words.",
      recoveryTest: true,
    },
    201,
  );
  const live = await waitDb(
    async () =>
      (
        await pool.query(
          "SELECT t.*,r.digest FROM conversation_turns t LEFT JOIN conversation_revisions r ON r.conversation_id=t.conversation_id AND r.revision=t.sequence WHERE t.conversation_id=$1 ORDER BY t.sequence DESC LIMIT 1",
          [conversationId],
        )
      ).rows[0],
    (v) => v?.status === "completed" && !!v.digest,
    "cheap live artifact",
    240,
  );
  assert.equal(live.model, "amazon/nova-micro");
  const artifact = (
    await pool.query(
      "SELECT * FROM conversation_revisions WHERE conversation_id=$1 AND revision=$2",
      [conversationId, live.sequence],
    )
  ).rows[0];
  assert.match(artifact.markdown, /WAKE42/);
  assert.match(artifact.markdown, /7|seven/i);
  passed(
    "live cheap-model scheduled-context follow-up creates independently checked artifact",
  );
  const decision = {
    action: "decision",
    revision: live.sequence,
    digest: artifact.digest,
    decision: "approve",
    dispatchRecoveryTest: true,
  };
  await json(path, first, decision);
  await waitDb(
    async () =>
      (
        await pool.query(
          "SELECT state FROM conversation_revisions WHERE conversation_id=$1 AND revision=$2",
          [conversationId, live.sequence],
        )
      ).rows[0],
    (v) => v?.state === "saved",
    "automatic approved-save dispatch",
  );
  passed(
    "approved save recovers from a foreground dispatch gap without client polling",
  );
  await delay(4000);
  assert.equal(
    (
      await pool.query(
        "SELECT attempts FROM conversation_actions WHERE conversation_id=$1 AND sequence=$2 AND kind='save_approved_artifact'",
        [conversationId, live.sequence],
      )
    ).rows[0].attempts,
    2,
  );
  assert.equal(
    (
      await pool.query(
        "SELECT count(*) FROM conversation_events WHERE conversation_id=$1 AND kind='artifact_saved' AND detail->>'revision'=$2",
        [conversationId, String(live.sequence)],
      )
    ).rows[0].count,
    "1",
  );
  passed(
    "post-commit save interruption reconciles two attempts to one effective save",
  );
  const terminalRun = (
    await pool.query(
      "SELECT save_run_id FROM conversation_approvals WHERE conversation_id=$1 AND revision=$2",
      [conversationId, live.sequence],
    )
  ).rows[0].save_run_id;
  const interruptedMessage = randomUUID();
  await json(
    path,
    first,
    {
      action: "message",
      messageId: interruptedMessage,
      text: "Recovery checkpoint.",
      executionMode: "checkpoint",
      dispatchRecoveryTest: true,
    },
    201,
  );
  // Fixture: persisted running claim points to a real completed Workflow run.
  // This exercises automatic terminal-run inspection and fencing, not a mock
  // Workflow status response or an application recovery endpoint.
  await pool.query(
    "UPDATE agent_conversations SET worker_run_id=$2 WHERE id=$1",
    [conversationId, terminalRun],
  );
  await pool.query(
    "UPDATE conversation_turns SET status='running' WHERE conversation_id=$1 AND message_id=$2",
    [conversationId, interruptedMessage],
  );
  await waitDb(
    async () =>
      (
        await pool.query(
          "SELECT status,attempt FROM conversation_turns WHERE conversation_id=$1 AND message_id=$2",
          [conversationId, interruptedMessage],
        )
      ).rows[0],
    (v) => v?.status === "completed" && v.attempt >= 2,
    "automatic stopped worker recovery",
  );
  passed(
    "stopped-worker claim recovers automatically through real Workflow status inspection",
  );
  const all = await waitDb(
    async () =>
      (
        await pool.query(
          "SELECT * FROM routine_occurrences WHERE routine_id=$1 ORDER BY due_at",
          [recurring.id],
        )
      ).rows,
    (v) => v.length === 2 && v.every((x) => x.status === "completed"),
    "bounded recurring runs",
    150,
  );
  assert.equal(
    (
      await pool.query(
        "SELECT status,run_count FROM agent_routines WHERE id=$1",
        [recurring.id],
      )
    ).rows[0].status,
    "completed",
  );
  const seqs = (await turns(conversationId)).map((t) => t.sequence);
  assert.equal(new Set(seqs).size, seqs.length);
  assert.deepEqual(
    seqs,
    [...seqs].sort((a, b) => a - b),
  );
  passed(
    "recurring wake-ups stop at their cap and share ordered conversation sequencing",
  );
  const revoked = await pool.connect();
  try {
    await revoked.query("BEGIN");
    await revoked.query(
      "UPDATE agent_routines SET version=version+1,status='paused' WHERE id=$1",
      [recurring.id],
    );
    await assert.rejects(
      () => assertTurnAuthority(revoked, conversationId, all[0].sequence),
      /ROUTINE_REVOKED/,
    );
    passed("scheduled tool authority rejects a revoked generation");
  } finally {
    await revoked.query("ROLLBACK");
    revoked.release();
  }
  assert.ok(
    (
      await pool.query(
        "SELECT count(*) FROM conversation_messages WHERE conversation_id=$1 AND role='system'",
        [conversationId],
      )
    ).rows[0].count >= 2,
  );
  passed(
    "scheduled instruction provenance remains distinct from user messages",
  );
  const before = (await json("/api/conversations", first)).conversations.find(
    (c: any) => c.id === conversationId,
  );
  assert.ok(before.unread > 0);
  await json(path, first, { action: "read" });
  const after = (await json("/api/conversations", first)).conversations.find(
    (c: any) => c.id === conversationId,
  );
  assert.equal(after.unread, 0);
  passed("background results persist as unread until explicitly acknowledged");
  const resume = {
    ...paused,
    action: "edit",
    version: 2,
    dueAt: new Date(Date.now() + 10000).toISOString(),
  };
  await json(path + "/routines", first, resume);
  await json(path + "/routines", first, {
    action: "cancel",
    id: paused.id,
    version: 3,
  });
  passed("paused routine resumes under a new generation and can be cancelled");
  const revoke = input({ dueAt: new Date(Date.now() + 8000).toISOString() });
  await json(path + "/routines", first, revoke, 201);
  await json(path, first, { action: "cancel" });
  await delay(10000);
  assert.equal(
    (
      await pool.query(
        "SELECT count(*) FROM routine_occurrences WHERE routine_id=$1",
        [revoke.id],
      )
    ).rows[0].count,
    "0",
  );
  passed("conversation revocation blocks all later scheduled work");
  const budgetAfter = (
    await pool.query(
      "SELECT * FROM agent_model_budget WHERE day=(now() AT TIME ZONE 'UTC')::date",
    )
  ).rows[0];
  const usage = (
    await pool.query(
      "SELECT detail FROM conversation_events WHERE conversation_id=$1 AND kind='model_usage'",
      [conversationId],
    )
  ).rows.map((x) => x.detail);
  const evidence = {
    completedAt: new Date().toISOString(),
    target: base.origin,
    conversationId,
    checks,
    authentication:
      "Synthetic fixture accounts using ordinary signed Better Auth sessions; no deployed test login.",
    liveModel: live.model,
    modelUsage: usage,
    budget: {
      before: budgetBefore ?? null,
      after: budgetAfter,
      reservationDeltaUsd:
        Number(budgetAfter?.reserved_usd ?? 0) -
        Number(budgetBefore?.reserved_usd ?? 0),
      note: "Conservative model reservations, not the provider invoice. Workflow/hosting/DB charges are separate.",
    },
    recurringOccurrences: all.map((x) => ({
      version: x.version,
      sequence: x.sequence,
      dueAt: x.due_at,
      status: x.status,
    })),
    failureInjection:
      "Foreground dispatch deliberately omitted; save failure injected after SQL commit; stopped-worker fixture uses a real completed Workflow run ID.",
    noPayments: true,
  };
  if (process.env.AGENT_EVIDENCE_PATH)
    await writeFile(
      process.env.AGENT_EVIDENCE_PATH,
      JSON.stringify(evidence, null, 2) + "\n",
    );
  console.log(JSON.stringify(evidence, null, 2));
} finally {
  await pool.end();
  await authPool.end();
}
