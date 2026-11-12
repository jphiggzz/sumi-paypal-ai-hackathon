"use client";

import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import * as Dialog from "@radix-ui/react-dialog";
import { ArrowUp, ChevronDown, X } from "lucide-react";
import { Button } from "./ui/button";
import { Mascot, AgentTeamHeader } from "./agent-avatar";
import { Sheet, SheetContent, SheetHeader, SheetTitle, SheetDescription, SheetFooter } from "./ui/sheet";

type Message = { id: string; role: string; content: string; status?: string };
type Product = { id: string; title: string; image: string | null; url: string; merchant: string; cents: number; retrievedAt: string };
type Turn = { name: string; content: string; phase: string; perspective?: boolean; simulated?: boolean };
type Option = { id: string; title: string; reason: string; lines: Product[]; goalCents: number; cautions: string[] };
type Job = { id: string; kind: string; status: string; revision: number; input?: { seedRequest?: { chatMessageId?: string } }; error_code?: string; result?: { phase?: string; transcript?: Turn[]; options?: Option[]; summary?: string } | null };
type Flow = { draft?: { participantChoice?: string }; state: { members: { id: string; name: string; simulated: boolean }[]; group: { id: string; revision: number; reserveCents: number; budgetCents: number; organizer?: boolean }; me: { id: string; limitCents: number }; facts: { member_id: string; message_id: string; content: string }[]; jobs: Job[]; channel3Configured: boolean } };
type Action = (command: unknown) => Promise<any>;
const agents = [{ name: "Scout", color: "#b4d3be" }, { name: "Muse", color: "#d2c4e6" }, { name: "Dot", color: "#e8c9ae" }];
const money = (cents: number) => new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" }).format(cents / 100);
export default function LiveGiftGroup({ flow, messages, checkpointNodes, busy, act, onOpenGroup }: { flow: Flow; messages: Message[]; checkpointNodes: Record<string, HTMLElement>; busy: boolean; act: Action; onOpenGroup: (selection?: {jobId: string; optionId: string}) => void }) {
  const s = flow.state;
  const [open, setOpen] = useState(false);
  const [focused, setFocused] = useState<{ product: Product; jobId: string; optionId: string; current: boolean; optionCount: number } | null>(null);
  const [setup, setSetup] = useState(false);
  const [selected, setSelected] = useState<string[]>([]);
  const [limit, setLimit] = useState("");
  const [feedback, setFeedback] = useState("");
  const [error, setError] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const pending = useRef<{ kind: "start" | "feedback"; text: string; feedbackId: string; jobId: string } | null>(null);
  const pendingKey = `sume.live-gift.pending.${s.group.id}`;
  useEffect(() => {
    try {
      const saved = JSON.parse(sessionStorage.getItem(pendingKey) || "null");
      if (saved && (saved.kind === "start" || saved.kind === "feedback") && typeof saved.text === "string" && typeof saved.feedbackId === "string" && typeof saved.jobId === "string") {
        pending.current = saved;
        if (saved.kind === "feedback") setFeedback(saved.text);
      }
    } catch { /* Ignore malformed local retry state. */ }
  }, [pendingKey]);
  const solo = flow.draft?.participantChoice === "solo" && s.members.length === 1;
  const participants = solo ? agents : s.members.map((member, index) => ({ name: member.name, color: agents[index % agents.length].color }));
  const description = solo ? "Three AI perspectives · live Channel3" : `${s.members.length} ${s.members.length === 1 ? "participant" : "participants"} · live Channel3`;
  const ownFacts = s.facts.filter((fact) => fact.member_id === s.me.id);
  const latest = s.jobs.find((job) => job.kind === "plan" && job.revision === s.group.revision);
  const running = Boolean(latest && ["queued", "running"].includes(latest.status));
  const ready = latest?.status === "ready" ? latest.result : null;
  const results = s.jobs.filter((job) => job.kind === "plan" && job.status === "ready" && job.result).slice().reverse();
  const visibleResult = results.at(-1)?.result;
  const focusedJob = focused ? s.jobs.find((job) => job.id === focused.jobId) : undefined;
  const focusedOption = focusedJob?.result?.options?.find((option) => option.id === focused?.optionId);
  const focusedSubtotal = focusedOption?.lines.reduce((total, line) => total + line.cents, 0);
  const otherProduct = focusedOption?.lines.find((line) => line.id !== focused?.product.id);
  const focusedReason = focusedOption?.reason?.trim().split(/(?<=[.!?])\s+/)[0];

  const candidates = messages.filter((message) => message.role === "user" && message.status !== "failed" && message.content.length <= 1500 && !/^start (?:the )?group(?: preview)?\.?$/i.test(message.content));
  useEffect(() => { if (s.me.limitCents > 0) setLimit((s.me.limitCents / 100).toString()); }, [s.me.limitCents]);
  const idsFor = (kind: "start" | "feedback", text = "") => {
    if (!pending.current || pending.current.kind !== kind || pending.current.text !== text) {
      pending.current = { kind, text, feedbackId: crypto.randomUUID(), jobId: crypto.randomUUID() };
      sessionStorage.setItem(pendingKey, JSON.stringify(pending.current));
    }
    return pending.current;
  };
  async function startSearch() {
    const cents = Math.round(Number(limit) * 100);
    if (!Number.isInteger(cents) || cents <= 0 || s.group.budgetCents - s.me.limitCents + cents <= s.group.reserveCents || cents > 20000 || (!selected.length && !ownFacts.length)) return;
    setSubmitting(true); setError("");
    const ids = idsFor("start", JSON.stringify({ cents, selected: [...selected].sort() }));
    try {
      if (cents !== s.me.limitCents && !await act({ action: "gift", payload: { action: "limit", cents } })) throw Error("Couldn’t save the contribution limit.");
      for (const messageId of selected) {
        if (!ownFacts.some((fact) => fact.message_id === messageId) && !await act({ action: "share_context", messageId, active: true })) throw Error("Couldn’t share the selected detail.");
      }
      if (!await act({ action: "gift", payload: { action: "plan", id: ids.jobId } })) throw Error("Couldn’t start the search. Try again.");
      pending.current = null; sessionStorage.removeItem(pendingKey); setSetup(false); setOpen(true);
    } catch (e) { setError(e instanceof Error ? e.message : "Couldn’t start the search."); }
    finally { setSubmitting(false); }
  }
  async function sendFeedback(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const text = feedback.trim(); if (!text || submitting) return;
    setSubmitting(true); setError(""); const ids = idsFor("feedback", text);
    try {
      if (!await act({ action: "group_feedback", id: ids.feedbackId, text })) throw Error("Couldn’t share your feedback.");
      if (!await act({ action: "gift", payload: { action: "plan", id: ids.jobId } })) throw Error("Feedback was shared, but the search didn’t start. Try again.");
      pending.current = null; sessionStorage.removeItem(pendingKey); setFeedback(""); setOpen(true);
    } catch (e) { setError(e instanceof Error ? e.message : "Couldn’t start the next round."); }
    finally { setSubmitting(false); }
  }
  const first = visibleResult?.options?.[0]?.lines?.[0];
  const suggestions = first ? [`More like ${first.title}`, `Less like ${first.title}`, "Show different ideas"] : ["Try a different direction"];
  const phase: Record<string, string> = { briefing: "Considering the brief…", searching: "Searching Channel3…", discussing: "Comparing ideas…", comparing: "Preparing results…" };
  return <>
    <div className="mt-4 rounded-2xl bg-muted p-5 sm:p-6">
      <AgentTeamHeader participants={participants} title="Gift agents" description={description} action={<Button className="rounded-full" disabled={busy || submitting} onClick={() => latest ? setOpen(true) : setSetup(!setup)}>{latest ? "Open group chat" : "Start group chat"}</Button>} />
      {!setup && (s.me.limitCents > 0 || ownFacts.length > 0) && <button type="button" aria-expanded="false" onClick={() => setSetup(true)} className="mt-4 flex w-full items-center gap-2 rounded-xl bg-background/60 px-3 py-3 text-left text-sm"><span aria-hidden="true">✓</span><span>Shared details</span><span className="text-muted-foreground">{s.me.limitCents > 0 ? money(s.me.limitCents) : ""}</span></button>}
      {setup && <div className="mt-5 space-y-4 border-t border-border pt-4">
        <fieldset><legend className="mb-2 text-sm font-medium">Choose what to share with the gift agents</legend><div className="space-y-1">{candidates.map((message) => <label key={message.id} className="flex cursor-pointer items-start gap-3 rounded-xl px-2 py-2 text-sm hover:bg-background/70"><input type="checkbox" checked={selected.includes(message.id) || ownFacts.some((fact) => fact.message_id === message.id)} disabled={ownFacts.some((fact) => fact.message_id === message.id)} onChange={(event) => setSelected((current) => event.target.checked ? [...current, message.id] : current.filter((id) => id !== message.id))} className="mt-1 size-4 accent-foreground" /><span className="whitespace-pre-wrap">{message.content}</span></label>)}</div></fieldset>
        <label className="block text-sm font-medium" htmlFor="live-gift-limit">Your contribution limit ($)</label><input id="live-gift-limit" type="number" min="0.01" max="200" step="0.01" value={limit} onChange={(event) => setLimit(event.target.value)} className="w-40 rounded-full border border-border bg-background px-4 py-2 text-sm" placeholder="Amount" />
        <p className="text-xs text-muted-foreground">Includes a {money(s.group.reserveCents)} reserve. Your selection is shared with the gift group.</p>
        {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
        <Button disabled={busy || submitting || !s.channel3Configured || (!selected.length && !ownFacts.length) || !limit || s.group.budgetCents - s.me.limitCents + Number(limit) * 100 <= s.group.reserveCents || Number(limit) > 200} onClick={() => void startSearch()} className="rounded-full">{submitting ? "Starting…" : "Share and search"}</Button>
      </div>}
    </div>
    {running && <p role="status" className="mt-4 text-sm text-muted-foreground">{phase[latest?.result?.phase || ""] || "Starting search…"}</p>}
    {latest?.status === "failed" && <div className="mt-4 rounded-2xl bg-muted p-4 text-sm"><p>Search couldn’t finish{latest.error_code ? ` · ${latest.error_code.replaceAll("_", " ")}` : ""}.</p><Button variant="outline" className="mt-3 rounded-full" disabled={busy || submitting} onClick={() => { setSetup(true); setOpen(false); }}>Try again</Button></div>}
    {results.map((resultJob) => {
      if (!resultJob.result) return null;
      const userIndex = messages.findIndex((m) => m.id === resultJob.input?.seedRequest?.chatMessageId);
      const reply = userIndex >= 0 ? messages.slice(userIndex + 1).find((m) => m.role === "assistant") : undefined;
      const target = reply ? checkpointNodes[reply.id] : undefined;
      const card = <div key={resultJob.id} className="mt-5 space-y-3"><p className="text-sm">{resultJob.result.summary || "Here are the gifts the agents found."}</p><div className="@container rounded-2xl bg-muted p-4"><p className="mb-3 text-xs text-muted-foreground">{resultJob.revision === s.group.revision ? "Channel3 results" : "Earlier Channel3 results"}</p><div className="grid gap-2 @[480px]:grid-cols-2 @[720px]:grid-cols-3">{(resultJob.result.options || []).map((option) => <div key={option.id} className="overflow-hidden rounded-xl bg-background">{option.lines.map((product) => <button type="button" key={product.id} onClick={() => { const item = { product, jobId: resultJob.id, optionId: option.id, current: resultJob.revision === s.group.revision, optionCount: option.lines.length }; setFocused(item); window.dispatchEvent(new CustomEvent("sume-product-focus", { detail: item })); }} className="block w-full text-left focus-visible:outline-2 focus-visible:outline-ring">{product.image && <img src={product.image} alt="" loading="lazy" className="aspect-square w-full bg-neutral-100 object-contain" />}<div className="p-3"><p className="line-clamp-2 text-sm font-medium">{product.title}</p><p className="mt-1 text-xs text-muted-foreground">{product.merchant} · {money(product.cents)}</p>{product.retrievedAt && !Number.isNaN(Date.parse(product.retrievedAt)) && <p className="mt-1 text-xs text-muted-foreground">Retrieved {new Date(product.retrievedAt).toLocaleDateString()}</p>}</div></button>)}<p className="px-3 pb-3 text-sm text-muted-foreground">{option.reason}</p></div>)}</div>{!resultJob.result.options?.length && <p className="text-sm">No suitable products found. Try different feedback.</p>}</div></div>;
      return target ? createPortal(card, target, resultJob.id) : card;
    })}
    {ownFacts.filter((fact) => !messages.some((message) => message.id === fact.message_id)).map((fact) => <details key={fact.message_id} className="mt-3 rounded-2xl bg-muted px-4 py-3 text-sm"><summary className="cursor-pointer">Shared with agents · {fact.content}</summary></details>)}
    {visibleResult && <div className="mt-4 space-y-3"><form onSubmit={sendFeedback} className="rounded-2xl bg-muted p-4"><p className="mb-3 text-sm font-medium">What should the next pass change?</p><div className="mb-3 flex flex-wrap gap-2">{suggestions.map((suggestion) => <button type="button" key={suggestion} onClick={() => setFeedback(suggestion)} className="max-w-full rounded-full bg-background px-3 py-2 text-left text-sm break-words hover:opacity-75">{suggestion}</button>)}</div><div className="flex items-center gap-2 rounded-xl bg-background px-3"><label htmlFor="live-gift-feedback" className="sr-only">Feedback for the gift agents</label><input id="live-gift-feedback" value={feedback} onChange={(event) => setFeedback(event.target.value)} maxLength={1500} placeholder="Tell the agents what to change" className="min-w-0 flex-1 bg-transparent py-3 text-sm outline-none"/><Button type="submit" size="icon" aria-label="Send feedback" disabled={!feedback.trim() || busy || submitting || running} className="rounded-full"><ArrowUp size={18}/></Button></div>{error && <p role="alert" className="mt-2 text-sm text-destructive">{error}</p>}</form><Button variant="ghost" onClick={() => onOpenGroup()}>Review and approve a gift</Button></div>}

    <Sheet modal={false} open={Boolean(focused)} onOpenChange={(isOpen) => { if (!isOpen) { setFocused(null); window.dispatchEvent(new CustomEvent("sume-product-focus", { detail: null })); } }}>
      <SheetContent side="right" showOverlay={false} onOpenAutoFocus={(event) => event.preventDefault()} onInteractOutside={(event) => event.preventDefault()} className="w-[min(100vw,420px)] max-w-none gap-0 sm:max-w-none">
        {focused && <>
          <SheetHeader className="shrink-0 border-b pr-12">
            <SheetTitle>Gift details</SheetTitle>
            <SheetDescription className="sr-only">Review the selected product or search for similar gifts.</SheetDescription>
          </SheetHeader>
          <div className="flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto p-5">
            {focused.product.image && <img src={focused.product.image} alt="" className="h-[min(40vh,360px)] w-full shrink-0 rounded-xl bg-muted object-contain"/>}
            <div className="flex flex-col gap-1">
              <h2 className="text-xl font-semibold">{focused.product.title}</h2>
              <p className="text-lg">{money(focused.product.cents)}</p>
              <a href={focused.product.url} target="_blank" rel="noopener noreferrer" className="text-sm text-muted-foreground underline">{focused.product.merchant}</a>
            </div>
            {focusedOption && <details className="group rounded-2xl bg-muted">
              <summary className="flex cursor-pointer list-none items-center gap-3 p-4 focus-visible:outline-2 focus-visible:outline-ring [&::-webkit-details-marker]:hidden">
                {otherProduct?.image && <img src={otherProduct.image} alt="" className="size-12 rounded-lg bg-background object-contain"/>}
                <span className="min-w-0 flex-1"><span className="block font-medium">Gift plan</span><span className="block text-sm text-muted-foreground">{focusedOption.lines.length} {focusedOption.lines.length === 1 ? "item" : "items"} · {money(focusedSubtotal ?? 0)} subtotal</span></span>
                <ChevronDown aria-hidden="true" className="size-4 shrink-0 text-muted-foreground transition-transform group-open:rotate-180"/>
              </summary>
              <div className="flex flex-col gap-3 border-t border-border px-4 py-3">
                {focusedOption.lines.map((line) => <div key={line.id} className="flex items-center gap-3 text-sm">{line.image && <img src={line.image} alt="" className="size-10 rounded-lg bg-background object-contain"/>}<span className="min-w-0 flex-1">{line.title}</span><span className="shrink-0">{money(line.cents)}</span></div>)}
                <p className="text-xs text-muted-foreground">Subtotal excludes the {money(s.group.reserveCents)} reserve.</p>
              </div>
            </details>}
            {focusedReason && <p className="text-sm leading-relaxed">{focusedReason}</p>}
          </div>
          <SheetFooter className="shrink-0 border-t sm:flex-row">
            <Button variant="outline" aria-label="Find similar with gift agents" className="flex-1 rounded-full" disabled={busy || running} onClick={() => window.dispatchEvent(new CustomEvent("sume-product-refine", { detail: { ...focused, text: "Find similar", similar: true } }))}>Find similar</Button>
            <Button className="flex-1 rounded-full" disabled={busy || focusedJob?.revision !== s.group.revision || !s.group.organizer} onClick={() => onOpenGroup({ jobId: focused.jobId, optionId: focused.optionId })}>Review gift</Button>
          </SheetFooter>
        </>}
      </SheetContent>
    </Sheet>
    <Dialog.Root open={open} onOpenChange={setOpen}><Dialog.Portal container={typeof document !== "undefined" ? document.querySelector<HTMLElement>("[data-unified-workspace]") : undefined}><Dialog.Overlay className="fixed inset-0 z-50 bg-black/50"/><Dialog.Content className="fixed left-1/2 top-1/2 z-50 flex h-[min(700px,90dvh)] w-[min(680px,calc(100%-2rem))] -translate-x-1/2 -translate-y-1/2 flex-col overflow-hidden rounded-3xl bg-background shadow-xl focus:outline-none" aria-describedby="live-gift-description">
      <header className="flex items-center gap-3 border-b border-border px-5 py-4"><div className="flex -space-x-2">{participants.map((agent, index) => <Mascot key={`${agent.name}-${index}`} color={agent.color} small />)}</div><div className="min-w-0 flex-1"><Dialog.Title className="text-sm font-semibold">Gift agents</Dialog.Title><p id="live-gift-description" className="text-xs text-muted-foreground">{description}</p></div><Dialog.Close aria-label="Close group chat" className="rounded-full p-2 hover:bg-muted"><X size={18}/></Dialog.Close></header>
      <div className="flex-1 space-y-4 overflow-y-auto px-5 py-5" role="log" aria-live="polite">{latest?.result?.transcript?.map((turn, index) => { const agent = participants.find((item) => item.name === turn.name); return <div key={`${latest.id}-${index}`} className="flex gap-2"><Mascot color={agent?.color || "#d2c4e6"} small/><div className="min-w-0"><p className="mb-1 text-xs text-muted-foreground">{turn.name}{turn.simulated ? " · simulated participant" : turn.perspective ? " · AI perspective" : "’s agent"}</p><p className="whitespace-pre-wrap rounded-2xl bg-muted px-4 py-3 text-sm">{turn.content.replace(/\s*\((?:product(?: index)?|index)\s+\d+\)/gi, "")}</p></div></div>; })}{running && <p role="status" className="text-sm text-muted-foreground">{phase[latest?.result?.phase || ""] || "Starting search…"}</p>}{latest?.status === "failed" && <p role="alert" className="text-sm text-destructive">Search couldn’t finish. Close this view to retry.</p>}</div>
      <div className="flex justify-end border-t border-border p-4"><Dialog.Close asChild><Button className="rounded-full" variant={ready ? "default" : "outline"}>{ready ? "View results" : "Close"}</Button></Dialog.Close></div>
    </Dialog.Content></Dialog.Portal></Dialog.Root>
  </>;
}
