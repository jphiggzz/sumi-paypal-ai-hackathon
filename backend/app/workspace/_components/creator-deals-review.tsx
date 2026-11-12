"use client";
import { useState } from "react";
import * as Dialog from "@radix-ui/react-dialog";
import { FileText, X } from "lucide-react";
import { creators } from "../../../lib/creator/catalog";
import type { Campaign } from "../../../lib/creator/policy";
import { Button } from "./ui/button";

const money = (cents: number) => new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", maximumFractionDigits: cents % 100 ? 2 : 0 }).format(cents / 100);

export function CreatorDealsReview({ state, busy, act, onMessage, open, setOpen }: { state: Campaign; busy: boolean; act: (command: object) => Promise<boolean>; onMessage: (message: string) => void; open: boolean; setOpen: (open: boolean) => void }) {
  const pending = state.deals.filter((deal) => !deal.approved && deal.revision === state.revision);
  const [snapshot, setSnapshot] = useState<typeof pending>([]);
  if (!pending.length && !open) return null;
  const total = snapshot.reduce((sum, deal) => sum + deal.totalCents, 0);
  const committed = state.deals.filter((deal) => deal.approved).reduce((sum, deal) => sum + deal.totalCents, 0);
  const enoughBudget = state.brief.budgetCents !== null && committed + total <= state.brief.budgetCents;
  const unchanged = pending.length === snapshot.length && snapshot.every((deal) => pending.some((item) => item.id === deal.id && item.digest === deal.digest));
  return <div className="mt-3 text-sm">
    {pending.length > 0 && <section className="flex flex-wrap items-center gap-3 rounded-2xl bg-muted p-4" aria-label="Deals ready for review">
      <span className="grid size-9 shrink-0 place-items-center rounded-lg bg-background/60"><FileText aria-hidden="true" className="size-4" /></span>
      <span className="min-w-0 flex-1"><span className="block font-medium">Deals</span><span className="text-muted-foreground">{pending.length} {pending.length === 1 ? "deal" : "deals"} · {money(pending.reduce((sum, deal) => sum + deal.totalCents, 0))} total</span></span>
      <Button variant="outline" onClick={() => { setSnapshot(pending); setOpen(true); }}>Review deals</Button>
    </section>}
    <Dialog.Root open={open} onOpenChange={setOpen}><Dialog.Portal container={typeof document !== "undefined" ? document.querySelector<HTMLElement>("[data-unified-workspace]") : undefined}><Dialog.Overlay className="fixed inset-0 z-50 bg-black/50"/><Dialog.Content className="fixed left-1/2 top-1/2 z-50 max-h-[85dvh] w-[min(720px,calc(100%-2rem))] -translate-x-1/2 -translate-y-1/2 overflow-auto rounded-2xl bg-background p-5 shadow-xl sm:p-6" aria-describedby={undefined}>
      <div className="flex items-center justify-between gap-4"><Dialog.Title className="text-base font-medium">Review deals</Dialog.Title><Dialog.Close asChild><button aria-label="Close" className="rounded-md p-1 text-muted-foreground hover:text-foreground"><X className="size-4" /></button></Dialog.Close></div>
      <p className="mt-2 text-xs text-muted-foreground">Sample terms · approval does not send payment</p>
      <div className="mt-5 hidden grid-cols-[minmax(140px,1fr)_minmax(0,2fr)] gap-4 border-b border-border pb-2 text-xs text-muted-foreground sm:grid"><span>Creator</span><span>Deal terms</span></div>
      <ul className="divide-y divide-border">{snapshot.map((deal) => { const creator = creators.find((entry) => entry.id === deal.creatorId); return <li key={deal.id} className="grid gap-2 py-4 sm:grid-cols-[minmax(140px,1fr)_minmax(0,2fr)] sm:gap-4"><span className="font-medium">{creator?.name || deal.creatorId}</span><div className="space-y-1"><p>{money(deal.totalCents)} · {deal.paymentStructure === "upfront" ? "100% upfront" : deal.paymentStructure === "split" ? "50% upfront, 50% after delivery" : "Milestone payment"}</p><p className="text-muted-foreground">{deal.deliverable} · {deal.delivery} · {deal.rightsDays}-day usage</p>{deal.counteroffer && <p className="text-muted-foreground">{deal.counteroffer}</p>}</div></li>; })}</ul>
      <div className="flex justify-between border-t border-border pt-4 font-medium"><span>Total</span><span>{money(total)}</span></div>
      {!unchanged && <p role="status" className="mt-3 text-muted-foreground">Deals changed. Close and review them again.</p>}
      {unchanged && !enoughBudget && <p className="mt-3 text-muted-foreground">{state.brief.budgetCents === null ? "Set a campaign budget before approving." : "These deals exceed the remaining campaign budget."}</p>}
      <div className="mt-5 flex flex-wrap justify-end gap-2"><Dialog.Close asChild><Button variant="ghost">Cancel</Button></Dialog.Close>{state.brief.budgetCents === null ? <Button variant="outline" onClick={() => { setOpen(false); onMessage("Help me set a campaign budget before approving these agreements."); }}>Set budget in chat</Button> : <Button disabled={busy || !unchanged || !enoughBudget} onClick={async () => { if (await act({ action: "approve_deals", revision: state.revision, deals: snapshot.map((deal) => ({ dealId: deal.id, digest: deal.digest })) })) setOpen(false); }}>Approve exact terms</Button>}</div>
    </Dialog.Content></Dialog.Portal></Dialog.Root>
  </div>;
}
