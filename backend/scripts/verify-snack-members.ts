/** Isolated database checks; no model or external payment calls. */
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { betterAuth } from "better-auth";
import { authPool } from "../lib/auth";
import { saveSnackOffice, saveSnackStock, admitSnackCycle, claimSnackCycle } from "../lib/snack-store";
import { snackInvite, joinSnackOffice, readSnackMembers, saveSnackPreferences } from "../lib/snack-members";
import { defaultSnackSettings } from "../lib/snack-policy";
const auth = betterAuth({ secret: process.env.BETTER_AUTH_SECRET, baseURL: "http://localhost:3000", database: authPool, user: { modelName: "auth_users" }, session: { modelName: "auth_sessions" }, account: { modelName: "auth_accounts" }, verification: { modelName: "auth_verifications" }, emailAndPassword: { enabled: true } });
const users: { id: string; name: string }[] = [];
try {
  for (let i = 0; i < 3; i++) { const r = await auth.api.signUpEmail({ body: { email: `snack-member-${randomUUID()}@example.invalid`, name: `Verifier ${i}`, password: randomUUID() + randomUUID() }, asResponse: true }); assert.equal(r.status, 200); users.push((await r.json()).user); }
  const [owner, one, two] = users, office = randomUUID();
  await saveSnackOffice(owner.id, office, 0, defaultSnackSettings); await saveSnackStock(owner.id, office, 1, []);
  await assert.rejects(() => snackInvite(one.id, office));
  const token = await snackInvite(owner.id, office); await joinSnackOffice(one, token); await joinSnackOffice(two, token);
  await assert.rejects(() => joinSnackOffice(one, "bad"));
  const member = (await authPool.query("SELECT id FROM snack_members WHERE office_id=$1 AND user_id=$2", [office, one.id])).rows[0];
  await authPool.query("INSERT INTO snack_messages(id,member_id,role,content) VALUES($1,$2,'user','private detail')", [randomUUID(), member.id]);
  assert.equal((await readSnackMembers(one.id, office)).messages.length, 1);
  assert.equal((await readSnackMembers(two.id, office)).messages.length, 0);
  assert.equal((await readSnackMembers(owner.id, office)).messages.length, 0);
  const prefs = { likes: ["mango"], dislikes: [], dietary: [], allergies: ["sesame"] };
  await saveSnackPreferences(one.id, office, prefs, false);
  assert.equal((await readSnackMembers(two.id, office)).members.length, 0);
  await saveSnackPreferences(one.id, office, prefs, true);
  assert.deepEqual((await readSnackMembers(two.id, office)).members[0].preferences, prefs);
  const cycle = randomUUID(); await admitSnackCycle(owner.id, office, 4, cycle);
  const claim = await claimSnackCycle(owner.id, office, cycle); assert.ok(claim && "input" in claim);
  assert.ok(claim.input.settings.groups.some((g: any) => g.likes.includes("mango") && g.allergies.includes("sesame")));
  await saveSnackPreferences(one.id, office, prefs, false);
  assert.equal((await readSnackMembers(two.id, office)).members.length, 0);
  assert.equal((await authPool.query("SELECT status FROM snack_cycles WHERE id=$1", [cycle])).rows[0].status, "cancelled");
  console.log("Snack members: invite authority, private isolation, explicit sharing, basket snapshot and withdrawal passed.");
} finally { for (const u of users) await authPool.query("DELETE FROM auth_users WHERE id=$1", [u.id]); await authPool.end(); }
