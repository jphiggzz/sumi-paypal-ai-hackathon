import { Channel3 } from "@channel3/sdk";
import { z } from "zod";
import type { GiftProduct } from "./gift-policy";
const https = z.string().url().refine(s => new URL(s).protocol === "https:");
const raw = z.object({ id: z.string().min(1).max(200), title: z.string().min(1).max(500), description: z.string().nullish(), category: z.object({ slug: z.string() }).nullish(), images: z.array(z.object({ url: z.string() })).optional(), offers: z.array(z.object({ url: https, domain: z.string(), price: z.object({ price: z.number().positive().finite(), currency: z.string() }), availability: z.string(), condition: z.string().nullish() })).optional() });
export function normalizeGiftProducts(values: unknown[], maxCents: number): GiftProduct[] {
  const result = new Map<string, GiftProduct>();
  for (const value of values) {
    const r = raw.safeParse(value); if (!r.success) continue;
    const p = r.data;
    const offer = p.offers?.filter(o => o.price.currency === "USD" && o.availability === "InStock" && o.condition !== "used" && !o.domain.endsWith(".ca") && Math.round(o.price.price * 100) <= maxCents).sort((a, b) => a.price.price - b.price.price)[0];
    if (!offer || result.has(p.id)) continue;
    result.set(p.id, { id: p.id, title: p.title, description: (p.description ?? "").slice(0, 1800), category: p.category?.slug ?? "unknown", url: offer.url, image: p.images?.find(i => https.safeParse(i.url).success)?.url ?? null, merchant: offer.domain, cents: Math.round(offer.price.price * 100), currency: "USD", retrievedAt: new Date().toISOString() });
  }
  return [...result.values()];
}
export async function searchGiftProducts(queries: string[], maxCents: number) {
  if (!process.env.CHANNEL3_API_KEY) throw new Error("CHANNEL3_NOT_CONFIGURED");
  const client = new Channel3({ apiKey: process.env.CHANNEL3_API_KEY, country: "US", currency: "USD", timeoutInSeconds: 20, maxRetries: 0 });
  const products = new Map<string, GiftProduct>();
  for (const query of [...new Set(queries)].slice(0, 4)) {
    const page = await client.products.search({ query, limit: 10, filters: { availability: ["InStock"], price: { max_price: maxCents / 100 } } });
    for (const product of normalizeGiftProducts(page.data, maxCents)) {
      const prior = products.get(product.id);
      if (prior) prior.sourceQueries = [...new Set([...(prior.sourceQueries || []), query])];
      else products.set(product.id, { ...product, sourceQueries: [query] });
    }
  }
  return [...products.values()];
}

export async function similarGiftProducts(productId: string, maxCents: number) {
  if (!process.env.CHANNEL3_API_KEY) throw new Error("CHANNEL3_NOT_CONFIGURED");
  const client = new Channel3({ apiKey: process.env.CHANNEL3_API_KEY, country: "US", currency: "USD", timeoutInSeconds: 20, maxRetries: 0 });
  const page = await client.products.findSimilar({ product_id: productId, limit: 20, filters: { availability: ["InStock"], price: { max_price: maxCents / 100 } } });
  return normalizeGiftProducts(page.data, maxCents).filter(product => product.id !== productId);
}
