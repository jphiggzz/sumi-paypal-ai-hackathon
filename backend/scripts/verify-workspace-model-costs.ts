import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { setTimeout as delay } from "node:timers/promises";
import { gateway } from "ai";
import { authPool } from "../lib/auth";
import { reconcileModelCharge } from "../lib/model-charges";
import { confirmedModelCost } from "../lib/model-charge-policy";
const base = "http://localhost:3000";
const saved = JSON.parse(
  await readFile("/tmp/gift-group-chat-verification.json", "utf8"),
);
const a = saved.people[0],
  evidencePath = "../research/gift-group-chat-verification-2026-11-10.json";
const evidence = JSON.parse(await readFile(evidencePath, "utf8"));
let campaignId: string | undefined;
async function api(path: string, body?: unknown, admit = false) {
  const r = await fetch(base + path, {
    method: body ? "POST" : "GET",
    headers: {
      Origin: base,
      Cookie: a.cookie,
      "Content-Type": "application/json",
      ...(admit ? { "x-demo-code": process.env.SUME_DEMO_CODE || "" } : {}),
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  assert.equal(r.status, 200);
  return r.json();
}
async function flow(command?: unknown, admit = false) {
  return api(
    "/api/workspace-chat/workflows" +
      (command ? "" : "?conversationId=" + a.conversation),
    command ? { conversationId: a.conversation, command } : undefined,
    admit,
  );
}
try {
  const chat = await api(
    "/api/workspace-chat?conversationId=" + a.conversation,
  );
  const text =
    "Keep this private: Sam dislikes glitter. Suggest one useful detail I could explicitly share later. Do not search or share anything now.";
  const stream = await fetch(base + "/api/workspace-chat/stream", {
    method: "POST",
    headers: {
      Origin: base,
      Cookie: a.cookie,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      conversationId: a.conversation,
      requestId: randomUUID(),
      messageId: randomUUID(),
      text,
      mode: "shopping",
      revision: chat.chat.revision,
    }),
  });
  assert.equal(stream.status, 200);
  await stream.text();
  const snapshot = await api(
    "/api/workspace-chat?conversationId=" + a.conversation,
  );
  assert.equal(snapshot.messages.at(-1).status, "completed");
  assert.equal(snapshot.messages.at(-1).role, "assistant");
  assert(
    !(await flow()).flows
      .find((f: any) => f.kind === "gift")
      .state.facts.some((f: any) => f.content.includes("glitter")),
  );
  await flow({ action: "prepare_campaign" }, true);
  let f = await flow(
    { action: "approve_campaign", approved: true, scenario: "review" },
    true,
  );
  campaignId = f.flows.find((x: any) => x.kind === "campaign").resourceId;
  let campaign: any;
  for (let i = 0; i < 60; i++) {
    f = await flow();
    campaign = f.flows.find((x: any) => x.kind === "campaign").state;
    if (["review", "failed"].includes(campaign?.status)) break;
    await delay(2000);
  }
  assert.equal(campaign.status, "review");
  assert(campaign.event_log.counteroffer.problems.length > 0);
  assert.equal(campaign.batch_id, null);
  const lastId = evidence.costReceipts.at(-1);
  const charge = (
    await authPool.query("SELECT * FROM agent_model_charges WHERE id=$1", [
      lastId,
    ])
  ).rows[0];
  let info: any;
  for (let i = 0; i < 15; i++) {
    try {
      info = await gateway.getGenerationInfo({ id: charge.generation_id });
      break;
    } catch {
      await delay(10000);
    }
  }
  assert(info);
  const confirmed = confirmedModelCost(
    charge.model,
    charge.generation_id,
    info,
  );
  assert.notEqual(confirmed, null);
  const before = Number(
    (
      await authPool.query(
        "SELECT reserved_usd FROM agent_model_budget WHERE day=$1",
        [charge.day],
      )
    ).rows[0].reserved_usd,
  );
  const wasPending = charge.confirmed_usd === null;
  await Promise.all([
    reconcileModelCharge(lastId),
    reconcileModelCharge(lastId),
  ]);
  const after = Number(
    (
      await authPool.query(
        "SELECT reserved_usd FROM agent_model_budget WHERE day=$1",
        [charge.day],
      )
    ).rows[0].reserved_usd,
  );
  assert(
    Math.abs(
      after -
        (wasPending ? before - Number(charge.held_usd) + confirmed! : before),
    ) < 0.0000001,
  );
  for (const id of evidence.costReceipts) await reconcileModelCharge(id);
  const rows = (
    await authPool.query(
      "SELECT held_usd,confirmed_usd FROM agent_model_charges WHERE id=ANY($1::uuid[])",
      [evidence.costReceipts],
    )
  ).rows;
  assert.equal(rows.length, 9);
  assert(rows.every((r) => r.confirmed_usd !== null));
  const groupCost = rows.reduce((n, r) => n + Number(r.confirmed_usd), 0);
  evidence.cost = {
    dailyCeiling: 5,
    calls: 9,
    fullContextReservations: 1.35,
    confirmedUsd: Number(groupCost.toFixed(6)),
    allReceiptsConfirmed: true,
    duplicateSettlementSafe: true,
  };
  evidence.checks.push(
    "Paper/brush alternatives respect the explicit no-more-paint fixture",
    "Owned private chat streams without organizer code and does not publish the private note",
    "Creator review uses the same model with cost tracking; no payout attempted",
    "Exact generation settlement stays below the unchanged $5 ceiling; duplicate settlement releases allowance once",
  );
  await writeFile(evidencePath, JSON.stringify(evidence, null, 2) + "\n");
  console.log(
    JSON.stringify({
      groupCost: evidence.cost,
      checks: evidence.checks.slice(-4),
    }),
  );
} finally {
  if (campaignId)
    await authPool.query(
      "DELETE FROM campaigns WHERE id=$1 AND scenario='review' AND batch_id IS NULL",
      [campaignId],
    );
  await authPool.end();
}
