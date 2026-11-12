/** Real AI + Channel3 sourcing against a disposable office. Never approves/buys. */
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { writeFile } from "node:fs/promises";
import { setTimeout as delay } from "node:timers/promises";
import { betterAuth } from "better-auth";
import { authPool } from "../lib/auth";
import { defaultSnackSettings, buildSnackBasket } from "../lib/snack-policy";
const base = process.env.SNACK_VERIFY_URL ?? "http://localhost:3016";
if (!/^http:\/\/(localhost|127\.0\.0\.1):\d+$/.test(base)) throw new Error("Local verification only");
const auth = betterAuth({ secret: process.env.BETTER_AUTH_SECRET, baseURL: base, database: authPool, user: { modelName: "auth_users" }, session: { modelName: "auth_sessions" }, account: { modelName: "auth_accounts" }, verification: { modelName: "auth_verifications" }, emailAndPassword: { enabled: true } });
let owner: string | undefined;
try {
  const r = await auth.api.signUpEmail({ body: { email: `snack-live-${randomUUID()}@example.invalid`, name: "Synthetic live-sourcing verifier", password: randomUUID() + randomUUID() }, asResponse: true });
  assert.equal(r.status, 200);
  owner = (await r.json()).user.id;
  const cookie = r.headers.getSetCookie().filter(c => c.split("=")[0].includes("session_token")).map(c => c.split(";")[0]).join("; ");
  const officeId = randomUUID();
  async function call(body?: Record<string, unknown>) {
    const response = await fetch(base + "/api/snacks" + (!body ? "?officeId=" + officeId : ""), { method: body ? "POST" : "GET", headers: { Origin: base, Cookie: cookie, "Content-Type": "application/json", "x-demo-code": process.env.SUME_DEMO_CODE ?? "" }, ...(body ? { body: JSON.stringify({ officeId, ...body }) } : {}) });
    const data = await response.json();
    if (!response.ok) throw new Error(`SNACK_API_${response.status}:${data.error}`);
    return data;
  }
  await call({ action: "save", revision: 0, settings: defaultSnackSettings });
  await call({ action: "stock", revision: 1, stock: [] });
  await call({ action: "plan", revision: 2, cycleId: randomUUID() });
  let state: any;
  for (let i = 0; i < 90; i++) {
    state = await call();
    if (["ready", "failed", "cancelled"].includes(state.cycles[0]?.status)) break;
    await delay(2000);
  }
  const cycle = state.cycles[0];
  const products = cycle.products;
  const second = cycle.status === "ready" && products.length ? buildSnackBasket(defaultSnackSettings, products, [], [], [{ productIds: cycle.basket.lines.map((l: any) => l.product.id), orderedAt: new Date().toISOString() }], new Date().toISOString()) : null;
  const evidence = {
    date: "2026-11-10", scope: "Authenticated local API → real background AI → real Channel3 → persisted basket; disposable office",
    status: cycle.status, errorCode: cycle.error_code, queries: cycle.queries,
    candidateCount: products.length, products: products.map((p: any) => ({ id: p.id, title: p.title, merchant: p.merchant, cents: p.cents, source: p.source, retrievedAt: p.retrievedAt })),
    basket: cycle.basket, simulatedSecondCycle: second,
    limitations: ["No order approvals, purchases, payment calls or actual office schedule", "Second-cycle history, if present, is simulated, not a purchase", "No inference of dietary safety or pack counts from model judgment", "An empty catalog result does not establish that Channel3 has no food inventory; it establishes failure of this tested sourcing case"],
  };
  await writeFile("../research/office-snacks-live-verification-2026-11-10.json", JSON.stringify(evidence, null, 2) + "\n");
  console.log(JSON.stringify({ status: cycle.status, errorCode: cycle.error_code, queries: cycle.queries, candidateCount: products.length, productTitles: products.map((p: any) => p.title), blockers: cycle.basket?.blockers, secondCycleTestable: Boolean(second) }, null, 2));
  if (cycle.status !== "ready") process.exitCode = 1;
} finally {
  if (owner) await authPool.query("DELETE FROM auth_users WHERE id=$1", [owner]);
  await authPool.end();
}
