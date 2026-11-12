"use client";
import { useEffect, useState } from "react";
import * as Dialog from "@radix-ui/react-dialog";
import { Mail, ExternalLink } from "lucide-react";
import { Button } from "./ui/button";
import { creators } from "../../../lib/creator/catalog";
import type { Campaign } from "../../../lib/creator/policy";

export function CreatorOutreach({ state, busy, act, onReview }: { state: Campaign; busy: boolean; act: (command: object) => Promise<boolean>; onReview: (id: string) => void }) {
  const [open, setOpen] = useState(false);
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
    {outreach && outreach.status !== "draft" && <section className="rounded-2xl bg-muted p-5 space-y-3">
      <p>Mail · {outreach.creatorIds.length} sample invitations sent</p>
      {outreach.status === "sent" ? <>
        <p>Choose sample responses</p>
        <ul className="divide-y divide-border">{outreach.creatorIds.map((creatorId) => <li key={creatorId} className="space-y-2 py-3">
          <div className="flex items-center justify-between gap-3">
            <label htmlFor={`response-${creatorId}`}>{names([creatorId])}</label>
            <select id={`response-${creatorId}`} className="rounded-lg border border-input bg-background p-2" value={responses[creatorId] || "none"} onChange={(event) => setResponses((current) => ({ ...current, [creatorId]: event.target.value as "none" | "email" | "connected" }))}>
              <option value="none">No response</option><option value="email">Email reply</option><option value="connected">Sume connected</option>
            </select>
          </div>
          {responses[creatorId] && responses[creatorId] !== "none" && <textarea aria-label={`Sample reply from ${names([creatorId])}`} value={replies[creatorId] || ""} onChange={(event) => setReplies((current) => ({ ...current, [creatorId]: event.target.value }))} maxLength={1000} rows={2} placeholder="Sample reply (optional)" className="w-full rounded-lg border border-input bg-background p-2"/>}
        </li>)}</ul>
        <Button variant="outline" disabled={busy} onClick={() => void act({ action: "outreach_responses", revision: state.revision, responses: outreach.creatorIds.map((creatorId) => ({ creatorId, status: responses[creatorId] || "none", reply: replies[creatorId]?.trim() || undefined })) })}>Save sample responses</Button>
      </> : <>
        <p className="font-medium">Contacts · simulated responses</p>
        <ul className="divide-y divide-border">{outreach.responses?.map((response) => <li key={response.creatorId} className="space-y-2 py-3">
          <div className="flex flex-wrap items-center justify-between gap-3"><span>{names([response.creatorId])}</span><span className="flex items-center gap-3"><span>{response.status === "connected" ? "Sume connected" : response.status === "email" ? "Email reply" : "No response"}</span>{response.status !== "none" && <Button variant="outline" onClick={() => onReview(response.creatorId)}>Review deal</Button>}</span></div>
          {response.reply && <p className="whitespace-pre-wrap text-muted-foreground">{response.reply}</p>}
        </li>)}</ul>
      </>}
    </section>}
    <Dialog.Root open={open} onOpenChange={setOpen}><Dialog.Portal container={typeof document !== "undefined" ? document.querySelector<HTMLElement>("[data-unified-workspace]") : undefined}><Dialog.Overlay className="fixed inset-0 z-50 bg-black/50"/><Dialog.Content className="fixed left-1/2 top-1/2 z-50 max-h-[85dvh] w-[min(680px,calc(100%-2rem))] -translate-x-1/2 -translate-y-1/2 overflow-auto rounded-2xl bg-background p-5 shadow-xl" aria-describedby={undefined}>
      <Dialog.Title className="text-base font-medium">Prepare sample outreach</Dialog.Title>
      <div className="my-4 max-h-48 overflow-auto divide-y divide-border">{state.candidates.map((candidate) => { const creator = creators.find((entry) => entry.id === candidate.id); if (!creator) return null; return <label key={candidate.id} className="flex items-center gap-3 py-2"><input type="checkbox" checked={selected.includes(candidate.id)} onChange={(event) => setSelected((current) => event.target.checked ? [...current, candidate.id] : current.filter((id) => id !== candidate.id))}/><span>{creator.name}</span><span className="text-muted-foreground">{creator.platform}</span></label>; })}</div>
      <label className="block">Message<textarea value={message} onChange={(event) => setMessage(event.target.value)} maxLength={3000} rows={7} className="mt-2 w-full rounded-xl border border-input bg-background p-3"/></label>
      <div className="mt-4 flex justify-end gap-2"><Dialog.Close asChild><Button variant="ghost">Cancel</Button></Dialog.Close><Button disabled={busy || !selected.length || !message.trim()} onClick={async () => { if (await act({ action: "outreach_draft", revision: state.revision, creatorIds: selected, message })) setOpen(false); }}>Review email</Button></div>
    </Dialog.Content></Dialog.Portal></Dialog.Root>
  </div>;
}
