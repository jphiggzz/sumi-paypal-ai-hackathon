import { randomUUID } from "node:crypto";
import { readFile, writeFile, rm } from "node:fs/promises";
import { betterAuth } from "better-auth";
import { authPool } from "../lib/auth";
import { giftPayPal } from "../lib/gift-paypal";
const base = "http://localhost:3000",
  file = "/tmp/connected-recording-personas.json";
const action = process.argv[2];
async function request(a: any, path: string, body?: unknown) {
  const r = await fetch(base + path, {
    method: body ? "POST" : "GET",
    headers: {
      Origin: base,
      Cookie: a.cookie,
      "Content-Type": "application/json",
      "x-demo-code": process.env.SUME_DEMO_CODE || "",
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  const v = await r.json();
  if (!r.ok) throw Error(JSON.stringify(v));
  return v;
}
async function state() {
  return JSON.parse(await readFile(file, "utf8"));
}
async function flow(a: any, command?: unknown) {
  return request(
    a,
    "/api/workspace-chat/workflows" +
      (command ? "" : "?conversationId=" + a.conversation),
    command ? { conversationId: a.conversation, command } : undefined,
  );
}
try {
  if (action === "setup") {
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
    const people = [];
    for (const name of ["Alex", "Casey", "Jordan"]) {
      const r = await auth.api.signUpEmail({
        body: {
          email: `record-connected-${randomUUID()}@example.invalid`,
          name,
          password: randomUUID() + randomUUID(),
        },
        asResponse: true,
      });
      if (!r.ok) throw Error("Recording persona failed");
      const { user } = await r.json();
      people.push({
        id: user.id,
        name,
        cookie: r.headers
          .getSetCookie()
          .filter((c) => c.split("=")[0].includes("session_token"))
          .map((c) => c.split(";")[0])
          .join("; "),
        conversation: null,
      });
    }
    await writeFile(file, JSON.stringify(people), { mode: 0o600 });
    const [name, ...value] = people[0].cookie.split("=");
    await writeFile(
      "/tmp/connected-recording-browser.json",
      JSON.stringify({
        cookies: [
          {
            name,
            value: value.join("="),
            domain: "localhost",
            path: "/",
            httpOnly: true,
            secure: false,
            sameSite: "Lax",
            expires: Date.now() / 1000 + 3600,
          },
        ],
        origins: [
          {
            origin: base,
            localStorage: [
              {
                name: "recording-admission",
                value: process.env.SUME_DEMO_CODE || "",
              },
            ],
          },
        ],
      }),
      { mode: 0o600 },
    );
    console.log("Three isolated recording personas ready.");
  } else if (action === "friends") {
    const people = await state();
    const alex = people[0];
    const l = (
      await authPool.query(
        "SELECT c.id FROM workspace_chats c JOIN workspace_workflow_links l ON l.conversation_id=c.id WHERE c.owner_id=$1 AND l.kind='gift' ORDER BY l.created_at DESC LIMIT 1",
        [alex.id],
      )
    ).rows[0];
    alex.conversation = l.id;
    const raw = await readFile("/tmp/connected-recording-invite.txt", "utf8");
    const match = raw.match(/https?:\/\/localhost:3000\/workspace\?[^\s"']+/);
    if (!match) throw Error("Invitation not captured");
    const token = new URL(match[0]).searchParams.get("giftInvite");
    for (const [i, a] of people.slice(1).entries()) {
      a.conversation = randomUUID();
      await request(a, "/api/workspace-chat", {
        action: "create",
        id: a.conversation,
        mode: "shopping",
      });
      await flow(a, { action: "join_gift", token });
      await flow(a, {
        action: "gift",
        payload: { action: "limit", cents: [3000, 2000][i] },
      });
      const message = randomUUID();
      const text =
        i === 0
          ? "Sam bought watercolor paints last week. Good watercolor paper or brushes would complement them. Avoid more paints."
          : "Sam has plenty of mugs. I would like a useful, compact creative gift such as artist brushes. Avoid bulky items.";
      await authPool.query(
        "INSERT INTO workspace_chat_messages(id,conversation_id,role,content,mode,status) VALUES($1,$2,'user',$3,'shopping','completed')",
        [message, a.conversation, text],
      );
      await flow(a, {
        action: "share_context",
        messageId: message,
        active: true,
      });
    }
    await writeFile(file, JSON.stringify(people), { mode: 0o600 });
    console.log(
      "Two synthetic friends joined and explicitly shared their sample context.",
    );
  } else if (action === "approve-friends") {
    const people = await state();
    const g = (await flow(people[0])).flows.find(
      (f: any) => f.kind === "gift",
    ).state;
    if (!g.option) throw Error("Select a gift first");
    for (const a of people.slice(1))
      await flow(a, {
        action: "gift",
        payload: { action: "approve", digest: g.option.digest },
      });
    console.log("Other synthetic friends approved the selected exact plan.");
  } else if (action === "approve-test-card") {
    const people = await state();
    const g = (await flow(people[0])).flows.find(
      (f: any) => f.kind === "gift",
    ).state;
    const p = g.payments.find((p: any) => p.status === "created");
    if (!p) throw Error("Create a Sandbox contribution first");
    const r = await giftPayPal(
      `/v2/checkout/orders/${p.order_id}/confirm-payment-source`,
      "POST",
      {
        payment_source: {
          card: {
            number: "4005519200000004",
            expiry: "2030-12",
            security_code: "123",
            name: "Sandbox Preview Test",
          },
        },
      },
      "preview-" + p.id,
    );
    if (!r.ok) throw Error("Sandbox card approval failed");
    console.log(
      "PayPal Sandbox test card approved via API; capture still requires the UI action.",
    );
  } else if (action === "cleanup") {
    const people = await state(),
      ids = people.map((a: any) => a.id);
    await authPool.query(
      "DELETE FROM campaigns WHERE id IN (SELECT l.resource_id FROM workspace_workflow_links l JOIN workspace_chats c ON c.id=l.conversation_id WHERE c.owner_id=ANY($1::text[]) AND l.kind='campaign')",
      [ids],
    );
    await authPool.query(
      "DELETE FROM auth_users u USING gift_members m,gift_groups g WHERE u.id=m.user_id AND m.group_id=g.id AND g.owner_id=ANY($1::text[]) AND m.simulated AND u.email LIKE 'gift-simulated-%@example.invalid'",
      [ids],
    );
    for (const id of ids)
      await authPool.query(
        "DELETE FROM auth_users WHERE id=$1 AND email LIKE 'record-connected-%@example.invalid'",
        [id],
      );
    for (const p of [
      file,
      "/tmp/connected-recording-browser.json",
      "/tmp/connected-recording-invite.txt",
    ])
      await rm(p, { force: true });
    console.log("Removed recording personas and private session state.");
  }
} finally {
  await authPool.end();
}
