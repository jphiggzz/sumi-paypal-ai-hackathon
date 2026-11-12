/** Live AI/Channel3 and optional real Sandbox test-card contributions. Synthetic users only. */
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { writeFile } from "node:fs/promises";
import { setTimeout as delay } from "node:timers/promises";
import { betterAuth } from "better-auth";
import { authPool } from "../lib/auth";
import { giftPayPal } from "../lib/gift-paypal";
const base = process.env.GIFT_VERIFY_URL ?? "http://localhost:3000";
if (!/^http:\/\/(localhost|127\.0\.0\.1):\d+$/.test(base)) throw new Error("Local verification only");
const sandbox = process.argv.includes("--sandbox"), keep = process.argv.includes("--keep");
const auth = betterAuth({ secret: process.env.BETTER_AUTH_SECRET, baseURL: base, database: authPool, user: { modelName: "auth_users" }, session: { modelName: "auth_sessions" }, account: { modelName: "auth_accounts" }, verification: { modelName: "auth_verifications" }, emailAndPassword: { enabled: true } });
const accounts: { id: string; cookie: string; name: string }[] = [], checks: string[] = [];
const groupId = randomUUID();
async function account(name: string) {
  const r = await auth.api.signUpEmail({ body: { email: `gift-${randomUUID()}@example.invalid`, name, password: randomUUID() + randomUUID() }, asResponse: true });
  assert.equal(r.status, 200); const user = (await r.json()).user;
  const cookie = r.headers.getSetCookie().filter(c => c.split("=")[0].includes("session_token")).map(c => c.split(";")[0]).join("; ");
  const a = { id: user.id as string, cookie, name }; accounts.push(a); return a;
}
async function call(a: typeof accounts[number] | null, body?: Record<string, unknown>, origin = base) {
  const r = await fetch(base + "/api/gifts" + (body ? "" : "?groupId=" + groupId), { method: body ? "POST" : "GET", headers: { Origin: origin, "Content-Type": "application/json", "x-demo-code": process.env.SUME_DEMO_CODE ?? "", ...(a ? { Cookie: a.cookie } : {}) }, ...(body ? { body: JSON.stringify({ groupId, ...body }) } : {}) });
  const raw = await r.text(); assert.doesNotMatch(raw, /access_token|refresh_token|session_token|Bearer\s|"stack"\s*:/i);
  return { status: r.status, data: raw ? JSON.parse(raw) : null };
}
async function ok(a: typeof accounts[number], body?: Record<string, unknown>) { const r = await call(a, body); assert.equal(r.status, 200, JSON.stringify(r.data)); return r.data; }
async function waitJob(a: typeof accounts[number], id: string) {
  for (let n = 0; n < 150; n++) { const s = await ok(a); const j = s.jobs.find((j: any) => j.id === id); if (j && ["ready", "failed", "cancelled"].includes(j.status)) { assert.equal(j.status, "ready", JSON.stringify(j)); return j; } await delay(2000); }
  throw new Error("GIFT_JOB_TIMEOUT");
}
try {
  const [alex, casey, jordan, stranger] = await Promise.all([account("Alex"), account("Casey"), account("Jordan"), account("Stranger")]);
  assert.equal((await call(null)).status, 401);
  const created = await ok(alex, { action: "create", groupId: undefined, id: groupId, recipient: "Sam", occasion: "Thank Sam for hosting our birthday weekend", reserveCents: 1000 });
  await ok(casey, { action: "join", groupId: undefined, token: created.inviteToken }); await ok(jordan, { action: "join", groupId: undefined, token: created.inviteToken });
  assert.equal((await call(stranger)).status, 404); checks.push("Membership required; uninvited user denied");
  assert.equal((await call(casey, { action: "limit", cents: 3000 }, "https://evil.example")).status, 403); checks.push("Cross-origin mutation denied");
  await ok(alex, { action: "limit", cents: 5000 }); await ok(casey, { action: "limit", cents: 3000 }); await ok(jordan, { action: "limit", cents: 2000 });
  const member = (await ok(alex)).me.id;
  await authPool.query("INSERT INTO gift_messages(id,member_id,role,content) VALUES($1,$2,'user',$3)", [randomUUID(), member, "PRIVATE-ONLY-MARKER: do not share this personal detail"]);
  let c = await ok(casey); assert.ok(!JSON.stringify(c).includes("PRIVATE-ONLY-MARKER")); assert.equal(c.me.limitCents, 3000); assert.equal(c.group.budgetCents, 10000); assert.ok(c.members.every((m: any) => !("limitCents" in m) && !("limit_cents" in m))); checks.push("Friends cannot read another private chat or private limit");
  const briefs = [
    [alex, "Sam started watercolor painting recently. A proper paint set and paper would make a thoughtful thank-you."],
    [casey, "Sam loves hiking but bought a new backpack last week. Avoid buying another backpack."],
    [jordan, "Sam already owns several travel mugs. Avoid mugs. One thoughtful creative gift would be appreciated."],
  ] as const;
  for (const [a, text] of briefs) {
    const id = randomUUID(); await ok(a, { action: "chat", id, text }); await waitJob(a, id);
    assert.ok(!(await ok(jordan)).facts.some((f: any) => f.content === text));
    if (a.id !== alex.id) assert.equal((await call(alex, { action: "share", messageId: id, active: true })).status, 404);
    await ok(a, { action: "share", messageId: id, active: true });
  }
  checks.push("Three real private agent chats; explicit sharing only; cross-owner sharing denied");
  const id = randomUUID(); await ok(alex, { action: "plan", id }); console.log("Running three friend agents, Channel3 searches and coordinator…");
  const plan = await waitJob(alex, id);
  assert.equal(plan.result.rounds.length, 3); assert.ok(plan.result.products.length > 0); assert.ok(plan.result.options.length > 0);
  assert.ok(!JSON.stringify(plan).includes("PRIVATE-ONLY-MARKER")); assert.ok(!JSON.stringify((await authPool.query("SELECT input FROM gift_jobs WHERE id=$1", [id])).rows[0]).includes("PRIVATE-ONLY-MARKER"));
  checks.push("Three independently generated agent handoffs and real Channel3 products; private context excluded from coordinator snapshot");
  const option = plan.result.options[0]; assert.ok(option.goalCents <= 10000); assert.ok(option.lines.every((p: any) => plan.result.products.some((x: any) => x.id === p.id && x.cents === p.cents)));
  await ok(alex, { action: "select", jobId: id, optionId: option.id }); let state = await ok(alex); const digest = state.option.digest;
  assert.equal((await call(casey, { action: "select", jobId: id, optionId: option.id })).status, 403);
  assert.equal((await call(casey, { action: "fund", id: randomUUID(), digest, cents: 100 })).status, 409); checks.push("Only organizer selects; exact personal approval precedes contribution");
  for (const a of [alex, casey, jordan]) await ok(a, { action: "approve", digest });
  assert.equal((await call(casey, { action: "fund", id: randomUUID(), digest, cents: 3001 })).status, 409); checks.push("Private contribution limit enforced server-side");
  const captures: string[] = [];
  if (sandbox) for (const a of [alex, casey]) {
    const contributionId = randomUUID(); state = await ok(a, { action: "fund", id: contributionId, digest, cents: 100 });
    let p = state.payments.find((p: any) => p.id === contributionId); assert.equal(p.status, "created", JSON.stringify(p));
    await ok(a, { action: "fund", id: contributionId, digest, cents: 100 });
    const confirmation = await giftPayPal(`/v2/checkout/orders/${p.order_id}/confirm-payment-source`, "POST", { payment_source: { card: { number: "4005519200000004", expiry: "2030-12", security_code: "123", name: "Sandbox Gift Test" } } }, "test-" + contributionId);
    if (!confirmation.ok) throw new Error("SANDBOX_CARD_CONFIRM_FAILED:" + JSON.stringify(confirmation.data.details?.map((d: any) => d.issue)));
    state = await ok(a, { action: "capture", id: contributionId }); p = state.payments.find((p: any) => p.id === contributionId);
    assert.equal(p.status, "completed", JSON.stringify(p)); assert.ok(p.capture_id); captures.push(p.capture_id.slice(-8));
    const repeated = await ok(a, { action: "capture", id: contributionId }); assert.equal(repeated.payments.find((p: any) => p.id === contributionId).capture_id, p.capture_id);
    assert.equal((await call(jordan, { action: "capture", id: contributionId })).status, 404);
  }
  if (sandbox) { assert.equal((await ok(alex)).group.fundedCents, 200); checks.push("Two real $1 Sandbox card contributions captured once, receipt-bound, cross-friend capture denied"); }
  // A late ownership update invalidates the old decision without erasing receipts.
  const late = randomUUID(); await authPool.query("INSERT INTO gift_messages(id,member_id,role,content) VALUES($1,$2,'user',$3)", [late, member, "Sam also just bought a watercolor set. Please look for complementary paper or brushes instead."]);
  await ok(alex, { action: "share", messageId: late, active: true });
  assert.equal((await call(casey, { action: "approve", digest })).status, 409);
  assert.equal((await call(casey, { action: "fund", id: randomUUID(), digest, cents: 100 })).status, 409);
  state = await ok(alex); assert.equal(state.option, null); if (sandbox) assert.equal(state.group.fundedCents, 200); checks.push("Late shared context invalidates selection/approvals and blocks old-plan payments while preserving confirmed funds");
  await writeFile("../research/group-gift-verification-2026-11-10.json", JSON.stringify({ date: "2026-11-10", scenario: "Synthetic birthday-weekend thank-you; real private AI chats, agent collaboration and Channel3 catalog", checks, queries: plan.result.queries, products: plan.result.products.map((p: any) => ({ id: p.id, title: p.title, merchant: p.merchant, cents: p.cents })), options: plan.result.options, sandboxCaptures: captures, limits: ["Synthetic friends/context, not customer validation", "Sandbox test card only, no real money", "No retailer purchase or Google Calendar integration", "Collection is to configured Sandbox demo merchant, not live P2P escrow", "Delivery, tax, shipping, suitability and exact variants require organizer review"] }, null, 2) + "\n");
  if (keep) {
    const cookieParts = alex.cookie.split("=");
    await writeFile("/tmp/group-gift-browser-state.json", JSON.stringify({ cookies: [{ name: cookieParts[0], value: cookieParts.slice(1).join("="), domain: "localhost", path: "/", httpOnly: true, secure: false, sameSite: "Lax", expires: Date.now() / 1000 + 3600 }], origins: [] }), { mode: 0o600 });
    await writeFile("/tmp/group-gift-test-users.json", JSON.stringify(accounts.map(a => a.id)), { mode: 0o600 });
  }
  console.log(JSON.stringify({ passed: checks.length, checks, groupId: keep ? groupId : undefined, sandboxCaptures: captures }, null, 2));
} finally {
  if (!keep) for (const a of accounts) await authPool.query("DELETE FROM auth_users WHERE id=$1", [a.id]);
  await authPool.end();
}
