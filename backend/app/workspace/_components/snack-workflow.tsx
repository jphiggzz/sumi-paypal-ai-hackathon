"use client";
import { useEffect, useRef, useState } from "react";
import { Button } from "./ui/button";
import { Input } from "./ui/input";
import { nextMonthlySnackDue } from "../../../lib/snack-policy";
import { snackFixtures } from "../../../lib/snack-fixtures";
const money = (n: number) => new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" }).format(n / 100);
const fields = { likes: "Favorites", dislikes: "Avoid", dietary: "Dietary requirements", allergies: "Allergies" } as const;
type Prefs = Record<keyof typeof fields, string[]>;
const empty: Prefs = { likes: [], dislikes: [], dietary: [], allergies: [] };
export default function SnackWorkflow({ flow, conversationId, code, refresh, setup, messages }: { flow: any; conversationId: string; code: string; refresh: () => Promise<void>; setup: (v: any) => Promise<any>; messages: { role: string; status?: string }[] }) {
  const [busy, setBusy] = useState(false), [error, setError] = useState(""), [invite, setInvite] = useState(""), [message, setMessage] = useState("");
  const [values, setValues] = useState<Record<keyof Prefs, string>>({ likes: "", dislikes: "", dietary: "", allergies: "" });
  const [initialized, setInitialized] = useState(false);
  const [stock, setStock] = useState<{ productId: string; servingsRemaining: number; suitableGroupIds: string[] }[]>([]);
  const sampleProducts = snackFixtures().products;
  const [settings, setSettings] = useState({ name: "", budget: "", reserve: "", people: "", days: "", servings: "", dietary: "", avoid: "", likes: "", dislikes: "" });
  const [reviewing, setReviewing] = useState(false), [editing, setEditing] = useState(false);
  const lastUserTurns = useRef(messages.filter(m => m.role === "user").length);
  const cycleId = useRef<string | null>(null), paymentId = useRef<string | null>(null), returnHandled = useRef(false);
  const team = flow.team, state = flow.state, office = state?.office, cycle = state?.cycles?.[0], basket = cycle?.basket;
  const payment = state?.payments?.find((p: any) => p.cycle_id === cycle?.id && p.digest === cycle?.digest);
  const completed = state?.payments?.find((p: any) => p.cycle_id === cycle?.id && p.status === "completed");
  const unresolved = state?.payments?.filter((p: any) => ["reserved", "created", "needs_review"].includes(p.status)) ?? [];
  useEffect(() => { if (office) setStock(office.stock); }, [office?.revision]);
  const userTurns = messages.filter(m => m.role === "user").length;
  useEffect(() => { if (userTurns !== lastUserTurns.current) { lastUserTurns.current = userTurns; setReviewing(false); setEditing(false); } }, [userTurns]);
  useEffect(() => {
    if (!initialized && team?.me) {
      const p: Prefs = team.me.preferences || empty;
      setValues(Object.fromEntries(Object.keys(fields).map(k => [k, p[k as keyof Prefs].join(", ")])) as Record<keyof Prefs, string>);
      setInitialized(true);
    }
  }, [team?.me, initialized]);
  async function post(path: string, body: object) {
    const r = await fetch(path, { method: "POST", headers: { "Content-Type": "application/json", "x-demo-code": code }, body: JSON.stringify(body) });
    const data = await r.json().catch(() => ({})); if (!r.ok) throw new Error(data.error || "Request failed"); return data;
  }
  async function run(fn: () => Promise<void>) {
    if (busy) return;
    setBusy(true); setError(""); try { await fn(); await refresh(); } catch (e) { setError(e instanceof Error ? e.message.replaceAll("_", " ") : "Request failed"); } finally { setBusy(false); }
  }
  async function snack(body: object) { return post("/api/snacks", { officeId: flow.resourceId, ...body }); }
  async function member(body: object) { return post("/api/snack-members", { officeId: flow.resourceId, ...body }); }
  useEffect(() => {
    if (!office || returnHandled.current) return;
    const url = new URL(window.location.href), id = url.searchParams.get("snackPayment");
    if (!id || !state.payments?.some((p: any) => p.id === id)) return;
    returnHandled.current = true;
    void run(async () => { await snack({ action: "capture", paymentId: id }); url.searchParams.delete("snackPayment"); url.searchParams.delete("token"); url.searchParams.delete("PayerID"); history.replaceState(null, "", url.pathname + url.search); });
  }, [office?.id, state?.payments]);
  if (!team) {
    const brief = flow.draft?.snackBrief || {};
    const thinking = messages.some(m => m.role === "assistant" && m.status === "streaming");
    const canReview = Boolean(brief.people && brief.budget) || messages.filter(m => m.role === "user").length >= 3;
    if (!canReview) return null;
    const openReview = () => {
      setSettings({ name: "Office snacks", budget: String(brief.budget?.value ?? ""), people: String(brief.people?.value ?? ""), reserve: String(brief.reserve?.value ?? 0), days: String(brief.days?.value ?? 10), servings: String(brief.servings?.value ?? 1), dietary: (brief.dietary || []).join(", "), avoid: (brief.avoid || []).join(", "), likes: (brief.likes || []).join(", "), dislikes: (brief.dislikes || []).join(", ") });
      setEditing(!brief.people || !brief.budget); setReviewing(true);
    };
    const submit = async () => {
      const s = { name: settings.name.trim(), budgetCents: Math.round(Number(settings.budget) * 100), reserveCents: Math.round(Number(settings.reserve) * 100), onsiteDays: Number(settings.days), servingsPerPersonDay: Number(settings.servings), groups: [{ id: "team", name: "Team", people: Number(settings.people), likes: settings.likes.split(",").map(x => x.trim()).filter(Boolean), dislikes: settings.dislikes.split(",").map(x => x.trim()).filter(Boolean), dietary: settings.dietary.split(",").map(x => x.trim()).filter(Boolean), allergies: settings.avoid.split(",").map(x => x.trim()).filter(Boolean) }] };
      await setup({ action: "snack_setup", settings: s });
    };
    if (!reviewing) return <Button type="button" variant="outline" disabled={thinking} onClick={openReview}>Review snack setup</Button>;
    return <section aria-label="Review snack setup" className="space-y-4 rounded-2xl bg-muted p-5 sm:p-6"><h2 className="text-sm font-medium">Review snack setup</h2>
      {editing ? <form className="grid gap-3 sm:grid-cols-2" onSubmit={e => { e.preventDefault(); setEditing(false); }}>
        {([ ["name", "Name", "text"], ["budget", "Monthly budget ($)", "number"], ["people", "People", "number"], ["reserve", "Shipping and tax reserve ($)", "number"], ["days", "Office days per month", "number"], ["servings", "Snacks per person per day", "number"], ["likes", "Favorites", "text"], ["dislikes", "Dislikes", "text"], ["dietary", "Dietary needs for the team", "text"], ["avoid", "Office-wide exclusions", "text"] ] as const).map(([key,label,type]) => <label key={key} className="grid gap-1.5 text-xs font-medium">{label}<Input required={!["likes", "dislikes", "dietary", "avoid"].includes(key)} type={type} min={type === "number" ? ((key === "reserve" || key === "people") ? 0 : 1) : undefined} step={key === "budget" || key === "reserve" ? "0.01" : "1"} maxLength={key === "name" ? 80 : undefined} value={settings[key]} onChange={e => setSettings(s => ({ ...s, [key]: e.target.value }))} className="bg-background" /></label>)}
        <Button className="w-fit" disabled={busy}>Review</Button>
      </form> : <><div className="space-y-1 text-sm"><p>{brief.people?.approximate ? "About " : ""}{settings.people} people · {money(Math.round(Number(settings.budget) * 100))} monthly budget cap{brief.budget?.approximate ? " (suggested from your estimate)" : ""}</p><p>{settings.days} office days · {settings.servings} snack per person per day · {money(Math.round(Number(settings.reserve) * 100))} reserved</p>{settings.likes && <p>Favorites: {settings.likes}</p>}{settings.dislikes && <p>Dislikes: {settings.dislikes}</p>}{settings.dietary && <p>Dietary needs for the team: {settings.dietary}</p>}{settings.avoid && <p>Office-wide exclusions: {settings.avoid}</p>}</div><p className="text-xs text-muted-foreground">Office days, servings and reserve are estimates unless you specified them. Dietary needs apply to the whole team.</p><div className="flex flex-wrap gap-2"><Button disabled={busy || thinking} onClick={() => void submit()}>Confirm setup</Button><Button variant="outline" disabled={busy} onClick={() => setEditing(true)}>Adjust</Button></div></>}
      {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
    </section>;
  }
  return <section aria-label="Office snacks" className="space-y-4 rounded-2xl border border-border bg-card p-5 sm:p-6">
    <div className="flex flex-wrap items-center justify-between gap-2"><h2 className="text-base font-semibold">{team.office.name}</h2><span className="text-xs text-muted-foreground">Office snacks</span></div>
    {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
    {team.me && <div className="space-y-4 rounded-xl bg-muted p-4"><h3 className="text-sm font-semibold">My agent</h3>
      <div className="max-h-64 space-y-3 overflow-auto text-sm">{team.messages.map((m: any) => <p key={m.id}><strong>{m.role === "user" ? "You" : "Agent"}</strong> {m.content}</p>)}</div>
      <form className="flex gap-2" onSubmit={e => { e.preventDefault(); const text = message.trim(); if (!text) return; void run(async () => { await member({ action: "chat", text }); setMessage(""); }); }}><Input aria-label="Private message" value={message} maxLength={1500} onChange={e => setMessage(e.target.value)} placeholder="Message your agent" /><Button disabled={busy || !message.trim()}>Send</Button></form>
      <details><summary className="cursor-pointer text-sm font-medium">{team.me.shared ? "Edit shared preferences" : "Share preferences"}</summary><form className="mt-3 grid gap-3" onSubmit={e => { e.preventDefault(); const preferences = Object.fromEntries(Object.entries(values).map(([k,v]) => [k, v.split(",").map(x => x.trim()).filter(Boolean)])); void run(() => member({ action: "preferences", preferences, shared: true }).then(() => {})); }}>
        {(Object.keys(fields) as (keyof Prefs)[]).map(k => <label className="grid gap-1 text-xs" key={k}>{fields[k]}<Input value={values[k]} onChange={e => setValues(v => ({ ...v, [k]: e.target.value }))} /></label>)}<div className="flex gap-2"><Button disabled={busy}>Share with office</Button>{team.me.shared && <Button type="button" variant="outline" disabled={busy} onClick={() => void run(() => member({ action: "preferences", preferences: team.me.preferences || empty, shared: false }).then(() => {}))}>Withdraw</Button>}</div>
      </form></details>
    </div>}
    {office && <details className="rounded-xl bg-muted p-4"><summary className="cursor-pointer text-sm font-medium">Office settings</summary><form key={office.revision} className="mt-3 grid gap-3 sm:grid-cols-2" onSubmit={e => { e.preventDefault(); const d = new FormData(e.currentTarget); const next = { ...office.settings, name: String(d.get("name")).trim(), budgetCents: Math.round(Number(d.get("budget")) * 100), reserveCents: Math.round(Number(d.get("reserve")) * 100), onsiteDays: Number(d.get("days")), servingsPerPersonDay: Number(d.get("servings")), groups: office.settings.groups.length === 1 ? [{ ...office.settings.groups[0], people: Number(d.get("people")), dietary: String(d.get("dietary") || "").split(",").map(v => v.trim()).filter(Boolean), allergies: String(d.get("avoid") || "").split(",").map(v => v.trim()).filter(Boolean) }] : office.settings.groups }; void run(async () => { await snack({ action: "save", revision: office.revision, settings: next }); }); }}>
      {([ ["name", "Office name", office.settings.name, "text"], ["budget", "Budget per month ($)", office.settings.budgetCents / 100, "number"], ["reserve", "Shipping and tax reserve ($)", office.settings.reserveCents / 100, "number"], ...(office.settings.groups.length === 1 ? [["people", "People", office.settings.groups[0].people, "number"], ["dietary", "Dietary needs", office.settings.groups[0].dietary.join(", "), "text"], ["avoid", "Office-wide exclusions", office.settings.groups[0].allergies.join(", "), "text"]] : []), ["days", "Office days per cycle", office.settings.onsiteDays, "number"], ["servings", "Snacks per person per day", office.settings.servingsPerPersonDay, "number"] ] as [string,string,string|number,string][]).map(([name,label,value,type]) => <label className="grid gap-1 text-xs" key={name}>{label}<Input name={name} type={type} defaultValue={value} required={!['dietary', 'avoid'].includes(name)} min={type === "number" ? (["reserve", "people"].includes(name) ? 0 : 1) : undefined} step={["budget", "reserve"].includes(name) ? "0.01" : "1"} /></label>)}<Button className="w-fit" disabled={busy || unresolved.length > 0}>Save settings</Button>
    </form></details>}
    {office && <div className="flex flex-wrap gap-2"><Button variant="outline" disabled={busy} onClick={() => void run(async () => { const data = await member({ action: "invite" }); setInvite(`${location.origin}/workspace?mode=shopping&snackInvite=${data.token}`); })}>Invite coworkers</Button>
      <Button variant="outline" disabled={busy || stock.length > 0 || unresolved.length > 0} onClick={() => void run(async () => { await snack({ action: "stock", revision: office.revision, stock: [] }); })}>Confirm empty stock</Button>
      <Button variant="outline" disabled={busy} onClick={() => { const now = new Date(); void run(async () => { await snack({ action: "schedule", revision: office.revision, scheduleVersion: office.schedule_version, active: !office.schedule_active, cadence: "monthly", source: "simulated", anchorDay: now.getUTCDate(), dueAt: nextMonthlySnackDue(now.toISOString(), now.getUTCDate(), now.getTime()) }); }); }}>{office.schedule_active ? "Pause monthly proposals" : "Schedule monthly proposals"}</Button>
      <Button disabled={busy || unresolved.length > 0} onClick={() => { cycleId.current ||= crypto.randomUUID(); void run(async () => { await snack({ action: "plan_simulated", revision: office.revision, cycleId: cycleId.current }); cycleId.current = null; }); }}>Build simulated basket</Button>
    </div>}
    {office?.schedule_active && <p className="text-xs text-muted-foreground">Next proposal: {new Date(office.next_due_at).toLocaleDateString()}</p>}
    {office && <details className="rounded-xl bg-muted p-4"><summary className="cursor-pointer text-sm font-medium">Add sample stock</summary><form className="mt-3 grid gap-3" onSubmit={e => { e.preventDefault(); const d = new FormData(e.currentTarget); const item = { productId: String(d.get("product")), servingsRemaining: Number(d.get("remaining")), suitableGroupIds: d.getAll("group").map(String) }; setStock(current => [...current.filter(s => s.productId !== item.productId), item]); e.currentTarget.reset(); }}><label className="grid gap-1 text-xs">Sample product<select name="product" required className="rounded-lg border border-border bg-background p-2">{sampleProducts.map(p => <option value={p.id} key={p.id}>{p.title}</option>)}</select></label><label className="grid gap-1 text-xs">Servings remaining<Input name="remaining" type="number" min="0" max="10000" required /></label>{office.settings.groups.map((g: any) => <label className="flex items-center gap-2 text-xs" key={g.id}><input type="checkbox" name="group" value={g.id} />Suitable for {g.name}</label>)}<Button className="w-fit" type="submit">Add stock</Button></form></details>}
    {office && stock.length > 0 && <form className="space-y-2 rounded-xl bg-muted p-4" onSubmit={e => { e.preventDefault(); void run(async () => { await snack({ action: "stock", revision: office.revision, stock }); }); }}><h3 className="text-sm font-semibold">Stock</h3>{stock.map((item, index) => <label className="grid gap-1 text-xs" key={item.productId}>{sampleProducts.find(p => p.id === item.productId)?.title || item.productId}<Input type="number" min="0" max="10000" value={item.servingsRemaining} onChange={e => setStock(v => v.map((s, i) => i === index ? { ...s, servingsRemaining: Number(e.target.value) } : s))} /></label>)}<Button disabled={busy || unresolved.length > 0}>Confirm stock</Button></form>}
    {office && unresolved.filter((p: any) => p.id !== payment?.id).map((p: any) => <div key={p.id} className="rounded-xl bg-muted p-4 text-sm"><p>Payment needs review · {money(p.amount_cents)}</p>{p.order_id && <Button className="mt-2" variant="outline" disabled={busy} onClick={() => void run(async () => { await snack({ action: "reconcile_payment", paymentId: p.id }); })}>Check payment status</Button>}</div>)}
    {invite && <div className="space-y-2"><label className="block text-xs font-medium">Invitation link<Input readOnly value={invite} onFocus={e => e.currentTarget.select()} /></label>{/^(localhost|127\.0\.0\.1)$/.test(location.hostname) && <p className="text-xs text-muted-foreground">Localhost links only work on this device.</p>}</div>}
    {team.members.length > 0 && <div className="text-sm"><h3 className="font-semibold">Shared preferences</h3>{team.members.map((m: any) => <p key={m.id} className="mt-2 text-muted-foreground"><strong className="text-foreground">{m.name}</strong> · {(Object.keys(fields) as (keyof Prefs)[]).filter(k => m.preferences[k].length).map(k => `${fields[k]}: ${m.preferences[k].join(", ")}`).join(" · ")}</p>)}</div>}
    {team.discussion.length > 0 && <div className="text-sm"><h3 className="font-semibold">Agent discussion</h3>{team.discussion.map((d: any, i: number) => <p key={i} className="mt-2"><strong>{d.name}</strong> {d.summary}</p>)}</div>}
    {office && <div className="space-y-3 border-t border-border pt-4"><div className="flex justify-between gap-2"><h3 className="text-sm font-semibold">Basket</h3><span className="text-xs text-muted-foreground">{cycle?.status === "ordered" && cycle.order_reference?.startsWith("SIM-") ? "Simulated" : cycle?.status || "Not started"}</span></div>
      {cycle && ["queued","running"].includes(cycle.status) && <div className="flex items-center gap-3"><p className="text-sm text-muted-foreground" role="status">Agents are building the basket…</p><Button variant="ghost" disabled={busy} onClick={() => void run(async () => { await snack({ action: "recover", cycleId: cycle.id }); })}>Resume</Button></div>}
      {cycle?.error_code && <p role="alert" className="text-sm text-destructive">{cycle.error_code.replaceAll("_", " ")}</p>}
      {cycle?.status === "ordered" && <p className="text-sm">Simulated supplier order recorded. {completed && `PayPal Sandbox payment: ${money(completed.amount_cents)} to the demo merchant.`}</p>}
      {basket && <><p className="text-xs text-muted-foreground">Simulated supplier · no delivery</p>{basket.lines.map((line: any) => <div key={line.product.id} className="space-y-2 border-b border-border pb-3 text-sm"><div className="flex justify-between gap-3"><strong>{line.product.title}</strong><span>{money(line.cents)}</span></div><p className="text-xs text-muted-foreground">{line.packs} {line.packs === 1 ? "pack" : "packs"} · {line.servings === null ? "Needs review" : `${line.servings} servings`}</p>{cycle.status === "ready" && !payment && <Review product={line.product} groups={cycle.input.settings.groups} initial={cycle.reviews.find((r: any) => r.productId === line.product.id)} busy={busy} submit={review => void run(async () => { await snack({ action: "review", cycleId: cycle.id, digest: cycle.digest, review }); })} />}</div>)}
      <div className="flex justify-between text-sm font-medium"><span>Subtotal</span><span>{money(basket.subtotalCents)}</span></div>
      {basket.blockers.filter((b: string) => b !== "Sample catalog — no real order").map((b: string) => <p key={b} className="text-xs text-destructive">{b}</p>)}
      {cycle.status === "ready" && <div className="space-y-3"><p className="text-xs text-muted-foreground">PayPal Sandbox pays the demo merchant. The supplier order is simulated.</p>{payment?.status === "completed" ? <Button disabled={busy} onClick={() => void run(async () => { await snack({ action: "simulate_order", cycleId: cycle.id, digest: cycle.digest }); })}>Place simulated order</Button> : <div className="flex flex-wrap gap-2"><Button disabled={busy || !basket.lines.length || basket.blockers.some((b: string) => b !== "Sample catalog — no real order")} onClick={() => void run(async () => { paymentId.current = payment?.id || paymentId.current || crypto.randomUUID(); const data = await snack({ action: "checkout", cycleId: cycle.id, digest: cycle.digest, paymentId: paymentId.current, conversationId }); const p = data.payments.find((v: any) => v.id === paymentId.current); if (p?.status === "created" && p.approval_url) window.location.assign(p.approval_url); else if (p?.status !== "completed") throw Error("Payment needs review. Retry the same payment."); })}>Pay {money(basket.subtotalCents)} with PayPal Sandbox</Button>{payment?.order_id && <Button variant="outline" disabled={busy} onClick={() => void run(async () => { await snack({ action: "reconcile_payment", paymentId: payment.id }); })}>Check payment</Button>}</div>}</div>}</>}
    </div>}
  </section>;
}
function Review({ product, groups, initial, busy, submit }: {product:any;groups:any[];initial:any;busy:boolean;submit:(value:any)=>void}) {
  return <details><summary className="cursor-pointer text-xs text-muted-foreground">{initial ? "Edit review" : "Review product"}</summary><form className="mt-3 grid gap-3" onSubmit={e => {e.preventDefault();const d=new FormData(e.currentTarget);submit({productId:product.id,fingerprint:product.fingerprint,servingsPerPack:Number(d.get("servings")),suitableGroupIds:d.getAll("group").map(String),officeSafe:d.get("safe")==="on",evidence:String(d.get("evidence"))});}}>
    <label className="grid gap-1 text-xs">Servings per pack<Input name="servings" type="number" min="1" max="500" required defaultValue={initial?.servingsPerPack} /></label>
    {groups.map(g => <label className="flex items-center gap-2 text-xs" key={g.id}><input type="checkbox" name="group" value={g.id} defaultChecked={initial?.suitableGroupIds.includes(g.id)} />{g.name}{g.dietary.length ? ` (${g.dietary.join(", ")})` : ""}</label>)}
    <label className="flex items-center gap-2 text-xs"><input type="checkbox" name="safe" defaultChecked={initial?.officeSafe} />Checked office-wide allergies and cross-contact: {groups.flatMap(g => g.allergies).join(", ") || "none reported"}</label>
    <label className="grid gap-1 text-xs">Source evidence<Input name="evidence" required minLength={3} maxLength={1000} defaultValue={initial?.evidence} /></label><Button disabled={busy}>Save review</Button>
  </form></details>;
}
