import test from "node:test";
import assert from "node:assert/strict";
import { installmentEligible, installmentPayoutKey, installmentTerms } from "./creator/installments";
import type { Deal } from "./creator/policy";

test("upfront and split terms conserve the agreed amount, including odd cents", () => {
  assert.deepEqual(installmentTerms(1001, "upfront"), [{ id: "upfront", amountCents: 1001, due: "approval" }]);
  assert.deepEqual(installmentTerms(1001, "split"), [
    { id: "upfront", amountCents: 500, due: "approval" },
    { id: "delivery", amountCents: 501, due: "accepted_delivery" },
  ]);
  assert.throws(() => installmentTerms(1, "split"));
});

test("installments need approval, and the final split also needs accepted delivery", () => {
  const [first, final] = installmentTerms(1000, "split");
  assert.equal(installmentEligible(first, { approved: false, acceptedDelivery: true }), false);
  assert.equal(installmentEligible(first, { approved: true, acceptedDelivery: false }), true);
  assert.equal(installmentEligible(final, { approved: true, acceptedDelivery: false }), false);
  assert.equal(installmentEligible(final, { approved: true, acceptedDelivery: true }), false);
  assert.equal(installmentEligible(final, { approved: true, acceptedDelivery: true, priorConfirmed: true }), true);
});

test("payout keys are stable across retries and distinct across installments and deals", () => {
  const first = installmentPayoutKey("deal-a", "upfront");
  assert.equal(first, installmentPayoutKey("deal-a", "upfront"));
  assert.notEqual(first, installmentPayoutKey("deal-a", "delivery"));
  assert.notEqual(first, installmentPayoutKey("deal-b", "upfront"));
});

test("uncertain installment retries retain their key and confirmed batches are read, not resubmitted", async () => {
  const { reconcileInstallment } = await import("./creator/payments");
  const deal = { id: "deal-a", totalCents: 1001, rightsDays: 30, delivery: "Friday" } as Deal;
  const item = { ...installmentTerms(1001, "split")[0], payment: "pending" as const };
  const calls: string[] = [];
  let fail = true;
  const transport = {
    submit: async (_offer: unknown, key: string) => { calls.push(key); if (fail) { fail = false; throw Error("uncertain"); } return "batch"; },
    status: async () => ({ status: "SUCCESS", itemId: "item" }),
  };
  const uncertain = await reconcileInstallment(deal, item, transport);
  assert.equal(uncertain.payment, "review");
  const confirmed = await reconcileInstallment(deal, { ...item, ...uncertain }, transport);
  assert.equal(confirmed.payment, "confirmed");
  assert.deepEqual(calls, [installmentPayoutKey(deal.id, item.id), installmentPayoutKey(deal.id, item.id)]);
  await reconcileInstallment(deal, { ...item, ...confirmed }, transport);
  assert.equal(calls.length, 2);
});
