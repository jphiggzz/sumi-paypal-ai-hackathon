import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { betterAuth } from "better-auth";
import { authPool } from "../lib/auth";
import { createChat, acceptTurn, saveReply } from "../lib/workspace-chat";
import catalog from "../app/workspace/_components/data/channel3-preview.json";
const base = process.env.WORKSPACE_VERIFY_URL || "http://localhost:3016";
if (!/^http:\/\/localhost:\d+$/.test(base)) throw Error("Local verification only");
const auth = betterAuth({ secret: process.env.BETTER_AUTH_SECRET, baseURL: base, database: authPool, user: { modelName: "auth_users" }, session: { modelName: "auth_sessions" }, account: { modelName: "auth_accounts" }, verification: { modelName: "auth_verifications" }, emailAndPassword: { enabled: true } });
const response = await auth.api.signUpEmail({ body: { email: `mock-feedback-${randomUUID()}@example.invalid`, name: "Synthetic preview user", password: randomUUID() + randomUUID() }, asResponse: true });
assert.equal(response.status, 200);
const { user } = await response.json();
const cookie = response.headers.getSetCookie().filter((entry) => entry.split("=")[0].includes("session_token")).map((entry) => entry.split(";")[0]).join("; ");
const id = randomUUID();
try {
  await createChat(user.id, id, "shopping");
  const requestId = randomUUID();
  await acceptTurn(user.id, { conversationId: id, requestId, messageId: randomUUID(), text: "Alex's new apartment; a gift for entertaining, budget $200.", mode: "shopping", revision: 0 });
  await saveReply(requestId, "Here are some examples.", "completed");
  async function run(mode: string, feedback: string, shownIndices: number[], priorFeedback: string[] = []) {
    const result = await fetch(base + "/api/mock-gift-feedback", { method: "POST", headers: { Origin: base, "Content-Type": "application/json", Cookie: cookie, "x-demo-code": process.env.SUME_DEMO_CODE || "" }, body: JSON.stringify({ conversationId: id, mode, feedback, priorFeedback, shownIndices }) });
    const body = await result.json();
    assert.equal(result.status, 200, JSON.stringify(body));
    return body;
  }
  const initial = await run("suggestions", "", [0, 1, 2]);
  assert.deepEqual(initial.productIndices, [0, 1, 2]);
  assert.ok(initial.suggestions.length >= 2);
  const revised = await run("feedback", "Less glassware, more serving boards", [0, 1, 2]);
  assert.ok(revised.productIndices.length > 0);
  assert.ok(revised.productIndices.every((index: number) => !/glass/i.test(catalog[index].title)));
  const unavailable = await run("feedback", "No wood or glass, I want a ceramic vase", revised.productIndices);
  console.log(JSON.stringify({ initialSuggestions: initial.suggestions, feedback: "Less glassware, more serving boards", selected: revised.productIndices.map((index: number) => catalog[index].title), discussion: revised.discussion, unavailable: { indices: unavailable.productIndices, selected: unavailable.productIndices.map((index: number) => catalog[index].title), summary: unavailable.summary } }));
  assert.deepEqual(unavailable.productIndices, []);
} finally {
  await authPool.query("DELETE FROM auth_users WHERE id=$1", [user.id]);
  await authPool.end();
}
