/** Synthetic local API + real Postgres verification. No AI, shopping or payment calls. */
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { writeFile, mkdir } from "node:fs/promises";
import { betterAuth } from "better-auth";
import { authPool } from "../lib/auth";
import { admitSnackCycle, claimSnackCycle, configureSnackSchedule, decideSnackCycle, finishSnackCycle, fireSnackSchedule, reviewSnackCycle, saveSnackOffice, saveSnackStock, snackOfficeState, snackStockCheck } from "../lib/snack-store";
import { defaultSnackSettings } from "../lib/snack-policy";
import { snackFixtures } from "../lib/snack-fixtures";
const base = process.env.SNACK_VERIFY_URL ?? "http://localhost:3016";
if (!/^http:\/\/(localhost|127\.0\.0\.1):\d+$/.test(base)) throw new Error("Local verification only");
const auth = betterAuth({ secret: process.env.BETTER_AUTH_SECRET, baseURL: base, database: authPool,
  user: { modelName: "auth_users" }, session: { modelName: "auth_sessions" }, account: { modelName: "auth_accounts" }, verification: { modelName: "auth_verifications" }, emailAndPassword: { enabled: true } });
const accounts: { id: string; cookie: string }[] = [];
const checks: string[] = [];
async function account() {
  const r = await auth.api.signUpEmail({ body: { email: `snacks-${randomUUID()}@example.invalid`, name: "Synthetic snack verifier", password: randomUUID() + randomUUID() }, asResponse: true });
  assert.equal(r.status, 200);
  const a = { id: (await r.json()).user.id as string, cookie: r.headers.getSetCookie().filter(c => c.split("=")[0].includes("session_token")).map(c => c.split(";")[0]).join("; ") };
  accounts.push(a); return a;
}
async function call(user: typeof accounts[number] | null, body?: unknown, id?: string, origin = base) {
  const r = await fetch(base + "/api/snacks" + (id ? "?officeId=" + id : ""), { method: body ? "POST" : "GET", headers: { Origin: origin, "Content-Type": "application/json", "x-demo-code": process.env.SUME_DEMO_CODE ?? "", ...(user ? { Cookie: user.cookie } : {}) }, ...(body ? { body: JSON.stringify(body) } : {}) });
  const raw = await r.text();
  assert.doesNotMatch(raw, /access_token|refresh_token|session_token|Bearer\s|"stack"\s*:/i);
  return { status: r.status, data: raw ? JSON.parse(raw) : null };
}
const officeId = randomUUID();
try {
  const a = await account(), b = await account();
  assert.equal((await call(null)).status, 401); checks.push("Unauthenticated access denied");
  const created = await call(a, { action: "save", officeId, revision: 0, settings: defaultSnackSettings });
  assert.equal(created.status, 200); checks.push("Authenticated API creates persistent office");
  assert.equal((await call(b, undefined, officeId)).status, 404); checks.push("Cross-owner read denied");
  assert.equal((await call(b, { action: "stock", officeId, revision: 1, stock: [] })).status, 404); checks.push("Cross-owner mutation denied");
  assert.equal((await call(a, { action: "stock", officeId, revision: 1, stock: [] }, undefined, "https://evil.example")).status, 403); checks.push("Cross-origin mutation denied");
  assert.equal((await call(a, { action: "stock", officeId, revision: 1, stock: [] })).status, 200);
  assert.equal((await call(a, { action: "stock", officeId, revision: 1, stock: [] })).status, 409); checks.push("Stale stock revision rejected");
  const late = randomUUID();
  await assert.rejects(() => admitSnackCycle(a.id, officeId, 2, late, Date.now() - 1));
  assert.equal((await authPool.query("SELECT count(*) FROM snack_cycles WHERE id=$1", [late])).rows[0].count, "0"); checks.push("Late cycle admission rolls back without orphaned work");
  const id = randomUUID();
  await admitSnackCycle(a.id, officeId, 2, id); await admitSnackCycle(a.id, officeId, 2, id);
  assert.equal((await authPool.query("SELECT count(*) FROM snack_cycles WHERE id=$1", [id])).rows[0].count, "1"); checks.push("Duplicate planning request creates one cycle");
  const claimed = await Promise.all([claimSnackCycle(a.id, officeId, id), claimSnackCycle(a.id, officeId, id)]);
  assert.equal(claimed.filter(c => c && "input" in c).length, 1); checks.push("Concurrent runners share one lease");
  const f = snackFixtures();
  // Synthetic provider-shaped objects exercise the production approval path.
  // Never exposed to users; deleted with the synthetic owner in finally.
  const products = f.products.map(p => ({ ...p, source: "channel3" as const, title: "SYNTHETIC " + p.title }));
  await finishSnackCycle(a.id, officeId, id, 99, products, ["synthetic query"]);
  let s = await snackOfficeState(a.id, officeId) as any;
  assert.equal(s.cycles[0].status, "running"); checks.push("Stale executor cannot commit");
  await finishSnackCycle(a.id, officeId, id, 1, products, ["synthetic query"]);
  s = await snackOfficeState(a.id, officeId) as any;
  const oldDigest = s.cycles[0].digest;
  await assert.rejects(() => decideSnackCycle(a.id, officeId, id, oldDigest, "approve")); checks.push("Unverified serving and dietary evidence blocks approval");
  for (const review of f.reviews) {
    await reviewSnackCycle(a.id, officeId, id, s.cycles[0].digest, review);
    s = await snackOfficeState(a.id, officeId) as any;
  }
  assert.equal(s.cycles[0].basket.ready, true);
  assert.ok(s.cycles[0].basket.subtotalCents + s.cycles[0].basket.reserveCents <= defaultSnackSettings.budgetCents);
  await assert.rejects(() => decideSnackCycle(a.id, officeId, id, oldDigest, "approve")); checks.push("Changed basket invalidates old approval digest");
  const digest = s.cycles[0].digest;
  assert.equal((await call(a, { action: "approve", officeId, cycleId: id, digest })).status, 200);
  assert.equal((await call(a, { action: "approve", officeId, cycleId: id, digest })).status, 200); checks.push("Exact basket approval is idempotent");
  await decideSnackCycle(a.id, officeId, id, digest, "record_order", "SYNTHETIC-NO-PURCHASE");
  await decideSnackCycle(a.id, officeId, id, digest, "record_order", "SYNTHETIC-NO-PURCHASE");
  await assert.rejects(() => decideSnackCycle(a.id, officeId, id, digest, "record_order", "changed")); checks.push("External purchase recording is idempotent and reference-bound");
  s = await snackOfficeState(a.id, officeId) as any;
  const next = randomUUID(); await admitSnackCycle(a.id, officeId, s.office.revision, next);
  const second = await claimSnackCycle(a.id, officeId, next) as any;
  assert.equal(second.input.history.length, 1); checks.push("Next cycle uses recorded purchase history");
  await saveSnackOffice(a.id, officeId, s.office.revision, { ...defaultSnackSettings, budgetCents: 19000 });
  await finishSnackCycle(a.id, officeId, next, 1, products, []);
  s = await snackOfficeState(a.id, officeId) as any;
  assert.equal(s.cycles.find((c: any) => c.id === next).status, "cancelled");
  assert.equal(s.office.stock_checked_at, null); checks.push("Changed settings cancel in-flight work and require stock suitability check");
  await saveSnackStock(a.id, officeId, s.office.revision, []);
  s = await snackOfficeState(a.id, officeId) as any;
  const due = new Date().toISOString();
  await configureSnackSchedule(a.id, officeId, s.office.revision, 0, true, due);
  const occurrences = await Promise.all([fireSnackSchedule(a.id, officeId, 1, due), fireSnackSchedule(a.id, officeId, 1, due)]);
  assert.ok(occurrences[0]); assert.equal(occurrences[0], occurrences[1]); checks.push("Duplicate schedule fires create one fortnightly occurrence");
  s = await snackOfficeState(a.id, officeId) as any;
  assert.equal(new Date(s.office.next_due_at).getTime() - Date.parse(due), 14 * 86400000); checks.push("Schedule advances exactly fourteen days without browser timer");
  await authPool.query("UPDATE snack_offices SET stock_check_due=false,stock_checked_at=now()-interval '4 days' WHERE id=$1", [officeId]);
  await snackStockCheck(a.id, officeId, 1);
  assert.equal((await authPool.query("SELECT stock_check_due FROM snack_offices WHERE id=$1", [officeId])).rows[0].stock_check_due, true); checks.push("Mid-cycle job flags stale pantry stock");
  await configureSnackSchedule(a.id, officeId, s.office.revision, 1, false);
  assert.equal(await claimSnackCycle(a.id, officeId, occurrences[0]!), null);
  assert.equal(await fireSnackSchedule(a.id, officeId, 1, due), null); checks.push("Pause fences old schedule jobs");
  await configureSnackSchedule(a.id, officeId, s.office.revision, 2, true, due);
  const rearmed = await fireSnackSchedule(a.id, officeId, 3, due);
  assert.ok(rearmed && rearmed !== occurrences[0]); checks.push("Reactivation at same due time has a new versioned occurrence");
  await configureSnackSchedule(a.id, officeId, s.office.revision, 3, false);
  if (!process.env.CHANNEL3_API_KEY) {
    assert.equal((await call(a, { action: "plan", officeId, revision: s.office.revision, cycleId: randomUUID() })).status, 503);
    checks.push("Missing Channel3 key returns explicit setup error without fake results");
  }
  await mkdir("../research", { recursive: true });
  await writeFile("../research/office-snacks-verification-2026-11-10.json", JSON.stringify({ date: "2026-11-10", scope: "Local authenticated API and real Postgres, synthetic accounts/catalog, no external commerce", checks, limitations: ["Live Channel3 search and catalog suitability not verified without API key", "AI generation not invoked by this synthetic verification", "Two-week elapsed timer not observed; schedule occurrence and fencing tested directly", "No merchant checkout or PayPal integration added"] }, null, 2) + "\n");
  console.log(JSON.stringify({ passed: checks.length, checks }, null, 2));
} finally {
  for (const a of accounts) await authPool.query("DELETE FROM auth_users WHERE id=$1", [a.id]);
  await authPool.end();
}
