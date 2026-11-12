"use client";
import { useEffect, useState } from "react";
import * as Dialog from "@radix-ui/react-dialog";
import { Mail, ExternalLink, UsersRound, ChevronRight, X } from "lucide-react";
import { Button } from "./ui/button";
import { creators } from "../../../lib/creator/catalog";
import type { Campaign } from "../../../lib/creator/policy";

export function CreatorOutreach({ state, busy, act, onReview }: { state: Campaign; busy: boolean; act: (command: object) => Promise<boolean>; onReview: (id: string) => void }) {
  const [open, setOpen] = useState(false);
  const [contactsOpen, setContactsOpen] = useState(false);
  const [selected, setSelected] = useState<string[]>([]);
  const [message, setMessage] = useState("");
  const [responses, setResponses] = useState<Record<string, "email" | "connected" | "none">>({});
  const [replies, setReplies] = useState<Record<string, string>>({});
  const outreach = state.outreach?.revision === state.revision ? state.outreach : undefined;
  useEffect(() => {
    setSelected(state.candidates.map((candidate) => candidate.id));
    setMessage(`Hi {{first_name}},\n\nWe'd like to collaborate with you on content for ${state.brief.brand || "our business"}. If you're interested, join Sume to learn more, or reply to this email.\n\nThanks`);
  // Polling returns fresh array instances; preserve edits until the selection actually changes.
  }, [state.brief.brand, state.candidates.map((candidate) => candidate.id).join("|")]);
  useEffect(() => {
    if (outreach?.status === "sent") { setResponses({}); setReplies({}); }
  }, [outreach?.status, outreach?.creatorIds.join("|")]);
  const names = (ids: string[]) => ids.map((id) => creators.find((creator) => creator.id === id)?.name || id).join(", ");
  const firstName = (id: string) => creators.find((creator) => creator.id === id)?.name.split(" ")[0] || "creator";
  const previewMessage = outreach?.message.replaceAll("{{first_name}}", firstName(outreach.creatorIds[0])) || "";
  const signature = previewMessage.match(/\n\s*\n(Thanks[,!]?\s*(?:\n[^\n]+)?)\s*$/i);
  const previewBody = signature ? previewMessage.slice(0, signature.index) : previewMessage;
  return <div className="space-y-3 text-sm">
    {!outreach && <Button variant="outline" onClick={() => setOpen(true)}>Prepare outreach</Button>}
    {outreach?.status === "draft" && <section className="rounded-2xl bg-muted p-5 sm:p-6" aria-label="Sample email draft">
      <div className="flex items-center gap-2.5 font-medium"><span className="grid size-7 place-items-center rounded-md bg-background/60"><Mail aria-hidden="true" className="size-4" /></span>Mail</div>
      <h3 className="mt-4 text-base font-medium">An invitation from {state.brief.brand || "your business"}</h3>
      <dl className="mt-3 divide-y divide-border/70 border-b border-border/70">
        <div className="flex gap-3 py-2.5"><dt className="w-10 shrink-0 text-muted-foreground">From</dt><dd>{state.brief.brand || "Business"}</dd></div>
        <div className="flex gap-3 py-2.5"><dt className="w-10 shrink-0 text-muted-foreground">To</dt><dd className="min-w-0 break-words">{names(outreach.creatorIds)}</dd></div>
      </dl>
      <div className="mt-4 whitespace-pre-wrap leading-6">{previewBody}</div>
      {/\bjoin\s+sume\b/i.test(outreach.message) && <button type="button" disabled aria-label="Join Sume, sample preview" title="Sample preview" className="mt-4 inline-flex items-center gap-2 rounded-full border border-foreground/60 px-4 py-2 text-sm opacity-80">Join Sume <ExternalLink aria-hidden="true" className="size-3.5" /></button>}
      {signature && <p className="mt-4 whitespace-pre-wrap leading-6">{signature[1]}</p>}
      <p className="mt-4 text-xs text-muted-foreground">Sample preview · no email will be sent</p>
      <div className="mt-3 flex flex-wrap justify-end gap-2"><Button variant="ghost" onClick={() => { setSelected(outreach.creatorIds); setMessage(outreach.message); setOpen(true); }}>Edit</Button><Button disabled={busy} onClick={() => void act({ action: "outreach_send", revision: state.revision })}>Send {outreach.creatorIds.length} sample {outreach.creatorIds.length === 1 ? "email" : "emails"}</Button></div>
    </section>}
    {outreach && outreach.status !== "draft" && <div className="space-y-3">
      <details className="group rounded-2xl bg-muted p-4">
        <summary className="flex cursor-pointer list-none items-center gap-3 [&::-webkit-details-marker]:hidden"><span className="grid size-9 shrink-0 place-items-center rounded-lg bg-background/60"><Mail aria-hidden="true" className="size-4" /></span><span className="font-medium">Mail</span><span className="text-muted-foreground">· {outreach.creatorIds.length} sample invitations sent</span><ChevronRight aria-hidden="true" className="ml-auto size-4 text-muted-foreground transition-transform group-open:rotate-90" /></summary>
        <div className="mt-4 border-t border-border/70 pt-3 text-muted-foreground"><p>To · {names(outreach.creatorIds)}</p><p className="mt-3 whitespace-pre-wrap">{previewMessage}</p></div>
      </details>
      <section className="rounded-2xl bg-muted p-4 sm:p-5" aria-label="Sample contacts">
        <div className="flex items-center gap-3"><UsersRound aria-hidden="true" className="size-4" /><span className="font-medium">Contacts</span></div>
        <ul className="mt-3 divide-y divide-border/70">{outreach.creatorIds.slice(0, 3).map((creatorId) => {
          const name = names([creatorId]);
          const response = outreach.responses?.find((entry) => entry.creatorId === creatorId);
          return <li key={creatorId} className="flex min-h-12 items-center gap-3 py-2"><span aria-hidden="true" className="grid size-8 shrink-0 place-items-center rounded-full bg-background text-xs">{initials(name)}</span><span className="min-w-0 flex-1 truncate">{name}</span><ContactStatus status={response?.status} /></li>;
        })}</ul>
        <button type="button" className="mt-1 flex min-h-10 w-full items-center justify-between border-t border-border/70 text-left focus-visible:outline-2 focus-visible:outline-ring" onClick={() => setContactsOpen(true)}><span>{outreach.status === "sent" ? "Choose sample responses" : `View all ${outreach.creatorIds.length}`}</span><ChevronRight aria-hidden="true" className="size-4 text-muted-foreground" /></button>
      </section>
      <Dialog.Root open={contactsOpen} onOpenChange={setContactsOpen}><Dialog.Portal container={typeof document !== "undefined" ? document.querySelector<HTMLElement>("[data-unified-workspace]") : undefined}><Dialog.Overlay className="fixed inset-0 z-50 bg-black/50"/><Dialog.Content className="fixed left-1/2 top-1/2 z-50 max-h-[85dvh] w-[min(760px,calc(100%-2rem))] -translate-x-1/2 -translate-y-1/2 overflow-auto rounded-2xl bg-background p-5 shadow-xl" aria-describedby={undefined}>
        <div className="flex items-center gap-3"><span className="grid size-10 place-items-center rounded-lg bg-muted"><UsersRound aria-hidden="true" className="size-5" /></span><div className="min-w-0 flex-1"><Dialog.Title className="text-base font-medium">Contacts</Dialog.Title><p className="text-sm text-muted-foreground">{outreach.creatorIds.length} sample recipients</p></div><Dialog.Close aria-label="Close contacts" className="rounded-full p-2 hover:bg-muted"><X className="size-4" /></Dialog.Close></div>
        {outreach.status === "sent" ? <>
          <p className="mt-5 text-sm">Choose sample responses</p>
          <ul className="mt-2 divide-y divide-border">{outreach.creatorIds.map((creatorId) => <li key={creatorId} className="space-y-2 py-3"><div className="flex items-center justify-between gap-3"><label htmlFor={`response-${creatorId}`}>{names([creatorId])}</label><select id={`response-${creatorId}`} className="rounded-lg border border-input bg-background p-2" value={responses[creatorId] || "none"} onChange={(event) => setResponses((current) => ({ ...current, [creatorId]: event.target.value as "none" | "email" | "connected" }))}><option value="none">No response</option><option value="email">Email reply</option><option value="connected">Sume connected</option></select></div>{responses[creatorId] && responses[creatorId] !== "none" && <textarea aria-label={`Sample reply from ${names([creatorId])}`} value={replies[creatorId] || ""} onChange={(event) => setReplies((current) => ({ ...current, [creatorId]: event.target.value }))} maxLength={1000} rows={2} placeholder="Sample reply (optional)" className="w-full rounded-lg border border-input bg-background p-2"/>}</li>)}</ul>
          <div className="mt-4 flex justify-end"><Button disabled={busy} onClick={async () => { if (await act({ action: "outreach_responses", revision: state.revision, responses: outreach.creatorIds.map((creatorId) => ({ creatorId, status: responses[creatorId] || "none", reply: replies[creatorId]?.trim() || undefined })) })) setContactsOpen(false); }}>Save sample responses</Button></div>
        </> : <>
          <div className="mt-5 flex flex-wrap items-center gap-2 border-y border-border/70 py-3 text-sm"><span className="mr-2">{outreach.creatorIds.length} total</span>{(["none", "email", "connected"] as const).map((status) => <span key={status} className={`inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 text-xs ${statusColor(status)}`}><span>{outreach.responses?.filter((response) => response.status === status).length || 0}</span><span>{statusLabel(status)}</span></span>)}</div>
          <div aria-hidden="true" className="hidden grid-cols-[minmax(0,1fr)_minmax(90px,0.6fr)_minmax(125px,0.8fr)_100px] gap-3 border-b border-border/70 px-1 py-2 text-xs text-muted-foreground sm:grid"><span>Recipient</span><span>Platform</span><span>Status</span><span /></div>
          <ul className="divide-y divide-border/70">{outreach.creatorIds.map((creatorId) => { const name = names([creatorId]); const creator = creators.find((item) => item.id === creatorId); const response = outreach.responses?.find((entry) => entry.creatorId === creatorId); return <li key={creatorId} className="py-3"><div className="flex flex-wrap items-center gap-3 sm:grid sm:grid-cols-[minmax(0,1fr)_minmax(90px,0.6fr)_minmax(125px,0.8fr)_100px]"><span className="flex min-w-0 flex-1 items-center gap-2"><span aria-hidden="true" className="grid size-8 shrink-0 place-items-center rounded-full bg-muted text-xs">{initials(name)}</span><span className="truncate">{name}</span></span><span className="text-muted-foreground">{creator?.platform}</span><span><ContactStatus status={response?.status} colored /></span><span>{response && response.status !== "none" && <Button variant="outline" size="sm" onClick={() => { setContactsOpen(false); onReview(creatorId); }}>Review deal</Button>}</span></div>{response?.reply && <p className="mt-2 whitespace-pre-wrap pl-10 text-muted-foreground">{response.reply}</p>}</li>; })}</ul>
        </>}
      </Dialog.Content></Dialog.Portal></Dialog.Root>
    </div>}
    <Dialog.Root open={open} onOpenChange={setOpen}><Dialog.Portal container={typeof document !== "undefined" ? document.querySelector<HTMLElement>("[data-unified-workspace]") : undefined}><Dialog.Overlay className="fixed inset-0 z-50 bg-black/50"/><Dialog.Content className="fixed left-1/2 top-1/2 z-50 max-h-[85dvh] w-[min(680px,calc(100%-2rem))] -translate-x-1/2 -translate-y-1/2 overflow-auto rounded-2xl bg-background p-5 shadow-xl" aria-describedby={undefined}>
      <Dialog.Title className="text-base font-medium">Prepare sample outreach</Dialog.Title>
      <div className="my-4 max-h-48 overflow-auto divide-y divide-border">{state.candidates.map((candidate) => { const creator = creators.find((entry) => entry.id === candidate.id); if (!creator) return null; return <label key={candidate.id} className="flex items-center gap-3 py-2"><input type="checkbox" checked={selected.includes(candidate.id)} onChange={(event) => setSelected((current) => event.target.checked ? [...current, candidate.id] : current.filter((id) => id !== candidate.id))}/><span>{creator.name}</span><span className="text-muted-foreground">{creator.platform}</span></label>; })}</div>
      <label className="block">Message<textarea value={message} onChange={(event) => setMessage(event.target.value)} maxLength={3000} rows={7} className="mt-2 w-full rounded-xl border border-input bg-background p-3"/></label>
      <div className="mt-4 flex justify-end gap-2"><Dialog.Close asChild><Button variant="ghost">Cancel</Button></Dialog.Close><Button disabled={busy || !selected.length || !message.trim()} onClick={async () => { if (await act({ action: "outreach_draft", revision: state.revision, creatorIds: selected, message })) setOpen(false); }}>Review email</Button></div>
    </Dialog.Content></Dialog.Portal></Dialog.Root>
  </div>;
}

function initials(name: string): string { return name.trim().split(/\s+/).slice(0, 2).map((part) => part.charAt(0).toUpperCase()).join(""); }
function statusLabel(status?: "none" | "email" | "connected"): string { return status === "connected" ? "Sume connected" : status === "email" ? "Email reply" : status === "none" ? "No response" : "Not set"; }
function statusColor(status: "none" | "email" | "connected"): string { return status === "connected" ? "bg-emerald-500/15 text-emerald-700 dark:text-emerald-200" : status === "email" ? "bg-blue-500/15 text-blue-700 dark:text-blue-200" : "bg-muted text-muted-foreground"; }
function ContactStatus({ status, colored = false }: { status?: "none" | "email" | "connected"; colored?: boolean }) { return <span className={colored && status ? `inline-block rounded-full px-2.5 py-1 text-xs ${statusColor(status)}` : status === "connected" ? "rounded-full border border-border bg-background/50 px-2.5 py-1 text-xs" : "text-xs text-muted-foreground"}>{statusLabel(status)}</span>; }
