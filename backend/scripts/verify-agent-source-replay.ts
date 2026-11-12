/** Explicit SQL fixture for interruption after an owned refresh lease/reservation
 * commits, before provider admission. Real hosted recovery and fixture HTTP read. */
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { writeFile } from "node:fs/promises";
import { setTimeout as delay } from "node:timers/promises";
import { Pool } from "pg";
import { betterAuth } from "better-auth";
import { chargeWork, workUuid } from "../lib/work-store";
import { authPool } from "../lib/auth";
const base = "https://sume-agent-foundation.vercel.app",
  pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 2 });
const auth = betterAuth({
  secret: process.env.BETTER_AUTH_SECRET,
  baseURL: base,
  database: pool,
  user: { modelName: "auth_users" },
  session: { modelName: "auth_sessions" },
  account: { modelName: "auth_accounts" },
  verification: { modelName: "auth_verifications" },
  emailAndPassword: { enabled: true },
});
try {
  const signup = await auth.api.signUpEmail({
    body: {
      email: `source-replay-${randomUUID()}@example.invalid`,
      password: randomUUID() + randomUUID(),
      name: "Source replay verifier",
    },
    asResponse: true,
  });
  assert.equal(signup.status, 200);
  const owner = (await signup.json()).user.id;
  const cookie = signup.headers
    .getSetCookie()
    .filter((c) => c.split("=")[0].includes("session_token"))
    .map((c) => c.split(";")[0])
    .join("; ");
  async function post(path: string, body: unknown, status = 201) {
    const r = await fetch(base + path, {
      method: "POST",
      headers: {
        Origin: base,
        "Content-Type": "application/json",
        Cookie: cookie,
        "x-demo-code": process.env.SUME_DEMO_CODE!,
      },
      body: JSON.stringify(body),
    });
    const result = await r.json();
    assert.equal(r.status, status);
    return result;
  }
  const connection = (
    await post("/api/connections", {
      provider: "fixture",
      scopes: ["documents:read"],
      resourceIds: ["doc-alpha"],
    })
  ).connection;
  const sourceId = randomUUID();
  await post("/api/documents", {
    requestId: randomUUID(),
    sourceId,
    expectedVersion: 0,
    filename: "source-replay.txt",
    content: "Service count: 7\n",
  });
  const conversationId = randomUUID(),
    workId = randomUUID(),
    refreshId = workUuid(`source:${conversationId}:1:check:tool`);
  await post("/api/conversations", {
    id: conversationId,
    messageId: workId,
    source: "Source lease replay fixture.",
    text: "Resolve the selected connected source.",
    executionMode: "capability_check",
    capabilityRequest: {
      tool: "refresh_connected_source",
      input: { sourceIndex: 0 },
    },
    dispatchRecoveryTest: true,
    work: {
      sources: [
        {
          kind: "connection",
          connectionId: connection.id,
          expectedVersion: connection.version,
          resourceId: "doc-alpha",
        },
        { kind: "source", id: sourceId, version: 1 },
      ],
      fields: ["Service count"],
      maxModelCalls: 0,
    },
  });
  const c = await pool.connect();
  try {
    await c.query("BEGIN");
    const work = (
      await c.query("SELECT * FROM agent_work WHERE id=$1 FOR UPDATE", [workId])
    ).rows[0];
    await chargeWork(c, work, "provider", 12, `refresh:${refreshId}:calls`);
    await chargeWork(c, work, "bytes", 196608, `refresh:${refreshId}:bytes`);
    await c.query(
      "INSERT INTO agent_source_leases VALUES($1,$2,$3,'doc-alpha',$4,now()+interval '30 seconds')",
      [owner, connection.id, connection.version, refreshId],
    );
    await c.query("COMMIT");
  } catch (e) {
    await c.query("ROLLBACK");
    throw e;
  } finally {
    c.release();
  }
  let row: any;
  for (let i = 0; i < 90; i++) {
    row = (
      await pool.query(
        "SELECT w.*,t.status AS turn_state FROM agent_work w JOIN conversation_turns t ON t.work_id=w.id AND t.sequence=1 WHERE w.id=$1",
        [workId],
      )
    ).rows[0];
    if (row.turn_state === "completed" || row.turn_state === "failed") break;
    await delay(1000);
  }
  assert.equal(row.turn_state, "completed");
  assert.equal(row.resolved_sources.length, 2);
  assert.equal(row.provider_calls, 12);
  assert.equal(row.source_bytes, 196608);
  assert.equal(row.model_calls, 0);
  assert.equal(
    +(
      await pool.query("SELECT count(*) FROM source_refreshes WHERE id=$1", [
        refreshId,
      ])
    ).rows[0].count,
    1,
  );
  assert.equal(
    +(
      await pool.query(
        "SELECT count(*) FROM agent_work_source_waiters WHERE work_id=$1",
        [workId],
      )
    ).rows[0].count,
    0,
  );
  await writeFile(
    "../research/agent-work-source-replay-verification-2026-11-09.json",
    JSON.stringify(
      {
        status: "passed",
        target: base,
        workId,
        conversationId,
        refreshId,
        checks: [
          "Prearmed turn recovery starts the deliberately undispatched task",
          "Refresh recognizes its own committed lease instead of waiting on itself",
          "Provider reservation receipt is reused once",
          "One real fixture HTTP refresh resolves source; no model call or self-waiter",
        ],
        fixtureBoundary:
          "SQL inserted the owned lease and shared reservations before dispatch, simulating interruption between lease commit and provider admission. Actual hosted Workflow recovery, source admission, fixture HTTP read and publication ran normally.",
      },
      null,
      2,
    ) + "\n",
  );
  console.log(
    JSON.stringify({
      status: "passed",
      checks: 4,
      providerUnits: 12,
      modelCalls: 0,
    }),
  );
} finally {
  await pool.end();
  await authPool.end();
}
