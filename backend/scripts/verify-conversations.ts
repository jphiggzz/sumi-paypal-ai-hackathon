import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import { writeFile } from "node:fs/promises";
import { betterAuth } from "better-auth";
import { Pool } from "pg";

const base = new URL(process.argv[2] || "http://localhost:3000");
if (
  !process.env.DATABASE_URL ||
  !process.env.BETTER_AUTH_SECRET ||
  !process.env.SUME_DEMO_CODE
)
  throw new Error(
    "Load the target database, matching auth secret, and preview access code.",
  );
const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 2 });
// Local privileged fixture setup only. The deployed app has no test-login or
// password provider. All HTTP checks use ordinary signed Better Auth sessions.
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
const headers = { Origin: base.origin, "Content-Type": "application/json" };
const password = randomUUID() + randomUUID();
const email = `conversation-verifier-${randomUUID()}@example.invalid`;
const evidence: Record<string, unknown> = {
  checkedAt: new Date().toISOString(),
  target: base.origin,
  authentication:
    "Ordinary signed sessions for synthetic fixture accounts, issued by a privileged local harness. Google OAuth is checked separately.",
  checks: [],
};
const checks = evidence.checks as string[];
function cookie(response: Response) {
  const value = response.headers
    .getSetCookie()
    .filter((item) => item.split("=")[0].includes("session_token"))
    .map((item) => item.split(";")[0])
    .join("; ");
  assert.ok(value);
  return value;
}
async function account(address: string) {
  const response = await fixtureAuth.api.signUpEmail({
    body: { email: address, password, name: "Conversation verifier" },
    headers: new Headers(headers),
    asResponse: true,
  });
  assert.equal(response.status, 200);
  return cookie(response);
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
async function detail(id: string, session: string) {
  const response = await call("/api/conversations/" + id, session);
  assert.equal(response.status, 200);
  return response.json();
}
async function waitFor(
  id: string,
  session: string,
  predicate: (value: any) => boolean,
  label: string,
) {
  for (let attempt = 0; attempt < 240; attempt++) {
    const value = await detail(id, session);
    assert.equal(
      value.turns.some((turn: any) => turn.status === "failed"),
      false,
      JSON.stringify({ label, turns: value.turns }),
    );
    if (predicate(value)) return value;
    await delay(1500);
  }
  throw new Error("Timed out: " + label);
}
const admission = { "x-demo-code": process.env.SUME_DEMO_CODE };
const source = "There are 7 workers. Deadline: November 12, 2026.";
try {
  const first = await account(email),
    other = await account(
      `conversation-verifier-${randomUUID()}@example.invalid`,
    );
  const login = await fixtureAuth.api.signInEmail({
    body: { email, password },
    headers: new Headers(headers),
    asResponse: true,
  });
  const secondDevice = cookie(login);
  assert.notEqual(first, secondDevice);
  const workspace = await call("/agents", first);
  assert.equal(
    workspace.status,
    200,
    "Authenticated conversation workspace must render",
  );
  assert.match(await workspace.text(), /Agent Foundation/);
  checks.push("authenticated conversation workspace renders");
  assert.equal((await call("/api/conversations")).status, 401);
  checks.push("unauthenticated access denied");
  const input = {
    id: randomUUID(),
    messageId: randomUUID(),
    text: "Create a Markdown brief with title Foundation Check. Include the exact phrase CONTROL: MAPLE42 and preserve it in all later revisions. Include the worker count and deadline from the source.",
    source,
    recoveryTest: true,
  };
  assert.equal((await call("/api/conversations", first, input)).status, 403);
  const foreignOrigin = await call("/api/conversations", first, input, {
    ...admission,
    Origin: "https://untrusted.invalid",
  });
  assert.ok(
    [403, 404].includes(foreignOrigin.status),
    "Cross-origin requests must be denied by the application or hosting layer",
  );
  assert.equal(
    (
      await pool.query(
        "SELECT count(*)::int AS count FROM agent_conversations WHERE id=$1",
        [input.id],
      )
    ).rows[0].count,
    0,
  );
  checks.push("metered admission and foreign-origin denial");
  const starts = await Promise.all([
    call("/api/conversations", first, input, admission),
    call("/api/conversations", first, input, admission),
  ]);
  assert.deepEqual(starts.map((item) => item.status).sort(), [200, 201]);
  checks.push("concurrent duplicate conversation start");
  const id = input.id;
  assert.equal((await call("/api/conversations/" + id, other)).status, 404);
  assert.equal(
    (await call("/api/conversations/" + id, other, { action: "cancel" }))
      .status,
    404,
  );
  assert.equal(
    (await call("/api/conversations/" + id + "/revisions/1", other)).status,
    404,
  );
  checks.push("cross-owner history, control and download denied");
  // No client or stream remains connected while the first turn executes.
  await delay(12_000);
  const v1 = await waitFor(
    id,
    secondDevice,
    (d) =>
      d.conversation.processed_sequence === 1 && !d.conversation.worker_run_id,
    "first draft without a connected client",
  );
  assert.equal(v1.turns.length, 1);
  assert.equal(v1.revisions.length, 1);
  assert.equal(v1.artifact.revision, 1);
  assert.match(v1.artifact.markdown, /CONTROL:\s*MAPLE42/);
  assert.equal(
    v1.actions.find((a: any) => a.kind === "read_context").result.sourceStats
      .words,
    8,
  );
  assert.equal(v1.approvals[0].state, "pending");
  checks.push("background execution and reconstruction from another session");
  const oldDigest = v1.artifact.digest;
  assert.equal(
    (
      await call("/api/conversations/" + id, secondDevice, {
        action: "decision",
        revision: 1,
        digest: "0".repeat(64),
        decision: "approve",
      })
    ).status,
    409,
  );
  assert.equal(
    (
      await call("/api/conversations/" + id, secondDevice, {
        action: "decision",
        revision: 1,
        digest: oldDigest,
        decision: "approve",
      })
    ).status,
    200,
  );
  checks.push("approval binds the exact immutable content");
  const a = {
    action: "message",
    messageId: randomUUID(),
    text: "Revise the artifact to also include the exact phrase OWNER: RIVER. Preserve earlier requested phrases and source facts.",
    recoveryTest: true,
  };
  const b = {
    action: "message",
    messageId: randomUUID(),
    text: "Revise the artifact to also include the exact phrase REVIEW: MONDAY. Preserve earlier requested phrases and source facts.",
    recoveryTest: true,
  };
  const replies = await Promise.all([
    call("/api/conversations/" + id, first, a, admission),
    call("/api/conversations/" + id, secondDevice, b, admission),
  ]);
  assert.deepEqual(
    replies.map((item) => item.status),
    [201, 201],
  );
  const accepted = await Promise.all(
    replies.map((response) => response.json()),
  );
  assert.deepEqual(accepted.map((item) => item.sequence).sort(), [2, 3]);
  const afterAccept = await detail(id, first);
  assert.equal(
    afterAccept.approvals.find((item: any) => item.revision === 1).state,
    "superseded",
  );
  assert.equal(
    (
      await call("/api/conversations/" + id, first, {
        action: "decision",
        revision: 1,
        digest: oldDigest,
        decision: "approve",
      })
    ).status,
    409,
  );
  assert.equal(
    (await call("/api/conversations/" + id, first, a, admission)).status,
    200,
  );
  assert.equal(
    (
      await call(
        "/api/conversations/" + id,
        first,
        { ...a, text: "Conflicting reused message identity" },
        admission,
      )
    ).status,
    409,
  );
  checks.push(
    "concurrent follow-ups receive ordered unique sequence numbers",
    "new message immediately supersedes a previously approved queued save",
    "duplicate messages deduplicate and conflicting reuse is rejected",
  );
  const v3 = await waitFor(
    id,
    secondDevice,
    (d) =>
      d.conversation.processed_sequence === 3 && !d.conversation.worker_run_id,
    "ordered follow-ups",
  );
  assert.equal(v3.turns.length, 3);
  assert.equal(v3.revisions.length, 3);
  const execution = v3.events
    .filter((event: any) => event.kind === "turn_started")
    .map((event: any) => event.detail.sequence);
  assert.deepEqual(execution, [1, 2, 3]);
  for (const phrase of [
    /CONTROL:\s*MAPLE42/,
    /OWNER:\s*RIVER/,
    /REVIEW:\s*MONDAY/,
  ])
    assert.match(v3.artifact.markdown, phrase);
  assert.match(v3.artifact.markdown, /7/);
  assert.match(v3.artifact.markdown, /November\s+12,?\s+2026/i);
  assert.equal(
    v3.approvals.find((item: any) => item.revision === 2).state,
    "superseded",
  );
  assert.equal(
    v3.approvals.find((item: any) => item.revision === 3).state,
    "pending",
  );
  assert.equal(
    v3.revisions.find((item: any) => item.revision === 1).state,
    "draft",
  );
  assert.equal(
    v3.actions.some(
      (item: any) =>
        item.sequence === 1 && item.kind === "save_approved_artifact",
    ),
    false,
  );
  const snapshots = (
    await pool.query(
      "SELECT sequence,context_snapshot FROM conversation_turns WHERE conversation_id=$1 ORDER BY sequence",
      [id],
    )
  ).rows;
  for (const row of snapshots) {
    assert.equal(row.context_snapshot.userInstructions.length, row.sequence);
    assert.ok(
      row.context_snapshot.userInstructions.every(
        (message: any) => message.sequence <= row.sequence,
      ),
    );
  }
  checks.push(
    "one active model turn per conversation",
    "context snapshots exclude messages from future turns",
    "follow-ups preserve independently specified literal facts",
    "superseded save cannot execute",
  );
  const decision = {
    action: "decision",
    revision: 3,
    digest: v3.artifact.digest,
    decision: "approve",
  };
  const decisions = await Promise.all([
    call("/api/conversations/" + id, first, decision),
    call("/api/conversations/" + id, secondDevice, decision),
  ]);
  assert.deepEqual(
    decisions.map((response) => response.status),
    [200, 200],
  );
  const saved = await waitFor(
    id,
    first,
    (d) =>
      d.events.some(
        (event: any) =>
          event.kind === "save_completed" && event.detail.revision === 3,
      ),
    "interrupted save recovery",
  );
  assert.equal(saved.artifact.state, "saved");
  assert.equal(
    saved.actions.find(
      (a: any) => a.sequence === 3 && a.kind === "save_approved_artifact",
    ).attempts,
    2,
  );
  assert.equal(
    saved.events.filter(
      (event: any) =>
        event.kind === "artifact_saved" && event.detail.revision === 3,
    ).length,
    1,
  );
  assert.equal(
    saved.events.filter(
      (event: any) =>
        event.kind === "test_interruption" && event.detail.revision === 3,
    ).length,
    1,
  );
  assert.equal(
    (
      await call("/api/conversations/" + id, first, {
        ...decision,
        decision: "reject",
      })
    ).status,
    409,
  );
  assert.equal(
    await (
      await call("/api/conversations/" + id + "/revisions/3", secondDevice)
    ).text(),
    v3.artifact.markdown,
  );
  checks.push(
    "duplicate approvals start one effective save",
    "interruption after committed save recovers with two attempts and one saved revision",
    "conflicting decisions refused",
    "artifact download matches immutable approved content",
  );
  const question = {
    action: "message",
    messageId: randomUUID(),
    text: "What is the original CONTROL phrase I asked you to preserve? Reply with only that phrase; do not create or revise an artifact.",
  };
  assert.equal(
    (await call("/api/conversations/" + id, secondDevice, question, admission))
      .status,
    201,
  );
  const answered = await waitFor(
    id,
    first,
    (d) =>
      d.conversation.processed_sequence === 4 && !d.conversation.worker_run_id,
    "follow-up question",
  );
  assert.equal(answered.revisions.length, 3);
  assert.match(
    answered.messages.find(
      (m: any) => m.sequence === 4 && m.role === "assistant",
    ).content,
    /CONTROL:\s*MAPLE42/,
  );
  assert.equal(
    answered.revisions.find((item: any) => item.revision === 3).digest,
    v3.artifact.digest,
  );
  checks.push(
    "conversation continues after an approved save",
    "follow-up question uses persisted context without creating an artifact",
    "saved history remains immutable",
  );
  const revise = {
    action: "message",
    messageId: randomUUID(),
    text: "Create one more artifact revision. Add the exact phrase FORMAT: CHECKLIST and preserve the prior CONTROL, OWNER, REVIEW phrases and original source facts.",
  };
  assert.equal(
    (await call("/api/conversations/" + id, first, revise, admission)).status,
    201,
  );
  const v5 = await waitFor(
    id,
    secondDevice,
    (d) =>
      d.conversation.processed_sequence === 5 && !d.conversation.worker_run_id,
    "new revision after reply",
  );
  assert.equal(v5.artifact.revision, 5);
  assert.match(v5.artifact.markdown, /FORMAT:\s*CHECKLIST/);
  assert.equal(
    (
      await call("/api/conversations/" + id, secondDevice, {
        action: "decision",
        revision: 5,
        digest: v5.artifact.digest,
        decision: "reject",
      })
    ).status,
    200,
  );
  assert.equal(
    (await detail(id, first)).approvals.find((item: any) => item.revision === 5)
      .state,
    "rejected",
  );
  assert.equal(
    (await call("/api/conversations/" + id, first, { action: "cancel" }))
      .status,
    200,
  );
  assert.equal(
    (
      await call(
        "/api/conversations/" + id,
        first,
        { action: "message", messageId: randomUUID(), text: "Continue" },
        admission,
      )
    ).status,
    409,
  );
  checks.push(
    "rejected version is not saved",
    "cancellation revokes subsequent execution",
  );
  const next = {
    id: randomUUID(),
    messageId: randomUUID(),
    source: "Separate source.",
    text: "Reply with exactly SECONDTHREAD. Do not create an artifact.",
  };
  assert.equal(
    (await call("/api/conversations", first, next, admission)).status,
    201,
  );
  const second = await waitFor(
    next.id,
    first,
    (d) =>
      d.conversation.processed_sequence === 1 && !d.conversation.worker_run_id,
    "separate conversation",
  );
  assert.equal(second.conversation.agent_id, v1.conversation.agent_id);
  assert.equal(second.revisions.length, 0);
  assert.equal(second.turns.length, 1);
  assert.equal(
    second.messages.some((m: any) => m.content.includes("MAPLE42")),
    false,
  );
  checks.push(
    "persistent agent identity spans independent conversations",
    "conversation context does not leak between threads",
  );
  evidence.conversationId = id;
  evidence.independentConversationId = next.id;
  evidence.model = saved.turns[0].model;
  evidence.acceptedMessageOrder = accepted;
  evidence.revisions = v5.revisions.map(({ revision, digest, state }: any) => ({
    revision,
    digest,
    state,
  }));
  evidence.recovery = { revision: 3, saveAttempts: 2, savedEvents: 1 };
  if (process.env.AGENT_EVIDENCE_PATH)
    await writeFile(
      process.env.AGENT_EVIDENCE_PATH,
      JSON.stringify(evidence, null, 2) + "\n",
    );
  console.log(
    "PASS: persistent conversations, ordered follow-ups, exact version approvals and recovery.",
  );
  console.log(JSON.stringify(evidence, null, 2));
} finally {
  await pool.end();
}
