/** Single-browser demo capability test; live planning is opt-in. No Google login. */
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { writeFile } from "node:fs/promises";
import { setTimeout as delay } from "node:timers/promises";
const base = process.env.GIFT_VERIFY_URL ?? "http://localhost:3000";
if (!/^http:\/\/(localhost|127\.0\.0\.1):\d+$/.test(base)) throw new Error("Local demo only");
let cookie = ""; const checks: string[] = [];
async function call(actor = "alex", body?: unknown, customCookie = cookie, origin = base) {
  const r = await fetch(base + "/api/gifts/demo?actor=" + actor, { method: body ? "POST" : "GET", headers: { Origin: origin, Cookie: customCookie, "Content-Type": "application/json" }, ...(body ? { body: JSON.stringify(body) } : {}) });
  if (r.headers.get("set-cookie")) cookie = r.headers.get("set-cookie")!.split(";")[0];
  const raw = await r.text();
  return { status: r.status, data: raw ? JSON.parse(raw) : null, cookie: r.headers.get("set-cookie") };
}
assert.equal((await call()).status, 401);
let r = await call("alex", { action: "start" }); assert.equal(r.status, 200);
assert.ok(r.cookie?.includes("HttpOnly") && r.cookie.includes("Path=/api/gifts/demo")); checks.push("Anonymous local demo creates HttpOnly session and three fictional friends without Google");
let s = r.data; const groupId = s.group.id;
assert.equal(s.members.length, 3); assert.equal(s.me.name, "Alex"); assert.equal(s.me.limitCents, 5000); assert.equal(s.facts.length, 0);
const a = s.messages[0].id;
r = await call("casey"); assert.equal(r.data.me.name, "Casey"); assert.equal(r.data.me.limitCents, 3000); assert.ok(!r.data.messages.some((m: any) => m.id === a)); checks.push("Switching friends changes private chat and limit without leaking another friend's messages");
assert.equal((await call("casey", { action: "share", groupId, messageId: a, active: true })).status, 404); checks.push("Friend switch does not bypass per-member message ownership");
assert.equal((await call("alex", { action: "limit", groupId: randomUUID(), cents: 1000 })).status, 403); checks.push("Demo capability cannot target another group");
assert.equal((await call("real-user-id")).status, 400); checks.push("Actor keys are closed; arbitrary identities rejected");
const real = await fetch(base + "/api/gifts?groupId=" + groupId, { headers: { Cookie: cookie } }); assert.equal(real.status, 401); checks.push("Demo cookie does not authenticate the real-user API");
assert.equal((await call("alex", { action: "start" }, "", "https://evil.example")).status, 403); checks.push("Cross-origin demo mutation rejected");
assert.equal((await call("alex", undefined, cookie.replace(/.$/, "!"))).status, 401); checks.push("Tampered demo capability rejected");
for (const actor of ["alex", "casey", "jordan"]) {
  const state = (await call(actor)).data;
  await call(actor, { action: "share", groupId, messageId: state.messages[0].id, active: true });
}
assert.equal((await call()).data.facts.length, 3); checks.push("Each friend's explicit share enters the same group context");
let live: any = null;
if (process.argv.includes("--live")) {
  const id = randomUUID(); assert.equal((await call("alex", { action: "plan", groupId, id })).status, 200);
  console.log("Running the demo's live agent collaboration…");
  for (let n = 0; n < 150; n++) {
    s = (await call()).data; const j = s.jobs.find((j: any) => j.id === id);
    if (j && ["ready", "failed", "cancelled"].includes(j.status)) { assert.equal(j.status, "ready"); assert.ok(j.result.options.length); live = j.result; break; }
    await delay(2000);
  }
  assert.ok(live); checks.push("Friend-switching demo runs three real agent handoffs and Channel3-backed planning");
  await call("alex", { action: "select", groupId, jobId: id, optionId: live.options[0].id });
  const digest = (await call()).data.option.digest;
  for (const actor of ["alex", "casey", "jordan"]) assert.equal((await call(actor, { action: "approve", groupId, digest })).status, 200);
  assert.ok((await call()).data.members.every((m: any) => m.approved)); checks.push("One operator approves the same exact gift plan as all three demo friends");
}

if (process.argv.includes("--keep")) {
  const [name, ...value] = cookie.split("=");
  await writeFile("/tmp/gift-demo-browser-state.json", JSON.stringify({ cookies: [{ name, value: value.join("="), domain: "localhost", path: "/api/gifts/demo", httpOnly: true, secure: false, sameSite: "Lax", expires: Date.now() / 1000 + 3600 }], origins: [] }), { mode: 0o600 });
} else {
  const old = cookie; const reset = await call("alex", { action: "reset" }); assert.equal(reset.status, 200); assert.notEqual(reset.data.group.id, groupId); assert.equal((await call("alex", undefined, old)).status, 401); checks.push("Reset rotates session and invalidates old demo capability");
}
await writeFile("../research/group-gift-demo-verification-2026-11-10.json", JSON.stringify({ date: "2026-11-10", checks, livePlanning: live ? { rounds: live.rounds.length, products: live.products.length, options: live.options.map((o: any) => ({ title: o.title, cents: o.subtotalCents, products: o.lines.map((p: any) => p.title) })) } : null, limitations: ["Fictional friends and preset private context; no real-user impersonation", "AI and Channel3 are live when --live is used", "PayPal remains Sandbox; no payment submitted by this verifier", "Demo is enabled only on local loopback origins"] }, null, 2) + "\n");
console.log(JSON.stringify({ passed: checks.length, checks }, null, 2));
