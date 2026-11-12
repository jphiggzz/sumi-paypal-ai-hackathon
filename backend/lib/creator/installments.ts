import { createHash } from "node:crypto";

export type PaymentStructure = "upfront" | "split";
export type Installment = {
  id: "upfront" | "delivery";
  amountCents: number;
  due: "approval" | "accepted_delivery";
};

/** Produce exact integer amounts; the second installment receives any odd cent. */
export function installmentTerms(totalCents: number, structure: PaymentStructure): Installment[] {
  if (!Number.isSafeInteger(totalCents) || totalCents < 2)
    throw new Error("Agreement total must be at least two cents.");
  if (structure === "upfront")
    return [{ id: "upfront", amountCents: totalCents, due: "approval" }];
  if (structure !== "split") throw new Error("Unsupported payment structure.");
  const first = Math.floor(totalCents / 2);
  return [
    { id: "upfront", amountCents: first, due: "approval" },
    { id: "delivery", amountCents: totalCents - first, due: "accepted_delivery" },
  ];
}

/** Distinct, stable provider keys for every installment of an agreement. */
export function installmentPayoutKey(dealId: string, installmentId: Installment["id"]): string {
  return `creator-${createHash("sha256").update(`${dealId}:${installmentId}`).digest("hex").slice(0, 24)}`;
}

export function installmentEligible(
  installment: Installment,
  state: { approved: boolean; acceptedDelivery: boolean; priorConfirmed?: boolean },
): boolean {
  return state.approved && (installment.due === "approval" || (state.acceptedDelivery && state.priorConfirmed === true));
}
