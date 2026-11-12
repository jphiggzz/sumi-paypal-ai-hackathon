import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { writeFile } from "node:fs/promises";
import { setTimeout as delay } from "node:timers/promises";
import { betterAuth } from "better-auth";
import { authPool } from "../lib/auth";
import { giftPayPal } from "../lib/gift-paypal";
const base = process.env.WORKSPACE_VERIFY_URL || "http://localhost:3000";
if (!/^http:\/\/localhost:\d+$/.test(base))
  throw Error("Local verification only");
const sandbox = process.argv.includes("--sandbox"),
  keep = process.argv.includes("--keep");
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
const accounts: {
  id: string;
  cookie: string;
  name: string;
  conversation: string;
}[] = [];
const campaigns: string[] = [];
const checks: string[] = [];
let succeeded = false;
async function account(name: string) {
  const r = await auth.api.signUpEmail({
    body: {
      email: `workspace-flow-${randomUUID()}@example.invalid`,
      name,
      password: randomUUID() + randomUUID(),
    },
    asResponse: true,
  });
  assert.equal(r.status, 200);
  const { user } = await r.json();
  const a = {
    id: user.id,
    name,
    cookie: r.headers
      .getSetCookie()
      .filter((c) => c.split("=")[0].includes("session_token"))
      .map((c) => c.split(";")[0])
      .join("; "),
    conversation: randomUUID(),
  };
  accounts.push(a);
  const c = await request(a, "/api/workspace-chat", {
    action: "create",
    id: a.conversation,
    mode: "shopping",
  });
  assert.equal(c.status, 200);
  return a;
}
async function request(
  a: (typeof accounts)[number] | null,
  path: string,
  body?: unknown,
  origin = base,
) {
  const r = await fetch(base + path, {
    method: body ? "POST" : "GET",
    headers: {
      Origin: origin,
      "Content-Type": "application/json",
      "x-demo-code": process.env.SUME_DEMO_CODE || "",
      ...(a ? { Cookie: a.cookie } : {}),
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  const text = await r.text();
  return { status: r.status, data: text ? JSON.parse(text) : null };
}
async function flow(
  a: (typeof accounts)[number],
  command?: unknown,
  conversation = a.conversation,
) {
  const r = await request(
    a,
    "/api/workspace-chat/workflows" +
      (command ? "" : "?conversationId=" + conversation),
    command ? { conversationId: conversation, command } : undefined,
  );
  assert.equal(r.status, 200, JSON.stringify(r.data));
  return r.data;
}
async function gift(a: (typeof accounts)[number], payload: unknown) {
  return flow(a, { action: "gift", payload });
}
async function note(a: (typeof accounts)[number], content: string) {
  const id = randomUUID();
  await authPool.query(
    "INSERT INTO workspace_chat_messages(id,conversation_id,role,content,mode,status) VALUES($1,$2,'user',$3,'shopping','completed')",
    [id, a.conversation, content],
  );
  return id;
}
const groupState = (v: any) =>
  v.flows.find((f: any) => f.kind === "gift").state;
try {
  const alex = await account("Alex"),
    casey = await account("Casey"),
    jordan = await account("Jordan");
  assert.equal(
    (
      await request(
        null,
        "/api/workspace-chat/workflows?conversationId=" + alex.conversation,
      )
    ).status,
    401,
  );
  assert.equal(
    (
      await request(
        casey,
        "/api/workspace-chat/workflows?conversationId=" + alex.conversation,
      )
    ).status,
    404,
  );
  assert.equal(
    (
      await request(
        alex,
        "/api/workspace-chat/workflows",
        {
          conversationId: alex.conversation,
          command: { action: "prepare_campaign" },
        },
        "https://evil.example",
      )
    ).status,
    403,
  );
  await flow(alex, { action: "prepare_campaign" });
  let state = await flow(alex);
  const campaign = state.flows.find((f: any) => f.kind === "campaign");
  campaigns.push(campaign.resourceId);
  assert.equal(campaign.state, null);
  assert.equal(
    (
      await authPool.query("SELECT id FROM campaigns WHERE id=$1", [
        campaign.resourceId,
      ])
    ).rowCount,
    0,
  );
  assert.equal(
    (
      await request(alex, "/api/workspace-chat/workflows", {
        conversationId: alex.conversation,
        command: {
          action: "approve_campaign",
          approved: false,
          scenario: "review",
        },
      })
    ).status,
    400,
  );
  checks.push(
    "Owner isolation, authentication, cross-origin protection; preparing a campaign cannot start a payment",
  );
  await flow(alex, {
    action: "approve_campaign",
    approved: true,
    scenario: "review",
  });
  for (let i = 0; i < 100; i++) {
    state = await flow(alex);
    const c = state.flows.find((f: any) => f.kind === "campaign").state;
    if (["review", "failed", "payment_review", "paid"].includes(c.status)) {
      assert.equal(c.status, "review", JSON.stringify(c));
      assert.ok(c.event_log.counteroffer.recommendation.reason);
      assert.equal(c.batch_id, null);
      break;
    }
    if (i === 99) throw Error("Campaign review timeout");
    await delay(2000);
  }
  checks.push(
    "Actual durable campaign + Nova offer evaluation reached review with no Sandbox payout for ineligible terms",
  );
  await flow(alex, {
    action: "prepare_gift",
    recipient: "Sam",
    occasion: "Thank Sam for hosting our birthday weekend",
    reserveCents: 1000,
  });
  const invitation = await gift(alex, { action: "invite" });
  const token = invitation.result.inviteToken;
  await flow(casey, { action: "join_gift", token });
  await flow(jordan, { action: "join_gift", token });
  for (const [a, cents] of [
    [alex, 5000],
    [casey, 3000],
    [jordan, 2000],
  ] as const)
    await gift(a, { action: "limit", cents });
  const secret = await note(
    alex,
    "UNSHARED-PRIVATE-MARKER: personal detail not for the group",
  );
  const notes = [
    [
      alex,
      "Sam recently started watercolor painting. A proper artist paint set or paper would be a thoughtful thank-you.",
    ],
    [
      casey,
      "Sam likes hiking, but bought a backpack last week. Avoid another backpack.",
    ],
    [
      jordan,
      "Sam has several mugs. A creative gift would feel more thoughtful.",
    ],
  ] as const;
  for (const [a, text] of notes) {
    const id = await note(a, text);
    await flow(a, { action: "share_context", messageId: id, active: true });
  }
  state = await flow(casey);
  assert.ok(!JSON.stringify(state).includes("UNSHARED-PRIVATE-MARKER"));
  assert.ok(!JSON.stringify(state).includes(secret));
  assert.equal(groupState(state).facts.length, 3);
  assert.equal(
    (
      await request(casey, "/api/workspace-chat/workflows", {
        conversationId: casey.conversation,
        command: { action: "share_context", messageId: secret, active: true },
      })
    ).status,
    404,
  );
  checks.push(
    "Three friends joined through real invite capability in separate owned chats; private text stays private; explicit shared context only",
  );
  const planId = randomUUID();
  await gift(alex, { action: "plan", id: planId });
  let g: any;
  for (let i = 0; i < 160; i++) {
    g = groupState(await flow(alex));
    const j = g.jobs.find((j: any) => j.id === planId);
    if (j && ["ready", "failed", "cancelled"].includes(j.status)) {
      assert.equal(j.status, "ready", JSON.stringify(j));
      assert.equal(j.result.rounds.length, 3);
      assert.ok(j.result.products.length);
      assert.ok(j.result.options.length, JSON.stringify(j.result));
      break;
    }
    if (i === 159) throw Error("Gift plan timeout");
    await delay(2000);
  }
  const job = g.jobs.find((j: any) => j.id === planId),
    option = job.result.options[0];
  await gift(alex, { action: "select", jobId: planId, optionId: option.id });
  g = groupState(await flow(alex));
  const digest = g.option.digest;
  assert.equal(
    (
      await request(casey, "/api/workspace-chat/workflows", {
        conversationId: casey.conversation,
        command: {
          action: "gift",
          payload: { action: "fund", id: randomUUID(), digest, cents: 100 },
        },
      })
    ).status,
    409,
  );
  for (const a of [alex, casey, jordan])
    await gift(a, { action: "approve", digest });
  checks.push(
    "Real friend-agent delegation, Channel3 catalog results and validated gift options; exact-plan selection/approval; funding denied before approval",
  );
  const captures: string[] = [];
  if (sandbox) {
    const contribution = randomUUID();
    await gift(alex, { action: "fund", id: contribution, digest, cents: 100 });
    g = groupState(await flow(alex));
    let p = g.payments.find((p: any) => p.id === contribution);
    assert.equal(p.status, "created", JSON.stringify(p));
    const again = groupState(
      await gift(alex, {
        action: "fund",
        id: contribution,
        digest,
        cents: 100,
      }),
    );
    assert.equal(
      again.payments.find((p: any) => p.id === contribution).order_id,
      p.order_id,
    );
    const confirmation = await giftPayPal(
      `/v2/checkout/orders/${p.order_id}/confirm-payment-source`,
      "POST",
      {
        payment_source: {
          card: {
            number: "4005519200000004",
            expiry: "2030-12",
            security_code: "123",
            name: "Sandbox Workspace Test",
          },
        },
      },
      "workspace-" + contribution,
    );
    assert.ok(confirmation.ok, "Sandbox card confirmation failed");
    g = groupState(await gift(alex, { action: "capture", id: contribution }));
    p = g.payments.find((p: any) => p.id === contribution);
    assert.equal(p.status, "completed", JSON.stringify(p));
    captures.push(p.capture_id.slice(-8));
    const repeat = groupState(
      await gift(alex, { action: "capture", id: contribution }),
    );
    assert.equal(
      repeat.payments.find((p: any) => p.id === contribution).capture_id,
      p.capture_id,
    );
    assert.equal(
      (
        await request(casey, "/api/workspace-chat/workflows", {
          conversationId: casey.conversation,
          command: {
            action: "gift",
            payload: { action: "capture", id: contribution },
          },
        })
      ).status,
      404,
    );
    checks.push(
      "One actual $1 Sandbox card capture via workspace endpoint; duplicate create/capture reuse same order/receipt; cross-friend capture denied",
    );
  }
  const late = await note(
    casey,
    "Sam just bought watercolor paints. Prefer complementary paper or brushes.",
  );
  await flow(casey, { action: "share_context", messageId: late, active: true });
  assert.equal(groupState(await flow(alex)).option, null);
  assert.equal(
    (
      await request(jordan, "/api/workspace-chat/workflows", {
        conversationId: jordan.conversation,
        command: {
          action: "gift",
          payload: { action: "fund", id: randomUUID(), digest, cents: 100 },
        },
      })
    ).status,
    409,
  );
  checks.push(
    "New shared context invalidates stale approvals and funding while confirmed receipts remain",
  );
  await writeFile(
    "../research/workspace-connected-flows-verification-2026-11-10.json",
    JSON.stringify(
      {
        date: "2026-11-10",
        checks,
        products: job.result.products.map((p: any) => ({
          id: p.id,
          title: p.title,
          merchant: p.merchant,
          cents: p.cents,
        })),
        sandboxCaptureSuffixes: captures,
        limits: [
          "Synthetic friends and workspace message fixtures",
          "Creator counterpart events and forecasts remain simulated",
          "Sandbox money only; no retailer order or live payout",
          "Actual Google consent not automated",
        ],
      },
      null,
      2,
    ) + "\n",
  );
  if (keep) {
    const [name, ...parts] = alex.cookie.split("=");
    await writeFile(
      "/tmp/workspace-connected-browser.json",
      JSON.stringify({
        cookies: [
          {
            name,
            value: parts.join("="),
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
                name: "workspace-verification-code",
                value: process.env.SUME_DEMO_CODE || "",
              },
            ],
          },
        ],
      }),
      { mode: 0o600 },
    );
    await writeFile(
      "/tmp/workspace-connected-users.json",
      JSON.stringify(accounts.map((a) => a.id)),
      { mode: 0o600 },
    );
    await writeFile("/tmp/workspace-connected-chat.txt", alex.conversation, {
      mode: 0o600,
    });
  }
  succeeded = true;
  console.log(JSON.stringify({ passed: checks.length, checks }));
} finally {
  if (!keep || !succeeded) {
    for (const c of campaigns)
      await authPool.query("DELETE FROM campaigns WHERE id=$1", [c]);
    for (const a of accounts)
      await authPool.query("DELETE FROM auth_users WHERE id=$1", [a.id]);
  }
  await authPool.end();
}
