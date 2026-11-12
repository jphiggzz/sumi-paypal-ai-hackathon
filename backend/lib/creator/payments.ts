import { submit, status } from "../paypal";
import type { Offer } from "../policy";
import type { Deal } from "./policy";
import { installmentPayoutKey } from "./installments";
export const payoutKey = (id: string) =>
  "creator-" + id.replaceAll("-", "").slice(0, 22);
// The caller persists its pending reservation first. An unknown outcome never
// clears that reservation or permits a fresh sender_batch_id.
export async function reconcileCreatorPayout(
  deal: Deal,
  transport = { submit, status },
) {
  const offer: Offer = {
    creator: "A",
    totalCents: deal.totalCents,
    milestoneCents: deal.milestoneCents,
    rightsDays: deal.rightsDays,
    deliveryDay: deal.delivery,
    visits: 0,
  };
  let batchId = deal.batchId,
    itemId = deal.itemId,
    payment: Deal["payment"] = "pending";
  try {
    batchId ||= await transport.submit(offer, payoutKey(deal.id));
    const receipt = await transport.status(offer, payoutKey(deal.id), batchId);
    if (receipt.status === "SUCCESS") {
      payment = "confirmed";
      itemId = receipt.itemId;
    } else if (
      !["PENDING", "NEW", "PROCESSING", "UNCLAIMED"].includes(receipt.status)
    )
      payment = "review";
  } catch {
    payment = "review";
  }
  return { payment, batchId, itemId };
}

export function mergePaymentReceipt(
  target: Deal,
  receipt: Pick<Deal, "payment" | "batchId" | "itemId">,
  attempt: string,
) {
  if (target.payment === "confirmed") return;
  if (target.paymentAttempt !== attempt && receipt.payment !== "confirmed")
    return;
  target.payment = receipt.payment;
  if (receipt.batchId) target.batchId = receipt.batchId;
  if (receipt.itemId) target.itemId = receipt.itemId;
  target.paymentLease = 0;
}

export async function reconcileInstallment(
  deal: Deal,
  installment: NonNullable<Deal["installments"]>[number],
  transport = { submit, status },
) {
  const offer: Offer = {
    creator: "A", totalCents: deal.totalCents, milestoneCents: installment.amountCents,
    rightsDays: deal.rightsDays, deliveryDay: deal.delivery, visits: 0,
  };
  const key = installmentPayoutKey(deal.id, installment.id);
  let batchId = installment.batchId, itemId = installment.itemId;
  let payment: typeof installment.payment = "pending";
  try {
    batchId ||= await transport.submit(offer, key);
    const receipt = await transport.status(offer, key, batchId);
    if (receipt.status === "SUCCESS") { payment = "confirmed"; itemId = receipt.itemId; }
    else if (!["PENDING", "NEW", "PROCESSING", "UNCLAIMED"].includes(receipt.status)) payment = "review";
  } catch { payment = "review"; }
  return { payment, batchId, itemId };
}
