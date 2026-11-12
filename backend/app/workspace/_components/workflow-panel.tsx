"use client";
import GiftCard from "./group-gift-card";
import SnackWorkflow from "./snack-workflow";
import { createPortal } from "react-dom";
import { giftSetupMessageId } from "../../../lib/gift-checkpoint-anchors";
import { useEffect, useRef, useState } from "react";
import { Button } from "./ui/button";
import { Input } from "./ui/input";
import { LabelText, MoneyField } from "./workflow-fields";
type Message = { id: string; role: string; content: string; status?: string };
const money = (n: number) =>
  new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" }).format(
    n / 100,
  );
export default function WorkflowPanel({
  conversationId,
  mode,
  code,
  messages,
  ensureChat,
  invite,
  snackInvite,
  onActiveChange,
  onGiftViewChange,
  onGiftNamed,
  suggestedGiftTitle,
  checkpointNodes,
  giftHeaderTarget,
  onGiftPreviewAvailableChange,
}: {
  conversationId: string | null;
  mode: string;
  code: string;
  messages: Message[];
  ensureChat: () => Promise<string | null>;
  invite: string | null;
  snackInvite: string | null;
  onActiveChange: (active: boolean) => void;
  onGiftViewChange: (view: "group" | "private" | "payment" | null) => void;
  onGiftNamed: (name: string) => void;
  suggestedGiftTitle: string;
  checkpointNodes: Record<string, HTMLElement>;
  giftHeaderTarget: HTMLElement | null;
  onGiftPreviewAvailableChange: (available: boolean) => void;
}) {
  const [flows, setFlows] = useState<any[]>([]),
    [error, setError] = useState(""),
    [busy, setBusy] = useState(false),
    [inviteUrl, setInviteUrl] = useState("");
  const mockPreviewAvailable = flows.some((f) => f.kind === "gift" && f.draft?.version === 2 && ["solo", "invite"].includes(f.draft.participantChoice) && !!f.state?.group?.title);
  useEffect(() => onGiftPreviewAvailableChange(mockPreviewAvailable), [mockPreviewAvailable, onGiftPreviewAvailableChange]);
  const active = useRef(conversationId),
    lock = useRef(false);
  active.current = conversationId;
  useEffect(() => {
    onActiveChange(flows.length > 0);
  }, [flows.length, onActiveChange]);
  async function refresh(id = conversationId) {
    if (!id) return;
    const r = await fetch(`/api/workspace-chat/workflows?conversationId=${id}`);
    const b = await r.json();
    if (!r.ok) throw Error(b.error);
    if (active.current === id) setFlows(b.flows);
  }
  useEffect(() => {
    setFlows([]);
    setInviteUrl(conversationId ? sessionStorage.getItem(`sume.gift.invite.${conversationId}`) || "" : "");
    setError("");
    if (!conversationId) return;
    void refresh().catch((e) => setError(e.message));
    const timer = setInterval(() => void refresh().catch(() => {}), 2500);
    return () => clearInterval(timer);
  }, [conversationId]);
  async function act(command: any) {
    if (lock.current) return;
    lock.current = true;
    setBusy(true);
    setError("");
    try {
      const id = conversationId || (await ensureChat());
      if (!id) return;
      const r = await fetch("/api/workspace-chat/workflows", {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-demo-code": code },
        body: JSON.stringify({ conversationId: id, command }),
      });
      const b = await r.json();
      if (!r.ok) throw Error(b.error);
      if (command.action === "join_snacks") { const url = new URL(location.href); url.searchParams.delete("snackInvite"); history.replaceState(null, "", url.pathname + url.search); }
      if (active.current === id) {
        setFlows(b.flows);
        if (b.result?.inviteToken) {
          const url = `${location.origin}/workspace?mode=shopping&giftInvite=${b.result.inviteToken}`;
          sessionStorage.setItem(`sume.gift.invite.${id}`, url);
          setInviteUrl(url);
        }
      }
      return b;
    } catch (e) {
      setError((e as Error).message);
    } finally {
      lock.current = false;
      setBusy(false);
    }
  }
  const setupMessageId = giftSetupMessageId(messages);
  const setupTarget = setupMessageId ? checkpointNodes[setupMessageId] || null : null;
  const hasCampaign = flows.some((f) => f.kind === "campaign"),
    hasGift = flows.some((f) => f.kind === "gift"),
    hasSnack = flows.some((f) => f.kind === "snack");
  return (
    <section aria-label="Connected workflows" className="flex flex-col gap-5">
      {error && (
        <p role="alert" className="text-sm text-destructive">
          {error === "GIFT_GROUP_LIMIT" ? "You’ve reached the limit of 50 gifts." : error.replaceAll("_", " ")}
        </p>
      )}
      {!hasCampaign && mode === "creators" && (
        <div>
          <Button
            variant="outline"
            disabled={busy}
            onClick={() => void act({ action: "prepare_campaign" })}
          >
            Open Sandbox campaign
          </Button>
        </div>
      )}
      {!hasGift && mode === "shopping" && !!invite && (
        <details
          className="rounded-xl border border-border p-4"
          open={!!invite}
        >
          <summary className="cursor-pointer font-medium">Group gift</summary>
          {!invite && (
            <form
              className="mt-4 flex flex-col gap-3"
              onSubmit={(e) => {
                e.preventDefault();
                const d = new FormData(e.currentTarget);
                void act({
                  action: "prepare_gift",
                  recipient: d.get("recipient"),
                  occasion: d.get("occasion"),
                  reserveCents: 1000,
                });
              }}
            >
              <LabelText
                label="Recipient"
                name="recipient"
                required
                maxLength={80}
              />
              <LabelText
                label="Occasion"
                name="occasion"
                required
                maxLength={600}
              />
              <Button disabled={busy}>Create gift group</Button>
            </form>
          )}
          <form
            className="mt-4 flex flex-col gap-3"
            onSubmit={(e) => {
              e.preventDefault();
              void act({
                action: "join_gift",
                token: new FormData(e.currentTarget).get("token"),
              });
            }}
          >
            <LabelText
              label="Invitation code"
              name="token"
              defaultValue={invite || ""}
              required
            />
            <Button variant="outline" disabled={busy}>
              Join friends’ gift
            </Button>
          </form>
        </details>
      )}
      {!hasSnack && mode === "shopping" && !!snackInvite && <div className="rounded-2xl bg-muted p-5"><p className="mb-3 text-sm font-medium">Join office snacks</p><Button disabled={busy} onClick={() => void act({ action: "join_snacks", token: snackInvite })}>Join office</Button></div>}
      {flows.map((f) =>
        f.kind === "snack" ? <SnackWorkflow key={f.id} flow={f} conversationId={conversationId!} code={code} refresh={() => refresh()} setup={act} messages={messages} /> : f.kind === "campaign" ? (
          <CampaignCard key={f.id} flow={f} busy={busy} act={act} />
        ) : f.state ? (
          <GiftPlacement key={f.id} target={setupTarget} waitForAnchor={Boolean(setupMessageId) || (f.draft?.version === 2 && messages.some((m) => m.role === "assistant" && m.status === "streaming"))}><GiftCard
            key={f.id}
            flow={f}
            busy={busy}
            act={act}
            messages={messages}
            inviteUrl={inviteUrl}
            conversationId={conversationId!}
            onViewChange={onGiftViewChange}
            checkpointNodes={checkpointNodes}
            headerTarget={giftHeaderTarget}
          /></GiftPlacement>
        ) : f.draft?.version === 2 ? (
          <GiftPlacement key={f.id} target={setupTarget} waitForAnchor={Boolean(setupMessageId) || messages.some((m) => m.role === "assistant" && m.status === "streaming")}><GiftDraft flow={f} busy={busy} act={act} onGiftNamed={onGiftNamed} suggestedTitle={suggestedGiftTitle} /></GiftPlacement>
        ) : (
          <div key={f.id} role="status" className="rounded-xl border p-4">
            Gift setup incomplete. <Button variant="outline" disabled={busy} onClick={() => void act({ action: "prepare_gift", ...f.draft })}>Finish setup</Button>
          </div>
        ),
      )}
    </section>
  );
}
function GiftPlacement({ target, waitForAnchor, children }: { target: HTMLElement | null; waitForAnchor: boolean; children: React.ReactNode }) {
  return target ? createPortal(children, target) : waitForAnchor ? null : children;
}
function GiftDraft({ flow, busy, act, onGiftNamed, suggestedTitle }: { flow: any; busy: boolean; act: (value: any) => Promise<any>; onGiftNamed: (name: string) => void; suggestedTitle: string }) {
  const [title, setTitle] = useState(flow.draft.title || suggestedTitle || "");
  const [editingChoice, setEditingChoice] = useState(false);
  const choice = flow.draft.participantChoice as "solo" | "invite" | undefined;
  return <section aria-label="Gift setup" className="flex flex-col gap-2">
    {choice && !editingChoice ? <button type="button" aria-expanded="false" className="flex min-h-14 items-center gap-3 rounded-2xl bg-muted px-5 text-left text-sm" onClick={() => setEditingChoice(true)}>✓ <span>Participants</span><span className="text-muted-foreground">{choice === "solo" ? "Just me" : "Invite friends"}</span></button> : <div className="rounded-2xl bg-muted p-5 sm:p-6">
      <p className="mb-4 text-sm font-medium">Who’s contributing?</p>
      {([ ["solo", "Just me"], ["invite", "Invite friends"] ] as const).map(([value, label], index) => <button key={value} type="button" disabled={busy} onClick={async () => { if (await act({ action: "gift_draft", participantChoice: value })) setEditingChoice(false); }} className="flex min-h-11 w-full items-center gap-3 rounded-xl px-2 text-left text-sm hover:bg-background/70 focus-visible:outline-2 focus-visible:outline-ring disabled:opacity-50"><span aria-hidden="true" className="grid size-7 place-items-center rounded-lg bg-background/70 text-xs text-muted-foreground">{index ? "B" : "A"}</span>{label}</button>)}
    </div>}
    {choice && <form className="rounded-2xl bg-muted p-5 sm:p-6" onSubmit={async (e) => { e.preventDefault(); const name = title.trim(); if (!name) return; if (await act({ action: "gift_draft", title: name })) onGiftNamed(name); }}>
      <label htmlFor="gift-draft-name" className="mb-4 block text-sm font-medium">What would you like to call this gift?</label>
      <div className="flex flex-wrap gap-2"><Input id="gift-draft-name" value={title} onChange={(e) => setTitle(e.target.value)} maxLength={80} required placeholder="e.g. Dallas trip gift" className="min-w-0 flex-1 rounded-full bg-background" /><Button disabled={busy || !title.trim()}>Continue</Button></div>
    </form>}
  </section>;
}
function CampaignCard({
  flow: f,
  busy,
  act,
}: {
  flow: any;
  busy: boolean;
  act: (v: any) => Promise<any>;
}) {
  const [scenario, setScenario] = useState(f.payoutReady ? "payout" : "review"),
    [approved, setApproved] = useState(false);
  const s = f.state;
  return (
    <article
      aria-label="Creator campaign workflow"
      className="flex flex-col gap-4 rounded-xl border border-border p-5"
    >
      <header className="flex flex-wrap items-center justify-between gap-2">
        <h2 className="font-semibold">ChatEDU creator campaign</h2>
        <span className="text-sm">
          PayPal Sandbox ·{" "}
          {s?.status?.replaceAll("_", " ") || "Ready for review"}
        </span>
      </header>
      <p className="text-sm text-muted-foreground">
        Fixed offers and simulated creator events. Chat briefs do not change
        these terms.
      </p>
      <div className="grid grid-cols-3 gap-3 text-sm">
        <div>
          Budget cap
          <br />
          <strong>{money(f.approval.capCents)}</strong>
        </div>
        <div>
          Usage
          <br />
          <strong>{f.approval.rightsDays} days</strong>
        </div>
        <div>
          Delivery
          <br />
          <strong>{f.approval.deliveryDay}</strong>
        </div>
      </div>
      {!s && !f.payoutReady && (
        <p className="text-sm text-destructive" role="status">
          Creator Sandbox recipients need setup. The review scenario is
          available.
        </p>
      )}
      {!s && (
        <>
          <label className="flex flex-col gap-2 text-sm">
            Scenario
            <select
              className="rounded-lg border border-input p-2"
              value={scenario}
              onChange={(e) => {
                setScenario(e.target.value);
                setApproved(false);
              }}
            >
              <option value="payout" disabled={!f.payoutReady}>
                Eligible offers → Sandbox payout
              </option>
              <option value="review">Ineligible offers → review</option>
            </select>
          </label>
          <div className="grid gap-3 sm:grid-cols-2">
            {f.offers[scenario].map((o: any) => (
              <div key={o.creator} className="rounded-lg bg-muted p-3 text-sm">
                <strong>{o.creator === "A" ? "Maya" : "Sam"}</strong>
                <p>
                  {money(o.totalCents)} total · {o.rightsDays}-day usage
                </p>
                <p>Milestone payout: {money(o.milestoneCents)}</p>
                <p>{o.visits} forecast visits · simulated</p>
              </div>
            ))}
          </div>
          <label className="flex items-start gap-3 text-sm">
            <input
              type="checkbox"
              checked={approved}
              onChange={(e) => setApproved(e.target.checked)}
              className="mt-1 size-4"
            />
            Authorize this fixed Sandbox campaign and the selected creator’s
            milestone payout after simulated acceptance and delivery.
          </label>
          <Button
            disabled={busy || !approved}
            onClick={() =>
              void act({ action: "approve_campaign", approved: true, scenario })
            }
          >
            Approve and run Sandbox campaign
          </Button>
        </>
      )}
      {s?.event_log?.counteroffer && (
        <div className="text-sm">
          <strong>
            AI recommendation ·{" "}
            {s.event_log.counteroffer.recommendation.creator === "A"
              ? "Maya"
              : "Sam"}
          </strong>
          <p>{s.event_log.counteroffer.recommendation.reason}</p>
          {s.event_log.counteroffer.problems.map((p: string) => (
            <p key={p} className="text-destructive">
              {p}
            </p>
          ))}
        </div>
      )}
      {s?.deal && (
        <div className="text-sm">
          Agreed total {money(s.deal.totalCents)} · milestone{" "}
          {money(s.deal.milestoneCents)}
          <p>
            Acceptance:{" "}
            {s.event_log.acceptance ? "simulated received" : "waiting"}
          </p>
          <p>
            Delivery: {s.event_log.delivery ? "simulated received" : "waiting"}
          </p>
        </div>
      )}
      {s?.batch_id && (
        <p className="break-all text-sm">Sandbox batch: {s.batch_id}</p>
      )}
      {s?.item_id && (
        <p className="break-all text-sm">Confirmed Sandbox item: {s.item_id}</p>
      )}
      {s?.event_log?.paypalStatus && (
        <p role="status" className="text-sm">
          PayPal Sandbox: {s.event_log.paypalStatus}
        </p>
      )}
      {s?.event_log?.failure && (
        <p role="alert" className="text-sm text-destructive">
          Stopped during {s.event_log.failure}. Payment review may be required.
        </p>
      )}
      {s?.status === "waiting" && (
        <Button
          variant="outline"
          disabled={busy}
          onClick={() =>
            void act({
              action: "approve_campaign",
              approved: true,
              scenario: s.scenario,
            })
          }
        >
          Retry same approved campaign
        </Button>
      )}
    </article>
  );
}
