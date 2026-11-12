"use client";
import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { AgentTeamHeader, Mascot } from "./agent-avatar";
import * as Dialog from "@radix-ui/react-dialog";
import { BriefcaseBusiness, ChevronDown, ChevronRight, FileText, Search, X } from "lucide-react";
import dynamic from "next/dynamic";
import { Button } from "./ui/button";
import { Tooltip, TooltipTrigger, TooltipContent } from "./ui/tooltip";
import { creators } from "../../../lib/creator/catalog";
import { compactAgentSummary } from "../../../lib/creator/summary";
import { CreatorOutreach } from "./creator-outreach";
import { CreatorReport } from "./creator-report";
import type { Campaign } from "../../../lib/creator/policy";
const Board = dynamic(() => import("./creator-board"), {
  ssr: false,
  loading: () => <p role="status">Opening board…</p>,
});
const money = (c: number) =>
  new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
    minimumFractionDigits: c % 100 === 0 ? 0 : 2,
    maximumFractionDigits: 2,
  }).format(c / 100);
export default function CreatorPanel({
  conversationId,
  code,
  onMessage,
  checkpointNodes,
  historyOnly = false,
}: {
  conversationId: string | null;
  code: string;
  onMessage: (text: string) => void;
  checkpointNodes: Record<string, HTMLElement>;
  historyOnly?: boolean;
}) {
  const [state, setState] = useState<Campaign | null>(null),
    [view, setView] = useState("shortlist"),
    [selected, setSelected] = useState(""),
    [busy, setBusy] = useState(false),
    [error, setError] = useState(""),
    [ready, setReady] = useState(false),
    [openRunId, setOpenRunId] = useState<string | null>(null),
    [shortlistRunId, setShortlistRunId] = useState<string | null>(null),
    [reportOpen, setReportOpen] = useState(false),
    [runs, setRuns] = useState<
      {
        id: string;
        message_id: string;
        revision: number;
        status: string;
        business_approved?: boolean;
        audience_suggestions?: string[];
        updated_at: string;
        activity: { name: string; summary: string; ids: string[] }[];
        brief?: Campaign["brief"];
        website?: { url: string; title: string; excerpt: string; iconUrl?: string; iconUrls?: string[]; readable?: boolean } | null;
        result?: {
          brief: Campaign["brief"];
          legacy?: boolean;
          refinement?: boolean;
          replacementAdded?: number;
          evidenceCheck?: { reviewed: number; retained: number };
          previous?: { id: string }[];
          profiles?: {
            id: string;
            name: string;
            platform: string;
            format: string;
            cents: number;
            evidence: readonly string[];
          }[];
          candidates: {
            id: string;
            reason: string;
            evidenceIndexes: number[];
          }[];
        } | null;
      }[]
    >([]);
  const active = useRef(conversationId);
  active.current = conversationId;
  useEffect(() => {
    setState(null);
    setRuns([]);
    setSelected("");
    setView("shortlist");
    setError("");
    setOpenRunId(null);
    if (!conversationId) return;
    let alive = true;
    const refresh = async () => {
      try {
        const r = await fetch(
          `/api/creator-campaign?conversationId=${conversationId}`,
        );
        const b = await r.json();
        if (!r.ok) throw Error(b.error);
        if (alive) {
          setState(b.state);
          setRuns(b.runs || []);
          setReady(b.payoutReady);
        }
      } catch (e) {
        if (alive) setError((e as Error).message);
      }
    };
    void refresh();
    const timer = setInterval(refresh, 2500);
    return () => {
      alive = false;
      clearInterval(timer);
    };
  }, [conversationId]);
  useEffect(() => {
    if (
      state && selected &&
      !state.candidates.some((candidate) => candidate.id === selected) &&
      !state.deals.some((deal) => deal.creatorId === selected)
    ) {
      setSelected("");
    }
  }, [state, selected]);
  async function act(command: object) {
    if (busy || !conversationId) return false;
    const id = conversationId;
    setBusy(true);
    setError("");
    try {
      const r = await fetch("/api/creator-campaign", {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-demo-code": code },
        body: JSON.stringify({ conversationId: id, command }),
      });
      const b = await r.json();
      if (!r.ok) throw Error(b.error);
      if (active.current === id) {
        setState(b.state);
        setReady(b.payoutReady);
      }
      return true;
    } catch (e) {
      if (active.current === id) setError((e as Error).message);
      return false;
    } finally {
      setBusy(false);
    }
  }
  if (!state?.revision)
    return !historyOnly && error ? (
      <p role="alert" className="text-sm text-destructive">
        {error}
      </p>
    ) : null;
  const deal = state.deals.find((d) => d.creatorId === selected),
    profile = state.candidates.some((candidate) => candidate.id === selected) || deal
      ? creators.find((creator) => creator.id === selected)
      : undefined;
  const currentRun = runs
    .filter(
      (r) =>
        r.status === "ready" &&
        JSON.stringify(r.result?.brief) === JSON.stringify(state.brief),
    )
    .at(-1)?.id;
  const currentMessage = runs.find((run) => run.id === currentRun)?.message_id;
  const changed =
    state.previous.length > 0 &&
    JSON.stringify(state.previous.map((c) => c.id)) !==
      JSON.stringify(state.candidates.map((c) => c.id));
  const agreement = profile ? (
        <section
          className="flex flex-col gap-3 rounded-2xl border border-border p-5"
          aria-label="Agreement review"
        >
          <div className="flex justify-between gap-2">
            <h3 className="font-medium">{profile.name}</h3>
            <Button variant="ghost" onClick={() => setSelected("")}>
              Close
            </Button>
          </div>
          {!deal ? (
            <AgreementSetup
              key={profile.id}
              format={profile.format}
              cents={profile.cents}
              deadline={state.brief.deadline}
              busy={busy}
              onPrepare={(delivery, rightsDays, paymentStructure) => void act({
                action: "prepare",
                creatorId: profile.id,
                revision: state.revision,
                delivery,
                rightsDays,
                paymentStructure,
              })}
            />
          ) : (
            <>
              <p className="text-sm">{deal.deliverable}</p>
              {deal.counteroffer && (
                <p className="text-sm">{deal.counteroffer}</p>
              )}
              <p className="text-sm">
                {money(deal.totalCents)} · {deal.rightsDays}-day usage ·{" "}
                {deal.delivery}
              </p>
              {deal.installments ? <div className="text-sm space-y-1">{deal.installments.map((item) => <p key={item.id}>{item.due === "approval" ? "Upfront" : "After accepted delivery"} · {money(item.amountCents)}</p>)}</div> : <p className="text-sm">10% milestone: {money(deal.milestoneCents)}</p>}
              <p className="text-xs text-muted-foreground">
                Simulated creator response and delivery. Sandbox payout goes to
                the configured test recipient.
              </p>
              {!deal.approved &&
                (state.brief.budgetCents === null ? (
                  <Button
                    variant="outline"
                    onClick={() =>
                      onMessage(
                        "Help me set a campaign budget before approving this agreement.",
                      )
                    }
                  >
                    Set budget in chat
                  </Button>
                ) : (
                  <Button
                    disabled={busy}
                    onClick={() =>
                      void act({
                        action: "approve",
                        dealId: deal.id,
                        digest: deal.digest,
                        revision: state.revision,
                      })
                    }
                  >
                    Approve exact agreement
                  </Button>
                ))}
              {deal.approved && deal.stage === "agreed" && (
                <Button
                  disabled={busy}
                  onClick={() =>
                    void act({
                      action: "delivery",
                      dealId: deal.id,
                      digest: deal.digest,
                      revision: state.revision,
                    })
                  }
                >
                  Open simulated delivery
                </Button>
              )}
              {deal.stage === "delivering" && (
                <>
                  <p className="text-sm">
                    Sample delivery: {deal.deliverable}. This demonstration does
                    not verify published content.
                  </p>
                  <Button
                    disabled={busy}
                    onClick={() =>
                      void act({
                        action: "complete",
                        dealId: deal.id,
                        digest: deal.digest,
                        revision: state.revision,
                      })
                    }
                  >
                    Accept simulated delivery
                  </Button>
                </>
              )}
              {deal.approved && deal.installments?.map((item) => <div key={item.id} className="space-y-2">
                <p className="text-sm">{item.due === "approval" ? "Upfront" : "After accepted delivery"} · {money(item.amountCents)} · {item.payment}</p>
                {item.payment !== "confirmed" && <Button disabled={busy || !ready || (item.due === "accepted_delivery" && (deal.stage !== "complete" || deal.installments?.find((entry) => entry.id === "upfront")?.payment !== "confirmed"))} onClick={() => void act({ action: "pay", dealId: deal.id, digest: deal.digest, revision: state.revision, installmentId: item.id })}>{item.payment === "none" ? `Pay ${money(item.amountCents)} in Sandbox` : "Check / retry same Sandbox payout"}</Button>}
                {item.itemId && <p className="break-all text-xs">Confirmed receipt: {item.itemId}</p>}
              </div>)}
              {deal.approved && deal.installments && !ready && <p className="text-sm">Sandbox recipients need configuration.</p>}
              {!deal.installments && deal.stage === "complete" && deal.payment !== "confirmed" && (
                <Button
                  disabled={busy || !ready}
                  onClick={() =>
                    void act({
                      action: "pay",
                      dealId: deal.id,
                      digest: deal.digest,
                      revision: state.revision,
                    })
                  }
                >
                  {deal.payment === "none"
                    ? `Pay ${money(deal.milestoneCents)} in Sandbox`
                    : "Check / retry same Sandbox payout"}
                </Button>
              )}
              {deal.stage === "complete" && !ready && (
                <p className="text-sm">
                  Sandbox recipients need configuration.
                </p>
              )}
              {deal.payment !== "none" && (
                <p role="status" className="text-sm">
                  Sandbox payment:{" "}
                  {deal.payment === "review"
                    ? "Outcome needs reconciliation; retry uses the same payment ID."
                    : deal.payment}
                </p>
              )}
              {deal.batchId && (
                <p className="break-all text-xs">Batch: {deal.batchId}</p>
              )}
              {deal.itemId && (
                <p className="break-all text-xs">
                  Confirmed receipt: {deal.itemId}
                </p>
              )}
            </>
          )}
        </section>
  ) : null;
  return (
    <section
      className={historyOnly ? "hidden" : "flex flex-col gap-4"}
      aria-label="Creator campaign"
    >
      {!!(state.candidates.length || state.deals.length) && (
        <div className="flex gap-2">
          {!runs.length && (
            <Button
              variant={view === "shortlist" ? "default" : "outline"}
              onClick={() => setView("shortlist")}
            >
              Creators
            </Button>
          )}
          <Button
            variant={view === "board" ? "default" : "outline"}
            onClick={() => setView("board")}
          >
            Board
          </Button>
          <Button variant="outline" onClick={() => setReportOpen(true)}>Report</Button>
        </div>
      )}
      {changed && !runs.length && (
        <details className="text-sm">
          <summary className="cursor-pointer">Shortlist changed</summary>
          <p className="mt-2">
            Previously:{" "}
            {state.previous
              .map((c) => creators.find((p) => p.id === c.id)?.name)
              .join(", ")}
          </p>
        </details>
      )}
      {view === "board" && (
        <BoardDialog
          state={state}
          onClose={() => setView("shortlist")}
          onSelect={(id) => {
            setSelected(id);
            setView("shortlist");
          }}
        />
      )}
      <CreatorReport state={state} open={reportOpen} onClose={() => setReportOpen(false)} />
      {state.lastAction === "compare" &&
        !state.candidates.length &&
        !runs.length && (
          <div className="rounded-2xl bg-muted p-5">
            <h3 className="font-medium">No matching sample creators</h3>
            <Button
              className="mt-3"
              variant="outline"
              onClick={() =>
                onMessage("Help me revise the brief to find suitable creators.")
              }
            >
              Revise brief
            </Button>
          </div>
        )}
      {runs.map((run) => {
        const target = checkpointNodes[run.message_id];
        if (!target) return null;
        const team = [
          { name: "Scout", color: "#b4d3be" },
          { name: "Muse", color: "#d2c4e6" },
          { name: "Dot", color: "#e8c9ae" },
        ];
        return createPortal(
          <div className="mt-4 space-y-3">
            {run.business_approved && run.brief && <details className="rounded-2xl bg-muted p-4 text-sm"><summary className="flex cursor-pointer list-none items-center gap-3 [&::-webkit-details-marker]:hidden"><BusinessIcon brand={run.brief.brand} iconUrls={run.website?.iconUrls || (run.website?.iconUrl ? [run.website.iconUrl] : [])} /><span><span className="block font-medium">{run.brief.brand || "Business"}</span><span className="text-muted-foreground">{run.brief.goal || "Creator campaign"}</span></span><ChevronDown aria-hidden="true" className="ml-auto size-4 shrink-0 text-muted-foreground" /></summary><p className="mt-3">Audience · <AudienceSummary segments={run.audience_suggestions} fallback={run.brief.audienceDetail || run.brief.audience || "Not set"} /></p>{run.website && <a className="mt-2 block underline" href={run.website.url} target="_blank" rel="noopener noreferrer">{run.website.title || new URL(run.website.url).hostname}</a>}</details>}
            <div className="rounded-2xl bg-muted p-5">
              {run.result?.refinement ? (
                <p className="font-medium">Shortlist updated</p>
              ) : run.result?.legacy ? (
                <p className="font-medium">
                  Earlier shortlist · current sample quotes
                </p>
              ) : run.status === "ready" ? (
                <button type="button" className="flex w-full items-center gap-3 text-left text-sm" onClick={() => setOpenRunId(run.id)} aria-label={`Search complete, ${run.result?.candidates.length || 0} sample creators. View agent activity`}>
                  <span className="grid size-10 shrink-0 place-items-center rounded-lg bg-background"><Search aria-hidden="true" className="size-5" /></span><span className="min-w-0"><span className="block font-medium">Search</span><span className="block text-muted-foreground">Complete · {run.result?.candidates.length || 0} sample creators</span></span><ChevronRight aria-hidden="true" className="ml-auto size-4 text-muted-foreground" />
                </button>
              ) : run.status === "draft" && !run.business_approved ? (
                <div className="text-sm">
                  <div className="flex items-center gap-2.5 font-medium"><BriefcaseBusiness aria-hidden="true" className="size-4" />Business</div>
                  <div className="mt-5 flex items-start gap-3">
                    <BusinessIcon brand={run.brief?.brand} iconUrls={run.website?.iconUrls || (run.website?.iconUrl ? [run.website.iconUrl] : [])} />
                    <div className="min-w-0"><p className="font-medium">{run.brief?.brand || "Business"}</p>
                      {run.website?.excerpt && <p className="mt-0.5 line-clamp-2 text-muted-foreground">{run.website.excerpt}</p>}
                    </div>
                  </div>
                  <dl className="mt-4 divide-y divide-border/70 border-y border-border/70">
                    <div className="grid grid-cols-[minmax(90px,25%)_1fr] gap-3 py-3"><dt>Audience</dt><dd><AudienceSummary segments={run.audience_suggestions} fallback={run.brief?.audienceDetail || run.brief?.audience || "Not set"} /></dd></div>
                    <div className="grid grid-cols-[minmax(90px,25%)_1fr] gap-3 py-3"><dt>Goal</dt><dd>{run.brief?.goal || "Not set"}</dd></div>
                  </dl>
                  <div className="mt-4 flex justify-end"><Button disabled={busy || historyOnly || run.revision !== state.revision} onClick={async () => {
                    if (await act({ action: "approve_business", revision: state.revision, runId: run.id })) setRuns((items) => items.map((item) => item.id === run.id ? { ...item, business_approved: true } : item));
                  }}>Looks good</Button></div>
                </div>
              ) : run.status === "draft" && run.business_approved && run.brief ? (
                <div className="text-sm">
                  <div className="flex items-center gap-2.5 font-medium"><Search aria-hidden="true" className="size-4" />Search</div>
                  <p className="mt-1 truncate text-muted-foreground" title={discoveryScope(run.brief, run.audience_suggestions)}>{discoveryScope(run.brief, run.audience_suggestions)}</p>
                  <div className="mt-4 divide-y divide-border/70 border-y border-border/70">
                    {[
                      { name: "Scout", color: "#b17a46", task: "Find candidates", detail: "Find sample creators whose work fits the campaign." },
                      { name: "Muse", color: "#3088f4", task: "Assess audience fit", detail: "Compare each candidate’s audience and content with the brief." },
                      { name: "Dot", color: "#f5f5f4", task: "Check evidence and constraints", detail: "Review supporting evidence, exclusions, and the available budget." },
                    ].map((agent) => <details key={agent.name} className="group">
                      <summary className="flex min-h-12 cursor-pointer list-none items-center gap-3 py-1 [&::-webkit-details-marker]:hidden">
                        <Mascot color={agent.color} small /><span><span className="font-medium">{agent.name}</span> · {agent.task}</span><ChevronRight aria-hidden="true" className="ml-auto size-4 text-muted-foreground transition-transform group-open:rotate-90" />
                      </summary>
                      <p className="pb-3 pl-12 text-muted-foreground">{agent.detail}</p>
                    </details>)}
                  </div>
                  <div className="mt-4 flex justify-end"><Button disabled={busy || historyOnly || run.revision !== state.revision} onClick={async () => {
                    setBusy(true);
                    setError("");
                    try {
                      const response = await fetch("/api/creator-campaign/start", {
                        method: "POST",
                        headers: { "Content-Type": "application/json", "x-demo-code": code },
                        body: JSON.stringify({ runId: run.id }),
                      });
                      if (!response.ok) throw Error((await response.json()).error);
                      setRuns((previous) => previous.map((item) => item.id === run.id ? { ...item, status: "queued", updated_at: new Date().toISOString() } : item));
                      setOpenRunId(run.id);
                    } catch (e) {
                      setError((e as Error).message);
                    } finally {
                      setBusy(false);
                    }
                  }}>Run search</Button></div>
                </div>
              ) : (
                <AgentTeamHeader
                  participants={team}
                  title="Campaign agents"
                  description={run.status === "queued" ? "Queued" : run.status === "running" ? `${["Scout", "Muse", "Dot"][run.activity.length] || "Team"} is working…` : run.status === "stale" ? "Brief changed" : "Discovery failed"}
                  action={(run.status === "queued" || run.status === "running") ? <Button className="rounded-full" variant="outline" onClick={() => setOpenRunId(run.id)}>Open agent chat</Button> : undefined}
                />
              )}
              {!!run.result?.legacy && !!run.result.previous?.length && (
                <details className="mt-3">
                  <summary>Previously saved creators</summary>
                  <p>{run.result.previous.map((c) => run.result?.profiles?.find((p) => p.id === c.id)?.name || creators.find((p) => p.id === c.id)?.name || c.id).join(", ")}</p>
                </details>
              )}
              {(run.status === "failed" ||
                (run.status === "queued" &&
                  Date.now() - Date.parse(run.updated_at) > 60000) ||
                (run.status === "running" &&
                  Date.now() - Date.parse(run.updated_at) > 180000)) &&
                run.revision === state.revision && (
                  <Button
                    className="mt-3"
                    variant="outline"
                    disabled={busy}
                    onClick={async () => {
                      setBusy(true);
                      setError("");
                      try {
                        const r = await fetch("/api/creator-campaign/retry", {
                          method: "POST",
                          headers: {
                            "Content-Type": "application/json",
                            "x-demo-code": code,
                          },
                          body: JSON.stringify({ runId: run.id }),
                        });
                        if (!r.ok) throw Error((await r.json()).error);
                        setRuns((old) =>
                          old.map((x) =>
                            x.id === run.id
                              ? {
                                  ...x,
                                  status: "queued",
                                  activity: [],
                                  updated_at: new Date().toISOString(),
                                }
                              : x,
                          ),
                        );
                      } catch (e) {
                        setError((e as Error).message);
                      } finally {
                        setBusy(false);
                      }
                    }}
                  >
                    Retry discovery
                  </Button>
                )}
            </div>
            {(run.status === "ready" || run.status === "stale") && run.result && (
              <div className="space-y-3">
                <p className="text-sm">{run.result.replacementAdded !== undefined ? (run.result.replacementAdded ? "I found another sample creator and kept the rest of your shortlist." : "I couldn’t find another matching sample creator.") : run.result.candidates.length ? `I found ${run.result.candidates.length} sample ${run.result.candidates.length === 1 ? "creator" : "creators"}.` : "I couldn’t find a matching sample creator."}</p>
                {!!run.result.candidates.length && <button type="button" onClick={() => setShortlistRunId(run.id)} className="block w-full rounded-2xl bg-muted p-4 text-left text-sm transition-colors hover:bg-muted/80 focus-visible:outline-2 focus-visible:outline-ring" aria-label={`Open creator shortlist, ${run.result.candidates.length} sample creators`}>
                  <span className="flex items-center gap-3"><span className="grid size-10 shrink-0 place-items-center rounded-lg bg-background"><FileText aria-hidden="true" className="size-5" /></span><span><span className="block font-medium">Creator shortlist</span><span className="block text-muted-foreground">{run.result.candidates.length} sample creators</span></span></span>
                  <span className="mt-3 block overflow-hidden rounded-lg border border-border/70">
                    <span className="grid grid-cols-[minmax(110px,35%)_1fr] gap-3 border-b border-border/70 px-3 py-2 text-xs text-muted-foreground"><span>Creator</span><span>Fit evidence</span></span>
                    {run.result.candidates.slice(0, 3).map((candidate) => { const creator = run.result?.profiles?.find((entry) => entry.id === candidate.id) || creators.find((entry) => entry.id === candidate.id); if (!creator) return null; return <span key={candidate.id} className="grid grid-cols-[minmax(110px,35%)_1fr] items-center gap-3 border-b border-border/50 px-3 py-2 last:border-0"><span className="flex min-w-0 items-center gap-2"><span aria-hidden="true" className="grid size-7 shrink-0 place-items-center rounded-full bg-background text-xs">{creator.name.slice(0, 1)}</span><span className="truncate">{creator.name}</span></span><span className="line-clamp-1 text-muted-foreground">{candidate.reason}</span></span>; })}
                  </span>
                </button>}
                <div className="flex flex-wrap items-start gap-2">
                  {!!run.result.candidates.length && <Button variant="outline" onClick={() => setShortlistRunId(run.id)}>Review creators</Button>}
                  {!historyOnly && run.status === "ready" && run.id === currentRun && !!run.result.candidates.length && <div className={state.outreach?.revision === state.revision ? "w-full" : ""}><CreatorOutreach state={state} busy={busy} act={act} onReview={setSelected} /></div>}
                </div>
                <Dialog.Root open={shortlistRunId === run.id} onOpenChange={(open) => setShortlistRunId(open ? run.id : null)}><Dialog.Portal container={typeof document !== "undefined" ? document.querySelector<HTMLElement>("[data-unified-workspace]") : undefined}><Dialog.Overlay className="fixed inset-0 z-50 bg-black/50"/><Dialog.Content className="fixed left-1/2 top-1/2 z-50 max-h-[85dvh] w-[min(760px,calc(100%-2rem))] -translate-x-1/2 -translate-y-1/2 overflow-auto rounded-2xl bg-background p-5 shadow-xl" aria-describedby={undefined}>
                  <div className="flex items-center justify-between"><Dialog.Title className="text-base font-medium">Sample creators</Dialog.Title><Dialog.Close asChild><Button variant="ghost">Close</Button></Dialog.Close></div>
                  <div className="mt-3 divide-y divide-border">{run.result.candidates.map((candidate) => { const creator = run.result?.profiles?.find((entry) => entry.id === candidate.id) || creators.find((entry) => entry.id === candidate.id); if (!creator) return null; return <article key={candidate.id} className="space-y-2 py-3 text-sm"><div className="flex justify-between gap-3"><span className="font-medium">{creator.name}</span><span>{money(creator.cents)} · sample quote</span></div><p className="text-muted-foreground">{creator.platform} · {creator.format}</p><p>{candidate.reason}</p><details><summary>Evidence</summary>{candidate.evidenceIndexes.map((index) => <p key={index} className="mt-1">{creator.evidence[index]}</p>)}</details>{!historyOnly && run.id === currentRun && state.candidates.some((entry) => entry.id === candidate.id) && <div className="flex gap-2"><Button variant="outline" onClick={() => { setShortlistRunId(null); setSelected(candidate.id); }}>Review deal</Button><Button variant="ghost" aria-label={`Remove ${creator.name}`} onClick={() => { setShortlistRunId(null); onMessage(`Exclude ${creator.name} and find another creator.`); }}>Remove</Button></div>}</article>; })}</div>
                </Dialog.Content></Dialog.Portal></Dialog.Root>
              </div>
            )}
            <Dialog.Root open={openRunId === run.id} onOpenChange={(open) => setOpenRunId(open ? run.id : null)}>
              <Dialog.Portal container={typeof document !== "undefined" ? document.querySelector<HTMLElement>("[data-unified-workspace]") : undefined}>
                <Dialog.Overlay className="fixed inset-0 z-50 bg-black/50" />
                <Dialog.Content className="fixed left-1/2 top-1/2 z-50 flex h-[min(700px,90dvh)] w-[min(680px,calc(100%-2rem))] -translate-x-1/2 -translate-y-1/2 flex-col overflow-hidden rounded-3xl bg-background shadow-xl focus:outline-none" aria-describedby={undefined}>
                  <header className="flex items-center gap-3 border-b border-border px-5 py-4">
                    <div className="flex -space-x-2">{team.map((agent) => <Mascot key={agent.name} color={agent.color} small />)}</div>
                    <Dialog.Title className="flex-1 text-sm font-semibold">Campaign agents</Dialog.Title>
                    <Dialog.Close aria-label="Close agent chat" className="rounded-full p-2 hover:bg-muted"><X size={18} /></Dialog.Close>
                  </header>
                  <div className="flex-1 space-y-4 overflow-y-auto px-5 py-5" role="log" aria-live="polite">
                    {run.activity.map((activity) => <div key={activity.name} className="flex gap-2">
                      <Mascot color={team.find((member) => member.name === activity.name)?.color || "#d2c4e6"} small />
                      <div><p className="text-xs text-muted-foreground">{activity.name}</p><p className="mt-1 whitespace-pre-wrap rounded-2xl bg-muted px-4 py-3 text-sm">{compactAgentSummary(activity.summary)}</p></div>
                    </div>)}
                    {run.result?.evidenceCheck && <p className="text-sm">Evidence check · {run.result.evidenceCheck.retained} of {run.result.evidenceCheck.reviewed} retained</p>}
                    {(run.status === "queued" || run.status === "running") && <p role="status" className="text-sm text-muted-foreground">{run.status === "queued" ? "Starting…" : `${["Scout", "Muse", "Dot"][run.activity.length] || "Team"} is working…`}</p>}
                    {run.status === "failed" && <p role="alert">Discovery couldn’t finish.</p>}
                  </div>
                  <div className="flex justify-end border-t border-border p-4"><Dialog.Close asChild><Button className="rounded-full">{run.status === "ready" ? "View creators" : "Close"}</Button></Dialog.Close></div>
                </Dialog.Content>
              </Dialog.Portal>
            </Dialog.Root>
          </div>,
          target,
          run.id,
        );
      })}
      <div className="grid gap-3">
        {(runs.length ? [] : state.candidates).map((c) => {
          const p = creators.find((x) => x.id === c.id)!;
          return (
            <article key={p.id} className="rounded-2xl bg-muted p-5">
              <div className="flex flex-wrap justify-between gap-2">
                <h3 className="font-medium">{p.name}</h3>
                <span className="text-sm">{money(p.cents)} · sample quote</span>
              </div>
              <p className="mt-1 text-sm text-muted-foreground">
                {p.platform} · {p.format}
              </p>
              <p className="mt-3 text-sm">{c.reason}</p>
              <details className="mt-3 text-sm">
                <summary className="cursor-pointer">Evidence</summary>
                <ul className="mt-2 list-disc space-y-2 pl-4">
                  {c.evidenceIndexes.map((i) => (
                    <li key={i}>{p.evidence[i]}</li>
                  ))}
                </ul>
                <p className="mt-2">
                  Fictional portfolio examples; audience demographics and
                  results are not verified.
                </p>
              </details>
              <Button
                className="mt-4"
                variant="outline"
                onClick={() => setSelected(p.id)}
              >
                Review {p.name.split(" ")[0]}
              </Button>
            </article>
          );
        })}
      </div>
      {agreement && (currentMessage && checkpointNodes[currentMessage]
        ? createPortal(agreement, checkpointNodes[currentMessage])
        : agreement)}
      {error && (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      )}
    </section>
  );
}
function discoveryScope(brief: Campaign["brief"], suggestions?: string[]): string {
  const platforms = [...new Set(creators.filter((creator) => creator.audience === brief.audience).map((creator) => creator.platform))];
  const focus = brief.topics.slice(0, 3).join(", ") || suggestions?.slice(0, 2).join(", ") || brief.audienceDetail || brief.audience || "creators";
  return ["Sample creators", platforms.join(", "), focus].filter(Boolean).join(" · ");
}
function AudienceSummary({ segments, fallback }: { segments?: string[]; fallback: string }) {
  const [expanded, setExpanded] = useState(false);
  if (!segments?.length) return <>{fallback}</>;
  const visible = segments.slice(0, 3);
  const extra = segments.slice(3);
  return <span>{visible.join(", ")}{extra.length > 0 && (expanded ? <>, {extra.join(", ")}</> : <> <Tooltip><TooltipTrigger asChild><button type="button" className="underline decoration-dotted underline-offset-4" aria-label={`Show ${extra.length} more suggested audiences`} aria-expanded={false} onClick={() => setExpanded(true)}>+{extra.length} more</button></TooltipTrigger><TooltipContent>{extra.join(", ")}</TooltipContent></Tooltip></>)}</span>;
}
function BusinessIcon({ brand, iconUrls }: { brand?: string | null; iconUrls: string[] }) {
  const [failed, setFailed] = useState<string[]>([]);
  const iconUrl = iconUrls.find((url) => !failed.includes(url));
  return <span aria-hidden="true" className="grid size-10 shrink-0 place-items-center overflow-hidden rounded-lg bg-background font-medium">
    {iconUrl ? <img src={iconUrl} alt="" className="size-full object-contain" referrerPolicy="no-referrer" onError={() => setFailed((urls) => [...urls, iconUrl])} /> : (brand || "B").slice(0, 1).toUpperCase()}
  </span>;
}
function AgreementSetup({
  format,
  cents,
  deadline,
  busy,
  onPrepare,
}: {
  format: string;
  cents: number;
  deadline: string | null;
  busy: boolean;
  onPrepare: (delivery: string, rightsDays: number, paymentStructure: "upfront" | "split") => void;
}) {
  const [delivery, setDelivery] = useState("");
  const [customDelivery, setCustomDelivery] = useState(false);
  const [rightsDays, setRightsDays] = useState(0);
  const [customRights, setCustomRights] = useState(false);
  const [paymentStructure, setPaymentStructure] = useState<"upfront" | "split" | null>(null);
  const deliveryOptions = [...new Set([...(deadline ? [deadline] : []), "Within 1 week", "Within 2 weeks"])];
  const choiceClass = "min-h-11 rounded-full bg-muted px-4 text-sm hover:bg-muted/70 focus-visible:outline-2 focus-visible:outline-ring disabled:opacity-50";
  return (
    <div className="space-y-4">
      <p className="text-sm">One {format.toLowerCase()} · {money(cents)}</p>
      {!delivery || customDelivery ? (
        <div className="space-y-2">
          <p className="text-sm font-medium">When should it be delivered?</p>
          <div className="flex flex-wrap gap-2">
            {deliveryOptions.map((option) => (
              <button key={option} type="button" className={choiceClass} disabled={busy} onClick={() => { setDelivery(option); setCustomDelivery(false); }}>{option}</button>
            ))}
            <button type="button" className={choiceClass} disabled={busy} onClick={() => { setDelivery(""); setCustomDelivery(true); }}>Something else</button>
          </div>
          {customDelivery && <form className="flex gap-2" onSubmit={(event) => { event.preventDefault(); const value = String(new FormData(event.currentTarget).get("delivery") || "").trim(); if (value) { setDelivery(value); setCustomDelivery(false); } }}>
            <input autoFocus name="delivery" aria-label="Delivery timeframe" required maxLength={100} placeholder="Enter a date or timeframe" className="min-w-0 flex-1 rounded-full border border-input bg-background px-4 py-2 text-sm" />
            <Button type="submit" disabled={busy} className="rounded-full">Continue</Button>
          </form>}
        </div>
      ) : (
        <button type="button" onClick={() => setDelivery("")} className="rounded-xl bg-muted px-4 py-3 text-left text-sm">Delivery · {delivery}</button>
      )}
      {!!delivery && (!rightsDays || customRights ? (
        <div className="space-y-2">
          <p className="text-sm font-medium">How long do you need usage rights?</p>
          <div className="flex flex-wrap gap-2">
            {[30, 90].map((days) => (
              <button key={days} type="button" className={choiceClass} disabled={busy} onClick={() => { setRightsDays(days); setCustomRights(false); }}>{days} days</button>
            ))}
            <button type="button" className={choiceClass} disabled={busy} onClick={() => { setRightsDays(0); setCustomRights(true); }}>Something else</button>
          </div>
          {customRights && <form className="flex gap-2" onSubmit={(event) => { event.preventDefault(); const value = Number(new FormData(event.currentTarget).get("rights")); if (Number.isInteger(value) && value >= 1 && value <= 365) { setRightsDays(value); setCustomRights(false); } }}>
            <input autoFocus name="rights" aria-label="Usage rights in days" type="number" required min={1} max={365} placeholder="Number of days" className="min-w-0 flex-1 rounded-full border border-input bg-background px-4 py-2 text-sm" />
            <Button type="submit" disabled={busy} className="rounded-full">Continue</Button>
          </form>}
        </div>
      ) : (
        <button type="button" onClick={() => setRightsDays(0)} className="block rounded-xl bg-muted px-4 py-3 text-left text-sm">Usage rights · {rightsDays} days</button>
      ))}
      {!!delivery && !!rightsDays && <div className="space-y-2"><p className="text-sm font-medium">When should payment be made?</p><div className="flex flex-wrap gap-2">{(["upfront", "split"] as const).map((option) => <button key={option} type="button" aria-pressed={paymentStructure === option} className={`${choiceClass} ${paymentStructure === option ? "ring-2 ring-foreground" : ""}`} onClick={() => setPaymentStructure(option)}>{option === "upfront" ? "100% upfront" : "50% upfront, 50% after delivery"}</button>)}</div></div>}
      {!!delivery && !!rightsDays && paymentStructure && <Button disabled={busy} onClick={() => onPrepare(delivery, rightsDays, paymentStructure)}>Prepare sample agreement</Button>}
    </div>
  );
}
function BoardDialog({
  state,
  onClose,
  onSelect,
}: {
  state: Campaign;
  onClose: () => void;
  onSelect: (id: string) => void;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    dialog.current?.showModal();
    return () => dialog.current?.close();
  }, []);
  return (
    <dialog
      ref={dialog}
      aria-labelledby="creator-board-title"
      onCancel={onClose}
      onClose={onClose}
      className="m-auto w-[calc(100%-2rem)] max-w-6xl max-h-[85vh] overflow-auto rounded-2xl border border-border bg-background p-5 text-foreground shadow-xl backdrop:bg-black/30"
    >
      <div className="mb-4 flex justify-between gap-3">
        <h2 id="creator-board-title" className="font-medium">
          {state.brief.brand} campaign
        </h2>
        <Button variant="ghost" onClick={onClose}>
          Close board
        </Button>
      </div>
      <Board state={state} onSelect={onSelect} />
    </dialog>
  );
}
