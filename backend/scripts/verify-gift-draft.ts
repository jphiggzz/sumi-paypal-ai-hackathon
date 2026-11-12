import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { betterAuth } from "better-auth";
import { authPool } from "../lib/auth";
import { startGiftDraft } from "../lib/workspace-flows";
const base = process.env.WORKSPACE_VERIFY_URL || "http://localhost:3016";
if (!/^http:\/\/localhost:\d+$/.test(base)) throw Error("Local verification only");
const auth = betterAuth({ secret: process.env.BETTER_AUTH_SECRET, baseURL: base, database: authPool, user: { modelName: "auth_users" }, session: { modelName: "auth_sessions" }, account: { modelName: "auth_accounts" }, verification: { modelName: "auth_verifications" }, emailAndPassword: { enabled: true } });
const users: string[] = [];
async function user(name: string) {
  const response = await auth.api.signUpEmail({ body: { email: `gift-draft-${randomUUID()}@example.invalid`, name, password: randomUUID() + randomUUID() }, asResponse: true });
  assert.equal(response.status, 200);
  const { user } = await response.json(); users.push(user.id);
  return { id: user.id, cookie: response.headers.getSetCookie().filter(c => c.split("=")[0].includes("session_token")).map(c => c.split(";")[0]).join("; "), conversation: randomUUID() };
}
async function request(a: Awaited<ReturnType<typeof user>>, path: string, body?: unknown) {
  const r = await fetch(base + path, { method: body ? "POST" : "GET", headers: { Origin: base, "Content-Type": "application/json", "x-demo-code": process.env.SUME_DEMO_CODE || "", Cookie: a.cookie }, ...(body ? { body: JSON.stringify(body) } : {}) });
  const text = await r.text(); assert.equal(r.status, 200, `${path}: ${r.status} ${text.slice(0, 300)}`); return text;
}
async function flow(a: Awaited<ReturnType<typeof user>>, command?: object) { return JSON.parse(await request(a, "/api/workspace-chat/workflows" + (command ? "" : `?conversationId=${a.conversation}`), command ? { conversationId: a.conversation, command } : undefined)); }
async function chat(a: Awaited<ReturnType<typeof user>>, text: string) {
  const snapshot = JSON.parse(await request(a, `/api/workspace-chat?conversationId=${a.conversation}`));
  return request(a, "/api/workspace-chat/stream", { conversationId: a.conversation, requestId: randomUUID(), messageId: randomUUID(), text, mode: "shopping", revision: snapshot.chat.revision });
}
try {
  const a = await user("Test organizer"), b = await user("Test friend"), solo = await user("Test solo");
  for (const u of [a,b,solo]) await request(u, "/api/workspace-chat", { action: "create", id: u.conversation, mode: "shopping" });
  await chat(a, "Plan a group thank-you gift");
  let data = await flow(a); let gift = data.flows.find((f: any) => f.kind === "gift");
  assert.equal(gift.state, null); assert.equal(gift.draft.version, 2);
  await flow(a, { action: "gift_draft", participantChoice: "invite" });
  data = await flow(a, { action: "gift_draft", title: "Dallas trip gift" }); gift = data.flows.find((f: any) => f.kind === "gift");
  assert.equal(gift.draft.initialTitle, "Dallas trip gift"); assert.equal(gift.state.group.title, "Dallas trip gift"); assert.equal(gift.state.group.recipient, null); assert.equal(gift.state.group.occasion, null);
  await chat(a, "Dallas trip gift");
  const conversation = JSON.parse(await request(a, `/api/workspace-chat?conversationId=${a.conversation}`));
  const reply = conversation.messages.at(-1); assert.equal(reply.status, "completed"); assert.ok(reply.content.includes("?"), `Expected a useful follow-up question, got: ${reply.content}`); assert.equal(reply.interaction?.type, "gift_clarification"); assert.ok(Array.isArray(reply.interaction.options)); assert.ok(reply.interaction.options.length <= 3);
  await chat(a, "something else");
  let afterAlternative = JSON.parse(await request(a, `/api/workspace-chat?conversationId=${a.conversation}`));
  const alternative = afterAlternative.messages.at(-1);
  assert.equal(alternative.status, "completed");
  assert.equal(alternative.interaction?.type, "gift_clarification");
  assert.notEqual(alternative.interaction?.next, "ready");
  assert.doesNotMatch(alternative.content, /workflow action could not complete|housewarming|apartment/i);
  await chat(a, "It is a gift to bring to my hosts. I want something personal, not food.");
  afterAlternative = JSON.parse(await request(a, `/api/workspace-chat?conversationId=${a.conversation}`));
  const direction = afterAlternative.messages.at(-1);
  assert.equal(direction.status, "completed");
  assert.equal(direction.interaction?.type, "gift_clarification");
  assert.doesNotMatch(direction.content, /workflow action could not complete/i);
  assert.ok(["ready", "explore"].includes(direction.interaction?.next));
  const budgetStep = await flow(a, { action: "gift_draft", readyForBudget: true }); assert.equal(budgetStep.flows.find((f: any) => f.kind === "gift").draft.readyForBudget, true);
  data = await flow(a, { action: "gift", payload: { action: "invite" } }); const token = data.result.inviteToken; assert.match(token, /^[A-Za-z0-9_-]{43}$/);
  await flow(a, { action: "gift_draft", inviteComplete: true });
  data = await flow(b, { action: "join_gift", token }); assert.equal(data.flows.find((f: any) => f.kind === "gift").state.group.title, "Dallas trip gift");
  data = await flow(a, { action: "gift_draft", title: "Dallas weekend gift" }); gift = data.flows.find((f: any) => f.kind === "gift"); assert.equal(gift.state.group.title, "Dallas weekend gift"); assert.equal(gift.draft.initialTitle, "Dallas trip gift");
  await startGiftDraft(solo.id, solo.conversation);
  await flow(solo, { action: "gift_draft", participantChoice: "solo" });
  const soloData = await flow(solo, { action: "gift_draft", title: "Nicola’s parents thank-you gift" });
  const soloGift = soloData.flows.find((f: any) => f.kind === "gift");
  assert.equal(soloGift.draft.participantChoice, "solo"); assert.equal(soloGift.state.group.recipient, null); assert.equal(soloGift.state.members.length, 1);
  await chat(solo, "Nicola’s parents thank-you gift");
  const beforeHandoff = JSON.parse(await request(solo, `/api/workspace-chat?conversationId=${solo.conversation}`));
  assert.equal(beforeHandoff.messages.at(-1).interaction?.type, "gift_clarification");
  await chat(solo, "Something personal, around $200");
  const handoff = JSON.parse(await request(solo, `/api/workspace-chat?conversationId=${solo.conversation}`));
  assert.equal(handoff.messages.at(-1).status, "completed");
  assert.equal(handoff.messages.at(-1).interaction?.type, "gift_mock_handoff");
  const afterHandoff = await flow(solo);
  const savedSolo = afterHandoff.flows.find((f: any) => f.kind === "gift");
  assert.equal(savedSolo.state.me.limitCents, 0, "Preview must not set a real limit");
  assert.equal(savedSolo.state.members.length, 1, "Preview must not create real or simulated gift members");
  assert.equal(savedSolo.state.facts.length, 0, "Preview must not share private text");
  console.log(JSON.stringify({ checks: ["draft without invented recipient or occasion", "persisted participant choice and title", "real AI follow-up completed", "real invitation join by separate account", "rename persists", "solo draft creates only the organizer"], aiFollowup: reply.content, alternative: { content: alternative.content, interaction: alternative.interaction }, direction: { content: direction.content, interaction: direction.interaction } }));
} finally {
  for (const id of users) await authPool.query("DELETE FROM auth_users WHERE id=$1", [id]);
  await authPool.end();
}
