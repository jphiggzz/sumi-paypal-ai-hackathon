import { z } from "zod";
import { createHash } from "node:crypto";
import { canonicalJson } from "./canonical-json";
export const giftGroupInput = z.object({ id: z.uuid(), recipient: z.string().trim().min(1).max(80), occasion: z.string().trim().min(3).max(600), reserveCents: z.number().int().min(0).max(10000) }).strict();
export const giftChatInput = z.object({ reply: z.string().min(1).max(1800) }).strict();
export const giftDelegateInput = z.object({ summary: z.string().min(1).max(600), factIds: z.array(z.uuid()).min(1).max(20), queries: z.array(z.string().min(5).max(180)).min(1).max(2) }).strict();
export const giftPlanInput = z.object({ summary: z.string().max(1000), options: z.array(z.object({ title: z.string().max(100), productIds: z.array(z.string().max(200)).min(1).max(3), reason: z.string().max(800), factIds: z.array(z.uuid()).min(1).max(30), cautions: z.array(z.string().max(160)).max(4) }).strict()).min(1).max(3) }).strict();
export type GiftProduct = { id: string; title: string; description: string; category: string; url: string; image: string | null; merchant: string; cents: number; currency: "USD"; retrievedAt: string; sourceQueries?: string[] };
export function validateGiftOptions(output: z.infer<typeof giftPlanInput>, products: GiftProduct[], factIds: string[], budgetCents: number, reserveCents: number) {
  const valid = new Set(factIds), catalog = new Map(products.map(p => [p.id, p]));
  const usedProducts = new Set<string>();
  return output.options.flatMap((o, i) => {
    if (!o.factIds.every(id => valid.has(id)) || new Set(o.productIds).size !== o.productIds.length) return [];
    if (o.productIds.some(id => usedProducts.has(id))) return [];
    const lines = o.productIds.map(id => catalog.get(id));
    if (lines.some(p => !p)) return [];
    const subtotalCents = lines.reduce((sum, p) => sum + p!.cents, 0);
    if (subtotalCents + reserveCents > budgetCents) return [];
    o.productIds.forEach(id => usedProducts.add(id));
    return [{ id: String(i), title: o.title, reason: o.reason, factIds: o.factIds, cautions: o.cautions, lines: lines as GiftProduct[], subtotalCents, reserveCents, goalCents: subtotalCents + reserveCents }];
  });
}
export function giftDigest(groupId: string, revision: number, jobId: string, option: unknown) {
  return createHash("sha256").update(canonicalJson({ groupId, revision, jobId, option })).digest("hex");
}
export function giftMoney(cents: number) { return (cents / 100).toFixed(2); }
export function verifyGiftOrder(body: any, contribution: { id: string; amount_cents: number; order_id?: string | null; merchant_id?: string | null }) {
  const unit = body.purchase_units?.[0];
  if (body.id !== contribution.order_id || body.purchase_units?.length !== 1 || unit?.custom_id !== contribution.id || unit.amount?.currency_code !== "USD" || unit.amount?.value !== giftMoney(contribution.amount_cents) || (contribution.merchant_id && unit.payee?.merchant_id !== contribution.merchant_id)) throw new Error("PAYPAL_ORDER_MISMATCH");
  const capture = unit.payments?.captures?.find((c: any) => c.status === "COMPLETED");
  if (capture && (capture.amount?.value !== giftMoney(contribution.amount_cents) || capture.amount?.currency_code !== "USD" || capture.final_capture !== true || typeof capture.id !== "string")) throw new Error("PAYPAL_CAPTURE_MISMATCH");
  return capture ? { id: capture.id as string, cents: contribution.amount_cents } : null;
}
