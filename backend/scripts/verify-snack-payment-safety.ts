/** Synthetic PayPal adapter and synthetic database users; never contacts PayPal. */
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { betterAuth } from "better-auth";
import { authPool } from "../lib/auth";
import { saveSnackOffice, saveSnackStock, admitSnackCycle, claimSnackCycle, finishSnackCycle, snackOfficeState, reviewSnackCycle, simulateSnackOrder, decideSnackCycle } from "../lib/snack-store";
import { createSnackPayment, captureSnackPayment } from "../lib/snack-payment";
import { giftMoney } from "../lib/gift-policy";
import { giftPayPal } from "../lib/gift-paypal";
import { defaultSnackSettings } from "../lib/snack-policy";
import { snackFixtures } from "../lib/snack-fixtures";
const auth = betterAuth({ secret: process.env.BETTER_AUTH_SECRET, baseURL: "http://localhost:3000", database: authPool, user: { modelName: "auth_users" }, session: { modelName: "auth_sessions" }, account: { modelName: "auth_accounts" }, verification: { modelName: "auth_verifications" }, emailAndPassword: { enabled: true } });
let user: string | undefined;
try {
  const response = await auth.api.signUpEmail({ body: { email: `snack-pay-${randomUUID()}@example.invalid`, name: "Synthetic verifier", password: randomUUID() + randomUUID() }, asResponse: true }); assert.equal(response.status, 200); user = (await response.json()).user.id;
  const owner=user!, office=randomUUID(), cycle=randomUUID(), payment=randomUUID();
  await saveSnackOffice(owner,office,0,defaultSnackSettings); await saveSnackStock(owner,office,1,[]); await admitSnackCycle(owner,office,2,cycle,undefined,"simulated");
  const claim=await claimSnackCycle(owner,office,cycle); assert.ok(claim && "attempt" in claim); const fixtures=snackFixtures(); await finishSnackCycle(owner,office,cycle,claim.attempt,fixtures.products,[]);
  let state=await snackOfficeState(owner,office) as any;
  for (const review of fixtures.reviews) { await reviewSnackCycle(owner,office,cycle,state.cycles[0].digest,review); state=await snackOfficeState(owner,office); }
  const digest=state.cycles[0].digest, cents=state.cycles[0].basket.subtotalCents;
  await assert.rejects(() => createSnackPayment("wrong-owner",office,cycle,digest,payment,"http://localhost:3000"));
  await assert.rejects(() => simulateSnackOrder(owner,office,cycle,digest));
  let createCalls=0, captureCalls=0, completed=false;
  const unit=() => ({ custom_id: payment, amount: { currency_code:"USD", value:giftMoney(cents) }, payee: { merchant_id:"SYNTHETIC" }, ...(completed ? { payments:{ captures:[{ id:"SYNTHETIC-CAPTURE", status:"COMPLETED", final_capture:true, amount:{ currency_code:"USD", value:giftMoney(cents) } }] } } : {}) });
  const fake = (async (path: string, method="GET", _body?: unknown, key?: string) => {
    if (path === "/v2/checkout/orders" && method === "POST") { createCalls++; assert.equal(key,payment); if (createCalls === 1) throw new Error("synthetic timeout"); return { ok:true,status:201,data:{ id:"ORDER123",links:[{rel:"approve",href:"https://www.sandbox.paypal.com/checkoutnow?token=ORDER123"}] } }; }
    if (path.endsWith("/capture")) { captureCalls++; assert.equal(key,`capture-${payment}`); completed=true; throw new Error("synthetic lost response"); }
    return { ok:true,status:200,data:{ id:"ORDER123",status:completed?"COMPLETED":"APPROVED",purchase_units:[unit()] } };
  }) as typeof giftPayPal;
  await createSnackPayment(owner,office,cycle,digest,payment,"http://localhost:3000",fake);
  state=await snackOfficeState(owner,office); assert.equal(state.payments[0].status,"needs_review");
  await assert.rejects(() => createSnackPayment(owner,office,cycle,digest,randomUUID(),"http://localhost:3000",fake));
  await Promise.all([createSnackPayment(owner,office,cycle,digest,payment,"http://localhost:3000",fake),createSnackPayment(owner,office,cycle,digest,payment,"http://localhost:3000",fake)]);
  assert.equal(createCalls,2); state=await snackOfficeState(owner,office); assert.equal(state.payments[0].status,"created");
  await assert.rejects(() => captureSnackPayment("wrong-owner",office,payment,false,fake));
  await captureSnackPayment(owner,office,payment,false,fake); state=await snackOfficeState(owner,office); assert.equal(state.payments[0].status,"needs_review");
  await captureSnackPayment(owner,office,payment,true,fake); await captureSnackPayment(owner,office,payment,false,fake);
  state=await snackOfficeState(owner,office); assert.equal(state.payments[0].status,"completed"); assert.equal(captureCalls,1);
  await assert.rejects(() => reviewSnackCycle(owner,office,cycle,digest,fixtures.reviews[0]));
  await assert.rejects(() => decideSnackCycle(owner,office,cycle,digest,"reject"));
  await Promise.all([simulateSnackOrder(owner,office,cycle,digest),simulateSnackOrder(owner,office,cycle,digest)]);
  // An approved provider order cannot capture after the owner changes the basket.
  const cycle2=randomUUID(), payment2=randomUUID();
  await saveSnackStock(owner,office,3,[]); await admitSnackCycle(owner,office,4,cycle2,undefined,"simulated");
  const c2=await claimSnackCycle(owner,office,cycle2); assert.ok(c2 && "attempt" in c2); await finishSnackCycle(owner,office,cycle2,c2.attempt,snackFixtures().products,[]);
  state=await snackOfficeState(owner,office) as any;
  for (const review of snackFixtures().reviews) { await reviewSnackCycle(owner,office,cycle2,state.cycles[0].digest,review); state=await snackOfficeState(owner,office); }
  const digest2=state.cycles[0].digest, cents2=state.cycles[0].basket.subtotalCents; let staleCaptureCalls=0;
  const conversation = randomUUID();
  const staleFake = (async (path: string, method="GET", body?: any) => {
    if (path.endsWith("/capture")) { staleCaptureCalls++; throw new Error("must not capture"); }
    if (method === "POST") { assert.equal(body.payment_source.paypal.experience_context.return_url, `http://localhost:3000/workspace?conversation=${conversation}&snackPayment=${payment2}`); assert.equal(body.payment_source.paypal.experience_context.cancel_url, `http://localhost:3000/workspace?conversation=${conversation}&snackCancelled=${payment2}`); return {ok:true,status:201,data:{id:"ORDER456",links:[{rel:"approve",href:"https://www.sandbox.paypal.com/checkoutnow?token=ORDER456"}]}}; }
    return {ok:true,status:200,data:{id:"ORDER456",status:"APPROVED",purchase_units:[{custom_id:payment2,amount:{currency_code:"USD",value:giftMoney(cents2)},payee:{merchant_id:"SYNTHETIC"}}]}};
  }) as typeof giftPayPal;
  await createSnackPayment(owner,office,cycle2,digest2,payment2,"http://localhost:3000",staleFake,conversation);
  await saveSnackStock(owner,office,4,[]);
  await assert.rejects(() => captureSnackPayment(owner,office,payment2,false,staleFake)); assert.equal(staleCaptureCalls,0);
  console.log("Synthetic PayPal: authorization, duplicate creation, uncertain create/capture, reconciliation, stale capture and simulation passed.");
} finally { if(user) await authPool.query("DELETE FROM auth_users WHERE id=$1",[user]); await authPool.end(); }
