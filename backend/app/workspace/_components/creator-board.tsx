"use client";
import { creators, stages } from "../../../lib/creator/catalog";
import type { Campaign, Deal } from "../../../lib/creator/policy";

const money = (cents: number) => new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", maximumFractionDigits: cents % 100 ? 2 : 0 }).format(cents / 100);
function paymentStatus(deal: Deal) {
  const payments = deal.installments?.map((item) => item.payment) || [deal.payment];
  if (payments.some((status) => status === "review")) return "Needs review";
  if (payments.some((status) => status === "pending")) return "Pending";
  if (payments.every((status) => status === "confirmed")) return "Paid in Sandbox";
  if (payments.some((status) => status === "confirmed")) return "Partially paid in Sandbox";
  return "Not initiated";
}
export default function CreatorBoard({ state, onSelect }: { state: Campaign; onSelect: (id: string) => void }) {
  const ids = [...new Set([...state.candidates.map((candidate) => candidate.id), ...state.deals.map((deal) => deal.creatorId)])];
  const tasks = ids.map((id) => ({ id, creator: creators.find((creator) => creator.id === id), deal: state.deals.find((deal) => deal.creatorId === id) }));
  const committed = state.deals.filter((deal) => deal.approved).reduce((sum, deal) => sum + deal.totalCents, 0);
  return <div className="flex min-h-0 flex-1 flex-col gap-5" aria-label="Campaign board">
    <div className="flex flex-wrap gap-x-6 gap-y-2 rounded-xl border border-border px-4 py-3 text-sm"><span>Budget: {state.brief.budgetCents === null ? "Not set" : money(state.brief.budgetCents)}</span><span>Committed: {money(committed)}</span></div>
    <div tabIndex={0} role="region" aria-label="Campaign stages, scroll horizontally" className="min-h-0 flex-1 overflow-auto pb-1 focus-visible:outline-2 focus-visible:outline-ring"><div className="grid min-h-full min-w-[950px] grid-cols-5 gap-2">{stages.map((stage) => {
      const inStage = tasks.filter(({ deal }) => (deal?.stage || "shortlisted") === stage.id);
      return <section key={stage.id} aria-label={`${stage.text}, ${inStage.length}`} className="min-h-[420px] rounded-xl border border-border p-2.5"><h3 className="flex items-center justify-between px-1 pb-3 text-sm font-medium"><span>{stage.text}</span><span className="text-xs text-muted-foreground">{inStage.length}</span></h3><div className="space-y-2">{inStage.map(({ id, creator, deal }) => <button key={id} type="button" onClick={() => onSelect(id)} className="w-full rounded-xl border border-border bg-muted/40 p-3 text-left text-sm transition-colors hover:bg-muted focus-visible:outline-2 focus-visible:outline-ring"><span className="block font-medium">{creator?.name || id}</span><span className="mt-1 block text-xs text-muted-foreground">{creator?.format || "Creator"}</span>{deal ? <><span className="mt-3 block">{money(deal.totalCents)} · {deal.approved ? "Terms approved" : "Sample terms"}</span><span className="mt-1 block text-xs text-muted-foreground">Payment: {paymentStatus(deal)}</span></> : <span className="mt-3 block text-xs text-muted-foreground">Sample quote · {creator ? money(creator.cents) : "Unavailable"}</span>}</button>)}</div></section>;
    })}</div></div>
  </div>;
}
