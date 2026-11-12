"use client";

import { useEffect, useRef, useState } from "react";
import * as Dialog from "@radix-ui/react-dialog";
import { ArrowUp, X } from "lucide-react";
import { Button } from "./ui/button";
import catalog from "./data/channel3-preview.json";
import { filterGroundedSuggestions } from "../../../lib/mock-gift-feedback";

type Sample = { category: string; title: string; detail: string; color: string; symbol: string };
type PreviewResponse = { productIndices: number[]; suggestions: string[]; discussion: string[]; summary: string };
type Round = { feedback: string; samples: Sample[]; published?: boolean; result?: PreviewResponse };
const samples: Sample[] = [
  { category: "hosting", title: "Entertaining set", detail: "Ideas for having people over.", color: "#e7ddcf", symbol: "◓" },
  { category: "hosting", title: "Serving set", detail: "A different way to host.", color: "#e7ddcf", symbol: "◒" },
  { category: "fishing", title: "Personalized tackle roll", detail: "A compact way to keep favorite lures together.", color: "#d5e4d8", symbol: "◒" },
  { category: "fishing", title: "Fly-tying starter set", detail: "A hands-on idea for time away from work.", color: "#d5e4d8", symbol: "⌁" },
  { category: "home", title: "Sculptural catchall tray", detail: "Something useful and distinctive for the new place.", color: "#e7ddcf", symbol: "◓" },
  { category: "home", title: "Portable reading light", detail: "A small upgrade that works in any room.", color: "#e7ddcf", symbol: "◍" },
  { category: "personal", title: "Custom illustrated map", detail: "A favorite place, made personal.", color: "#e1daf0", symbol: "✳" },
  { category: "personal", title: "Engraved everyday carry", detail: "A useful object with a personal detail.", color: "#e1daf0", symbol: "◇" },
  { category: "sports", title: "Stadium art print", detail: "A subtle nod to a favorite team.", color: "#e9d8cd", symbol: "◌" },
  { category: "sports", title: "Game-day tabletop set", detail: "For watching a game with friends.", color: "#e9d8cd", symbol: "▦" },
  { category: "experience", title: "Local workshop voucher", detail: "An experience they can choose when ready.", color: "#d9e4e9", symbol: "✦" },
  { category: "experience", title: "Private casting lesson", detail: "A different way to enjoy an existing hobby.", color: "#d9e4e9", symbol: "∿" },
  { category: "travel", title: "Travel journal set", detail: "A thoughtful companion for the next trip.", color: "#e8e1cd", symbol: "▤" },
  { category: "travel", title: "Compact travel kit", detail: "Useful things for time on the road.", color: "#e8e1cd", symbol: "◫" },
];
const tags: Record<string, RegExp> = { hosting: /entertain|host|dinner|serving|glassware/i, fishing: /fish|angler|lure|tackle|cast(?:ing)?/i, home: /home|apartment|house|kitchen|decor/i, personal: /personal|custom|meaningful|sentimental|art/i, sports: /sport|team|game|football|basketball/i, experience: /experience|activity|lesson|trip|adventure/i, travel: /travel|trip|dallas|journey/i };
const agents = [{ name: "Scout", color: "#b4d3be" }, { name: "Muse", color: "#d2c4e6" }, { name: "Dot", color: "#e8c9ae" }];
function excludedDirections(feedback: string) {
  return new Set(Object.entries(tags).filter(([key]) => new RegExp(`\\b(?:no|less|not|avoid|without)\\b[^,.;]{0,24}\\b${key === "fishing" ? "fish\\w*" : key + "\\w*"}`, "i").test(feedback)).map(([key]) => key));
}
function selectSamples(context: string, feedback: string, round: number): Sample[] {
  const excluded = excludedDirections(feedback);
  const preferred = Object.entries(tags).filter(([key, pattern]) => !excluded.has(key) && pattern.test(feedback)).map(([key]) => key);
  const contextual = Object.entries(tags).filter(([key, pattern]) => !excluded.has(key) && pattern.test(context)).map(([key]) => key);
  const priorities = [...new Set([...preferred, ...contextual, "personal", "home", "experience", "travel", "sports", "fishing"])].filter((category) => !excluded.has(category));
  return priorities.slice(0, 3).map((category) => {
    const matching = samples.filter((sample) => sample.category === category);
    const allowed = matching.filter((sample) => [...excluded].every((key) => !tags[key].test(`${sample.title} ${sample.detail}`)));
    const options = allowed.length ? allowed : matching;
    return options[round % options.length];
  });
}
const directions: Record<string, string> = {
  hosting: "something for entertaining",
  fishing: "something inspired by fishing",
  home: "something for the home",
  personal: "a personal touch",
  sports: "a sports-related idea",
  experience: "an experience",
  travel: "something for a trip",
};
function discussion(round: Round) {
  if (round.feedback && round.result?.discussion?.length === 3) return round.result.discussion;
  const first = directions[round.samples[0]?.category] ?? "a different direction";
  const second = directions[round.samples[1]?.category] ?? "another angle";
  const third = directions[round.samples[2]?.category] ?? "one more possibility";
  const excluded = [...excludedDirections(round.feedback)][0];
  const reaction = excluded && directions[excluded] ? `Let’s move away from ${directions[excluded]} and try ${first}.` : `Got it. Let’s try ${first} this time.`;
  return round.feedback
    ? [reaction, `I like that. I'll add ${second}.`, `And ${third} gives us another option. Here’s a new set.`]
    : [`We could start with ${first}.`, `Good idea. Let’s also consider ${second}.`, `I’ll add ${third}, so we have a few directions to compare.`];
}
function examplesForRound(feedback: string, index: number) {
  let choices = [...catalog];
  if (/\b(?:less|no|avoid|without)\b[^,.;]{0,24}\bglass/i.test(feedback)) choices = choices.filter((product) => !/glass/i.test(product.title));
  if (/personal|custom|monogram/i.test(feedback)) choices.sort((a, b) => Number(/personal|custom|monogram|engrav/i.test(b.title)) - Number(/personal|custom|monogram|engrav/i.test(a.title)));
  else if (/practical|useful/i.test(feedback)) choices.sort((a, b) => Number(/board/i.test(b.title)) - Number(/board/i.test(a.title)));
  else if (index && choices.length) choices = [...choices.slice((index * 3) % choices.length), ...choices.slice(0, (index * 3) % choices.length)];
  return choices.slice(0, 3);
}
function Mascot({ color, small = false }: { color: string; small?: boolean }) {
  return <svg aria-hidden="true" viewBox="0 0 128 128" className={small ? "size-9 shrink-0" : "size-12 shrink-0"}><path fill={color} d="M64 17C88 17 107 32 109 55C112 80 96 105 70 109C45 113 22 99 19 76C15 51 36 18 64 17Z"/><rect x="47" y="53" width="10" height="22" rx="5" fill="#252420"/><rect x="72" y="50" width="10" height="22" rx="5" fill="#252420"/></svg>;
}
export default function MockGiftGroup({ conversationId, context, code }: { conversationId: string; context: string; code: string }) {
  const storageKey = `sume.mock-gift.${conversationId}`;
  const [rounds, setRounds] = useState<Round[]>([]);
  const [open, setOpen] = useState(false);
  const [feedback, setFeedback] = useState("");
  const [thinking, setThinking] = useState(false);
  const [previewError, setPreviewError] = useState("");
  const suggestionRequest = useRef("");
  const thread = useRef<HTMLDivElement>(null);
  const lastRound = useRef<HTMLDivElement>(null);
  useEffect(() => {
    try {
      const stored = JSON.parse(sessionStorage.getItem(storageKey) || "[]");
      if (Array.isArray(stored) && stored.every((round) => typeof round.feedback === "string" && Array.isArray(round.samples))) setRounds(stored);
    } catch { /* Ignore invalid local preview state. */ }
  }, [storageKey]);
  useEffect(() => {
    if (open && rounds.length > 1 && thread.current && lastRound.current) {
      thread.current.scrollTop = Math.max(0, lastRound.current.offsetTop - thread.current.offsetTop);
    }
  }, [open, rounds.length]);
  function save(next: Round[]) { setRounds(next); sessionStorage.setItem(storageKey, JSON.stringify(next)); }
  async function requestPreview(mode: "suggestions" | "feedback", text: string, current: Round[], shownIndices: number[]): Promise<PreviewResponse> {
    const response = await fetch("/api/mock-gift-feedback", {
      method: "POST", headers: { "Content-Type": "application/json", "x-demo-code": code },
      body: JSON.stringify({ conversationId, mode, feedback: text, priorFeedback: current.map((round) => round.feedback).filter(Boolean).slice(-10), shownIndices }),
    });
    if (!response.ok) throw new Error("Couldn’t update the preview. Please try again.");
    return response.json();
  }
  const latestPublished = rounds.findLastIndex((round) => round.published);
  useEffect(() => {
    if (latestPublished < 0 || rounds[latestPublished].result?.suggestions || rounds.at(-1)?.published !== true) return;
    const key = `${storageKey}:${latestPublished}`;
    if (suggestionRequest.current === key) return;
    suggestionRequest.current = key;
    const shownIndices = examplesForRound(rounds[latestPublished].feedback, latestPublished).map((product) => catalog.findIndex((entry) => entry.url === product.url));
    setThinking(true);
    requestPreview("suggestions", "", rounds, shownIndices).then((result) => {
      setRounds((current) => {
        if (!current[latestPublished]?.published || current[latestPublished]?.result) return current;
        const next = current.map((round, index) => index === latestPublished ? { ...round, result } : round);
        sessionStorage.setItem(storageKey, JSON.stringify(next));
        return next;
      });
      setPreviewError("");
    }).catch(() => setPreviewError("Couldn’t suggest feedback. You can still type your own."))
      .finally(() => setThinking(false));
  // A persisted round is analyzed only once. A new round is generated explicitly on submit.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [latestPublished, rounds, storageKey, conversationId, code]);
  function start() { if (!rounds.length) save([{ feedback: "", samples: selectSamples(context, "", 0) }]); setOpen(true); }
  async function submit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const text = feedback.trim();
    if (!text || thinking) return;
    setThinking(true); setPreviewError("");
    try {
      const shown = latestPublished < 0 ? [] : (rounds[latestPublished].result?.productIndices ?? examplesForRound(rounds[latestPublished].feedback, latestPublished).map((product) => catalog.findIndex((entry) => entry.url === product.url)));
      const result = await requestPreview("feedback", text, rounds, shown);
      save([...rounds, { feedback: text, samples: selectSamples(context, text, rounds.length), result }]);
      setFeedback("");
      setOpen(true);
    } catch { setPreviewError("Couldn’t update the preview. Please try again."); }
    finally { setThinking(false); }
  }
  async function advance() {
    const last = rounds.length - 1;
    if (last < 0 || thinking) return;
    const current = rounds[last];
    let result = current.result;
    if (current.feedback && !result) {
      setThinking(true); setPreviewError("");
      try {
        const previous = rounds.slice(0, last).findLast((round) => round.published);
        const previousIndex = previous ? rounds.indexOf(previous) : -1;
        const shown = previous ? (previous.result?.productIndices ?? examplesForRound(previous.feedback, previousIndex).map((product) => catalog.findIndex((entry) => entry.url === product.url))) : [];
        result = await requestPreview("feedback", current.feedback, rounds.slice(0, last), shown);
      } catch { setPreviewError("Couldn’t update the preview. Please try again."); return; }
      finally { setThinking(false); }
    }
    save(rounds.map((round, index) => index === last ? { ...round, ...(result ? { result } : {}), published: true } : round));
    setOpen(false);
  }
  const pending = rounds.length > 0 && !rounds.at(-1)?.published;
  return <>
    <div className="mt-4 rounded-2xl bg-muted p-5 sm:p-6">
      <div className="mb-4 flex -space-x-2">{agents.map((agent) => <Mascot key={agent.name} color={agent.color} />)}</div>
      <div className="flex flex-wrap items-end justify-between gap-4"><div><p className="font-medium">Group gift preview</p><p className="mt-1 text-sm text-muted-foreground">Simulated agents · Channel3 examples</p></div><Button className="rounded-full" onClick={start}>{rounds.length ? "Open preview" : "Start group chat"}</Button></div>
    </div>
    {rounds.map((round, index) => round.published && <div key={index} className="mt-5 space-y-3">
      {round.feedback && <p className="ml-auto max-w-[85%] rounded-2xl bg-muted px-4 py-3 text-sm">{round.feedback}</p>}
      <p className="text-sm">Here are some examples. What do you think?</p>
      <div className="rounded-2xl bg-muted p-4">
        <p className="mb-3 text-xs text-muted-foreground">Channel3 examples · Nov 10 snapshot</p>
        <div className="grid gap-2 sm:grid-cols-3">{(round.result ? round.result.productIndices.map((productIndex) => catalog[productIndex]).filter(Boolean) : examplesForRound(round.feedback, index)).map((product) => {
          return <a key={product.url} href={product.url} target="_blank" rel="noopener noreferrer" className="overflow-hidden rounded-xl bg-background focus-visible:outline-2 focus-visible:outline-ring">
            <img src={product.image} alt="" loading="lazy" className="aspect-square w-full bg-neutral-100 object-cover" />
            <div className="p-3"><p className="line-clamp-2 text-sm font-medium">{product.title}</p><p className="mt-1 text-xs text-muted-foreground">{product.merchant} · ${(product.cents / 100).toFixed(2)}</p></div>
          </a>;
        })}</div>
        {round.result && round.result.productIndices.length === 0 && <p className="text-sm">None of the saved examples match that feedback. Try a different direction.</p>}
        <p className="mt-3 text-xs text-muted-foreground">Saved examples, not a live search for this chat. Prices and availability may have changed.</p>
      </div>
      {rounds[index + 1]?.feedback ? <details className="rounded-2xl bg-muted px-4 py-3 text-sm"><summary className="cursor-pointer">Feedback · {rounds[index + 1].feedback}</summary></details> : index === latestPublished && !pending && <form onSubmit={submit} className="rounded-2xl bg-muted p-4">
        <p className="mb-3 text-sm font-medium">What should the next pass change?</p>
        <div className="mb-3 flex flex-wrap gap-2">{filterGroundedSuggestions(round.result?.suggestions ?? [], round.result?.productIndices ?? [], catalog.map((product) => product.title)).map((suggestion) => <button type="button" key={suggestion} onClick={() => setFeedback(suggestion)} className="rounded-full bg-background px-3 py-2 text-sm hover:opacity-75">{suggestion}</button>)}</div>
        {thinking && <p role="status" className="mb-2 text-sm text-muted-foreground">Thinking…</p>}{previewError && <div className="mb-2 flex items-center gap-2"><p role="alert" className="text-sm text-destructive">{previewError}</p>{!round.result?.suggestions && <button type="button" className="text-sm underline" onClick={() => { suggestionRequest.current = ""; setPreviewError(""); setRounds((current) => [...current]); }}>Retry suggestions</button>}</div>}
        <div className="flex items-center gap-2 rounded-xl bg-background px-3"><label htmlFor={`mock-feedback-${index}`} className="sr-only">Feedback for the next pass</label><input id={`mock-feedback-${index}`} value={feedback} onChange={(event) => setFeedback(event.target.value)} maxLength={1000} placeholder="Or tell them in your own words" className="min-w-0 flex-1 bg-transparent py-3 text-sm outline-none"/><Button type="submit" size="icon" aria-label="Send feedback" disabled={!feedback.trim() || thinking} className="rounded-full"><ArrowUp size={18}/></Button></div>
      </form>}
    </div>)}
    <Dialog.Root open={open} onOpenChange={setOpen}><Dialog.Portal container={typeof document !== "undefined" ? document.querySelector<HTMLElement>("[data-unified-workspace]") : undefined}><Dialog.Overlay className="fixed inset-0 z-50 bg-black/50"/><Dialog.Content className="fixed left-1/2 top-1/2 z-50 flex h-[min(700px,90dvh)] w-[min(680px,calc(100%-2rem))] -translate-x-1/2 -translate-y-1/2 flex-col overflow-hidden rounded-3xl bg-background shadow-xl focus:outline-none" aria-describedby="mock-description">
      <header className="flex items-center gap-3 border-b border-border px-5 py-4"><div className="flex -space-x-2">{agents.map((agent) => <Mascot key={agent.name} color={agent.color} small />)}</div><div className="min-w-0 flex-1"><Dialog.Title className="text-sm font-semibold">Group gift preview</Dialog.Title><p id="mock-description" className="text-xs text-muted-foreground">Simulated conversation · AI-assisted</p></div><button type="button" className="rounded-full px-3 py-2 text-xs text-muted-foreground hover:bg-muted" onClick={() => { suggestionRequest.current = ""; setPreviewError(""); save([{ feedback: "", samples: selectSamples(context, "", 0) }]); setFeedback(""); }}>Reset</button><Dialog.Close aria-label="Close preview" className="rounded-full p-2 hover:bg-muted"><X size={18}/></Dialog.Close></header>
      <div ref={thread} className="relative flex-1 space-y-7 overflow-y-auto px-5 py-5" aria-live="polite">
        {rounds.map((round, index) => <div key={index} ref={index === rounds.length - 1 ? lastRound : undefined} className="space-y-4">
          {round.feedback && <p className="ml-auto max-w-[85%] rounded-2xl bg-muted px-4 py-3 text-sm whitespace-pre-wrap">{round.feedback}</p>}
          {discussion(round).map((message, agentIndex) => <div key={agents[agentIndex].name} className="flex gap-2"><Mascot color={agents[agentIndex].color} small /><div className="min-w-0"><p className="mb-1 text-xs text-muted-foreground">{agents[agentIndex].name}</p><p className="rounded-2xl bg-muted px-4 py-3 text-sm">{message}</p></div></div>)}
        </div>)}
      </div>
      <div className="flex items-center justify-between gap-3 border-t border-border p-4"><p className="text-xs text-muted-foreground">{previewError || (thinking ? "Thinking…" : "AI-assisted preview · no live search")}</p><Button type="button" className="rounded-full" disabled={thinking} onClick={() => void advance()}>{pending ? "Advance to results" : "View results"}</Button></div>
    </Dialog.Content></Dialog.Portal></Dialog.Root>
  </>;
}
