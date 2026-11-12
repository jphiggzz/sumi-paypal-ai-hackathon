import { z } from "zod";

export const FORTNIGHT_MS = 14 * 86400000;
const words = z.array(z.string().trim().min(1).max(80)).max(12);
export const snackSettings = z.object({
  name: z.string().trim().min(1).max(80),
  budgetCents: z.number().int().min(500).max(100000),
  reserveCents: z.number().int().min(0).max(50000),
  onsiteDays: z.number().int().min(1).max(14),
  servingsPerPersonDay: z.number().int().min(1).max(3),
  groups: z.array(z.object({
    id: z.string().regex(/^[a-z0-9-]{1,40}$/),
    name: z.string().trim().min(1).max(60),
    people: z.number().int().min(0).max(100),
    likes: words, dislikes: words, dietary: words, allergies: words,
  }).strict()).min(1).max(12),
}).strict().superRefine((v, ctx) => {
  if (v.reserveCents >= v.budgetCents) ctx.addIssue({ code: "custom", message: "Reserve must be below budget" });
  if (new Set(v.groups.map(g => g.id)).size !== v.groups.length) ctx.addIssue({ code: "custom", message: "Duplicate group" });
  if (v.groups.reduce((n, g) => n + g.people, 0) > 100) ctx.addIssue({ code: "custom", message: "Maximum 100 people" });
});
export type SnackSettings = z.infer<typeof snackSettings>;
export const snackStock = z.array(z.object({
  productId: z.string().min(1).max(200),
  servingsRemaining: z.number().int().min(0).max(10000),
  suitableGroupIds: z.array(z.string().max(40)).max(12),
}).strict()).max(60);
export type SnackStock = z.infer<typeof snackStock>;
export const productReview = z.object({
  productId: z.string().min(1).max(200),
  fingerprint: z.string().min(1).max(100),
  servingsPerPack: z.number().int().min(1).max(500),
  suitableGroupIds: z.array(z.string().max(40)).max(12),
  // With allergies, cross-contact/office-wide exclusion is a separate check.
  officeSafe: z.boolean(),
  evidence: z.string().trim().min(3).max(1000),
}).strict();
export type ProductReview = z.infer<typeof productReview>;
export type SnackProduct = {
  id: string; title: string; description: string; url: string; imageUrl: string | null;
  merchant: string; cents: number; currency: "USD"; retrievedAt: string;
  fingerprint: string; source: "channel3" | "fixture";
};
export type SnackHistory = { productIds: string[]; orderedAt: string }[];
export type BasketLine = {
  product: SnackProduct; packs: number; cents: number; servings: number | null;
  suitableGroupIds: string[]; category: "favorite" | "rotation" | "experiment";
};
export type SnackBasket = ReturnType<typeof buildSnackBasket>;
const text = (p: SnackProduct) => `${p.title} ${p.description}`.toLowerCase();
const matches = (p: SnackProduct, terms: string[]) => terms.some(t => text(p).includes(t.toLowerCase()));
export function stockWarnings(settings: SnackSettings, stock: SnackStock, checkedAt: string | null, now = Date.now()) {
  const target = settings.groups.reduce((n, g) => n + g.people, 0) * settings.onsiteDays * settings.servingsPerPersonDay;
  const total = stock.reduce((n, s) => n + s.servingsRemaining, 0);
  return [
    ...(!checkedAt || now - Date.parse(checkedAt) > 7 * 86400000 ? ["Stock check needed"] : []),
    ...(total < target / 2 ? ["Low stock — review before the next delivery"] : []),
  ];
}

/** All costs, quantities and coverage are computed here, never by the model. */
export function buildSnackBasket(
  settings: SnackSettings, products: SnackProduct[], reviews: ProductReview[],
  stock: SnackStock, history: SnackHistory, stockCheckedAt: string | null, now = Date.now(), recommendedIds: string[] = [],
) {
  settings = snackSettings.parse(settings);
  const groupIds = new Set(settings.groups.map(g => g.id));
  const reviewed = new Map(reviews.map(r => [r.productId, r]));
  const targets = settings.groups.map(g => ({ id: g.id, name: g.name, target: g.people * settings.onsiteDays * settings.servingsPerPersonDay, covered: 0 }));
  // Stock counts can be allocated once across suitable groups, not once per group.
  const allocate = (servings: number, eligible: string[]) => {
    for (let n = 0; n < servings; n++) {
      const g = targets.filter(g => eligible.includes(g.id) && g.covered < g.target)
        .sort((a, b) => a.covered / a.target - b.covered / b.target || a.id.localeCompare(b.id))[0];
      if (!g) break;
      g.covered++;
    }
  };
  // Stale stock is displayed but cannot silently reduce the order quantities.
  const freshStock = stockCheckedAt && now - Date.parse(stockCheckedAt) <= 7 * 86400000 ? stock : [];
  for (const s of freshStock) allocate(s.servingsRemaining, s.suitableGroupIds);
  const recent = new Set(history.slice(0, 2).flatMap(h => h.productIds));
  const past = new Set(history.flatMap(h => h.productIds));
  const totalTarget = targets.reduce((n, g) => n + g.target, 0);
  const need = targets.reduce((n, g) => n + g.target - g.covered, 0);
  const slots = Math.min(8, Math.max(1, Math.ceil(need / 20)));
  const likes = settings.groups.flatMap(g => g.likes);
  const seen = new Set<string>();
  const candidates = products.filter(p => {
    if (seen.has(p.id) || p.currency !== "USD" || !Number.isSafeInteger(p.cents) || p.cents <= 0) return false;
    seen.add(p.id);
    const r = reviewed.get(p.id);
    if (r?.fingerprint === p.fingerprint && !r.officeSafe) return false;
    return !freshStock.some(s => s.productId === p.id && s.servingsRemaining >= Math.ceil(totalTarget / slots));
  }).map(p => {
    const category = matches(p, likes) ? "favorite" as const : past.has(p.id) ? "rotation" as const : "experiment" as const;
    const affinity = settings.groups.reduce((n, g) => n + (matches(p, g.likes) ? g.people : 0) - (matches(p, g.dislikes) ? g.people * 2 : 0), 0);
    return { p, category, score: affinity + Math.min(8, recommendedIds.filter(id => id === p.id).length) * 2 - (recent.has(p.id) ? 1000 : 0) };
  }).sort((a, b) => b.score - a.score || a.p.cents - b.p.cents || a.p.id.localeCompare(b.p.id));
  // 60/30/10 is a preference, not a coverage or safety constraint. Prefer fresh
  // choices globally before falling back to a recent product in any category.
  const quotas = { favorite: Math.round(slots * .6), rotation: Math.floor(slots * .3), experiment: Math.max(1, Math.round(slots * .1)) };
  const picked: typeof candidates = [];
  for (const category of ["favorite", "rotation", "experiment"] as const) {
    picked.push(...candidates.filter(c => c.category === category && !recent.has(c.p.id)).slice(0, quotas[category]));
  }
  for (const c of candidates) if (picked.length < slots && !picked.includes(c)) picked.push(c);
  const lines: BasketLine[] = [];
  let spent = 0;
  const limit = settings.budgetCents - settings.reserveCents;
  if (need > 0) for (const { p, category } of picked.slice(0, slots)) {
    const r = reviewed.get(p.id);
    const verified = r?.fingerprint === p.fingerprint && r.officeSafe;
    const eligible = verified ? r.suitableGroupIds.filter(id => groupIds.has(id) && !matches(p, settings.groups.find(g => g.id === id)!.dislikes)) : [];
    if (verified && eligible.length === 0) continue;
    const deficit = targets.filter(g => eligible.includes(g.id)).reduce((n, g) => n + g.target - g.covered, 0);
    const desired = verified ? Math.ceil(Math.min(deficit, Math.ceil(need / Math.max(1, picked.length))) / r.servingsPerPack) : 1;
    const packs = Math.min(desired, Math.floor((limit - spent) / p.cents));
    if (packs <= 0) continue;
    const servings = verified ? packs * r.servingsPerPack : null;
    lines.push({ product: p, packs, cents: packs * p.cents, servings, suitableGroupIds: eligible, category });
    spent += packs * p.cents;
    if (servings !== null) allocate(servings, eligible);
  }
  // Spend remaining budget only where another verified pack improves coverage.
  for (let n = 0; n < 1000; n++) {
    const line = lines.filter(l => {
      const r = reviewed.get(l.product.id);
      return r && l.servings !== null && spent + l.product.cents <= limit && targets.some(g => l.suitableGroupIds.includes(g.id) && g.covered < g.target);
    }).sort((a, b) => a.product.cents / reviewed.get(a.product.id)!.servingsPerPack - b.product.cents / reviewed.get(b.product.id)!.servingsPerPack)[0];
    if (!line) break;
    const amount = reviewed.get(line.product.id)!.servingsPerPack;
    line.packs++; line.cents += line.product.cents; line.servings! += amount;
    spent += line.product.cents; allocate(amount, line.suitableGroupIds);
  }
  const blockers = [
    ...(need > 0 && products.length === 0 ? ["No suitable office snacks found in the catalog"] : []),
    ...(!stockCheckedAt || now - Date.parse(stockCheckedAt) > 7 * 86400000 ? ["Check current stock"] : []),
    ...(lines.some(l => l.servings === null) ? ["Verify pack sizes, dietary suitability and allergy cross-contact"] : []),
    ...(targets.some(g => g.covered < g.target) ? ["Not enough verified servings for every group"] : []),
    ...(products.some(p => p.source === "fixture") ? ["Sample catalog — no real order"] : []),
    ...(lines.some(l => now - Date.parse(l.product.retrievedAt) > 86400000) ? ["Refresh product prices"] : []),
  ];
  return {
    lines, subtotalCents: spent, reserveCents: settings.reserveCents,
    budgetCents: settings.budgetCents, availableCents: limit - spent,
    coverage: targets, blockers, ready: blockers.length === 0,
    warnings: stockWarnings(settings, stock, stockCheckedAt, now),
    repeatedProductIds: lines.filter(l => recent.has(l.product.id)).map(l => l.product.id),
    shippingAndTax: "unknown" as const,
  };
}

export function nextSnackDue(due: string, now: number) {
  const anchor = Date.parse(due);
  return new Date(anchor + Math.max(1, Math.floor((now - anchor) / FORTNIGHT_MS) + 1) * FORTNIGHT_MS).toISOString();
}
/** UTC calendar-month recurrence; preserve the original day across short months. */
export function nextMonthlySnackDue(due: string, anchorDay: number, now: number) {
  const source = new Date(due);
  if (!Number.isFinite(source.getTime()) || !Number.isInteger(anchorDay) || anchorDay < 1 || anchorDay > 31 || !Number.isFinite(now)) throw new Error("SNACK_DUE_INVALID");
  for (let month = 1; month <= 1200; month++) {
    const first = new Date(Date.UTC(source.getUTCFullYear(), source.getUTCMonth() + month, 1, source.getUTCHours(), source.getUTCMinutes(), source.getUTCSeconds(), source.getUTCMilliseconds()));
    const lastDay = new Date(Date.UTC(first.getUTCFullYear(), first.getUTCMonth() + 1, 0)).getUTCDate();
    first.setUTCDate(Math.min(anchorDay, lastDay));
    if (first.getTime() > now) return first.toISOString();
  }
  throw new Error("SNACK_DUE_INVALID");
}
export const defaultSnackSettings: SnackSettings = {
  name: "Office snacks", budgetCents: 20000, reserveCents: 2500,
  onsiteDays: 10, servingsPerPersonDay: 1,
  groups: [
    { id: "team", name: "Team", people: 13, likes: ["pretzels", "popcorn", "protein bars"], dislikes: ["raisins"], dietary: [], allergies: [] },
    { id: "plant-based", name: "Plant based", people: 3, likes: ["spicy", "chickpeas"], dislikes: [], dietary: ["vegan"], allergies: [] },
    { id: "gluten-free", name: "Gluten free", people: 2, likes: ["fruit", "popcorn"], dislikes: [], dietary: ["gluten free"], allergies: [] },
  ],
};
