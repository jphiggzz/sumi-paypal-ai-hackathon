import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { writeFile } from "node:fs/promises";
import { betterAuth } from "better-auth";
import { authPool } from "../lib/auth";
const base = process.env.WORKSPACE_VERIFY_URL || "http://localhost:3016";
if (!/^http:\/\/localhost:\d+$/.test(base)) throw new Error("Local only");
const auth = betterAuth({
  secret: process.env.BETTER_AUTH_SECRET,
  baseURL: base,
  database: authPool,
  user: { modelName: "auth_users" },
  session: { modelName: "auth_sessions" },
  account: { modelName: "auth_accounts" },
  verification: { modelName: "auth_verifications" },
  emailAndPassword: { enabled: true },
});
const users: { id: string; cookie: string }[] = [];
const checks: string[] = [];
async function account(name: string) {
  const r = await auth.api.signUpEmail({
    body: {
      email: `workspace-${randomUUID()}@example.invalid`,
      name,
      password: randomUUID() + randomUUID(),
    },
    asResponse: true,
  });
  assert.equal(r.status, 200);
  const u = (await r.json()).user;
  const a = {
    id: u.id,
    cookie: r.headers
      .getSetCookie()
      .filter((c) => c.split("=")[0].includes("session_token"))
      .map((c) => c.split(";")[0])
      .join("; "),
  };
  users.push(a);
  return a;
}
async function call(
  a: (typeof users)[number] | null,
  path = "",
  body?: unknown,
  extra: Record<string, string> = {},
) {
  return fetch(base + "/api/workspace-chat" + path, {
    method: body ? "POST" : "GET",
    headers: {
      Origin: base,
      "Content-Type": "application/json",
      ...(a ? { Cookie: a.cookie } : {}),
      ...extra,
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
}
const keep = process.argv.includes("--keep");
try {
  const a = await account("Workspace Review"),
    b = await account("Other Owner"),
    id = randomUUID();
  assert.equal((await call(null)).status, 401);
  let r = await call(a, "", { action: "create", id, mode: "shopping" });
  assert.equal(r.status, 200);
  let state = await r.json();
  assert.equal((await call(b, "?conversationId=" + id)).status, 404);
  assert.equal(
    (await call(b, "", { action: "mode", id, mode: "creators", revision: 0 }))
      .status,
    409,
  );
  assert.equal(
    (
      await call(
        a,
        "",
        { action: "mode", id, mode: "creators", revision: 0 },
        { Origin: "https://evil.example" },
      )
    ).status,
    403,
  );
  checks.push(
    "Authentication, owner isolation and cross-origin mutation protection",
  );
  r = await call(a, "", {
    action: "mode",
    id,
    mode: "creators",
    revision: state.chat.revision,
  });
  state = await r.json();
  assert.equal(state.chat.mode, "creators");
  const turn = {
    conversationId: id,
    requestId: randomUUID(),
    messageId: randomUUID(),
    text: "Give three practical tips for choosing a thoughtful thank-you gift. Do not prepare or run any workflow or tool.",
    mode: "shopping",
    revision: state.chat.revision,
  };
  assert.equal((await call(a, "/stream", turn)).status, 403);
  r = await call(a, "/stream", turn, {
    "x-demo-code": process.env.SUME_DEMO_CODE || "",
  });
  assert.equal(r.status, 200);
  assert.match(r.headers.get("content-type") || "", /event-stream/);
  const duplicate = await call(a, "/stream", turn, {
    "x-demo-code": process.env.SUME_DEMO_CODE || "",
  });
  assert.equal(duplicate.status, 409);
  const chunks: string[] = [];
  const reader = r.body!.getReader();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(new TextDecoder().decode(value));
  }
  const raw = chunks.join("");
  assert.match(raw, /text-delta/);
  assert.ok((raw.match(/text-delta/g) || []).length > 1);
  assert.ok(!raw.includes("errorText"), raw.slice(-500));
  state = await (await call(a, "?conversationId=" + id)).json();
  assert.equal(state.messages.length, 2);
  assert.equal(state.messages[1].status, "completed");
  assert.ok(state.messages[1].content.length > 10);
  assert.equal(state.chat.mode, "shopping");
  checks.push(
    "Real Gateway streamed token deltas, completed reply persistence, duplicate request blocked",
  );
  const before = state.messages;
  state = await (
    await call(a, "", {
      action: "mode",
      id,
      mode: "creators",
      revision: state.chat.revision,
    })
  ).json();
  assert.deepEqual(state.messages, before);
  checks.push("Mode changes preserve saved history");
  // Exercise stop and expired lease without buying another model turn.
  const stopId = randomUUID();
  await authPool.query(
    "INSERT INTO workspace_chat_messages(id,conversation_id,role,content,mode,parent_id,status,lease_until) VALUES($1,$2,'assistant','Partial reply','creators',$3,'streaming',now()+interval '60 seconds')",
    [stopId, id, turn.messageId],
  );
  assert.equal(
    (await call(b, "", { action: "stop", id, messageId: stopId })).status,
    404,
  );
  state = await (
    await call(a, "", { action: "stop", id, messageId: stopId })
  ).json();
  assert.equal(state.messages.at(-1).status, "interrupted");
  const expired = randomUUID();
  await authPool.query(
    "INSERT INTO workspace_chat_messages(id,conversation_id,role,content,mode,status,lease_until) VALUES($1,$2,'assistant','Expired partial','creators','streaming',now()-interval '1 second')",
    [expired, id],
  );
  state = await (await call(a, "?conversationId=" + id)).json();
  assert.equal(state.messages.at(-1).status, "interrupted");
  checks.push(
    "Owned stop and stale stream reconciliation; partial content retained without regeneration",
  );
  await authPool.query(
    "DELETE FROM workspace_chat_messages WHERE id=ANY($1::uuid[])",
    [[stopId, expired]],
  );
  if (keep) {
    const [name, ...v] = a.cookie.split("=");
    await writeFile(
      "/tmp/workspace-browser-state.json",
      JSON.stringify({
        cookies: [
          {
            name,
            value: v.join("="),
            domain: "localhost",
            path: "/",
            httpOnly: true,
            secure: false,
            sameSite: "Lax",
            expires: Date.now() / 1000 + 3600,
          },
        ],
        origins: [],
      }),
      { mode: 0o600 },
    );
    await writeFile(
      "/tmp/workspace-test-users.json",
      JSON.stringify(users.map((u) => u.id)),
      { mode: 0o600 },
    );
    await writeFile("/tmp/workspace-test-chat.txt", id, { mode: 0o600 });
  }
  await writeFile(
    "../research/unified-workspace-verification-2026-11-10.json",
    JSON.stringify(
      {
        date: "2026-11-10",
        checks,
        liveModel: "amazon/nova-micro",
        limits: [
          "Synthetic accounts and gift brief",
          "Conversational assistance only; no commerce tools",
          "Stop and lease fixtures are labeled test inserts",
        ],
      },
      null,
      2,
    ) + "\n",
  );
  console.log(JSON.stringify({ passed: checks.length, checks }));
} finally {
  if (!keep)
    for (const u of users)
      await authPool.query("DELETE FROM auth_users WHERE id=$1", [u.id]);
  await authPool.end();
}
