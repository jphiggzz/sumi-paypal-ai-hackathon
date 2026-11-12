import { createHash } from "node:crypto";
import { Channel3 } from "@channel3/sdk";
import { z } from "zod";
import type { SnackProduct } from "./snack-policy";
import { canonicalJson } from "./canonical-json";
import { CapabilityError } from "./capability-contracts";

const https = z.string().url().refine(s => new URL(s).protocol === "https:");
const rawProduct = z.object({
  id: z.string().min(1).max(200), title: z.string().min(1).max(500),
  description: z.string().max(20000).nullish(),
  category: z.object({ slug: z.string(), path: z.array(z.object({ slug: z.string() })).optional() }).nullish(),
  images: z.array(z.object({ url: z.string() })).optional(),
  offers: z.array(z.object({
    url: https, domain: z.string().min(1).max(200),
    price: z.object({ price: z.number().finite().positive().max(10000), currency: z.string() }),
    availability: z.string(), condition: z.string().nullish(),
  })).optional(),
});

/** No inference of ingredients, serving counts, shipping or allergy safety. */
export function normalizeSnackProducts(raw: unknown[], retrievedAt: string): SnackProduct[] {
  const result: SnackProduct[] = [];
  const seen = new Set<string>();
  for (const value of raw) {
    const parsed = rawProduct.safeParse(value);
    if (!parsed.success || seen.has(parsed.data.id)) continue;
    const p = parsed.data;
    // An office snack needs positive human-food category evidence. A matching
    // word in a book, bowl or pet treat title is not sufficient.
    const root = p.category?.path?.[0]?.slug ?? p.category?.slug;
    if (!root || !/^(food(?:-|$)|grocer)/i.test(root)) continue;
    // Observed live searches return pet food, toy food, clothing and appliances
    // for snack queries. Category evidence overrides a snack-like title.
    const categories = [p.category?.slug, ...(p.category?.path?.map(c => c.slug) ?? [])];
    const excluded = new Set(["animals-pet-supplies", "toys-games", "apparel-accessories", "baby-toddler", "home-garden", "business-industrial", "arts-entertainment", "sporting-goods", "health-beauty", "popcorn-makers", "serving-platters", "food-beverage-carriers"]);
    if (categories.some(c => c && excluded.has(c)) || /\b(dog|dogs|cat|cats|bird|birds|pet|pets|reptile|hamster|puppy|kitten|beefhide|rawhide|slime|inflatable|figurine|ornament|stress toy|play food)\b/i.test(p.title)) continue;
    const offer = p.offers?.filter(o => o.price.currency === "USD" && o.availability === "InStock" && o.condition !== "used")
      .sort((a, b) => a.price.price - b.price.price)[0];
    if (!offer) continue;
    const facts = {
      id: p.id, title: p.title, description: (p.description ?? "").slice(0, 4000),
      url: offer.url, merchant: offer.domain,
      cents: Math.round(offer.price.price * 100), currency: "USD" as const,
    };
    if (facts.cents <= 0) continue;
    result.push({
      ...facts, imageUrl: p.images?.find(i => https.safeParse(i.url).success)?.url ?? null,
      fingerprint: createHash("sha256").update(canonicalJson(facts)).digest("hex"),
      retrievedAt, source: "channel3",
    });
    seen.add(p.id);
  }
  return result;
}

export async function searchSnackCatalog(queries: string[], maxPriceCents: number, transport?: { apiKey: string; fetch: typeof fetch }) {
  if (!process.env.CHANNEL3_API_KEY && !transport) throw new CapabilityError("CHANNEL3_NOT_CONFIGURED", 503);
  const client = new Channel3({
    apiKey: process.env.CHANNEL3_API_KEY, country: "US", currency: "USD",
    timeoutInSeconds: 20, maxRetries: 0, ...transport,
  });
  const results: unknown[] = [];
  // Four first pages maximum; never follow pagination automatically.
  for (const query of [...new Set(queries)].slice(0, 4)) {
    try {
      const page = await client.products.search({ query, limit: 12, filters: { availability: ["InStock"], exclude_category_ids: ["animals-pet-supplies", "toys-games", "apparel-accessories", "baby-toddler"] } });
      results.push(...page.data);
    } catch (e) {
      const code = (e as { statusCode?: number }).statusCode;
      throw new CapabilityError(code === 429 ? "CHANNEL3_RATE_LIMITED" : "CHANNEL3_SEARCH_FAILED", code === 429 ? 429 : 503);
    }
  }
  return normalizeSnackProducts(results, new Date().toISOString()).filter(p => p.cents <= maxPriceCents);
}
