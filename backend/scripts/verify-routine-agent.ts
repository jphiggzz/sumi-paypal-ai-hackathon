import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import { writeFile } from "node:fs/promises";
import { Pool } from "pg";
import { betterAuth } from "better-auth";
const base = new URL(process.argv[2] || "http://localhost:3000");
const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 1 });
const headers = {
  Origin: base.origin,
  "Content-Type": "application/json",
  "x-demo-code": process.env.SUME_DEMO_CODE ?? "",
};
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
const checks: string[] = [];
async function wait(
  read: () => Promise<any>,
  ready: (v: any) => boolean,
  label: string,
) {
  for (let i = 0; i < 240; i++) {
    const v = await read();
    if (ready(v)) return v;
    await delay(1000);
  }
  throw new Error("Timed out: " + label);
}
try {
  const fixture = await auth.api.signUpEmail({
    body: {
      email: `timer-agent-verifier-${randomUUID()}@example.invalid`,
      password: randomUUID() + randomUUID(),
      name: "Timed agent verifier",
    },
    headers: new Headers(headers),
    asResponse: true,
  });
  assert.equal(fixture.status, 200);
  const cookie = fixture.headers
    .getSetCookie()
    .filter((v) => v.split("=")[0].includes("session_token"))
    .map((v) => v.split(";")[0])
    .join("; ");
  async function post(path: string, body: unknown, status = 200) {
    const r = await fetch(new URL(path, base), {
      method: "POST",
      headers: { ...headers, Cookie: cookie },
      body: JSON.stringify(body),
    });
    assert.equal(r.status, status, await r.clone().text());
    return r.json();
  }
  const id = randomUUID(),
    path = "/api/conversations/" + id;
  await post(
    "/api/conversations",
    {
      id,
      messageId: randomUUID(),
      text: "Record a checkpoint.",
      source: "TIMER73. Eleven workers. Review November 12, 2026.",
      executionMode: "checkpoint",
      dispatchRecoveryTest: true,
    },
    201,
  );
  await wait(
    async () =>
      (
        await pool.query(
          "SELECT status FROM conversation_turns WHERE conversation_id=$1 AND sequence=1",
          [id],
        )
      ).rows[0],
    (v) => v?.status === "completed",
    "initial checkpoint",
  );
  const routineId = randomUUID(),
    dueAt = new Date(Date.now() + 7000).toISOString();
  await post(
    path + "/routines",
    {
      action: "create",
      id: routineId,
      instruction:
        "Create a Markdown artifact titled Timer proof. Include exactly TIMER73, eleven workers, and November 12, 2026. Keep it under 100 words.",
      executionMode: "assistant",
      dueAt,
      timezone: "America/New_York",
      intervalSeconds: null,
      maxRuns: 1,
      expiresAt: new Date(Date.now() + 300000).toISOString(),
    },
    201,
  );
  // Observe only SQL: no app requests or connected browser after scheduling.
  const output = await wait(
    async () =>
      (
        await pool.query(
          "SELECT t.*,r.digest,r.markdown FROM routine_occurrences o JOIN conversation_turns t ON t.occurrence_id=o.id LEFT JOIN conversation_revisions r ON r.conversation_id=t.conversation_id AND r.revision=t.sequence WHERE o.routine_id=$1",
          [routineId],
        )
      ).rows[0],
    (v) => v?.status === "completed" && !!v.digest,
    "timer to live model to draft",
  );
  assert.equal(output.model, "amazon/nova-micro");
  assert.match(output.markdown, /TIMER73/);
  assert.match(output.markdown, /eleven|11/i);
  assert.match(output.markdown, /November\s+12,?\s+2026/i);
  checks.push(
    "durable timer starts a live Nova Micro turn without client polling",
    "scheduled model output preserves independent source facts",
    "scheduled draft remains unsaved pending exact human approval",
  );
  const draft = (
    await pool.query(
      "SELECT state FROM conversation_revisions WHERE conversation_id=$1 AND revision=$2",
      [id, output.sequence],
    )
  ).rows[0];
  assert.equal(draft.state, "draft");
  // Explicit fixture-only failure injection using the same marker as the UI's
  // save-recovery checkbox. It does not change approval or execution authority.
  await pool.query(
    "UPDATE conversation_turns SET recovery_test=true WHERE conversation_id=$1 AND sequence=$2",
    [id, output.sequence],
  );
  await post(path, {
    action: "decision",
    decision: "approve",
    revision: output.sequence,
    digest: output.digest,
    dispatchRecoveryTest: true,
  });
  await wait(
    async () =>
      (
        await pool.query(
          "SELECT 1 FROM conversation_events WHERE conversation_id=$1 AND kind='save_completed' AND detail->>'revision'=$2",
          [id, String(output.sequence)],
        )
      ).rowCount,
    (v) => v === 1,
    "approved save recovery",
  );
  const action = (
    await pool.query(
      "SELECT attempts FROM conversation_actions WHERE conversation_id=$1 AND sequence=$2 AND kind='save_approved_artifact'",
      [id, output.sequence],
    )
  ).rows[0];
  assert.equal(action.attempts, 2);
  const events = (
    await pool.query(
      "SELECT count(*) FROM conversation_events WHERE conversation_id=$1 AND kind='artifact_saved'",
      [id],
    )
  ).rows[0].count;
  assert.equal(events, "1");
  checks.push(
    "exact approval dispatches automatically after a foreground dispatch gap",
    "save interruption recovers to one effective save",
  );
  const usage = (
    await pool.query(
      "SELECT detail FROM conversation_events WHERE conversation_id=$1 AND kind='model_usage'",
      [id],
    )
  ).rows.map((x) => x.detail);
  const record = {
    completedAt: new Date().toISOString(),
    target: base.origin,
    conversationId: id,
    routineId,
    dueAt,
    checks,
    model: output.model,
    usage,
    estimatedInferenceUsd: usage.reduce((sum, x) => sum + x.estimatedUsd, 0),
    note: "Provider token-price estimate, not an invoice. All other lifecycle checks use real model-free checkpoints. No PayPal operation.",
  };
  if (process.env.AGENT_EVIDENCE_PATH)
    await writeFile(
      process.env.AGENT_EVIDENCE_PATH,
      JSON.stringify(record, null, 2) + "\n",
    );
  console.log(JSON.stringify(record, null, 2));
} finally {
  await pool.end();
}
