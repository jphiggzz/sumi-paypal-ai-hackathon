/** Two real AI/Channel3 rounds, disposable account, no payments. */
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import { betterAuth } from "better-auth";
import { authPool } from "../lib/auth";
import { createChat, acceptTurn, saveReply } from "../lib/workspace-chat";
import { startGiftDraft } from "../lib/workspace-flows";
const base = process.env.WORKSPACE_VERIFY_URL || "http://localhost:3016";
if (!/^http:\/\/localhost:\d+$/.test(base)) throw Error("Local verification only");
const auth = betterAuth({ secret: process.env.BETTER_AUTH_SECRET, baseURL: base, database: authPool, user: { modelName: "auth_users" }, session: { modelName: "auth_sessions" }, account: { modelName: "auth_accounts" }, verification: { modelName: "auth_verifications" }, emailAndPassword: { enabled: true } });
const signup = await auth.api.signUpEmail({ body: { email: `live-solo-${randomUUID()}@example.invalid`, name: "Synthetic organizer", password: randomUUID() + randomUUID() }, asResponse: true });
assert.equal(signup.status, 200);
const { user } = await signup.json();
const cookie = signup.headers.getSetCookie().filter((entry) => entry.split("=")[0].includes("session_token")).map((entry) => entry.split(";")[0]).join("; ");
const chatId = randomUUID();
const secret = `UNSHARED_${randomUUID()}`;
async function flow(command?: object) {
  const response = await fetch(base + "/api/workspace-chat/workflows" + (command ? "" : `?conversationId=${chatId}`), { method: command ? "POST" : "GET", headers: { Origin: base, "Content-Type": "application/json", Cookie: cookie, "x-demo-code": process.env.SUME_DEMO_CODE || "" }, ...(command ? { body: JSON.stringify({ conversationId: chatId, command }) } : {}) });
  const body = await response.json();
  assert.equal(response.status, 200, JSON.stringify(body));
  return body.flows.find((item: any) => item.kind === "gift");
}
async function waitFor(id: string) {
  const deadline = Date.now() + 300000;
  let previous = "";
  while (Date.now() < deadline) {
    const gift = await flow();
    const job = gift.state.jobs.find((item: any) => item.id === id);
    const status = `${job?.status}:${job?.result?.phase || ""}:${job?.result?.transcript?.length || 0}`;
    if (status !== previous) { console.log(JSON.stringify({ job: id, status })); previous = status; }
    if (job?.status === "failed") throw Error(`Job failed: ${job.error_code}`);
    if (job?.status === "ready") return { gift, job };
    await delay(3000);
  }
  throw Error("Timed out waiting for live gift workflow");
}
try {
  await createChat(user.id, chatId, "shopping");
  const sharedId = randomUUID(), firstReply = randomUUID();
  await acceptTurn(user.id, { conversationId: chatId, requestId: firstReply, messageId: sharedId, text: "Alex has a new apartment and loves entertaining friends. A useful serving gift would be great.", mode: "shopping", revision: 0 });
  await saveReply(firstReply, "Understood.", "completed");
  const secondReply = randomUUID();
  await acceptTurn(user.id, { conversationId: chatId, requestId: secondReply, messageId: randomUUID(), text: secret, mode: "shopping", revision: 1 });
  await saveReply(secondReply, "Noted privately.", "completed");
  await startGiftDraft(user.id, chatId);
  await flow({ action: "gift_draft", participantChoice: "solo" });
  await flow({ action: "gift_draft", title: "Alex's new apartment" });
  await flow({ action: "gift", payload: { action: "limit", cents: 20000 } });
  await flow({ action: "share_context", messageId: sharedId, active: true });
  const id = randomUUID();
  await flow({ action: "gift", payload: { action: "plan", id } });
  const input = (await authPool.query("SELECT input FROM gift_jobs WHERE id=$1", [id])).rows[0].input;
  assert.equal(input.soloPerspectives, true);
  assert.equal(input.members.length, 1);
  assert.ok(!JSON.stringify(input).includes(secret));
  const first = await waitFor(id);
  assert.equal(first.job.result.transcript.length, 6);
  assert.deepEqual([...new Set(first.job.result.transcript.map((turn: any) => turn.name))], ["Scout", "Muse", "Dot"]);
  assert.ok(first.job.result.transcript.every((turn: any) => turn.perspective && !turn.simulated));
  assert.ok(first.job.result.products.length > 0);
  assert.ok(!JSON.stringify(first.job.result).includes(secret));
  console.log(JSON.stringify({ round: 1, products: first.job.result.products.length, options: first.job.result.options.map((option: any) => option.lines.map((product: any) => product.title)) }));
  await flow({ action: "group_feedback", id: randomUUID(), text: "No glassware. Please focus on wooden serving boards." });
  const nextId = randomUUID();
  await flow({ action: "gift", payload: { action: "plan", id: nextId } });
  const nextInput = (await authPool.query("SELECT input FROM gift_jobs WHERE id=$1", [nextId])).rows[0].input;
  assert.ok(nextInput.facts.some((fact: any) => /no glassware/i.test(fact.content)));
  const second = await waitFor(nextId);
  assert.equal(second.job.result.transcript.length, 6);
  const products = second.job.result.options.flatMap((option: any) => option.lines.map((product: any) => product.title));
  console.log(JSON.stringify({ round: 2, products: second.job.result.products.length, selected: products }));
  assert.ok(products.every((title: string) => !/glass/i.test(title)), "Feedback exclusion must be respected");
  assert.equal(second.gift.state.me.limitCents, 20000);
  assert.equal(second.gift.state.members.length, 1);
  assert.equal(second.gift.state.payments.length, 0);
  console.log(JSON.stringify({ passed: true, noPayments: true, noSimulatedMembers: true, unsharedContextExcluded: true }));
} finally {
  await authPool.query("DELETE FROM auth_users WHERE id=$1", [user.id]);
  await authPool.end();
}
