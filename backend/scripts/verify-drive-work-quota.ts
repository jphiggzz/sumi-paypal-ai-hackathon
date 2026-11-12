/** Current attended Drive development connection: verify the new tool respects
 * its already-exhausted day allowance. Reuses owner's existing app session;
 * never creates provider consent or resets a quota. No model/Google calls. */
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { writeFile } from "node:fs/promises";
import { setTimeout as delay } from "node:timers/promises";
import { serializeSignedCookie } from "better-call";
import { Pool } from "pg";
const base = "https://sume-agent-foundation.vercel.app",
  pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 2 });
try {
  const connection = (
    await pool.query(
      "SELECT * FROM agent_connections WHERE id=$1 AND provider='google' AND status='connected'",
      ["a775b25c-cf80-413b-91c0-61ecd3eaa68d"],
    )
  ).rows[0];
  assert.ok(connection);
  const source = (
    await pool.query(
      "SELECT id,version FROM source_records WHERE owner_id=$1 AND title='agent-work-left.txt' AND kind='upload' AND deleted_at IS NULL ORDER BY fetched_at DESC LIMIT 1",
      [connection.owner_id],
    )
  ).rows[0];
  assert.ok(source);
  const session = (
    await pool.query(
      'SELECT token FROM auth_sessions WHERE "userId"=$1 AND "expiresAt">now() ORDER BY "createdAt" DESC LIMIT 1',
      [connection.owner_id],
    )
  ).rows[0];
  assert.ok(session);
  const cookie = (
    await serializeSignedCookie(
      "__Secure-better-auth.session_token",
      session.token,
      process.env.BETTER_AUTH_SECRET!,
      { secure: true, path: "/", httpOnly: true, sameSite: "lax" },
    )
  ).split(";")[0];
  const before = (
    await pool.query(
      "SELECT requests,bytes FROM connector_usage WHERE budget_key=$1 AND day=(now() AT TIME ZONE 'UTC')::date",
      ["connection:" + connection.id],
    )
  ).rows[0];
  assert.equal(before.requests, 60);
  const id = randomUUID(),
    workId = randomUUID();
  const response = await fetch(base + "/api/conversations", {
    method: "POST",
    headers: {
      Origin: base,
      "Content-Type": "application/json",
      Cookie: cookie,
      "x-demo-code": process.env.SUME_DEMO_CODE!,
    },
    body: JSON.stringify({
      id,
      messageId: workId,
      text: "Verify the selected development Drive source is blocked by its existing read allowance.",
      source: "Synthetic verification only; no new Google grant.",
      executionMode: "capability_check",
      capabilityRequest: {
        tool: "refresh_connected_source",
        input: { sourceIndex: 0 },
      },
      work: {
        sources: [
          {
            kind: "connection",
            connectionId: connection.id,
            expectedVersion: connection.version,
            resourceId: connection.resource_ids[0],
          },
          { kind: "source", id: source.id, version: source.version },
        ],
        fields: ["Service count"],
        maxModelCalls: 0,
      },
    }),
  });
  assert.equal(response.status, 201);
  let task: any;
  for (let i = 0; i < 90; i++) {
    task = (
      await pool.query(
        "SELECT state,error_code,model_calls FROM agent_work WHERE id=$1",
        [workId],
      )
    ).rows[0];
    if (task?.state === "budget_exhausted") break;
    await delay(1000);
  }
  assert.equal(task.state, "budget_exhausted");
  assert.equal(task.model_calls, 0);
  assert.equal(task.error_code, "CONNECTOR_BUDGET_EXHAUSTED");
  const orphanLeases = (
    await pool.query(
      "SELECT 1 FROM agent_source_leases WHERE owner_id=$1 AND connection_id=$2 AND expires_at>now()",
      [connection.owner_id, connection.id],
    )
  ).rowCount;
  assert.equal(
    orphanLeases,
    0,
    "Known failed admission must not leave a pending refresh lease",
  );
  const after = (
    await pool.query(
      "SELECT requests,bytes FROM connector_usage WHERE budget_key=$1 AND day=(now() AT TIME ZONE 'UTC')::date",
      ["connection:" + connection.id],
    )
  ).rows[0];
  assert.deepEqual(after, before);
  const credential = (
    await pool.query("SELECT 1 FROM drive_credentials WHERE connection_id=$1", [
      connection.id,
    ])
  ).rowCount;
  assert.equal(credential, 1);
  await writeFile(
    "../research/agent-work-real-drive-quota-verification-2026-11-09.json",
    JSON.stringify(
      {
        status: "passed",
        target: base,
        workId,
        conversationId: id,
        connectionId: connection.id,
        checks: [
          "New registered refresh tool authorizes the actual selected Google connection",
          "Existing exhausted connector budget yields typed budget_exhausted and exact error code",
          "Known failed admission clears its pending lease instead of blocking another task",
          "No extra provider reservation, model call, quota reset or credential deletion",
        ],
        before,
        after,
        providerReadBoundary:
          "Google consent/read/refresh previously verified separately; this run deliberately stops before a Google call because the development allowance remains exhausted.",
        authentication:
          "Existing attended owner app session reused by privileged local verification; no provider grant fabricated.",
      },
      null,
      2,
    ) + "\n",
  );
  console.log(
    JSON.stringify({
      status: "passed",
      state: task.state,
      modelCalls: 0,
      quotaUnchanged: true,
    }),
  );
} finally {
  await pool.end();
}
