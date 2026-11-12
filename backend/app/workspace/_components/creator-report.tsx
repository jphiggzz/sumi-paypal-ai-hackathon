"use client";
import * as Dialog from "@radix-ui/react-dialog";
import { Button } from "./ui/button";
import type { Campaign } from "../../../lib/creator/policy";

export function CreatorReport({ state, open, onClose }: { state: Campaign; open: boolean; onClose: () => void }) {
  const outreach = state.outreach?.revision === state.revision ? state.outreach : undefined;
  const count = outreach?.creatorIds.length || 0;
  const rows = [
    { name: "Sume connected", value: outreach?.responses?.filter((entry) => entry.status === "connected").length || 0 },
    { name: "Email reply", value: outreach?.responses?.filter((entry) => entry.status === "email").length || 0 },
    { name: "No response", value: outreach?.responses?.filter((entry) => entry.status === "none").length || 0 },
  ];
  const approved = state.deals.filter((deal) => deal.approved);
  const committed = approved.reduce((sum, deal) => sum + deal.totalCents, 0);
  const paid = approved.reduce((sum, deal) => sum + (deal.installments ? deal.installments.filter((item) => item.payment === "confirmed").reduce((amount, item) => amount + item.amountCents, 0) : deal.payment === "confirmed" ? deal.milestoneCents : 0), 0);
  const money = (amount: number) => new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" }).format(amount / 100);
  return <Dialog.Root open={open} onOpenChange={(value) => { if (!value) onClose(); }}><Dialog.Portal container={typeof document !== "undefined" ? document.querySelector<HTMLElement>("[data-unified-workspace]") : undefined}><Dialog.Overlay className="fixed inset-0 z-50 bg-black/50"/><Dialog.Content className="fixed left-1/2 top-1/2 z-50 max-h-[90dvh] w-[min(760px,calc(100%-2rem))] -translate-x-1/2 -translate-y-1/2 overflow-auto rounded-2xl bg-background p-6 shadow-xl" aria-describedby={undefined}>
    <div className="flex justify-between gap-4"><Dialog.Title className="text-base font-medium">Campaign report</Dialog.Title><Dialog.Close asChild><Button variant="ghost">Close</Button></Dialog.Close></div>
    <p className="mt-4 text-sm">{state.brief.brand || "Campaign"} · Sample outreach and responses</p>
    {outreach?.status === "responded" ? <div className="mt-5 space-y-3">{rows.map((row) => <div key={row.name} className="grid grid-cols-[110px_1fr_24px] items-center gap-3 text-sm"><span>{row.name}</span><div className="h-3 rounded bg-muted"><div className="h-3 rounded bg-foreground/65" style={{ width: `${count ? row.value / count * 100 : 0}%` }}/></div><span>{row.value}</span></div>)}</div> : <p className="mt-5 text-sm text-muted-foreground">No simulated responses yet.</p>}
    <dl className="mt-6 divide-y divide-border text-sm"><div className="flex justify-between py-3"><dt>Approved agreements</dt><dd>{approved.length}</dd></div><div className="flex justify-between py-3"><dt>Committed</dt><dd>{money(committed)}</dd></div><div className="flex justify-between py-3"><dt>Confirmed Sandbox payouts</dt><dd>{money(paid)}</dd></div></dl>
    <p className="mt-4 text-sm text-muted-foreground">Creator responses are simulated. Campaign visits and performance are not measured.</p>
  </Dialog.Content></Dialog.Portal></Dialog.Root>;
}
