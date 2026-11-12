/** Isolated local database test. No model, PayPal, or supplier calls. */
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { betterAuth } from "better-auth";
import { authPool } from "../lib/auth";
import { admitSnackCycle, claimSnackCycle, finishSnackCycle, reviewSnackCycle, saveSnackOffice, saveSnackStock, simulateSnackOrder, snackOfficeState } from "../lib/snack-store";
import { defaultSnackSettings } from "../lib/snack-policy";
import { snackFixtures } from "../lib/snack-fixtures";
const auth = betterAuth({ secret: process.env.BETTER_AUTH_SECRET, baseURL: "http://localhost:3000", database: authPool, user: { modelName: "auth_users" }, session: { modelName: "auth_sessions" }, account: { modelName: "auth_accounts" }, verification: { modelName: "auth_verifications" }, emailAndPassword: { enabled: true } });
let user: string | undefined;
try {
  const r = await auth.api.signUpEmail({ body: { email: `snack-sim-${randomUUID()}@example.invalid`, name: "Synthetic verifier", password: randomUUID() + randomUUID() }, asResponse: true });
  assert.equal(r.status, 200); user = (await r.json()).user.id;
  const owner = user!; const office = randomUUID(); const cycle = randomUUID();
  await saveSnackOffice(owner, office, 0, defaultSnackSettings);
  await saveSnackStock(owner, office, 1, []);
  await admitSnackCycle(owner, office, 2, cycle);
  const claim = await claimSnackCycle(owner, office, cycle);
  assert.ok(claim && "attempt" in claim);
  const fixture = snackFixtures();
  await finishSnackCycle(owner, office, cycle, claim.attempt, fixture.products, []);
  let state = await snackOfficeState(owner, office) as any;
  const stale = state.cycles[0].digest;
  await assert.rejects(() => simulateSnackOrder(owner, office, cycle, stale));
  await assert.rejects(() => simulateSnackOrder("wrong-owner", office, cycle, stale));
  for (const review of fixture.reviews) {
    await reviewSnackCycle(owner, office, cycle, state.cycles[0].digest, review);
    state = await snackOfficeState(owner, office) as any;
  }
  assert.ok(state.cycles[0].basket.lines.length);
  await assert.rejects(() => simulateSnackOrder(owner, office, cycle, stale));
  const digest = state.cycles[0].digest;
  await assert.rejects(() => simulateSnackOrder(owner, office, cycle, digest));
  await authPool.query("INSERT INTO snack_payments(id,office_id,cycle_id,owner_id,digest,amount_cents,status) VALUES($1,$2,$3,$4,$5,$6,'completed')", [randomUUID(),office,cycle,owner,digest,state.cycles[0].basket.subtotalCents]); // Explicit database fixture, no PayPal call.
  await Promise.all([simulateSnackOrder(owner, office, cycle, digest), simulateSnackOrder(owner, office, cycle, digest)]);
  state = await snackOfficeState(owner, office) as any;
  assert.equal(state.cycles[0].order_reference, `SIM-${cycle}`);
  assert.equal(state.cycles[0].status, "ordered");
  const next = randomUUID(); await admitSnackCycle(owner, office, state.office.revision, next);
  const nextClaim = await claimSnackCycle(owner, office, next);
  assert.ok(nextClaim && "input" in nextClaim);
  assert.equal(nextClaim.input.history.length, 0);
  console.log("Simulated supplier: ownership, review, stale digest, duplicate request, and live-history isolation passed.");
} finally {
  if (user) await authPool.query("DELETE FROM auth_users WHERE id=$1", [user]);
  await authPool.end();
}
