import { authPool } from "./auth";
import { transaction } from "./agent-store";
import { CapabilityError } from "./capability-contracts";
import { ownedSnackOffice } from "./snack-store";
import { giftPayPal } from "./gift-paypal";
import { giftMoney, verifyGiftOrder } from "./gift-policy";
import { buildSnackBasket } from "./snack-policy";
import { canonicalJson } from "./canonical-json";
import { createHash } from "node:crypto";
const fail = (code: string, status = 409): never => { throw new CapabilityError(code, status); };
function validBasket(o: any, r: any, digest: string) {
  if (!r || r.office_revision !== o.revision || r.status !== "ready" || r.digest !== digest || !r.products.length || r.products.some((p: any) => p.source !== "fixture")) fail("SNACK_PAYMENT_BASKET_CHANGED");
  const i = r.input;
  const basket = buildSnackBasket(i.settings, r.products, r.reviews, i.stock, i.history, i.stockCheckedAt, Date.now(), (r.discussion ?? []).flatMap((d: any) => d.productIds));
  const hash = createHash("sha256").update(canonicalJson({ id: r.id, revision: o.revision, basket })).digest("hex");
  if (hash !== digest || !basket.lines.length || basket.subtotalCents <= 0 || basket.blockers.some(b => b !== "Sample catalog — no real order")) fail("SNACK_BASKET_NEEDS_REVIEW");
  return basket;
}
export async function createSnackPayment(owner: string, office: string, cycle: string, digest: string, id: string, origin: string, paypal = giftPayPal, returnConversation?: string) {
  await transaction(async c => {
    const o = await ownedSnackOffice(c, owner, office, true);
    const r = (await c.query("SELECT * FROM snack_cycles WHERE office_id=$1 AND id=$2 FOR UPDATE", [office, cycle])).rows[0];
    const basket = validBasket(o, r, digest);
    const existing = (await c.query("SELECT * FROM snack_payments WHERE cycle_id=$1 OR id=$2", [cycle,id])).rows[0];
    if (existing) {
      if (existing.id !== id || existing.owner_id !== owner || existing.digest !== digest || existing.amount_cents !== basket.subtotalCents) fail("SNACK_PAYMENT_CONFLICT");
      return;
    }
    const open = (await c.query("SELECT id FROM snack_payments WHERE office_id=$1 AND status IN ('reserved','created','needs_review')", [office])).rows[0];
    if (open) fail("SNACK_PAYMENT_RECONCILE_FIRST");
    await c.query("INSERT INTO snack_payments(id,office_id,cycle_id,owner_id,digest,amount_cents) VALUES($1,$2,$3,$4,$5,$6)", [id,office,cycle,owner,digest,basket.subtotalCents]);
  });
  await transaction(async c => {
    const o = await ownedSnackOffice(c, owner, office, true);
    const p = (await c.query("SELECT * FROM snack_payments WHERE id=$1 AND office_id=$2 AND owner_id=$3 FOR UPDATE", [id,office,owner])).rows[0];
    if (!p) fail("SNACK_PAYMENT_NOT_FOUND",404);
    if (p.order_id) return;
    const r = (await c.query("SELECT * FROM snack_cycles WHERE id=$1 FOR UPDATE", [p.cycle_id])).rows[0];
    validBasket(o,r,p.digest);
    if (Date.now() - new Date(p.created_at).getTime() > 5 * 3600000) fail("SNACK_PAYMENT_RECONCILE_FIRST");
    try {
      const returnUrl = returnConversation ? `${origin}/workspace?conversation=${returnConversation}&snackPayment=${id}` : `${origin}/snacks?office=${office}&payment=${id}`;
      const cancelUrl = returnConversation ? `${origin}/workspace?conversation=${returnConversation}&snackCancelled=${id}` : `${origin}/snacks?office=${office}&cancelled=${id}`;
      const result = await paypal("/v2/checkout/orders", "POST", { intent: "CAPTURE", purchase_units: [{ custom_id: id, description: "Sume office snack demo — Sandbox demo merchant", amount: { currency_code: "USD", value: giftMoney(p.amount_cents) } }], payment_source: { paypal: { experience_context: { brand_name: "Sume Sandbox", shipping_preference: "NO_SHIPPING", user_action: "PAY_NOW", return_url: returnUrl, cancel_url: cancelUrl } } } }, id);
      const data = result.data;
      const link = data.links?.find((l: any) => ["payer-action","approve"].includes(l.rel))?.href;
      if (!result.ok || typeof data.id !== "string" || !/^[A-Z0-9]{6,32}$/.test(data.id) || !link || !["https://www.sandbox.paypal.com", "https://sandbox.paypal.com"].includes(new URL(link).origin)) throw new Error();
      const detail = await paypal(`/v2/checkout/orders/${data.id}`);
      const merchant = detail.data.purchase_units?.[0]?.payee?.merchant_id;
      if (!detail.ok || typeof merchant !== "string") throw new Error();
      verifyGiftOrder(detail.data, { ...p, order_id: data.id, merchant_id: merchant });
      await c.query("UPDATE snack_payments SET status='created',order_id=$2,merchant_id=$3,approval_url=$4,error_code=null,updated_at=now() WHERE id=$1", [id,data.id,merchant,link]);
    } catch {
      await c.query("UPDATE snack_payments SET status='needs_review',error_code='PAYPAL_CREATE_UNCERTAIN',updated_at=now() WHERE id=$1", [id]);
    }
  });
}
export async function captureSnackPayment(owner: string, office: string, id: string, reconcileOnly = false, paypal = giftPayPal) {
  await transaction(async c => {
    const o = await ownedSnackOffice(c, owner, office, true);
    const p = (await c.query("SELECT * FROM snack_payments WHERE id=$1 AND office_id=$2 AND owner_id=$3 FOR UPDATE", [id,office,owner])).rows[0];
    if (!p?.order_id) fail("SNACK_PAYMENT_NOT_FOUND",404);
    if (p.status === "completed") return;
    try {
      let read = await paypal(`/v2/checkout/orders/${p.order_id}`);
      if (!read.ok) throw new Error();
      let captured = verifyGiftOrder(read.data,p);
      if (!captured && read.data.status === "APPROVED" && !reconcileOnly) {
        const r = (await c.query("SELECT * FROM snack_cycles WHERE id=$1 FOR UPDATE", [p.cycle_id])).rows[0];
        validBasket(o,r,p.digest);
        await paypal(`/v2/checkout/orders/${p.order_id}/capture`, "POST", {}, `capture-${id}`);
        read = await paypal(`/v2/checkout/orders/${p.order_id}`);
        if (!read.ok) throw new Error();
        captured = verifyGiftOrder(read.data,p);
      }
      if (!captured && read.data.status === "COMPLETED") throw new Error();
      if (captured) await c.query("UPDATE snack_payments SET status='completed',capture_id=$2,error_code=null,updated_at=now() WHERE id=$1", [id,captured.id]);
      else await c.query("UPDATE snack_payments SET status=$2,error_code=null,updated_at=now() WHERE id=$1", [id,read.data.status === "VOIDED" ? "cancelled" : "created"]);
    } catch (e) {
      if (e instanceof CapabilityError) throw e;
      await c.query("UPDATE snack_payments SET status='needs_review',error_code='PAYPAL_RECONCILE_REQUIRED',updated_at=now() WHERE id=$1", [id]);
    }
  });
}
export async function snackPaymentState(owner: string, office: string) {
  await ownedSnackOffice(authPool, owner, office);
  return (await authPool.query("SELECT id,cycle_id,digest,amount_cents,status,order_id,approval_url,capture_id,error_code FROM snack_payments WHERE office_id=$1 AND owner_id=$2 ORDER BY created_at DESC LIMIT 30", [office,owner])).rows;
}
