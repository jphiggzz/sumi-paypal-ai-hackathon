import { test } from "node:test";
import assert from "node:assert/strict";
import { giftDigest, validateGiftOptions, verifyGiftOrder, type GiftProduct } from "./gift-policy";
import { normalizeGiftProducts } from "./gift-catalog";
const fact = "ad7c7569-4ba4-44eb-aeb9-72a7fe79aeaf";
const p: GiftProduct = { id: "paint", title: "Paint set", description: "Watercolors", category: "art-craft-paint", url: "https://shop.example/paint", image: null, merchant: "shop.example", cents: 1299, currency: "USD", retrievedAt: new Date().toISOString() };
const plan = { summary: "Paint", options: [{ title: "Painting thank-you", productIds: [p.id], reason: "Shared interest", factIds: [fact], cautions: [] }] };
test("gift options derive exact prices and reserve from returned products", () => { const options = validateGiftOptions(plan, [p], [fact], 2500, 500); assert.equal(options[0].goalCents, 1799); assert.equal(options[0].lines[0].id, p.id); });
test("gift options reject invented products, evidence, duplicates and budget overrun", () => {
  for (const option of [{ ...plan.options[0], productIds: ["invented"] }, { ...plan.options[0], factIds: ["invented"] }, { ...plan.options[0], productIds: [p.id, p.id] }]) assert.equal(validateGiftOptions({ ...plan, options: [option] }, [p], [fact], 2500, 500).length, 0);
  assert.equal(validateGiftOptions(plan, [p], [fact], 1500, 500).length, 0);
});
test("gift approval digest binds context revision, option, job and prices", () => {
  const digest = giftDigest("group", 1, "job", plan);
  assert.notEqual(digest, giftDigest("group", 2, "job", plan)); assert.notEqual(digest, giftDigest("group", 1, "new-job", plan)); assert.notEqual(digest, giftDigest("group", 1, "job", { ...plan, summary: "changed" }));
});
const contribution = { id: "contribution", order_id: "ORDER", amount_cents: 100, merchant_id: "MERCHANT" };
function receipt() { return { id: "ORDER", status: "COMPLETED", purchase_units: [{ custom_id: "contribution", amount: { value: "1.00", currency_code: "USD" }, payee: { merchant_id: "MERCHANT" }, payments: { captures: [{ id: "CAPTURE", status: "COMPLETED", final_capture: true, amount: { value: "1.00", currency_code: "USD" } }] } }] }; }
test("PayPal completed receipt binds order, contribution, currency, amount and merchant", () => { assert.deepEqual(verifyGiftOrder(receipt(), contribution), { id: "CAPTURE", cents: 100 }); });
test("PayPal mismatches never count as a completed contribution", () => {
  for (const mutate of [
    (r: any) => r.id = "OTHER", (r: any) => r.purchase_units[0].custom_id = "OTHER", (r: any) => r.purchase_units[0].amount.value = "2.00", (r: any) => r.purchase_units[0].payee.merchant_id = "OTHER", (r: any) => r.purchase_units[0].payments.captures[0].amount.currency_code = "EUR", (r: any) => r.purchase_units[0].payments.captures[0].final_capture = false,
  ]) { const r = receipt(); mutate(r); assert.throws(() => verifyGiftOrder(r, contribution)); }
});
test("pending payments do not become confirmed funds", () => { const r = receipt(); r.purchase_units[0].payments.captures[0].status = "PENDING"; assert.equal(verifyGiftOrder(r, contribution), null); });
test("gift catalog rejects unsafe links and unsupported merchant/currency/stock", () => {
  const offer = { url: "https://shop.example/paint", domain: "shop.example", price: { price: 12.99, currency: "USD" }, availability: "InStock" };
  const raw = [{ id: "paint", title: "Paint", offers: [offer] }, { id: "unsafe", title: "Paint", offers: [{ ...offer, url: "javascript:alert(1)" }] }, { id: "canada", title: "Paint", offers: [{ ...offer, domain: "shop.ca" }] }, { id: "gone", title: "Paint", offers: [{ ...offer, availability: "OutOfStock" }] }];
  assert.equal(normalizeGiftProducts(raw, 2000).length, 1); assert.equal(normalizeGiftProducts(raw, 1000).length, 0);
});

test("different options cannot reuse the same catalog product", () => {
  const repeated = { ...plan, options: [plan.options[0], { ...plan.options[0], title: "Repeated" }] };
  assert.equal(validateGiftOptions(repeated, [p], [fact], 2500, 500).length, 1);
});
