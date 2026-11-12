"use client";
import { useCallback, useEffect, useRef, useState, type CSSProperties } from "react";
import { useSearchParams } from "next/navigation";
import { DefaultChatTransport, readUIMessageStream, type UIMessage } from "ai";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import {
  Plus,
  House,
  PanelLeft,
  X,
  MessageSquare,
  ArrowUp,
  Square,
  Check,
  LogOut,
  LogIn,
  UserCircle,
} from "lucide-react";
import { DropdownMenu } from "radix-ui";
import { authClient } from "../../lib/auth-client";
import { workspaceConversationUrl } from "../../lib/workspace-return";
import {
  SidebarProvider,
  Sidebar,
  SidebarHeader,
  SidebarContent,
  SidebarFooter,
  SidebarInset,
  SidebarTrigger,
  SidebarMenu,
  SidebarMenuItem,
  SidebarMenuButton,
  useSidebar,
} from "./_components/ui/sidebar";
import { Button } from "./_components/ui/button";
import { Message, MessageContent } from "./_components/ui/message";
import {
  MessageScrollerProvider,
  MessageScroller,
  MessageScrollerViewport,
  MessageScrollerContent,
  MessageScrollerItem,
  MessageScrollerButton,
} from "./_components/ui/message-scroller";
import {
  InputGroup,
  InputGroupTextarea,
  InputGroupAddon,
  InputGroupButton,
} from "./_components/ui/input-group";
import {
  Sheet,
  SheetContent,
  SheetHeader,
  SheetTitle,
} from "./_components/ui/sheet";
import {
  Select,
  SelectTrigger,
  SelectValue,
  SelectContent,
  SelectItem,
} from "./_components/ui/select";
import WorkflowPanel from "./_components/workflow-panel";
import CreatorPanel from "./_components/creator-panel";
import CreatorGuide from "./_components/creator-guide";
import WorkspaceHome from "./_components/workspace-home";
import {creatorExamples} from "../../lib/creator/catalog";
import giftExamples from "../../evals/gift-clarification-cases.json";
import moreGiftExamples from "../../evals/gift-clarification-holdout.json";
import styles from "./_components/sidebar.module.css";
type Theme = "light" | "dark" | "ink-2" | "og-dark";
type Mode = "creators" | "shopping";
type Chat = { id: string; title: string; mode: Mode; revision: number };
type Msg = {
  id: string;
  role: "user" | "assistant";
  content: string;
  status: string;
  parent_id?: string;
  interaction?: { type: "creator_clarification"; options: string[] } | { type: "gift_clarification"; options: string[]; selection?: "single" | "multiple"; next?: "explore" | "ready" } | { type: "gift_mock_handoff" } | null;
};
function GiftClarificationCard({ question, options, selection, answer, busy, previewAvailable, onAnswer, showExtra = true, instant = false }: {
  question: string; options: string[]; selection: "single" | "multiple"; answer?: string; busy: boolean; previewAvailable: boolean; onAnswer: (answer: string) => void; showExtra?: boolean; instant?: boolean;
}) {
  const [selected, setSelected] = useState<string[]>([]);
  const [other, setOther] = useState(false);
  const [custom, setCustom] = useState("");
  const toggle = (option: string) => {
    const uncertain = /\b(not sure|unsure|surprise me|don.t know)\b/i;
    setSelected((current) => {
      if (current.includes(option)) return current.filter((item) => item !== option);
      if (selection === "single" || uncertain.test(option)) return [option];
      return [...current.filter((item) => !uncertain.test(item)), option];
    });
    if (selection === "single" || uncertain.test(option)) setOther(false);
  };
  if (answer) return <details className="rounded-2xl bg-muted px-5 py-4 text-sm"><summary className="cursor-pointer truncate">Answered · {answer}</summary><div className="mt-4 font-medium">{question}</div><div className="mt-2 text-muted-foreground">{options.join(" · ")}</div></details>;
  if (instant) return <div className="rounded-2xl bg-muted p-5 text-sm">
    <p className="mb-3 font-medium">{question}</p>
    <div className="flex flex-wrap gap-2" role="group" aria-label={question}>
      {options.map((option) => <button type="button" key={option} disabled={busy} onClick={() => onAnswer(option)} className="min-h-11 rounded-full bg-background px-4 text-left transition-colors hover:bg-background/70 focus-visible:outline-2 focus-visible:outline-ring disabled:opacity-50">{option}</button>)}
      {!options.includes("Continue without a website") && <button type="button" disabled={busy} onClick={() => setOther(true)} className="min-h-11 rounded-full bg-background px-4 text-left transition-colors hover:bg-background/70 focus-visible:outline-2 focus-visible:outline-ring disabled:opacity-50">Something else</button>}
    </div>
    {other && <form className="mt-3 flex gap-2" onSubmit={(event) => { event.preventDefault(); if (custom.trim() && !busy) onAnswer(custom.trim()); }}>
      <input autoFocus aria-label="Your answer" value={custom} onChange={(event) => setCustom(event.target.value)} placeholder="Type your answer" className="min-w-0 flex-1 rounded-full border border-border bg-background px-4 py-2 outline-none focus-visible:ring-2 focus-visible:ring-ring" />
      <Button type="submit" disabled={busy || !custom.trim()} className="rounded-full">Send</Button>
    </form>}
  </div>;
  const values = [...selected, ...(other && custom.trim() ? [custom.trim()] : [])];
  return <div className="rounded-2xl bg-muted p-5 text-sm">
    <p className="mb-3 font-medium">{question}</p>
    <div role="group" aria-label={question} className="flex flex-col gap-1">
      {options.map((option) => <label key={option} className="flex min-h-11 cursor-pointer items-center gap-3 rounded-xl px-2 hover:bg-background/70"><input type={selection === "multiple" ? "checkbox" : "radio"} name={selection === "single" ? question : undefined} checked={selected.includes(option)} disabled={busy} onChange={() => toggle(option)} className="size-4 accent-foreground" /><span>{option}</span></label>)}
      <label className="flex min-h-11 cursor-pointer items-center gap-3 rounded-xl px-2 hover:bg-background/70"><input type={selection === "multiple" ? "checkbox" : "radio"} name={selection === "single" ? question : undefined} checked={other} disabled={busy} onChange={() => { setOther(!other); if (selection === "single") setSelected([]); else setSelected((current) => current.filter((item) => !/\b(not sure|unsure|surprise me|don.t know)\b/i.test(item))); }} className="size-4 accent-foreground" /><span>Something else</span></label>
      {other && <input autoFocus aria-label="Something else" value={custom} onChange={(event) => setCustom(event.target.value)} placeholder="Type your answer" className="mt-1 w-full rounded-xl border border-border bg-background px-3 py-2 outline-none focus-visible:ring-2 focus-visible:ring-ring" />}
    </div>
    <div className="mt-4 flex items-center justify-between gap-3">{showExtra ? <Button type="button" variant="ghost" disabled={busy} onClick={() => onAnswer(previewAvailable ? "Start the group." : "Could you suggest some different directions?")} className="rounded-full">{previewAvailable ? "Start group" : "More ideas"}</Button> : <span />}<Button type="button" disabled={busy || !values.length || (other && !custom.trim())} onClick={() => onAnswer(values.length === 1 ? values[0] : `I'd like to explore: ${values.join("; ")}.`)} className="rounded-full">Continue</Button></div>
  </div>;
}
function CheckpointAnchor({ id, onChange }: { id: string; onChange: (id: string, node: HTMLElement | null) => void }) {
  const ref = useCallback((node: HTMLDivElement | null) => onChange(id, node), [id, onChange]);
  return <div ref={ref} id={`gift-checkpoint-${id}`} className="mt-5 empty:mt-0 empty:hidden" />;
}
const labels = { creators: "Creator campaigns", shopping: "Buy stuff" };
const prompts = {
  creators: [],
  shopping: [
    "Plan a group thank-you gift",
    "Find a birthday gift idea",
    "Help me choose something for myself",
    "Plan monthly office snacks",
  ],
};
export default function Workspace() {
  const query = useSearchParams();
  const session = authClient.useSession();
  const [home, setHome] = useState(() => !query.get("mode") && !query.get("conversation") && !query.get("giftInvite") && !query.get("snackInvite"));
  const [mode, setMode] = useState<Mode>(
    query.get("mode") === "shopping" ? "shopping" : "creators",
  );
  const [chats, setChats] = useState<Chat[]>([]),
    [chat, setChat] = useState<Chat | null>(null),
    [messages, setMessages] = useState<Msg[]>([]),
    [draft, setDraft] = useState(() => query.get("start") === "gifts" ? "Plan a group thank-you gift" : query.get("start") === "snacks" ? "Plan monthly office snacks" : ""),
    [exampleTitle, setExampleTitle] = useState(""),
    [mockPreviewAvailable, setMockPreviewAvailable] = useState(false),
    [busy, setBusy] = useState(false),
    [error, setError] = useState(""),
    [theme, setTheme] = useState<Theme>("light"),
    [account, setAccount] = useState(false),
    [code, setCode] = useState("");
  const [codeReady, setCodeReady] = useState(false);
  const [admission, setAdmission] = useState<"checking" | "allowed" | "denied" | "error">("checking");
  const [entryCode, setEntryCode] = useState("");
  const [entryError, setEntryError] = useState("");
  const abort = useRef<AbortController | null>(null),
    inFlight = useRef(false),
    composer = useRef<HTMLFormElement>(null),
    area = useRef<HTMLTextAreaElement>(null),
    root = useRef<HTMLDivElement>(null),
    current = useRef<string | null>(null),
    activeReply = useRef<string | null>(null);
  const [focusedGift, setFocusedGift] = useState<{ product: { id: string; title: string; image: string | null }; jobId: string } | null>(null);
  const refining = useRef(false);
  const pendingRefinement = useRef<{ key: string; feedbackId: string; jobId: string; chatMessageId?: string; shared: boolean } | null>(null);
  const refineHandler = useRef<(item: any) => void>(() => {});
  useEffect(() => {
    const focus = (event: Event) => setFocusedGift((event as CustomEvent).detail);
    const refine = (event: Event) => refineHandler.current((event as CustomEvent).detail);
    window.addEventListener("sume-product-focus", focus);
    window.addEventListener("sume-product-refine", refine);
    return () => { window.removeEventListener("sume-product-focus", focus); window.removeEventListener("sume-product-refine", refine); };
  }, []);
  useEffect(() => setFocusedGift(null), [chat?.id]);
  const [hasWorkflows, setHasWorkflows] = useState(false);
  const [checkpointNodes, setCheckpointNodes] = useState<Record<string, HTMLElement>>({});
  const [giftHeaderTarget, setGiftHeaderTarget] = useState<HTMLDivElement | null>(null);
  const registerCheckpoint = useCallback((id: string, node: HTMLElement | null) => {
    setCheckpointNodes((previous) => {
      if (previous[id] === node || (!node && !previous[id])) return previous;
      const next = { ...previous };
      if (node) next[id] = node; else delete next[id];
      return next;
    });
  }, []);
  const [giftView, setGiftView] = useState<
    "group" | "private" | "payment" | null
  >(null);
  const user = (
    session.data as unknown as { user: { id: string; name: string; email?: string; image?: string | null } } | null
  )?.user;
  async function api(body: unknown) {
    const r = await fetch("/api/workspace-chat", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    const v = await r.json();
    if (!r.ok) throw new Error(v.error);
    return v;
  }
  async function list() {
    const r = await fetch("/api/workspace-chat");
    if (r.ok) setChats((await r.json()).chats);
  }
  async function reopen(id: string) {
    setHome(false);
    abort.current?.abort();
    current.current = id;
    setBusy(false);
    setError("");
    const r = await fetch(`/api/workspace-chat?conversationId=${id}`);
    const data = await r.json();
    if (current.current !== id) return;
    if (!r.ok) {
      setError(data.error);
      return;
    }
    setChat(data.chat);
    setExampleTitle(sessionStorage.getItem(`sume.workspace.example.${id}`) || "");
    setMode(data.chat.mode);
    setMessages(data.messages);
    history.replaceState(null, "", workspaceConversationUrl(window.location.href, id));
  }
  useEffect(() => {
    try {
      const storedTheme = localStorage.getItem("sume.workspace.theme");
      setTheme(storedTheme === "light" || storedTheme === "ink-2" || storedTheme === "og-dark" ? storedTheme : storedTheme === "dark" || storedTheme === "ink" || storedTheme === "soft-black"
        ? "dark" : matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light");
      const saved = JSON.parse(
        sessionStorage.getItem("sume.workspace.draft") || "null",
      );
      if (saved && !query.get("start")) {
        setDraft(saved.text || "");
        if (!query.get("conversation")) setExampleTitle(saved.exampleTitle || "");
        if (
          !query.get("mode") &&
          (saved.mode === "shopping" || saved.mode === "creators")
        )
          setMode(saved.mode);
      }
      setCode(sessionStorage.getItem("sume.workspace.code") || "");
    } catch {}
    setCodeReady(true);
    return () => abort.current?.abort();
  }, []);
  useEffect(() => {
    if (!user || !codeReady) return;
    if (query.get("giftInvite") || query.get("snackInvite")) { setAdmission("allowed"); return; }
    let cancelled = false;
    setAdmission("checking");
    fetch("/api/workspace-chat/admission", {
      method: "POST", headers: { "Content-Type": "application/json", "x-demo-code": code },
      body: JSON.stringify({ conversationId: chat?.id || query.get("conversation") }),
    }).then(async response => {
      if (!response.ok) throw new Error();
      const result = await response.json();
      if (!cancelled) setAdmission(result.admitted ? "allowed" : "denied");
    }).catch(() => { if (!cancelled) setAdmission("error"); });
    return () => { cancelled = true; };
  }, [user?.id, codeReady, code, chat?.id, query]);
  async function submitAccessCode(event: React.FormEvent) {
    event.preventDefault();
    setEntryError("");
    try {
      const response = await fetch("/api/workspace-chat/admission", {
        method: "POST", headers: { "Content-Type": "application/json", "x-demo-code": entryCode },
        body: JSON.stringify({}),
      });
      if (!response.ok) throw new Error();
      if (!(await response.json()).admitted) { setEntryError("That access code isn’t valid."); return; }
      sessionStorage.setItem("sume.workspace.code", entryCode);
      setCode(entryCode);
      setAdmission("allowed");
    } catch { setEntryError("Couldn’t check the code. Try again."); }
  }
  useEffect(() => {
    if (!user) {
      setChats([]);
      setChat(null);
      setMessages([]);
      return;
    }
    void list();
    const id = query.get("conversation");
    if (id && /^[a-f0-9-]{36}$/i.test(id)) void reopen(id);
  }, [user?.id]);
  useEffect(() => {
    try {
      sessionStorage.setItem(
        "sume.workspace.draft",
        JSON.stringify({ text: draft, mode, exampleTitle }),
      );
    } catch {}
  }, [draft, mode, exampleTitle]);
  useEffect(() => {
    const el = composer.current;
    if (!el) {
      root.current?.style.setProperty("--composer-height", "0px");
      return;
    }
    const obs = new ResizeObserver(() =>
      root.current?.style.setProperty(
        "--composer-height",
        `${el.offsetHeight}px`,
      ),
    );
    obs.observe(el);
    return () => obs.disconnect();
  }, [giftView]);
  useEffect(() => {
    if (busy || !chat || !messages.some((m) => m.status === "streaming"))
      return;
    const id = chat.id;
    const timer = setInterval(async () => {
      try {
        const r = await fetch(`/api/workspace-chat?conversationId=${id}`);
        if (r.ok && current.current === id) {
          const data = await r.json();
          setMessages(data.messages);
          setChat(data.chat);
        }
      } catch {}
    }, 3000);
    return () => clearInterval(timer);
  }, [busy, chat?.id, messages.some((m) => m.status === "streaming")]);
  function newChat() {
    setHome(false);
    abort.current?.abort();
    current.current = null;
    setChat(null);
    setMessages([]);
    setBusy(false);
    setError("");
    setDraft("");
    setExampleTitle("");
    history.replaceState(null, "", `/workspace?mode=${mode}`);
    area.current?.focus();
  }
  async function changeMode(next: Mode) {
    setHome(false);
    if (busy) return;
    try {
      if (chat) {
        const data = await api({
          action: "mode",
          id: chat.id,
          mode: next,
          revision: chat.revision,
        });
        setChat(data.chat);
        void list();
      } else history.replaceState(null, "", `/workspace?mode=${next}`);
      setMode(next);
    } catch (e) {
      setError((e as Error).message);
    }
  }
  async function signIn() {
    try {
      sessionStorage.setItem(
        "sume.workspace.draft",
        JSON.stringify({ text: draft, mode }),
      );
      await authClient.signIn.social({
        provider: "google",
        callbackURL:
          (chat
            ? `${location.origin}/workspace?conversation=${chat.id}`
            : `${location.origin}/workspace?mode=${mode}`) +
          (query.get("giftInvite")
            ? `&giftInvite=${encodeURIComponent(query.get("giftInvite")!)}`
            : query.get("snackInvite") ? `&snackInvite=${encodeURIComponent(query.get("snackInvite")!)}` : ""),
      });
    } catch {
      setError("Sign-in could not start. Try again.");
    }
  }
  async function ensureWorkflowChat() {
    if (!user) {
      await signIn();
      return null;
    }
    if (chat) return chat.id;
    const data = await api({ action: "create", id: crypto.randomUUID(), mode });
    setChat(data.chat);
    current.current = data.chat.id;
    const pendingSnack = query.get("snackInvite");
    history.replaceState(null, "", `/workspace?conversation=${data.chat.id}${pendingSnack ? `&snackInvite=${encodeURIComponent(pendingSnack)}` : ""}`);
    void list();
    return data.chat.id;
  }
  async function send(retry?: Msg, suppliedText?: string, productRefinement = false) {
    if (inFlight.current) return;
    const text = retry
      ? messages.find((m) => m.id === retry.parent_id)?.content
      : (suppliedText ?? draft).trim();
    if (!text) return;
    if (!user) {
      await signIn();
      return;
    }
    setHome(false);
    inFlight.current = true;
    setBusy(true);
    setError("");
    let selected = chat;
    const controller = new AbortController();
    abort.current = controller;
    const requestId = crypto.randomUUID();
    activeReply.current = requestId;
    const messageId = retry?.parent_id || crypto.randomUUID();
    let sent = false;
    try {
      if (!selected) {
        const data = await api({
          action: "create",
          id: crypto.randomUUID(),
          mode,
        });
        selected = data.chat;
        if (exampleTitle) sessionStorage.setItem(`sume.workspace.example.${selected!.id}`, exampleTitle);
        setChat(selected);
        current.current = selected!.id;
        history.replaceState(
          null,
          "",
          `/workspace?conversation=${selected!.id}`,
        );
      }
      const id = selected!.id;
      current.current = id;
      if (!retry) {
        setMessages((ms) => [
          ...ms,
          { id: messageId, role: "user", content: text, status: "completed" },
        ]);
        if (suppliedText === undefined) setDraft("");
      }
      setMessages((ms) => [
        ...ms,
        {
          id: requestId,
          role: "assistant",
          content: "",
          status: "streaming",
          parent_id: messageId,
        },
      ]);
      const transport = new DefaultChatTransport<UIMessage>({
        api: "/api/workspace-chat/stream",
        prepareSendMessagesRequest: ({ body }) => ({ body }),
      });
      const stream = await transport.sendMessages({
        trigger: "submit-message",
        chatId: id,
        messageId: undefined,
        messages: [],
        abortSignal: controller.signal,
        headers: { "x-demo-code": code },
        body: {
          conversationId: id,
          requestId,
          messageId,
          text,
          mode,
          revision: selected!.revision,
          ...(retry ? { retryOf: retry.id } : {}),
          ...(productRefinement ? { productRefinement: true } : {}),
        },
      });
      for await (const reply of readUIMessageStream({
        stream,
        terminateOnError: true,
      })) {
        if (current.current !== id) break;
        const content = reply.parts
          .filter((p) => p.type === "text")
          .map((p) => p.text)
          .join("");
        setMessages((ms) =>
          ms.map((m) => (m.id === requestId ? { ...m, content } : m)),
        );
      }
      sent = true;
    } catch (e) {
      if (!controller.signal.aborted) {
        const message = (e as Error).message || "Connection interrupted.";
        if (message.includes("Enter your preview access code")) setAdmission("denied");
        else setError(message);
      }
    } finally {
      inFlight.current = false;
      activeReply.current = null;
      try {
        if (selected && current.current === selected.id) {
          const r = await fetch(
            `/api/workspace-chat?conversationId=${selected.id}`,
          );
          if (r.ok) {
            const data = await r.json();
            if (!data.messages.some((m: Msg) => m.id === messageId) && !retry && suppliedText === undefined)
              setDraft(text);
            setChat(data.chat);
            setMessages(data.messages);
          }
          await list();
        }
      } catch {
        setError(
          "Connection interrupted. Reopen the saved chat to check the response.",
        );
      } finally {
        setBusy(false);
      }
    }
    return sent ? messageId : undefined;
  }
  async function refineGift(item: { product: { id: string; title: string }; jobId: string; text: string; similar: boolean }) {
    if (!chat || refining.current || busy || !item.text.trim()) return;
    refining.current = true;
    const text = `${item.text.trim()} · ${item.product.title}`;
    if (text.length > 1500) { setError("Keep gift-agent instructions under 1,500 characters."); refining.current = false; return; }
    const key = JSON.stringify([chat.id, item.jobId, item.product.id, item.similar, text]);
    if (!pendingRefinement.current || pendingRefinement.current.key !== key) pendingRefinement.current = { key, feedbackId: crypto.randomUUID(), jobId: crypto.randomUUID(), shared: false };
    const pending = pendingRefinement.current;
    try {
      if (!pending.chatMessageId) pending.chatMessageId = await send(undefined, text, true);
      if (!pending.chatMessageId) return;
      const post = async (command: unknown) => {
        const response = await fetch("/api/workspace-chat/workflows", { method: "POST", headers: { "Content-Type": "application/json", "x-demo-code": code }, body: JSON.stringify({ conversationId: chat.id, command }) });
        const body = await response.json();
        if (!response.ok) throw new Error(body.error || "Couldn’t start the search.");
      };
      if (!pending.shared) {
        await post({ action: "group_feedback", id: pending.feedbackId, text });
        pending.shared = true;
      }
      await post({ action: "gift", payload: { action: "plan", id: pending.jobId, seed: { jobId: item.jobId, productId: item.product.id, similar: item.similar, chatMessageId: pending.chatMessageId } } });
      pendingRefinement.current = null;
      setDraft("");
    } catch (e) { setError((e as Error).message || "Couldn’t start the search."); }
    finally { refining.current = false; }
  }
  refineHandler.current = (item) => void refineGift(item);
  async function stop() {
    abort.current?.abort();
    if (chat && activeReply.current) {
      try {
        const data = await api({
          action: "stop",
          id: chat.id,
          messageId: activeReply.current,
        });
        setChat(data.chat);
        setMessages(data.messages);
      } catch {
        setError("Connection interrupted. Reload to check the saved reply.");
      }
    }
  }
  if (user && (!codeReady || admission !== "allowed")) {
    return <div className="workspace-theme flex min-h-svh items-center justify-center bg-background px-5 text-foreground">
      {admission === "denied" ? <form onSubmit={submitAccessCode} className="w-full max-w-sm space-y-5">
        <h1 className="text-2xl font-semibold tracking-tight">Enter your hackathon access code</h1>
        <input autoFocus aria-label="Hackathon access code" type="password" autoComplete="off" value={entryCode} onChange={event => setEntryCode(event.target.value)} className="w-full rounded-xl border border-input bg-background px-4 py-3" />
        {entryError && <p role="alert" className="text-sm text-destructive">{entryError}</p>}
        <Button type="submit" disabled={!entryCode.trim()} className="w-full rounded-full">Continue</Button>
        <button type="button" className="w-full text-sm underline" onClick={() => void authClient.signOut()}>Sign out</button>
      </form> : admission === "error" ? <div role="alert" className="text-center">Couldn’t check access. <button className="underline" onClick={() => location.reload()}>Try again</button></div> : <p role="status">Checking access…</p>}
    </div>;
  }
  return (
    <div
      ref={root}
      data-unified-workspace
      data-theme={theme}
      className={`workspace-theme ${theme !== "light" ? "dark" : ""} h-svh overflow-hidden`}
    >
      <SidebarProvider
        style={
          {
            "--sidebar-width": "calc(var(--spacing) * 64)",
            "--sidebar-width-icon": "calc(var(--spacing) * 14)",
            "--header-height": "calc(var(--spacing) * 12)",
          } as CSSProperties
        }
      >
        <Sidebar collapsible="icon" className={styles.sidebar}>
          <WorkspaceSidebarHeader />
          <SidebarContent className="px-2">
            <SidebarMenu>
              <SidebarMenuItem>
                <SidebarMenuButton onClick={() => { abort.current?.abort(); current.current = null; setChat(null); setMessages([]); setBusy(false); setError(""); setDraft(""); setExampleTitle(""); setGiftView(null); setFocusedGift(null); setHasWorkflows(false); setHome(true); history.replaceState(null, "", "/workspace"); }} tooltip="Home"><House aria-hidden="true" /><span>Home</span></SidebarMenuButton>
              </SidebarMenuItem>
              <SidebarMenuItem>
                <NewChatButton onClick={newChat} />
              </SidebarMenuItem>
            </SidebarMenu>
            <SidebarMenu>
              {chats.map((c) => (
                <SidebarMenuItem key={c.id}>
                  <ChatLink
                    chat={c}
                    active={chat?.id === c.id}
                    onOpen={() => void reopen(c.id)}
                  />
                </SidebarMenuItem>
              ))}
            </SidebarMenu>
          </SidebarContent>
          <SidebarFooter className="gap-0.5 px-2 pt-1 pb-2">
            <AccountMenu
              user={user}
              theme={theme}
              onAccount={() => setAccount(true)}
              onTheme={(next) => {
                setTheme(next);
                localStorage.setItem("sume.workspace.theme", next);
              }}
              onSignIn={() => void signIn()}
            />
          </SidebarFooter>
        </Sidebar>
        <SidebarInset className={focusedGift ? "min-w-0 bg-card lg:mr-[420px]" : "min-w-0 bg-card"}>
          <header className="z-30 flex h-(--header-height) shrink-0 items-center gap-3 border-b border-border/40 bg-background/80 px-4 backdrop-blur-xl md:border-0 md:bg-transparent md:backdrop-blur-none">
            <SidebarTrigger className="-ml-1 md:hidden" />
            <span className="min-w-0 truncate text-sm font-medium">
              {giftView && giftView !== "private"
                ? "Group gift"
                : home ? "Home" : chat?.title || "New chat"}
            </span>
            <div ref={setGiftHeaderTarget} id="gift-header-action" className="ml-auto" />
          </header>
          <div className="relative min-h-0 flex-1 overflow-hidden">
            {home ? <div className="h-full overflow-y-auto"><WorkspaceHome onChoose={(story) => { setHome(false); setMode(story.mode); setDraft(story.draft || ""); setExampleTitle(""); history.replaceState(null, "", `/workspace?mode=${story.mode}`); requestAnimationFrame(() => area.current?.focus()); }} /></div> : <MessageScrollerProvider autoScroll defaultScrollPosition="end">
              <MessageScroller>
                <MessageScrollerViewport
                  className="scroll-pt-6 scroll-pb-[calc(var(--composer-height,0px)+1rem)]"
                  aria-label="Conversation"
                >
                  <MessageScrollerContent
                    className={`mx-auto w-full gap-5 px-4 py-5 lg:px-6 ${mode === "creators" && !messages.length && !hasWorkflows ? "max-w-[1040px] !px-4 !pt-10 md:!px-7" : "max-w-3xl"}`}
                    role="feed"
                    aria-live="off"
                    style={{
                      paddingBottom:
                        mode === "creators" && !messages.length && !hasWorkflows
                          ? "calc(var(--composer-height, 160px) + 40px)"
                          : "calc(var(--composer-height, 160px) + 24px)",
                    }}
                  >
                    {!messages.length &&
                      !hasWorkflows &&
                      !query.get("giftInvite") && !query.get("snackInvite") && (
                        mode === "creators" ? <CreatorGuide /> : <div className="my-auto flex flex-col gap-7 py-16">
                          <h1 className="text-3xl font-medium tracking-tight">
                            What are you shopping for?
                          </h1>
                          <div className="flex flex-wrap gap-2">
                            {prompts[mode].map((p) => (
                              <Button
                                key={p}
                                variant="outline"
                                onClick={() => {
                                  setDraft(p);
                                  setExampleTitle("");
                                  area.current?.focus();
                                }}
                              >
                                {p}
                              </Button>
                            ))}
                            {mode === "shopping" && <Select value="" onValueChange={(id) => {
                              const example = [...giftExamples, ...moreGiftExamples].find((item) => item.id === id);
                              if (!example) return;
                              setDraft(example.brief);
                              setExampleTitle(example.title);
                              area.current?.focus();
                            }}>
                              <SelectTrigger aria-label="Gift examples"><SelectValue placeholder="Examples" /></SelectTrigger>
                              <SelectContent position="popper" align="start">{[...giftExamples, ...moreGiftExamples].map((example) => <SelectItem key={example.id} value={example.id}>{example.title}</SelectItem>)}</SelectContent>
                            </Select>}
                          </div>
                        </div>
                      )}
                    {(!giftView || giftView === "private") &&
                      messages.map((m, i) => (
                        <MessageScrollerItem key={m.id} messageId={m.id}>
                          <Message align={m.role === "user" ? "end" : "start"}>
                            <MessageContent>
                              {m.role === "user" ? (
                                <p className="max-w-[90%] self-end rounded-2xl rounded-br-sm bg-muted px-4 py-3 whitespace-pre-wrap">
                                  {m.content}
                                </p>
                              ) : (
                                <div className="markdown text-sm leading-7">
                                  {m.content && !((m.interaction?.type === "gift_clarification" || (m.interaction?.type === "creator_clarification" && !m.interaction.options.includes("Continue without a website"))) && m.interaction.options.length > 0 && !messages.slice(i + 1).some(next => next.role === "user")) ? <ReactMarkdown remarkPlugins={[remarkGfm]}>{m.content.replace("Workflow updated. Review the card below for status and the next action.", "Ready.")}</ReactMarkdown> : m.status === "streaming" ? <span role="status" className="inline-flex items-center gap-2 text-muted-foreground"><span aria-hidden="true" className="size-2 rounded-full bg-current motion-safe:animate-pulse" />Thinking…</span> : null}
                                  {["interrupted", "failed"].includes(
                                    m.status,
                                  ) && (
                                    <div className="flex items-center gap-3 text-muted-foreground">
                                      <span>Response interrupted</span>
                                      {i === messages.length - 1 && (
                                        <Button
                                          variant="ghost"
                                          disabled={busy}
                                          onClick={() => void send(m)}
                                        >
                                          Retry
                                        </Button>
                                      )}
                                    </div>
                                  )}
                                </div>
                              )}
                            </MessageContent>
                          </Message>
                          {m.role === "assistant" && m.interaction?.type === "gift_clarification" && m.interaction.options.length > 0 && (() => {
                            const answer = messages.slice(i + 1).find((next) => next.role === "user");
                            return <GiftClarificationCard question={m.content} options={m.interaction!.options} selection={m.interaction!.selection ?? "single"} answer={answer?.content} busy={busy} previewAvailable={mockPreviewAvailable} onAnswer={(value) => void send(undefined, value)} />;
                          })()}
                          {m.role === "assistant" && m.interaction?.type === "creator_clarification" && m.interaction.options.length > 0 && !m.interaction.options.includes("Continue without a website") && <GiftClarificationCard question={m.content} options={m.interaction.options} selection="single" answer={messages.slice(i + 1).find(next => next.role === "user")?.content} busy={busy} previewAvailable={false} showExtra={false} instant onAnswer={value => void send(undefined, value)} />}
                          <CheckpointAnchor id={m.id} onChange={registerCheckpoint} />
                        </MessageScrollerItem>
                      ))}
                    {(mode === "creators" || messages.some(m => m.interaction?.type === "creator_clarification")) && <CreatorPanel conversationId={chat?.id || null} code={code} checkpointNodes={checkpointNodes} historyOnly={mode !== "creators"} onMessage={value => void send(undefined,value)} />}
                    {mode === "shopping" && <WorkflowPanel
                      onActiveChange={setHasWorkflows}
                      onGiftViewChange={setGiftView}
                      checkpointNodes={checkpointNodes}
                      giftHeaderTarget={giftHeaderTarget}
                      onGiftPreviewAvailableChange={setMockPreviewAvailable}
                      onGiftNamed={(name) => { if (current.current === chat?.id) void send(undefined, name); }}
                      suggestedGiftTitle={exampleTitle}
                      conversationId={chat?.id || null}
                      mode={mode}
                      code={code}
                      messages={messages}
                      ensureChat={ensureWorkflowChat}
                      invite={query.get("giftInvite")}
                      snackInvite={query.get("snackInvite")}
                    />}
                  </MessageScrollerContent>
                </MessageScrollerViewport>
                <MessageScrollerButton
                  style={{ bottom: "calc(var(--composer-height,160px) + 8px)" }}
                />
              </MessageScroller>
            </MessageScrollerProvider>}
            {(!giftView || giftView === "private") && (
              <form
                ref={composer}
                onSubmit={(e) => {
                  e.preventDefault();
                  if (focusedGift) void refineGift({ ...focusedGift, text: draft, similar: false });
                  else void send();
                }}
                className="pointer-events-none absolute inset-x-0 bottom-0 mx-auto flex w-full max-w-3xl flex-col gap-2 bg-card px-4 pt-3 pb-4 lg:px-6"
              >
                {!home && mode === "creators" && !messages.length && !hasWorkflows && !query.get("giftInvite") && !query.get("snackInvite") && (
                  <div className="pointer-events-auto px-2 pb-1">
                    {creatorExamples.map(({ label, brief }) => <button key={label} type="button" className="flex min-h-10 w-full items-center gap-3 border-b border-border/60 px-2 text-left text-sm text-foreground transition-colors hover:bg-muted/60 focus-visible:outline-2 focus-visible:outline-ring" onClick={() => { setDraft(brief); setExampleTitle(""); area.current?.focus(); }}><span aria-hidden="true" className="flex size-6 shrink-0 items-center justify-center overflow-hidden rounded-md bg-white"><img className={label === "PayPal" ? "size-4 object-contain" : "size-6 object-cover"} src={label === "PayPal" ? "/workspace-logos/paypal.svg" : "/workspace-logos/chatedu.png"} alt="" /></span>Plan a campaign for {label}</button>)}
                  </div>
                )}
                {error && (
                  <div
                    role="alert"
                    className="pointer-events-auto flex items-center justify-between gap-2 text-sm text-destructive"
                  >
                    <span>{error}</span>
                    <Button
                      variant="ghost"
                      size="sm"
                      onClick={() => setError("")}
                    >
                      Dismiss
                    </Button>
                  </div>
                )}
                <div className="pointer-events-auto relative">
                  <InputGroup>
                    {focusedGift && <div className="flex items-center gap-2 px-3 pt-3 text-sm"><span className="rounded-lg bg-muted px-3 py-1">{focusedGift.product.title} · shared with gift agents</span><button type="button" aria-label="Remove selected product" onClick={() => setFocusedGift(null)}><X size={15}/></button></div>}
                    <InputGroupTextarea
                      ref={area}
                      aria-label={
                        hasWorkflows && mode === "shopping"
                          ? "Message your private agent"
                          : "Message Sume"
                      }
                      placeholder={
                        focusedGift ? "Tell the gift agents what to find…" : hasWorkflows && mode === "shopping"
                          ? "Message your private agent"
                          : "Message Sume"
                      }
                      value={draft}
                      maxLength={6000}
                      rows={1}
                      className="min-h-10 max-h-40"
                      onChange={(e) => setDraft(e.target.value)}
                      onKeyDown={(e) => {
                        if (
                          e.key === "Enter" &&
                          !e.shiftKey &&
                          !e.nativeEvent.isComposing
                        ) {
                          e.preventDefault();
                          e.currentTarget.form?.requestSubmit();
                        }
                      }}
                    />
                    <InputGroupAddon
                      align="block-end"
                      className="justify-between"
                    >
                      <Select
                        value={mode}
                        disabled={busy}
                        onValueChange={(v) => void changeMode(v as Mode)}
                      >
                        <SelectTrigger
                          aria-label="Conversation mode"
                          className="h-8 border-0 bg-transparent text-xs shadow-none"
                        >
                          <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                          <SelectItem value="creators">
                            {labels.creators}
                          </SelectItem>
                          <SelectItem value="shopping">
                            {labels.shopping}
                          </SelectItem>
                        </SelectContent>
                      </Select>
                      <InputGroupButton
                        type={busy ? "button" : "submit"}
                        onClick={busy ? () => void stop() : undefined}
                        size="icon-sm"
                        variant={busy ? "outline" : "default"}
                        disabled={!busy && !draft.trim()}
                        aria-label={busy ? "Stop reply" : focusedGift ? "Send to gift agents" : "Send message"}
                      >
                        {busy ? <Square size={16} /> : <ArrowUp size={16} />}
                      </InputGroupButton>
                    </InputGroupAddon>
                  </InputGroup>
                </div>
              </form>
            )}
          </div>
        </SidebarInset>
      </SidebarProvider>
      <Sheet open={account} onOpenChange={setAccount}>
        <SheetContent
          side="left"
          aria-label="Account"
          aria-describedby={undefined}
          className="gap-3 p-4"
        >
          <SheetHeader>
            <SheetTitle>Account</SheetTitle>
          </SheetHeader>
          <label className="text-sm" htmlFor="preview-code">
            Preview access code
          </label>
          <input
            id="preview-code"
            type="password"
            className="rounded-md border border-input px-3 py-2"
            value={code}
            onChange={(e) => {
              setCode(e.target.value);
              sessionStorage.setItem("sume.workspace.code", e.target.value);
            }}
          />
          {user ? (
            <Button
              variant="ghost"
              onClick={() =>
                void authClient.signOut().then(() => {
                  setAccount(false);
                  newChat();
                })
              }
            >
              <LogOut />
              Sign out
            </Button>
          ) : (
            <Button onClick={() => void signIn()}>
              <LogIn />
              Sign in with Google
            </Button>
          )}
        </SheetContent>
      </Sheet>
    </div>
  );
}
function AccountMenu({ user, theme, onAccount, onTheme, onSignIn }: {
  user?: { name: string; email?: string; image?: string | null };
  theme: Theme;
  onAccount: () => void;
  onTheme: (theme: Theme) => void;
  onSignIn: () => void;
}) {
  const { isMobile, setOpenMobile } = useSidebar();
  const initials = user?.name?.split(/\s+/).filter(Boolean).map(part => part[0]).join("").slice(0, 2).toUpperCase() || "S";
  const avatar = <span aria-hidden="true" className="flex size-7 shrink-0 items-center justify-center overflow-hidden rounded-full bg-muted text-xs font-medium">{user?.image ? <img src={user.image} alt="" className="size-full object-cover" /> : initials}</span>;
  const itemClass = "flex cursor-default items-center gap-2 rounded-md px-2 py-2 text-sm outline-none data-[highlighted]:bg-accent data-[highlighted]:text-accent-foreground [&_svg]:size-4";
  return <SidebarMenu><SidebarMenuItem><DropdownMenu.Root>
    <DropdownMenu.Trigger asChild>
      <SidebarMenuButton className="!h-10 rounded-[12px]" tooltip={user?.name || "Account"} aria-label={user ? `${user.name} account menu` : "Account menu"}>
        {avatar}<span className="truncate">{user?.name || "Sign in"}</span>
      </SidebarMenuButton>
    </DropdownMenu.Trigger>
    <DropdownMenu.Portal container={typeof document !== "undefined" ? document.querySelector<HTMLElement>("[data-unified-workspace]") : undefined}>
      <DropdownMenu.Content side={isMobile ? "top" : "right"} align="end" sideOffset={4} className="z-50 min-w-56 rounded-lg border border-border bg-popover p-1 text-popover-foreground shadow-md">
        {user && <><DropdownMenu.Label className="flex items-center gap-2 px-2 py-2 text-sm font-normal">{avatar}<span className="grid min-w-0 leading-tight"><span className="truncate font-medium">{user.name}</span>{user.email && <span className="truncate text-xs text-muted-foreground">{user.email}</span>}</span></DropdownMenu.Label><DropdownMenu.Separator className="my-1 h-px bg-border" /></>}
        <DropdownMenu.Item className={itemClass} onSelect={() => { if (isMobile) setOpenMobile(false); onAccount(); }}><UserCircle />Account</DropdownMenu.Item>
        <DropdownMenu.Separator className="my-1 h-px bg-border" />
        <DropdownMenu.RadioGroup value={theme} onValueChange={(value) => onTheme(value as Theme)}>
          {([["light", "Light"], ["dark", "Ink"], ["ink-2", "Ink 2"], ["og-dark", "OG dark"]] as const).map(([value, label]) => <DropdownMenu.RadioItem key={value} value={value} className={itemClass} onSelect={(event) => event.preventDefault()}><span className="flex size-4 items-center justify-center"><DropdownMenu.ItemIndicator><Check /></DropdownMenu.ItemIndicator></span>{label}</DropdownMenu.RadioItem>)}
        </DropdownMenu.RadioGroup>
        {!user && <DropdownMenu.Item className={itemClass} onSelect={onSignIn}><LogIn />Sign in with Google</DropdownMenu.Item>}
      </DropdownMenu.Content>
    </DropdownMenu.Portal>
  </DropdownMenu.Root></SidebarMenuItem></SidebarMenu>;
}
function ChatLink({
  chat,
  active,
  onOpen,
}: {
  chat: Chat;
  active: boolean;
  onOpen: () => void;
}) {
  const { isMobile, setOpenMobile } = useSidebar();
  return (
    <SidebarMenuButton
      isActive={active}
      tooltip={chat.title}
      onClick={() => {
        onOpen();
        if (isMobile) setOpenMobile(false);
      }}
    >
      <MessageSquare />
      <span className="truncate">{chat.title}</span>
    </SidebarMenuButton>
  );
}

function NewChatButton({ onClick }: { onClick: () => void }) {
  const { setOpenMobile } = useSidebar();
  return (
    <SidebarMenuButton
      tooltip="New chat"
      onClick={() => {
        onClick();
        setOpenMobile(false);
      }}
    >
      <Plus />
      <span>New chat</span>
    </SidebarMenuButton>
  );
}

function WorkspaceSidebarHeader() {
  const { state, isMobile, toggleSidebar, setOpenMobile } = useSidebar();
  const collapsed = state === "collapsed";
  return (
    <SidebarHeader
      className={isMobile ? "gap-0 px-3 py-2" : "h-14 justify-center px-2"}
    >
      {isMobile ? (
        <div className="flex min-h-11 items-center justify-between gap-3">
          <a
            href="/workspace/landing"
            aria-label="Sume home"
            className="text-xl font-semibold tracking-tight"
          >
            sume
          </a>
          <Button
            variant="ghost"
            size="icon"
            aria-label="Close sidebar"
            onClick={() => setOpenMobile(false)}
          >
            <X />
          </Button>
        </div>
      ) : (
        <SidebarMenu>
          <SidebarMenuItem className="relative flex h-8 items-center">
            <SidebarMenuButton
              asChild
              tooltip="Sume"
              inert={collapsed}
              data-sidebar-reveal=""
              className="w-auto max-w-[calc(100%-40px)] justify-start data-[slot=sidebar-menu-button]:!p-1.5"
            >
              <a href="/workspace/landing" aria-label="Sume home">
                <span className="text-xl font-semibold tracking-tight">
                  sume
                </span>
              </a>
            </SidebarMenuButton>
            <SidebarMenuButton
              type="button"
              tooltip={collapsed ? "Expand sidebar" : "Collapse sidebar"}
              aria-label={collapsed ? "Expand sidebar" : "Collapse sidebar"}
              onClick={toggleSidebar}
              className="absolute right-[3px] size-8 shrink-0 justify-center rounded-[12px] p-0 group-data-[collapsible=icon]:size-8! group-data-[collapsible=icon]:p-0! [&>svg]:size-[18px]"
            >
              <PanelLeft />
            </SidebarMenuButton>
          </SidebarMenuItem>
        </SidebarMenu>
      )}
    </SidebarHeader>
  );
}
