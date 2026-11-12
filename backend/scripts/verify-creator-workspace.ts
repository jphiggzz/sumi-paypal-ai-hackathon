import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { writeFile } from "node:fs/promises";
import { betterAuth } from "better-auth";
import { authPool } from "../lib/auth";
import { initialCampaign, applyAnswer } from "../lib/creator/policy";
const base = process.env.WORKSPACE_VERIFY_URL || "http://localhost:3000";
if (!/^http:\/\/localhost:\d+$/.test(base))
  throw Error("Local verification only");
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
const users: string[] = [];
let retained = false;
const keep = process.argv.includes("--keep");
async function user() {
  const r = await auth.api.signUpEmail({
    body: {
      email: `creator-test-${randomUUID()}@example.invalid`,
      name: "Campaign review",
      password: randomUUID() + randomUUID(),
    },
    asResponse: true,
  });
  assert.equal(r.status, 200);
  const b = await r.json();
  users.push(b.user.id);
  return {
    id: b.user.id,
    cid: randomUUID(),
    cookie: r.headers
      .getSetCookie()
      .filter((c) => c.split("=")[0].includes("session_token"))
      .map((c) => c.split(";")[0])
      .join("; "),
  };
}
async function req(
  u: Awaited<ReturnType<typeof user>>,
  path: string,
  body?: unknown,
) {
  const r = await fetch(base + path, {
    method: body ? "POST" : "GET",
    headers: {
      Origin: base,
      "Content-Type": "application/json",
      "x-demo-code": process.env.SUME_DEMO_CODE || "",
      Cookie: u.cookie,
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  return { status: r.status, body: await r.json() };
}
try {
  const u = await user(),
    other = await user();
  assert.equal(
    (
      await req(u, "/api/workspace-chat", {
        action: "create",
        id: u.cid,
        mode: "creators",
      })
    ).status,
    200,
  );
  const denied = await fetch(base + "/api/workspace-chat/stream", {
    method: "POST",
    headers: {
      Origin: base,
      "Content-Type": "application/json",
      Cookie: u.cookie,
    },
    body: JSON.stringify({
      conversationId: u.cid,
      requestId: randomUUID(),
      messageId: randomUUID(),
      text: "Promote PayPal",
      mode: "creators",
      revision: 0,
    }),
  });
  assert.equal(denied.status, 403, "Creator AI requires preview admission");
  const state = applyAnswer(
    initialCampaign(),
    {
      brief: {
        ...initialCampaign().brief,
        brand: "PayPal",
        audience: "developers",
        audienceDetail: "Independent app builders",
        budgetCents: 200000,
      },
      reply: "Sample test setup",
      options: [],
      sources: [],
      next: "compare",
      candidates: [
        {
          id: "api-educator",
          reason: "Sample checkout and API tutorial evidence.",
          evidenceIndexes: [0, 1],
        },
        {
          id: "deployment-builder",
          reason: "Sample deployment tutorials for independent builders.",
          evidenceIndexes: [0],
        },
      ],
    },
    "fixture",
  );
  await authPool.query(
    "INSERT INTO creator_campaigns(conversation_id,state) VALUES($1,$2)",
    [u.cid, JSON.stringify(state)],
  );
  const path = "/api/creator-campaign";
  const act = (command: object) =>
    req(u, path, { conversationId: u.cid, command });
  const draftRun = randomUUID();
  await authPool.query("INSERT INTO workspace_chat_messages(id,conversation_id,role,content,mode,status) VALUES($1,$2,'assistant','Review business','creators','completed')", [draftRun, u.cid]);
  await authPool.query("INSERT INTO creator_runs(id,conversation_id,message_id,revision,status,input,attempt) VALUES($1,$2,$1,1,'draft',$3,$1)", [draftRun, u.cid, JSON.stringify({ brief: state.brief })]);
  assert.equal((await req(u, "/api/creator-campaign/start", { runId: draftRun })).status, 409);
  assert.notEqual((await req(other, path, { conversationId: u.cid, command: { action: "approve_business", revision: 1, runId: draftRun } })).status, 200);
  assert.equal((await act({ action: "approve_business", revision: 1, runId: draftRun })).status, 200);
  assert.equal((await req(u, path + "?conversationId=" + u.cid)).body.runs.find((run: { id: string }) => run.id === draftRun).business_approved, true);
  assert.notEqual(
    (await req(other, path + "?conversationId=" + u.cid)).status,
    200,
  );
  assert.notEqual(
    (
      await req(other, path, {
        conversationId: u.cid,
        command: {
          action: "prepare",
          creatorId: "api-educator",
          revision: 1,
          delivery: "Friday",
          rightsDays: 30,
        },
      })
    ).status,
    200,
  );
  assert.equal(
    (
      await act({
        action: "prepare",
        creatorId: "made-up",
        revision: 1,
        delivery: "Friday",
        rightsDays: 30,
      })
    ).status,
    409,
  );
  const prepared = await act({
    action: "prepare",
    creatorId: "api-educator",
    revision: 1,
    delivery: "Friday",
    rightsDays: 30,
  });
  assert.equal(prepared.status, 200, JSON.stringify(prepared.body));
  const d = prepared.body.state.deals[0];
  assert.equal(
    (await act({ action: "pay", dealId: d.id, digest: d.digest, revision: 1 }))
      .status,
    409,
  );
  assert.equal(
    (
      await act({
        action: "approve",
        dealId: d.id,
        digest: "0".repeat(64),
        revision: 1,
      })
    ).status,
    409,
  );
  const approved = await act({
    action: "approve",
    dealId: d.id,
    digest: d.digest,
    revision: 1,
  });
  assert.equal(approved.status, 200);
  assert.equal(approved.body.state.deals[0].stage, "agreed");
  assert.equal(
    (
      await act({
        action: "approve",
        dealId: d.id,
        digest: d.digest,
        revision: 1,
      })
    ).body.state.deals.length,
    1,
  );
  assert.equal(
    (await act({ action: "pay", dealId: d.id, digest: d.digest, revision: 1 }))
      .status,
    409,
  );
  assert.equal(
    (
      await act({
        action: "delivery",
        dealId: d.id,
        digest: d.digest,
        revision: 1,
      })
    ).body.state.deals[0].stage,
    "delivering",
  );
  assert.equal(
    (
      await act({
        action: "complete",
        dealId: d.id,
        digest: d.digest,
        revision: 1,
      })
    ).body.state.deals[0].stage,
    "complete",
  );
  assert.equal(
    (await req(u, path + "?conversationId=" + u.cid)).body.state.deals[0].stage,
    "complete",
  );
  for (const action of ["approve", "delivery"]) {
    const repeated = await act({
      action,
      dealId: d.id,
      digest: d.digest,
      revision: 1,
    });
    assert.equal(
      repeated.body.state.deals[0].stage,
      "complete",
      "Repeated earlier action must not regress progress",
    );
  }
  assert.equal((await act({ action: "outreach_draft", revision: 1, creatorIds: ["made-up"], message: "Hello" })).status, 409);
  const draft = await act({ action: "outreach_draft", revision: 1, creatorIds: ["api-educator", "deployment-builder"], message: "Hello {{first_name}}" });
  assert.equal(draft.status, 200);
  assert.equal(draft.body.state.outreach.status, "draft");
  const sampleResponses = [{ creatorId: "api-educator", status: "connected" }, { creatorId: "deployment-builder", status: "email", reply: "Sample: interested in a tutorial." }];
  assert.equal((await act({ action: "outreach_responses", revision: 1, responses: sampleResponses })).status, 409);
  assert.equal((await act({ action: "outreach_send", revision: 1 })).body.state.outreach.status, "sent");
  assert.equal((await act({ action: "outreach_responses", revision: 1, responses: [{ creatorId: "api-educator", status: "connected" }, { creatorId: "api-educator", status: "email" }] })).status, 409);
  const responses = await act({ action: "outreach_responses", revision: 1, responses: sampleResponses });
  assert.equal(responses.body.state.outreach.responses.length, 2);
  assert.equal(responses.body.state.outreach.responses[1].reply, "Sample: interested in a tutorial.");
  assert.deepEqual((await act({ action: "outreach_responses", revision: 1, responses: sampleResponses })).body.state.outreach.responses, responses.body.state.outreach.responses);
  const split = await act({ action: "prepare", creatorId: "deployment-builder", revision: 1, delivery: "Friday", rightsDays: 30, paymentStructure: "split" });
  assert.equal(split.status, 200, JSON.stringify(split.body));
  const second = split.body.state.deals.find((entry: { creatorId: string }) => entry.creatorId === "deployment-builder");
  assert.deepEqual(second.installments.map((entry: { amountCents: number }) => entry.amountCents), [35000, 35000]);
  assert.equal((await act({ action: "pay", dealId: second.id, digest: second.digest, revision: 1, installmentId: "upfront" })).status, 409);
  assert.equal((await act({ action: "approve", dealId: second.id, digest: second.digest, revision: 1 })).status, 200);
  assert.equal((await act({ action: "pay", dealId: second.id, digest: second.digest, revision: 1, installmentId: "delivery" })).status, 409);
  if (keep) {
    await writeFile(
      "/tmp/sume-creator-browser.json",
      JSON.stringify({
        ...u,
        base,
        code: process.env.SUME_DEMO_CODE || "",
        users,
      }),
      { mode: 0o600 },
    );
    retained = true;
  }
  console.log(
    JSON.stringify({
      checks: [
        "ownership isolation",
        "business approval required before discovery",
        "creator AI admission",
        "monotonic duplicate stage actions",
        "catalog validation",
        "payment before approval rejected",
        "wrong digest rejected",
        "exact approval",
        "duplicate approval",
        "payment before delivery rejected",
        "persisted simulated completion",
        "sample outreach validation and idempotent response simulation",
        "split terms and unauthorized installment rejection",
      ],
      fixture: true,
      paymentExecuted: false,
      conversationId: keep ? u.cid : undefined,
    }),
  );
} finally {
  if (!retained)
    for (const id of users)
      await authPool.query("DELETE FROM auth_users WHERE id=$1", [id]);
  await authPool.end();
}
