"use client";
import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import LiveGiftGroup from "./live-gift-group";
import { giftBudgetAvailability, giftBudgetResponse } from "../../../lib/gift-planning";
import { giftFollowupAnchor } from "../../../lib/gift-checkpoint-anchors";
import { Check, ChevronDown, X } from "lucide-react";
import * as Dialog from "@radix-ui/react-dialog";
import { QRCodeSVG } from "qrcode.react";
import { Button } from "./ui/button";
import { Input } from "./ui/input";
import { LabelText, MoneyField } from "./workflow-fields";
// Older persisted turns may name internal catalog indexes. Those references
// remain in structured job data; public conversation text uses product names.
const publicText = (text: string) =>
  text.replace(/\s*\((?:product(?: index)?|index)\s+\d+\)/gi, "");
type Message = { id: string; role: string; content: string; status?: string; interaction?: { type: string; options: string[]; next?: "explore" | "ready" } | null };
const money = (n: number) =>
  new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" }).format(
    n / 100,
  );
export default function GiftCard({
  flow: f,
  busy,
  act,
  messages,
  inviteUrl,
  conversationId,
  onViewChange,
  checkpointNodes,
  headerTarget,
}: {
  flow: any;
  busy: boolean;
  act: (v: any) => Promise<any>;
  messages: Message[];
  inviteUrl: string;
  conversationId: string;
  onViewChange: (view: "group" | "private" | "payment" | null) => void;
  checkpointNodes: Record<string, HTMLElement>;
  headerTarget: HTMLElement | null;
}) {
  const s = f.state,
    g = s.group,
    o = s.option;
  const [limit, setLimit] = useState(""),
    [amount, setAmount] = useState(""),
    [view, setView] = useState<"group" | "private" | "payment">("group"),
    [feedback, setFeedback] = useState(""),
    [showGroup, setShowGroup] = useState(false),
    [editing, setEditing] = useState<"budget" | "share" | null>(null),
    [customBudget, setCustomBudget] = useState(false),
    [inviteStep, setInviteStep] = useState<"loading" | "choose" | "invite" | "done">("loading"),
    [inviteChoice, setInviteChoice] = useState<"solo" | "invite" | "existing" | null>(null),
    [copied, setCopied] = useState(false),
    [editingTitle, setEditingTitle] = useState(false),
    [title, setTitle] = useState(g.title || "");
  const processedReturn = useRef<string | null>(null);
  const ownFacts = s.facts.filter((fact: any) => fact.member_id === s.me.id);
  const followup = giftFollowupAnchor(messages, f.draft?.initialTitle || g.title);
  const hasAnsweredFollowup = followup.answered;
  const liveHandoff = f.draft?.version === 2 ? messages.find((m) => m.interaction?.type === "gift_mock_handoff") : undefined;
  const liveTarget = liveHandoff ? checkpointNodes[liveHandoff.id] : null;
  const budgetResponse = giftBudgetResponse(messages, followup.assistantId);
  const budgetTarget = budgetResponse.anchorId ? checkpointNodes[budgetResponse.anchorId] || null : null;
  const interactiveClarification = messages.some((m) => m.interaction?.type === "gift_clarification");
  const { show: showBudget, offer: offerBudget } = giftBudgetAvailability({
    newDraft: f.draft?.version === 2,
    limitCents: s.me.limitCents,
    hasSharedFacts: ownFacts.length > 0,
    readyForBudget: Boolean(f.draft?.readyForBudget),
    answered: hasAnsweredFollowup,
    interactive: interactiveClarification,
    responseFinished: budgetResponse.eligible,
  });
  useEffect(() => {
    const saved = f.draft?.version === 2 ? f.draft.participantChoice : sessionStorage.getItem(`sume.gift.path.${conversationId}`);
    const choice = saved === "solo" || saved === "invite" ? saved : saved === "done" || s.me.limitCents > 0 ? "existing" : null;
    setInviteChoice(choice);
    setInviteStep(!g.organizer ? "done" : f.draft?.version === 2 && choice === "invite" && !f.draft.inviteComplete ? "invite" : choice ? "done" : "choose");
  }, [conversationId, g.organizer]);
  const completeInviteStep = async (choice: "solo" | "invite") => {
    if (f.draft?.version === 2) {
      if (!await act({ action: "gift_draft", participantChoice: choice, ...(choice === "invite" ? { inviteComplete: true } : {}) })) return;
    } else sessionStorage.setItem(`sume.gift.path.${conversationId}`, choice);
    setInviteChoice(choice);
    setInviteStep("done");
  };
  const budgetOpen = editing === "budget" || (editing === null && s.me.limitCents <= 0);
  const shareOpen = editing === "share" || (editing === null && s.me.limitCents > 0 && !ownFacts.length);
  useEffect(() => {
    onViewChange("private");
    return () => onViewChange(null);
  }, [onViewChange]);
  useEffect(() => {
    setLimit(s.me.limitCents ? (s.me.limitCents / 100).toString() : "");
  }, [s.me.limitCents]);
  const gift = (payload: any) => act({ action: "gift", payload });
  useEffect(() => {
    if (!o) return;
    const reserved = s.payments.filter((p: any) => !["failed", "cancelled"].includes(p.status)).reduce((sum: number, p: any) => sum + p.amount_cents, 0);
    const available = Math.max(0, Math.min(s.me.limitCents - reserved, o.goalCents - g.fundedCents));
    setAmount(available ? (available / 100).toFixed(2) : "");
  }, [o?.digest, s.me.limitCents, g.fundedCents]);
  useEffect(() => {
    const url = new URL(window.location.href);
    const cancelled = url.searchParams.get("cancelled");
    if (cancelled && s.payments.some((p: any) => p.id === cancelled)) {
      setView("payment"); setShowGroup(true);
      url.searchParams.delete("cancelled"); url.searchParams.delete("token");
      window.history.replaceState(null, "", url.pathname + url.search + url.hash);
      return;
    }
    const id = url.searchParams.get("contribution");
    if (!id || processedReturn.current === id || !s.payments.some((p: any) => p.id === id)) return;
    processedReturn.current = id;
    setView("payment");
    setShowGroup(true);
    void (async () => {
      const result = await act({ action: "gift", payload: { action: "capture", id } });
      if (!result) return;
      const payment = result.flows?.find((flow: any) => flow.kind === "gift")?.state?.payments?.find((entry: any) => entry.id === id);
      if (payment?.status === "completed") {
        for (let index = sessionStorage.length - 1; index >= 0; index--) {
          const key = sessionStorage.key(index);
          if (key?.startsWith(`sume.workspace.intent.${conversationId}.fund:`) && sessionStorage.getItem(key) === id) sessionStorage.removeItem(key);
        }
      }
      url.searchParams.delete("contribution"); url.searchParams.delete("token"); url.searchParams.delete("PayerID");
      window.history.replaceState(null, "", url.pathname + url.search + url.hash);
    })();
  }, [conversationId, s.payments, act]);
  const plan = s.jobs.find(
    (j: any) =>
      j.kind === "plan" && j.revision === g.revision && j.status === "ready",
  );
  const latest = s.jobs.find(
    (j: any) => j.kind === "plan" && j.revision === g.revision,
  );
  const transcript = latest?.result?.transcript || [];
  const running = s.jobs.some((j: any) =>
    ["queued", "running"].includes(j.status),
  );
  const planRunning = Boolean(latest && ["queued", "running"].includes(latest.status));
  const progressLabel: Record<string, string> = {
    briefing: "Reviewing shared details…",
    searching: "Searching for gifts…",
    discussing: "Agents comparing ideas…",
    comparing: "Preparing gift options…",
  };
  function identity(key: string) {
    const storageKey = `sume.workspace.intent.${conversationId}.${key}`;
    const prior = sessionStorage.getItem(storageKey);
    if (prior) return prior;
    const id = crypto.randomUUID();
    sessionStorage.setItem(storageKey, id);
    return id;
  }
  const planningContent = (<section aria-label="Gift planning" className="flex flex-col gap-2">{offerBudget && <Button type="button" variant="outline" className="self-start" disabled={busy} onClick={() => void act({ action: "gift_draft", readyForBudget: true })}>Set contribution limit</Button>}        {showBudget && <div className="overflow-hidden rounded-2xl bg-muted">
          {budgetOpen ? (
            <div className="p-5 sm:p-6">
              <p className="mb-4 text-sm font-medium">What’s your contribution limit?</p>
              <div className="flex flex-col gap-1">
                {[2500, 5000, 10000].map((cents, index) => (
                  <button key={cents} type="button" disabled={busy} onClick={async () => {
                    if (await gift({ action: "limit", cents })) { setEditing(null); setCustomBudget(false); }
                  }} className="group flex min-h-11 w-full items-center gap-3 rounded-xl px-2 text-left text-sm transition-colors hover:bg-background/70 focus-visible:outline-2 focus-visible:outline-ring disabled:opacity-50">
                    <span aria-hidden="true" className="grid size-7 place-items-center rounded-lg bg-background/70 text-xs text-muted-foreground">{String.fromCharCode(65 + index)}</span>
                    <span>{new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 0 }).format(cents / 100)}</span>
                  </button>
                ))}
                {!customBudget && <button type="button" onClick={() => setCustomBudget(true)} className="flex min-h-11 items-center gap-3 rounded-xl px-2 text-left text-sm transition-colors hover:bg-background/70 focus-visible:outline-2 focus-visible:outline-ring"><span aria-hidden="true" className="grid size-7 place-items-center rounded-lg bg-background/70 text-xs text-muted-foreground">D</span>Another amount</button>}
              </div>
              {editing === "budget" && <Button type="button" variant="ghost" size="sm" className="mt-2" onClick={() => { setEditing(null); setCustomBudget(false); }}>Done</Button>}
              {customBudget && <form className="mt-3 flex items-center gap-2" onSubmit={async (e) => {
                e.preventDefault();
                if (await gift({ action: "limit", cents: Math.round(Number(limit) * 100) })) { setEditing(null); setCustomBudget(false); }
              }}>
                <label className="sr-only" htmlFor="gift-custom-limit">Custom contribution limit in dollars</label>
                <Input id="gift-custom-limit" type="number" inputMode="decimal" min="0.01" step="0.01" required placeholder="Amount in dollars" value={limit} onChange={(e) => setLimit(e.target.value)} className="max-w-48 rounded-full bg-background" />
                <Button disabled={busy}>Save</Button>
              </form>}
              {s.me.limitCents > 0 && g.budgetCents <= g.reserveCents && <p role="status" className="mt-3 text-sm">The combined budget must exceed the {money(g.reserveCents)} reserve to search.</p>}
            </div>
          ) : <button type="button" aria-expanded="false" onClick={() => setEditing("budget")} className="flex min-h-14 w-full items-center gap-3 px-5 text-left text-sm focus-visible:outline-2 focus-visible:outline-ring"><Check aria-hidden="true" className="size-4 text-muted-foreground" /><span>Contribution limit</span><span className="text-muted-foreground">{money(s.me.limitCents)}</span><ChevronDown aria-hidden="true" className="ml-auto size-4 text-muted-foreground" /></button>}
        </div>}
        {(s.me.limitCents > 0 || ownFacts.length > 0 || editing === "share") && <div className="overflow-hidden rounded-2xl bg-muted">
          {shareOpen ? <div className="p-5 sm:p-6">
            <p className="mb-1 text-sm font-medium">Choose what to share with this gift</p><p className="mb-4 text-sm text-muted-foreground">Shared messages are visible to everyone who joins.</p>
            <div className="flex flex-col gap-1">
              {messages.filter((m) => m.role === "user").map((m, index) => {
                const shared = s.facts.some((fact: any) => fact.message_id === m.id);
                return <button key={m.id} type="button" disabled={busy || m.content.length > 1500} onClick={async () => {
                  if (await act({ action: "share_context", messageId: m.id, active: !shared })) setEditing(null);
                }} className="flex min-h-11 w-full items-start gap-3 rounded-xl px-2 py-2 text-left text-sm transition-colors hover:bg-background/70 focus-visible:outline-2 focus-visible:outline-ring disabled:opacity-50">
                  <span aria-hidden="true" className="grid size-7 shrink-0 place-items-center rounded-lg bg-background/70 text-xs text-muted-foreground">{shared ? <Check className="size-4" /> : String.fromCharCode(65 + index)}</span>
                  <span className="min-w-0 whitespace-pre-wrap break-words pt-1">{m.content}</span>
                  {shared && <span className="ml-auto shrink-0 pt-1 text-xs text-muted-foreground">Shared</span>}
                </button>;
              })}
            </div>
            {editing === "share" && <Button type="button" variant="ghost" size="sm" className="mt-2" onClick={() => setEditing(null)}>Done</Button>}
          </div> : <button type="button" aria-expanded="false" onClick={() => setEditing("share")} className="flex min-h-14 w-full items-center gap-3 px-5 text-left text-sm focus-visible:outline-2 focus-visible:outline-ring">{ownFacts.length > 0 && <Check aria-hidden="true" className="size-4 text-muted-foreground" />}<span>Shared context</span><span className="text-muted-foreground">{ownFacts.length ? `${ownFacts.length} ${ownFacts.length === 1 ? "message" : "messages"}` : "Not shared"}</span><ChevronDown aria-hidden="true" className="ml-auto size-4 text-muted-foreground" /></button>}
        </div>}
</section>);
  return (
    <>
      <section aria-label="Gift setup" className="flex flex-col gap-2">
        {g.organizer && inviteStep === "done" && inviteChoice && <button type="button" aria-expanded="false" onClick={() => setInviteStep("choose")} className="flex min-h-14 w-full items-center gap-3 rounded-2xl bg-muted px-5 text-left text-sm focus-visible:outline-2 focus-visible:outline-ring"><Check aria-hidden="true" className="size-4 text-muted-foreground" /><span>Participants</span><span className="text-muted-foreground">{inviteChoice === "solo" ? "Just me" : inviteChoice === "invite" ? "Invite friends" : `${s.members.length} ${s.members.length === 1 ? "participant" : "participants"}`}</span><ChevronDown aria-hidden="true" className="ml-auto size-4 text-muted-foreground" /></button>}
        {inviteStep === "choose" && <div className="rounded-2xl bg-muted p-5 sm:p-6">
          <p className="mb-4 text-sm font-medium">Who’s contributing?</p>
          <div className="flex flex-col gap-1">
            <button type="button" onClick={() => setInviteStep("invite")} className="flex min-h-11 items-center gap-3 rounded-xl px-2 text-left text-sm transition-colors hover:bg-background/70 focus-visible:outline-2 focus-visible:outline-ring"><span aria-hidden="true" className="grid size-7 place-items-center rounded-lg bg-background/70 text-xs text-muted-foreground">A</span>Invite friends</button>
            <button type="button" disabled={s.members.length > 1 || busy} onClick={() => void completeInviteStep("solo")} className="flex min-h-11 items-center gap-3 rounded-xl px-2 text-left text-sm transition-colors hover:bg-background/70 focus-visible:outline-2 focus-visible:outline-ring disabled:opacity-50"><span aria-hidden="true" className="grid size-7 place-items-center rounded-lg bg-background/70 text-xs text-muted-foreground">B</span>Just me</button>
          </div>
          {inviteChoice && <Button type="button" variant="ghost" size="sm" className="mt-2" onClick={() => setInviteStep("done")}>Done</Button>}
        </div>}
        {inviteStep === "invite" && <div className="rounded-2xl bg-muted p-5 sm:p-6">
          <p className="text-sm font-medium">Invite friends</p>
          {inviteUrl ? <div className="mt-4 flex flex-col gap-4 sm:flex-row sm:items-center">
            <div className="w-fit rounded-xl bg-white p-3"><QRCodeSVG value={inviteUrl} size={112} marginSize={1} title="Invitation link QR code" /></div>
            <div className="flex min-w-0 flex-1 flex-col items-start gap-3"><label htmlFor="gift-invite-link" className="sr-only">Invitation link</label><Input id="gift-invite-link" readOnly value={inviteUrl} onFocus={(e) => e.currentTarget.select()} className="w-full rounded-full bg-background" /><Button type="button" variant="outline" onClick={async () => { try { await navigator.clipboard.writeText(inviteUrl); setCopied(true); } catch { setCopied(false); } }}>{copied ? "Copied" : "Copy link"}</Button></div>
          </div> : <div className="mt-4"><Button type="button" disabled={busy} onClick={() => void gift({ action: "invite" })}>Create invitation link</Button><p className="mt-3 text-xs text-muted-foreground">A new link replaces any earlier invitation link.</p></div>}
          {inviteUrl && ["localhost", "127.0.0.1", "::1"].includes(new URL(inviteUrl).hostname) && <p className="mt-3 text-xs text-muted-foreground">This local link works only on this computer.</p>}
          <div className="mt-5 flex flex-wrap gap-2"><Button type="button" disabled={!inviteUrl} onClick={() => completeInviteStep("invite")}>Continue</Button><Button type="button" variant="ghost" onClick={() => setInviteStep("choose")}>Back</Button></div>
        </div>}
        {f.draft?.version === 2 && g.title && (editingTitle ? <form className="rounded-2xl bg-muted p-5" onSubmit={async (e) => { e.preventDefault(); if (await act({ action: "gift_draft", title: title.trim() })) setEditingTitle(false); }}><label htmlFor="edit-gift-title" className="mb-3 block text-sm font-medium">Gift name</label><div className="flex gap-2"><Input id="edit-gift-title" required maxLength={80} value={title} onChange={(e) => setTitle(e.target.value)} className="rounded-full bg-background" /><Button disabled={busy || !title.trim()}>Save</Button><Button type="button" variant="ghost" onClick={() => { setTitle(g.title); setEditingTitle(false); }}>Cancel</Button></div></form> : <button type="button" aria-expanded="false" onClick={() => { setTitle(g.title); setEditingTitle(true); }} className="flex min-h-14 w-full items-center gap-3 rounded-2xl bg-muted px-5 text-left text-sm"><Check aria-hidden="true" className="size-4 text-muted-foreground" /><span>Gift</span><span className="text-muted-foreground">{g.title}</span><ChevronDown aria-hidden="true" className="ml-auto size-4 text-muted-foreground" /></button>)}
      </section>
      {liveTarget && createPortal(<LiveGiftGroup flow={f} messages={messages} checkpointNodes={checkpointNodes} busy={busy} act={act} onOpenGroup={async (selection) => { if (selection && !await act({ action: "gift", payload: { action: "select", ...selection } })) return; setView("payment"); setShowGroup(true); }} />, liveTarget)}
      {!liveHandoff && (showBudget || offerBudget || ownFacts.length > 0 || editing === "share") && (inviteStep === "done" || (inviteChoice !== null && f.draft?.version !== 2)) && (
        budgetTarget ? createPortal(planningContent, budgetTarget) :
        (f.draft?.version !== 2 || !hasAnsweredFollowup) ? planningContent : null
      )}
      {headerTarget && createPortal(<Button type="button" variant="ghost" size="sm" onClick={() => setShowGroup(true)}>Group gift</Button>, headerTarget)}
      <Dialog.Root open={showGroup} onOpenChange={setShowGroup}>
        <Dialog.Portal container={typeof document !== "undefined" ? document.querySelector<HTMLElement>("[data-unified-workspace]") : undefined}>
          <Dialog.Overlay className="fixed inset-0 z-50 bg-black/50" />
          <Dialog.Content aria-describedby={undefined} className="fixed top-1/2 left-1/2 z-50 flex max-h-[min(90dvh,850px)] w-[calc(100%-2rem)] max-w-2xl -translate-x-1/2 -translate-y-1/2 flex-col overflow-y-auto rounded-2xl bg-background p-5 shadow-xl focus:outline-none sm:p-6">
            <Dialog.Close aria-label="Close group" className="absolute top-4 right-4 rounded-full p-2 text-muted-foreground hover:bg-muted focus-visible:outline-2 focus-visible:outline-ring"><X className="size-4" /></Dialog.Close>
      <article aria-label="Group gift workflow" className="flex flex-col gap-4 pr-7">
      <header className="flex flex-wrap items-center justify-between gap-2">
        <Dialog.Title className="font-semibold">{g.title || `Gift for ${g.recipient}`}</Dialog.Title>
        <span className="text-sm">{s.members.length} {s.members.length === 1 ? "participant" : "participants"}</span>
      </header>
      {g.occasion && <p className="text-sm">{g.occasion}</p>}
      {f.draft?.version === 2 && !showBudget && <Button type="button" variant="outline" className="self-start" disabled={busy} onClick={async () => { if (await act({ action: "gift_draft", readyForBudget: true })) setShowGroup(false); }}>Set contribution limit</Button>}
      <nav
        aria-label="Gift views"
        className="sticky top-0 z-20 flex gap-1 border-b border-border bg-card py-3"
      >
        {(
          [
            ["group", "Group chat"],
            ["private", "My agent"],
            ["payment", "My payment"],
          ] as const
        ).map(([key, label]) => (
          <Button
            key={key}
            variant={view === key ? "default" : "ghost"}
            size="sm"
            className="min-w-0 flex-1 px-2 text-xs"
            aria-pressed={view === key}
            onClick={() => setView(key)}
          >
            {label}
          </Button>
        ))}
      </nav>
      {view === "group" && (
        <Button variant="outline" onClick={() => setView("private")}>
          Set my limit & share context
        </Button>
      )}
      {view === "group" && (
        <div className="flex flex-wrap gap-2" aria-label="Gift participants">
          {s.members.map((m: any) => (
            <span
              key={m.id}
              className="rounded-full bg-muted px-3 py-1 text-sm"
            >
              {m.name}’s agent{m.simulated ? " · simulated" : ""}
            </span>
          ))}
        </div>
      )}

      <div className="grid grid-cols-3 gap-3 text-sm">
        <div>
          {s.members.some((m: any) => m.simulated)
            ? "Planning budget"
            : "Group budget"}
          <br />
          <strong>{money(g.budgetCents)}</strong>
        </div>
        <div>
          Reserve
          <br />
          <strong>{money(g.reserveCents)}</strong>
        </div>
        <div>
          Sandbox funded
          <br />
          <strong>{money(g.fundedCents)}</strong>
        </div>
      </div>
      {view === "private" && (
        <>
          <form
            className="flex flex-wrap items-end gap-3"
            onSubmit={(e) => {
              e.preventDefault();
              void gift({
                action: "limit",
                cents: Math.round(Number(limit) * 100),
              });
            }}
          >
            <MoneyField
              label="My private limit ($)"
              value={limit}
              onChange={setLimit}
              min="0"
            />
            <Button variant="outline" disabled={busy}>
              Save limit
            </Button>
          </form>
        </>
      )}
      {view === "group" && (
        <>
          {g.organizer && !inviteUrl && (
            <Button
              variant="outline"
              disabled={busy}
              onClick={() => void gift({ action: "invite" })}
            >
              Create new invitation link
            </Button>
          )}
          {inviteUrl && (
            <label className="flex flex-col gap-2 text-sm">
              Invitation link
              <Input
                readOnly
                value={inviteUrl}
                onFocus={(e) => e.target.select()}
              />
            </label>
          )}
          {g.organizer &&
            !s.members.some((m: any) => m.simulated) &&
            s.members.length <= 6 && (
              <Button
                variant="outline"
                disabled={busy || running}
                onClick={() => void gift({ action: "simulate_friends" })}
              >
                Simulate friends
              </Button>
            )}
          {inviteUrl && (
            <Button
              variant="outline"
              onClick={() => void navigator.clipboard.writeText(inviteUrl)}
            >
              Copy invitation link
            </Button>
          )}
        </>
      )}
      {view === "private" && (
        <>
          <details open>
            <summary className="cursor-pointer font-medium">
              Context to share
            </summary>
            <div className="mt-3 flex flex-col gap-3">
              {messages
                .filter((m) => m.role === "user")
                .map((m) => {
                  const shared = s.facts.some(
                    (f: any) => f.message_id === m.id,
                  );
                  return (
                    <div
                      className="flex flex-col gap-2 rounded-lg bg-muted p-3 text-sm"
                      key={m.id}
                    >
                      <p className="whitespace-pre-wrap">{m.content}</p>
                      <Button
                        variant="outline"
                        size="sm"
                        disabled={busy || m.content.length > 1500}
                        onClick={() =>
                          void act({
                            action: "share_context",
                            messageId: m.id,
                            active: !shared,
                          })
                        }
                      >
                        {shared ? "Stop sharing" : "Share with gift agents"}
                      </Button>
                    </div>
                  );
                })}
            </div>
          </details>
        </>
      )}
      {view === "group" && (
        <>
          <details>
            <summary className="cursor-pointer font-medium">
              Shared group context · {s.facts.length}
            </summary>
            {s.facts.map((f: any) => (
              <p key={f.id} className="mt-2 text-sm">
                <strong>{f.name}:</strong> {f.content}
                {f.member_id === s.me.id && (
                  <Button
                    variant="ghost"
                    size="sm"
                    disabled={busy}
                    onClick={() =>
                      void gift({
                        action: "share",
                        messageId: f.message_id,
                        active: false,
                      })
                    }
                  >
                    Stop sharing
                  </Button>
                )}
              </p>
            ))}
          </details>
          <Button
            disabled={
              busy ||
              running ||
              !s.channel3Configured ||
              !s.facts.length ||
              g.budgetCents <= g.reserveCents
            }
            onClick={() =>
              void gift({
                action: "plan",
                id: identity(
                  `plan:${g.revision}:${s.jobs.find((j: any) => j.kind === "plan" && j.revision === g.revision)?.id || "first"}`,
                ),
              })
            }
          >
            {running
              ? "Agents collaborating…"
              : "Find gifts with the group’s agents"}
          </Button>
          {planRunning && <p role="status" className="flex items-center gap-2 text-sm text-muted-foreground"><span aria-hidden="true" className="size-2 rounded-full bg-current motion-safe:animate-pulse" />{progressLabel[latest?.result?.phase] || "Starting gift search…"}</p>}
          {s.jobs.filter((j: any) => j.status === "failed").slice(0, 2).map((j: any) => (
            <div key={j.id} role="status" className="text-sm">
              <span>
                {j.kind === "plan"
                  ? "Collaboration and Channel3 search"
                  : "Private agent"}{" "}
                · {j.revision === g.revision ? j.status : "outdated"}
              </span>
              {j.error_code && (
                <p className="text-destructive">
                  {j.error_code.replaceAll("_", " ")}
                </p>
              )}
              {["queued", "running"].includes(j.status) && (
                <Button
                  variant="ghost"
                  size="sm"
                  disabled={busy}
                  onClick={() => void gift({ action: "recover", id: j.id })}
                >
                  Reconnect job
                </Button>
              )}
            </div>
          ))}
          <div
            role="log"
            aria-label="Shared agent conversation"
            aria-live="polite"
            aria-relevant="additions"
            className="flex flex-col gap-5 py-3"
          >

            {transcript.map((turn: any, i: number) => (
              <div key={`${latest.id}:${i}`} className="flex gap-3">
                <span
                  aria-hidden="true"
                  className="flex size-9 shrink-0 items-center justify-center rounded-full bg-muted font-medium"
                >
                  {turn.name.slice(0, 1)}
                </span>
                <div className="min-w-0 flex-1">
                  <p className="mb-1 text-sm font-semibold">
                    {turn.name}’s agent{turn.simulated ? " · simulated" : ""}
                  </p>
                  <p className="whitespace-pre-wrap text-sm leading-6">
                    {publicText(turn.content)}
                  </p>
                  <details className="mt-1 text-xs text-muted-foreground">
                    <summary className="cursor-pointer">Shared sources</summary>
                    {turn.factIds.map((id: string) => {
                      const fact = s.facts.find((f: any) => f.id === id);
                      return fact ? (
                        <p className="mt-1" key={id}>
                          {fact.name}: {fact.content}
                        </p>
                      ) : null;
                    })}
                  </details>
                </div>
              </div>
            ))}

          </div>
          {plan?.result?.summary && (
            <p className="text-sm">{publicText(plan.result.summary)}</p>
          )}
          {plan?.result?.options?.map((candidate: any) => (
            <section
              key={candidate.id}
              className="flex flex-col gap-3 rounded-xl border border-border p-4"
            >
              <header className="flex justify-between gap-3">
                <h3 className="font-medium">{candidate.title}</h3>
                <strong>{money(candidate.goalCents)}</strong>
              </header>
              <p className="text-sm">{candidate.reason}</p>
              {candidate.lines.map((p: any) => (
                <a
                  key={p.id}
                  href={p.url}
                  target="_blank"
                  rel="noreferrer"
                  className="flex items-center gap-3 text-sm underline"
                >
                  {p.image && (
                    <img
                      src={p.image}
                      alt=""
                      className="size-14 rounded-lg object-contain"
                    />
                  )}
                  <span>
                    {p.title}
                    <br />
                    {p.merchant} · {money(p.cents)}
                  </span>
                </a>
              ))}
              {candidate.cautions?.map((c: string) => (
                <p key={c} className="text-sm text-muted-foreground">
                  {c}
                </p>
              ))}
              <p className="text-sm">
                Subtotal {money(candidate.subtotalCents)} + reserve{" "}
                {money(candidate.reserveCents)}
              </p>
              {g.organizer && (
                <Button
                  variant="outline"
                  disabled={busy}
                  onClick={() =>
                    void gift({
                      action: "select",
                      jobId: plan.id,
                      optionId: candidate.id,
                    })
                  }
                >
                  {o?.id === candidate.id ? "Selected" : "Select gift plan"}
                </Button>
              )}
            </section>
          ))}
          <form
            className="flex flex-col gap-2"
            onSubmit={async (e) => {
              e.preventDefault();
              const b = await act({
                action: "group_feedback",
                id: crypto.randomUUID(),
                text: feedback,
              });
              if (b) {
                setFeedback("");
                if (g.budgetCents > g.reserveCents)
                  await gift({ action: "plan", id: crypto.randomUUID() });
              }
            }}
          >
            <LabelText
              label="Share feedback with the group’s agents"
              name="feedback"
              value={feedback}
              onChange={(e: any) => setFeedback(e.target.value)}
              required
              maxLength={1500}
            />
            <Button
              variant="outline"
              disabled={busy || running || !feedback.trim()}
            >
              {g.budgetCents > g.reserveCents
                ? "Send to agents"
                : "Share context"}
            </Button>
          </form>
          {o && (
            <Button onClick={() => setView("payment")}>
              Review gift & my contribution
            </Button>
          )}
        </>
      )}
      {view === "payment" && (
        <>
          {!o && (
            <p className="text-sm">Select a gift in the group chat first.</p>
          )}
          {o && (
            <section className="flex flex-col gap-3 rounded-xl bg-muted p-4">
              <h3 className="font-medium">
                {o.title} · {money(o.goalCents)}
              </h3>
              <div className="flex flex-wrap gap-3 text-sm">
                {s.members.map((m: any) => (
                  <span key={m.id}>
                    {m.name}
                    {m.simulated ? " (simulated)" : ""} ·{" "}
                    {m.approved ? "approved" : "awaiting approval"}
                  </span>
                ))}
              </div>
              {g.organizer &&
                s.members.some((m: any) => m.simulated && !m.approved) && (
                  <Button
                    variant="outline"
                    disabled={busy}
                    onClick={() =>
                      void gift({
                        action: "approve_simulated",
                        digest: o.digest,
                      })
                    }
                  >
                    Simulate friends’ plan approvals
                  </Button>
                )}
              <p className="text-sm text-muted-foreground">PayPal Sandbox contribution to the demo merchant. Retailer checkout is separate.</p>
              <div className="flex flex-col gap-2 text-sm">{o.lines.map((product: any) => <div key={product.id} className="flex justify-between gap-3"><span>{product.title}</span><span>{money(product.cents)}</span></div>)}<div className="flex justify-between gap-3 text-muted-foreground"><span>Reserve</span><span>{money(o.reserveCents)}</span></div></div>
              <form className="flex flex-col gap-3" onSubmit={async (event) => {
                event.preventDefault();
                const cents = Math.round(Number(amount) * 100);
                if (!Number.isInteger(cents) || cents < 100) return;
                const intent = `fund:${o.digest}:${amount}`;
                let id = identity(intent);
                if (s.payments.some((entry: any) => entry.id === id && ["completed", "failed", "cancelled"].includes(entry.status))) {
                  sessionStorage.removeItem(`sume.workspace.intent.${conversationId}.${intent}`);
                  id = identity(intent);
                }
                const result = await gift({ action: "checkout", id, digest: o.digest, cents });
                const state = result?.flows?.find((flow: any) => flow.kind === "gift")?.state;
                const payment = state?.payments?.find((entry: any) => entry.id === id);
                if (payment?.status === "created" && payment.approval_url) window.location.assign(payment.approval_url);
              }}>
                <MoneyField label="Your contribution ($)" value={amount} onChange={setAmount} min="1" />
                <p className="text-sm text-muted-foreground">Continuing approves this gift plan and contribution.</p>
                <Button className="rounded-full" disabled={busy || !s.paypalConfigured || Number(amount) < 1}>Continue with PayPal Sandbox</Button>
              </form>
            </section>
          )}
          {s.payments.some(
            (p: any) => p.status === "completed" && p.digest !== o?.digest,
          ) && (
            <p role="status" className="text-sm">
              Existing receipts are from an earlier plan. Review funding before
              retailer checkout.
            </p>
          )}
          {s.payments.map((p: any) => (
            <section
              key={p.id}
              className="flex flex-col gap-2 rounded-lg border border-border p-3 text-sm"
            >
              <strong>
                {money(p.amount_cents)} · {p.status.replaceAll("_", " ")}
              </strong>
              {p.capture_id && <p>Sandbox contribution confirmed.</p>}
              {p.approval_url && p.status !== "completed" && (
                <Button asChild variant="outline">
                  <a href={p.approval_url}>Resume PayPal Sandbox</a>
                </Button>
              )}
              {p.order_id && p.status !== "completed" && (
                <div className="flex flex-wrap gap-2">
                  <Button
                    disabled={busy}
                    onClick={() => void gift({ action: "capture", id: p.id })}
                  >
                    Complete approved contribution
                  </Button>
                  <Button
                    variant="outline"
                    disabled={busy}
                    onClick={() => void gift({ action: "reconcile", id: p.id })}
                  >
                    Check payment status
                  </Button>
                </div>
              )}
              {!p.order_id && p.status === "needs_review" && (
                <Button
                  variant="outline"
                  disabled={busy}
                  onClick={() =>
                    void gift({
                      action: "fund",
                      id: p.id,
                      digest: p.digest,
                      cents: p.amount_cents,
                    })
                  }
                >
                  Retry same Sandbox order
                </Button>
              )}
              {p.error_code && (
                <p role="alert">{p.error_code.replaceAll("_", " ")}</p>
              )}
            </section>
          ))}
          {g.organizer && o && (
            <details>
              <summary className="cursor-pointer font-medium">
                Retailer checkout handoff
              </summary>
              <p className="my-3 text-sm">
                No automatic retailer order is placed. Use the product links,
                then record the external order after all friends approve and the
                Sandbox goal is funded.
              </p>
              <form
                className="flex flex-col gap-3"
                onSubmit={(e) => {
                  e.preventDefault();
                  void gift({
                    action: "record_order",
                    digest: o.digest,
                    reference: new FormData(e.currentTarget).get("reference"),
                  });
                }}
              >
                <LabelText
                  label="External order reference"
                  name="reference"
                  required
                  minLength={3}
                  maxLength={200}
                />
                <Button variant="outline" disabled={busy}>
                  Record external order
                </Button>
              </form>
            </details>
          )}
        </>
      )}
      {g.orderReference && (
        <p className="text-sm">External order: {g.orderReference}</p>
      )}
    </article>
          </Dialog.Content>
        </Dialog.Portal>
      </Dialog.Root>
    </>
  );
}
