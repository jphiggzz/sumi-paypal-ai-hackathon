"use client";
import { CalendarDays, Check, ChevronDown } from "lucide-react";
import { creators } from "../../../lib/creator/catalog";
import type { Campaign, Deal } from "../../../lib/creator/policy";
import { Button } from "./ui/button";

const money = (cents: number) => new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", maximumFractionDigits: cents % 100 ? 2 : 0 }).format(cents / 100);
const paymentStatus = (payment: string) => payment === "confirmed" ? "Paid in Sandbox" : payment === "pending" ? "Sandbox payment pending" : payment === "review" ? "Sandbox payment needs review" : "Requires separate authorization";
const creatorName = (deal: Deal) => creators.find((creator) => creator.id === deal.creatorId)?.name || deal.creatorId;

export function CreatorApprovalSchedule({ state, onBoard }: { state: Campaign; onBoard: () => void }) {
  const deals = state.deals.filter((deal) => deal.approved);
  if (!deals.length) return null;
  const total = deals.reduce((sum, deal) => sum + deal.totalCents, 0);
  return <div className="space-y-3 text-sm" aria-label="Approved deals and schedule">
    <p className="flex items-center gap-2"><Check aria-hidden="true" className="size-4" /> Sample terms approved</p>
    <details className="group rounded-2xl bg-muted p-4">
      <summary className="flex cursor-pointer list-none items-center gap-3 [&::-webkit-details-marker]:hidden"><span className="grid size-9 shrink-0 place-items-center rounded-lg bg-background/60"><Check aria-hidden="true" className="size-4" /></span><span className="min-w-0 flex-1"><span className="block font-medium">Deals approved</span><span className="text-muted-foreground">{deals.length} sample {deals.length === 1 ? "deal" : "deals"} · {money(total)} total</span></span><ChevronDown aria-hidden="true" className="size-4 text-muted-foreground transition-transform group-open:rotate-180" /></summary>
      <ul className="mt-3 divide-y divide-border/70 border-t border-border/70">{deals.map((deal) => <li key={deal.id} className="flex flex-wrap justify-between gap-x-4 gap-y-1 py-2.5"><span>{creatorName(deal)}</span><span className="text-muted-foreground">{money(deal.totalCents)} · {deal.paymentStructure === "upfront" ? "100% upfront" : deal.paymentStructure === "split" ? "50% upfront, 50% after delivery" : "Milestone payment"}</span></li>)}</ul>
    </details>
    <section className="rounded-2xl bg-muted p-4 sm:p-5" aria-label="Schedule">
      <h3 className="flex items-center gap-2.5 font-medium"><span className="grid size-7 place-items-center rounded-md bg-background/60"><CalendarDays aria-hidden="true" className="size-4" /></span>Schedule</h3>
      <div className="mt-3 divide-y divide-border/70 border-t border-border/70">{deals.map((deal) => <div key={deal.id} className="grid gap-2 py-3 sm:grid-cols-[minmax(120px,1fr)_minmax(0,2fr)]"><span className="font-medium">{creatorName(deal)}</span><div className="space-y-1.5 text-muted-foreground"><p>Delivery · {deal.delivery}</p>{deal.installments?.map((item) => <p key={item.id}>{item.due === "approval" ? "Upfront" : "After accepted delivery"} · {money(item.amountCents)} · {paymentStatus(item.payment)}</p>)}{!deal.installments && <p>Payment · {paymentStatus(deal.payment)}</p>}</div></div>)}</div>
      <div className="mt-2 flex justify-end"><Button variant="outline" onClick={onBoard}>View campaign board</Button></div>
    </section>
  </div>;
}
