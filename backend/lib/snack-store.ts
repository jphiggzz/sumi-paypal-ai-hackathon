import { createHash, randomUUID } from "node:crypto";
import type { PoolClient } from "pg";
import { authPool } from "./auth";
import { transaction } from "./agent-store";
import { CapabilityError } from "./capability-contracts";
import { canonicalJson } from "./canonical-json";
import {
  buildSnackBasket, FORTNIGHT_MS, nextSnackDue, nextMonthlySnackDue, type ProductReview,
  type SnackSettings, type SnackStock, type SnackProduct, type SnackHistory,
} from "./snack-policy";

function fail(code: string, status = 409): never { throw new CapabilityError(code, status); }
export async function ownedSnackOffice(c: Pick<PoolClient, "query">, owner: string, id: string, lock = false) {
  const o = (await c.query(`SELECT * FROM snack_offices WHERE id=$1 AND owner_id=$2${lock ? " FOR UPDATE" : ""}`, [id, owner])).rows[0];
  if (!o) fail("SNACK_OFFICE_NOT_FOUND", 404);
  return o;
}
export async function snackOfficeState(owner: string, id?: string) {
  if (!id) return { offices: (await authPool.query("SELECT id,settings,revision,schedule_active,next_due_at FROM snack_offices WHERE owner_id=$1 ORDER BY created_at DESC", [owner])).rows };
  return transaction(async c => {
  await c.query("SELECT id FROM snack_offices WHERE id=$1 FOR SHARE", [id]);
  const office = await ownedSnackOffice(c, owner, id);
  const cycles = (await c.query("SELECT * FROM snack_cycles WHERE office_id=$1 ORDER BY created_at DESC LIMIT 30", [id])).rows;
  // Old snapshots can contain preferences whose owners have withdrawn consent.
  // Retain the status/reference for reconciliation, but do not expose their contents.
  const visibleCycles = cycles.map(r => r.office_revision === office.revision ? r : { ...r, input: null, products: [], reviews: [], queries: [], basket: null, digest: null, discussion: [] });
  const payments = (await c.query("SELECT id,cycle_id,digest,amount_cents,status,order_id,approval_url,capture_id,error_code FROM snack_payments WHERE office_id=$1 AND owner_id=$2 ORDER BY created_at DESC LIMIT 30", [id,owner])).rows;
  return { office, cycles: visibleCycles, payments, channel3Configured: Boolean(process.env.CHANNEL3_API_KEY) };
  });
}
export async function saveSnackOffice(owner: string, id: string, revision: number, settings: SnackSettings) {
  return transaction(async c => {
    await c.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", ["snacks:" + owner]);
    const prior = (await c.query("SELECT * FROM snack_offices WHERE id=$1 FOR UPDATE", [id])).rows[0];
    if (prior) {
      if (prior.owner_id !== owner) fail("SNACK_OFFICE_NOT_FOUND", 404);
      if (prior.revision !== revision) fail("SNACK_REVISION_CONFLICT");
      if (prior.headcount_mode === "total") {
        const shared = +(await c.query("SELECT count(*) FROM snack_members WHERE office_id=$1 AND shared", [id])).rows[0].count;
        if (settings.groups.length !== 1 || settings.groups[0].people < shared) fail("SNACK_HEADCOUNT_CONFLICT");
      }
      const stock = prior.stock.map((s: SnackStock[number]) => ({ ...s, suitableGroupIds: s.suitableGroupIds.filter(id => settings.groups.some(g => g.id === id)) }));
      await c.query("UPDATE snack_offices SET settings=$2,stock=$3,stock_checked_at=null,revision=revision+1,updated_at=now() WHERE id=$1", [id, JSON.stringify(settings), JSON.stringify(stock)]);
      await c.query("UPDATE snack_cycles SET status='cancelled' WHERE office_id=$1 AND status IN ('queued','running','ready','approved')", [id]);
    } else {
      if (revision !== 0) fail("SNACK_REVISION_CONFLICT");
      const count = +(await c.query("SELECT count(*) FROM snack_offices WHERE owner_id=$1", [owner])).rows[0].count;
      if (count >= 5) fail("SNACK_OFFICE_LIMIT", 429);
      await c.query("INSERT INTO snack_offices(id,owner_id,settings) VALUES($1,$2,$3)", [id, owner, JSON.stringify(settings)]);
    }
    return { id };
  });
}
export async function saveSnackStock(owner: string, id: string, revision: number, stock: SnackStock) {
  return transaction(async c => {
    const o = await ownedSnackOffice(c, owner, id, true);
    if (o.revision !== revision) fail("SNACK_REVISION_CONFLICT");
    if (new Set(stock.map(s => s.productId)).size !== stock.length || stock.some(s => s.suitableGroupIds.some(id => !o.settings.groups.some((g: { id: string }) => g.id === id)))) fail("SNACK_STOCK_INVALID", 400);
    await c.query("UPDATE snack_offices SET stock=$2,stock_checked_at=now(),stock_check_due=false,revision=revision+1,updated_at=now() WHERE id=$1", [id, JSON.stringify(stock)]);
    await c.query("UPDATE snack_cycles SET status='cancelled' WHERE office_id=$1 AND status IN ('queued','running','ready','approved')", [id]);
  });
}
async function history(c: Pick<PoolClient, "query">, id: string): Promise<SnackHistory> {
  return (await c.query("SELECT basket,ordered_at FROM snack_cycles WHERE office_id=$1 AND status='ordered' AND order_reference NOT LIKE 'SIM-%' ORDER BY ordered_at DESC LIMIT 24", [id])).rows.map(r => ({ productIds: r.basket.lines.map((l: { product: { id: string } }) => l.product.id), orderedAt: new Date(r.ordered_at).toISOString() }));
}
async function insertCycle(c: PoolClient, o: any, id: string, key: string, version: number | null, source: "channel3" | "simulated" = "channel3") {
  const shared = (await c.query("SELECT id,name,preferences FROM snack_members WHERE office_id=$1 AND shared ORDER BY id", [o.id])).rows;
  if (o.headcount_mode === "total" && (o.settings.groups.length !== 1 || shared.length > o.settings.groups[0].people)) fail("SNACK_HEADCOUNT_CONFLICT");
  const baseGroups = o.headcount_mode === "total" ? [{ ...o.settings.groups[0], people: o.settings.groups[0].people - shared.length }] : o.settings.groups;
  const memberGroups = shared.map(m => ({ id: `m-${m.id.replaceAll("-", "")}`, name: m.name, people: 1, ...m.preferences }));
  const settings = { ...o.settings, groups: [...baseGroups, ...memberGroups] };
  const { snackSettings } = await import("./snack-policy");
  if (!snackSettings.safeParse(settings).success) fail("SNACK_SHARED_GROUP_LIMIT");
  const snapshot = { settings, stock: o.stock, stockCheckedAt: o.stock_checked_at ? new Date(o.stock_checked_at).toISOString() : null, history: await history(c, o.id) };
  const result = await c.query("INSERT INTO snack_cycles(id,office_id,occurrence_key,office_revision,schedule_version,input,source) VALUES($1,$2,$3,$4,$5,$6,$7) ON CONFLICT(office_id,occurrence_key) DO NOTHING RETURNING id", [id, o.id, key, o.revision, version, JSON.stringify(snapshot), source]);
  if (result.rowCount) return id;
  return (await c.query("SELECT id FROM snack_cycles WHERE office_id=$1 AND occurrence_key=$2", [o.id, key])).rows[0].id as string;
}
export async function admitSnackCycle(owner: string, officeId: string, revision: number, cycleId: string, admissionDeadline?: number, source: "channel3" | "simulated" = "channel3") {
  return transaction(async c => {
    const o = await ownedSnackOffice(c, owner, officeId, true);
    if (o.revision !== revision) fail("SNACK_REVISION_CONFLICT");
    const existing = (await c.query("SELECT * FROM snack_cycles WHERE id=$1", [cycleId])).rows[0];
    if (existing) {
      if (existing.office_id !== officeId || existing.office_revision !== revision || existing.source !== source) fail("SNACK_CYCLE_CONFLICT");
      return { id: cycleId, replayed: true };
    }
    const count = +(await c.query("SELECT count(*) FROM snack_cycles WHERE office_id=$1 AND created_at>now()-interval '1 day'", [officeId])).rows[0].count;
    if (count >= 5) fail("SNACK_DAILY_CYCLE_LIMIT", 429);
    await insertCycle(c, o, cycleId, "manual:" + cycleId, null, source);
    if (admissionDeadline !== undefined && Date.now() > admissionDeadline) fail("SNACK_ADMISSION_EXPIRED");
    return { id: cycleId };
  });
}
export async function claimSnackCycle(owner: string, officeId: string, id: string) {
  return transaction(async c => {
    const o = await ownedSnackOffice(c, owner, officeId, true);
    const r = (await c.query("SELECT * FROM snack_cycles WHERE id=$1 AND office_id=$2 FOR UPDATE", [id, officeId])).rows[0];
    if (!r) return { missing: true as const };
    if (!["queued", "running"].includes(r.status)) return null;
    if (r.office_revision !== o.revision || (r.schedule_version !== null && (!o.schedule_active || o.schedule_version !== r.schedule_version))) {
      await c.query("UPDATE snack_cycles SET status='cancelled' WHERE id=$1", [id]);
      return null;
    }
    if (r.status === "running" && r.lease_until > new Date()) return { busy: true as const };
    if (r.attempts >= 2) {
      await c.query("UPDATE snack_cycles SET status='failed',error_code='SNACK_RETRIES_EXHAUSTED' WHERE id=$1", [id]);
      return null;
    }
    await c.query("UPDATE snack_cycles SET status='running',attempts=attempts+1,lease_until=now()+interval '4 minutes',updated_at=now() WHERE id=$1", [id]);
    return { input: r.input, revision: o.revision, attempt: r.attempts + 1 };
  });
}
function basketDigest(id: string, revision: number, basket: unknown) {
  return createHash("sha256").update(canonicalJson({ id, revision, basket })).digest("hex");
}
export async function finishSnackCycle(owner: string, officeId: string, id: string, attempt: number, products: SnackProduct[], queries: string[], discussion: { name: string; summary: string; productIds: string[] }[] = []) {
  return transaction(async c => {
    const o = await ownedSnackOffice(c, owner, officeId, true);
    const r = (await c.query("SELECT * FROM snack_cycles WHERE id=$1 AND office_id=$2 FOR UPDATE", [id, officeId])).rows[0];
    if (!r || r.status !== "running" || r.attempts !== attempt || r.office_revision !== o.revision || (r.schedule_version !== null && (!o.schedule_active || o.schedule_version !== r.schedule_version))) return;
    const i = r.input;
    const basket = buildSnackBasket(i.settings, products, [], i.stock, i.history, i.stockCheckedAt, Date.now(), discussion.flatMap(d => d.productIds));
    await c.query("UPDATE snack_cycles SET status='ready',products=$2,queries=$3,basket=$4,digest=$5,discussion=$6,lease_until=null,updated_at=now() WHERE id=$1", [id, JSON.stringify(products), JSON.stringify(queries), JSON.stringify(basket), basketDigest(id, o.revision, basket), JSON.stringify(discussion)]);
  });
}

/** Demo supplier operations never grant payment authority or place a retailer order. */
export async function simulateSnackOrder(owner: string, officeId: string, id: string, digest: string) {
  return transaction(async c => {
    const o = await ownedSnackOffice(c, owner, officeId, true);
    const r = (await c.query("SELECT * FROM snack_cycles WHERE id=$1 AND office_id=$2 FOR UPDATE", [id, officeId])).rows[0];
    if (!r || r.digest !== digest) fail("SNACK_BASKET_CONFLICT");
    const reference = `SIM-${id}`;
    if (r.status === "ordered" && r.order_reference === reference) return;
    if (r.status !== "ready" || r.office_revision !== o.revision || !r.products.length || r.products.some((p: SnackProduct) => p.source !== "fixture")) fail("SNACK_SIMULATION_CONFLICT");
    const payment = (await c.query("SELECT amount_cents FROM snack_payments WHERE cycle_id=$1 AND office_id=$2 AND owner_id=$3 AND digest=$4 AND status='completed'", [id,officeId,owner,digest])).rows[0];
    if (!payment) fail("SNACK_PAYMENT_REQUIRED");
    const i = r.input;
    const basket = buildSnackBasket(i.settings, r.products, r.reviews, i.stock, i.history, i.stockCheckedAt, Date.now(), (r.discussion ?? []).flatMap((d: { productIds: string[] }) => d.productIds));
    if (basketDigest(id, o.revision, basket) !== digest || payment.amount_cents !== basket.subtotalCents || !basket.lines.length || basket.blockers.some(b => b !== "Sample catalog — no real order")) fail("SNACK_BASKET_NEEDS_REVIEW");
    await c.query("UPDATE snack_cycles SET status='ordered',order_reference=$2,ordered_at=now(),updated_at=now() WHERE id=$1", [id, reference]);
    await c.query("UPDATE snack_cycles SET status='cancelled' WHERE office_id=$1 AND id<>$2 AND status IN ('queued','running','ready','approved')", [officeId, id]);
    await c.query("UPDATE snack_offices SET revision=revision+1,updated_at=now() WHERE id=$1", [officeId]);
  });
}
export async function failSnackCycle(id: string, attempt: number, code: string) {
  await authPool.query("UPDATE snack_cycles SET status='failed',error_code=$3,lease_until=null,updated_at=now() WHERE id=$1 AND attempts=$2 AND status='running'", [id, attempt, code]);
}
export async function reviewSnackCycle(owner: string, officeId: string, id: string, digest: string, review: ProductReview) {
  return transaction(async c => {
    const o = await ownedSnackOffice(c, owner, officeId, true);
    const r = (await c.query("SELECT * FROM snack_cycles WHERE id=$1 AND office_id=$2 FOR UPDATE", [id, officeId])).rows[0];
    if (!r || r.status !== "ready" || r.digest !== digest || r.office_revision !== o.revision) fail("SNACK_BASKET_CONFLICT");
    if ((await c.query("SELECT id FROM snack_payments WHERE cycle_id=$1 AND status IN ('reserved','created','needs_review','completed')", [id])).rowCount) fail("SNACK_PAYMENT_RECONCILE_FIRST");
    if (!r.products.some((p: SnackProduct) => p.id === review.productId && p.fingerprint === review.fingerprint) || review.suitableGroupIds.some(id => !r.input.settings.groups.some((g: { id: string }) => g.id === id))) fail("SNACK_REVIEW_INVALID", 400);
    const reviews = [...r.reviews.filter((v: ProductReview) => v.productId !== review.productId), review];
    const i = r.input;
    const basket = buildSnackBasket(i.settings, r.products, reviews, i.stock, i.history, i.stockCheckedAt, Date.now(), (r.discussion ?? []).flatMap((d: { productIds: string[] }) => d.productIds));
    await c.query("UPDATE snack_cycles SET reviews=$2,basket=$3,digest=$4,updated_at=now() WHERE id=$1", [id, JSON.stringify(reviews), JSON.stringify(basket), basketDigest(id, o.revision, basket)]);
  });
}
export async function decideSnackCycle(owner: string, officeId: string, id: string, digest: string, action: "approve" | "reject" | "record_order", reference?: string) {
  if (action === "record_order" && reference?.startsWith("SIM-")) fail("SNACK_ORDER_REFERENCE_RESERVED", 400);
  return transaction(async c => {
    const o = await ownedSnackOffice(c, owner, officeId, true);
    const r = (await c.query("SELECT * FROM snack_cycles WHERE id=$1 AND office_id=$2 FOR UPDATE", [id, officeId])).rows[0];
    if (!r || r.digest !== digest) fail("SNACK_BASKET_CONFLICT");
    if (action === "record_order" && r.status === "ordered") {
      if (r.order_reference !== reference) fail("SNACK_ORDER_CONFLICT");
      return;
    }
    if (r.office_revision !== o.revision) fail("SNACK_BASKET_CONFLICT");
    if (action === "reject") {
      if ((await c.query("SELECT id FROM snack_payments WHERE cycle_id=$1 AND status IN ('reserved','created','needs_review','completed')", [id])).rowCount) fail("SNACK_PAYMENT_RECONCILE_FIRST");
      if (!["ready", "approved", "cancelled"].includes(r.status)) fail("SNACK_BASKET_CONFLICT");
      await c.query("UPDATE snack_cycles SET status='cancelled',updated_at=now() WHERE id=$1", [id]);
      return;
    }
    if (action === "approve") {
      if (r.status === "approved") return;
      if (r.status !== "ready") fail("SNACK_BASKET_CONFLICT");
      const i = r.input;
      const basket = buildSnackBasket(i.settings, r.products, r.reviews, i.stock, i.history, i.stockCheckedAt, Date.now(), (r.discussion ?? []).flatMap((d: { productIds: string[] }) => d.productIds));
      if (!basket.ready || basketDigest(id, o.revision, basket) !== digest) fail("SNACK_BASKET_NEEDS_REVIEW");
      // Basket approval grants no payment or merchant checkout permission.
      await c.query("UPDATE snack_cycles SET status='approved',updated_at=now() WHERE id=$1", [id]);
      return;
    }
    if (r.status === "ordered") {
      if (r.order_reference !== reference) fail("SNACK_ORDER_CONFLICT");
      return;
    }
    if (r.status !== "approved" || !reference) fail("SNACK_ORDER_NOT_APPROVED");
    await c.query("UPDATE snack_cycles SET status='ordered',order_reference=$2,ordered_at=now(),updated_at=now() WHERE id=$1", [id, reference]);
    // Another open basket cannot use the purchase history that preceded this order.
    await c.query("UPDATE snack_cycles SET status='cancelled' WHERE office_id=$1 AND id<>$2 AND status IN ('queued','running','ready','approved')", [officeId, id]);
    await c.query("UPDATE snack_offices SET revision=revision+1,updated_at=now() WHERE id=$1", [officeId]);
  });
}

export async function configureSnackSchedule(owner: string, id: string, revision: number, expectedVersion: number, active: boolean, dueAt?: string, admissionDeadline?: number, cadence: "fortnight" | "monthly" = "fortnight", anchorDay?: number, source: "channel3" | "simulated" = "channel3") {
  return transaction(async c => {
    const o = await ownedSnackOffice(c, owner, id, true);
    if (o.revision !== revision || o.schedule_version !== expectedVersion) fail("SNACK_REVISION_CONFLICT");
    if (active && (!dueAt || Date.parse(dueAt) < Date.now() - 5000 || Date.parse(dueAt) > Date.now() + (cadence === "monthly" ? 32 * 86400000 : FORTNIGHT_MS))) fail("SNACK_DUE_INVALID", 400);
    await c.query("UPDATE snack_offices SET schedule_active=$2,schedule_version=schedule_version+1,next_due_at=$3,schedule_expires_at=$4,schedule_cadence=$5,schedule_anchor_day=$6,schedule_source=$7,updated_at=now() WHERE id=$1", [id, active, active ? dueAt : null, active ? new Date(Date.now() + 366 * 86400000) : null, active ? cadence : o.schedule_cadence, active && cadence === "monthly" ? (anchorDay ?? new Date(dueAt!).getUTCDate()) : null, active ? source : o.schedule_source]);
    await c.query("UPDATE snack_cycles SET status='cancelled' WHERE office_id=$1 AND schedule_version IS NOT NULL AND status IN ('queued','running')", [id]);
    if (admissionDeadline !== undefined && Date.now() > admissionDeadline) fail("SNACK_ADMISSION_EXPIRED");
  });
}
export async function readSnackSchedule(owner: string, id: string, version: number) {
  const o = await ownedSnackOffice(authPool, owner, id);
  if (o.schedule_version < version) return { missing: true as const };
  if (!o.schedule_active || o.schedule_version !== version) return null;
  if (new Date(o.schedule_expires_at) <= new Date()) {
    await authPool.query("UPDATE snack_offices SET schedule_active=false WHERE id=$1 AND schedule_version=$2", [id, version]);
    return null;
  }
  return { dueAt: new Date(o.next_due_at).toISOString(), cadence: o.schedule_cadence as "monthly" | "fortnight", source: o.schedule_source as "channel3" | "simulated" };
}
export async function snackStockCheck(owner: string, id: string, version: number) {
  await authPool.query("UPDATE snack_offices SET stock_check_due=true WHERE id=$1 AND owner_id=$2 AND schedule_active AND schedule_version=$3 AND (stock_checked_at IS NULL OR stock_checked_at<now()-interval '3 days')", [id, owner, version]);
}
export async function fireSnackSchedule(owner: string, id: string, version: number, due: string) {
  return transaction(async c => {
    const o = await ownedSnackOffice(c, owner, id, true);
    if (!o.schedule_active || o.schedule_version !== version || new Date(o.schedule_expires_at) <= new Date()) return null;
    // Idempotent occurrence; duplicate timers cannot create a second basket.
    const key = `scheduled:${version}:${due}`;
    const prior = (await c.query("SELECT id FROM snack_cycles WHERE office_id=$1 AND occurrence_key=$2", [id, key])).rows[0];
    if (prior) return prior.id as string;
    if (new Date(o.next_due_at).toISOString() !== due || Date.parse(due) > Date.now()) return null;
    const cycleId = await insertCycle(c, o, randomUUID(), key, version, o.schedule_source);
    const nextDue = o.schedule_cadence === "monthly" ? nextMonthlySnackDue(due, o.schedule_anchor_day, Date.now()) : nextSnackDue(due, Date.now());
    await c.query("UPDATE snack_offices SET next_due_at=$2,stock_check_due=true,updated_at=now() WHERE id=$1", [id, nextDue]);
    return cycleId;
  });
}
