/** Isolated database checks; no timer, model, payment, or supplier calls. */
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { betterAuth } from "better-auth";
import { authPool } from "../lib/auth";
import { saveSnackOffice, saveSnackStock, configureSnackSchedule, readSnackSchedule, fireSnackSchedule, claimSnackCycle, finishSnackCycle, snackOfficeState } from "../lib/snack-store";
import { defaultSnackSettings } from "../lib/snack-policy";
import { snackFixtures } from "../lib/snack-fixtures";
const auth = betterAuth({ secret: process.env.BETTER_AUTH_SECRET, baseURL: "http://localhost:3000", database: authPool, user: { modelName: "auth_users" }, session: { modelName: "auth_sessions" }, account: { modelName: "auth_accounts" }, verification: { modelName: "auth_verifications" }, emailAndPassword: { enabled: true } });
let user: string | undefined;
try {
  const response = await auth.api.signUpEmail({ body: { email: `snack-monthly-${randomUUID()}@example.invalid`, name: "Synthetic verifier", password: randomUUID() + randomUUID() }, asResponse: true });
  assert.equal(response.status, 200); user = (await response.json()).user.id;
  const owner = user!, office = randomUUID();
  await saveSnackOffice(owner, office, 0, defaultSnackSettings);
  await saveSnackStock(owner, office, 1, []);
  const due = new Date(Date.now() - 1000).toISOString();
  await configureSnackSchedule(owner, office, 2, 0, true, due, undefined, "monthly", new Date(due).getUTCDate(), "simulated");
  const schedule = await readSnackSchedule(owner, office, 1);
  assert.ok(schedule && !('missing' in schedule)); assert.equal(schedule.source, "simulated");
  const [id, duplicate] = await Promise.all([fireSnackSchedule(owner, office, 1, due), fireSnackSchedule(owner, office, 1, due)]);
  assert.ok(id); assert.equal(id, duplicate);
  const claimed = await claimSnackCycle(owner, office, id!); assert.ok(claimed && "attempt" in claimed);
  await finishSnackCycle(owner, office, id!, claimed.attempt, snackFixtures().products, []);
  const state = await snackOfficeState(owner, office) as any;
  assert.equal(state.cycles.length, 1); assert.equal(state.cycles[0].status, "ready");
  assert.ok(state.cycles[0].products.every((p: any) => p.source === "fixture"));
  assert.equal(state.cycles[0].order_reference, null);
  assert.ok(new Date(state.office.next_due_at).getTime() > Date.now());
  await assert.rejects(() => readSnackSchedule("wrong-owner", office, 1));
  console.log("Monthly simulated proposal: source, owner, duplicate timer, next due, and no order passed.");
} finally {
  if (user) await authPool.query("DELETE FROM auth_users WHERE id=$1", [user]);
  await authPool.end();
}
