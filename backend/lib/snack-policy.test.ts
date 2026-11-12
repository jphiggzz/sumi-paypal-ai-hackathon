import { test } from "node:test";
import assert from "node:assert/strict";
import { buildSnackBasket, defaultSnackSettings, nextSnackDue, nextMonthlySnackDue, snackSettings, type SnackProduct } from "./snack-policy";
import { snackFixtures } from "./snack-fixtures";
import { normalizeSnackProducts, searchSnackCatalog } from "./snack-channel3";
const now = Date.parse("2026-11-10T15:00:00Z");
const at = new Date(now).toISOString();
const settings = () => structuredClone(defaultSnackSettings);
const fixture = () => snackFixtures(now);
function basket(opts: { stock?: Parameters<typeof buildSnackBasket>[3]; history?: Parameters<typeof buildSnackBasket>[4]; checked?: string | null; reviewed?: boolean } = {}) {
  const { products, reviews } = fixture();
  return buildSnackBasket(settings(), products, opts.reviewed === false ? [] : reviews, opts.stock ?? [], opts.history ?? [], opts.checked === undefined ? at : opts.checked, now);
}
test("basket covers 180 servings inside budget plus shipping reserve", () => {
  const b = basket();
  assert.ok(b.subtotalCents + b.reserveCents <= 20000);
  assert.ok(b.coverage.every(g => g.covered === g.target));
  assert.equal(b.coverage.reduce((n, g) => n + g.target, 0), 180);
  assert.deepEqual(b.blockers, ["Sample catalog — no real order"]);
});
test("unreviewed products cannot provide verified coverage or approval", () => {
  const b = basket({ reviewed: false });
  assert.ok(b.lines.every(l => l.servings === null));
  assert.ok(b.coverage.every(g => g.covered === 0));
  assert.equal(b.ready, false);
});
test("remaining stock is counted once across groups and plentiful products skipped", () => {
  const b = basket({ stock: [{ productId: "sample-0", servingsRemaining: 48, suitableGroupIds: ["team", "plant-based", "gluten-free"] }] });
  assert.ok(!b.lines.some(l => l.product.id === "sample-0"));
  const all = basket({ stock: [{ productId: "pantry", servingsRemaining: 180, suitableGroupIds: ["team", "plant-based", "gluten-free"] }] });
  assert.equal(all.lines.length, 0);
  assert.equal(all.coverage.reduce((n, g) => n + g.covered, 0), 180);
});
test("stock suitable for one group never covers other dietary groups", () => {
  const b = basket({ reviewed: false, stock: [{ productId: "stock", servingsRemaining: 180, suitableGroupIds: ["team"] }] });
  assert.equal(b.coverage.find(g => g.id === "plant-based")!.covered, 0);
  assert.equal(b.coverage.find(g => g.id === "team")!.covered, 130);
});
test("stale stock cannot reduce purchases", () => {
  const b = basket({ stock: [{ productId: "stock", servingsRemaining: 1000, suitableGroupIds: ["team", "plant-based", "gluten-free"] }], checked: "2026-10-01T00:00:00Z", reviewed: false });
  assert.ok(b.blockers.includes("Check current stock"));
  assert.ok(b.coverage.every(g => g.covered === 0));
});
test("next cycle changes the basket and avoids leftover pretzels", () => {
  const first = basket();
  const second = basket({ history: [{ productIds: first.lines.map(l => l.product.id), orderedAt: at }], stock: [{ productId: "sample-0", servingsRemaining: 48, suitableGroupIds: ["team", "plant-based", "gluten-free"] }] });
  assert.ok(!second.lines.some(l => l.product.id === "sample-0"));
  assert.ok(second.lines.some(l => !first.lines.some(old => old.product.id === l.product.id)));
});
test("changed product fingerprint invalidates dietary and serving reviews", () => {
  const { products, reviews } = fixture();
  const b = buildSnackBasket(settings(), products.map(p => ({ ...p, fingerprint: "new-offer" })), reviews, [], [], at, now);
  assert.ok(b.lines.every(l => l.servings === null));
  assert.equal(b.ready, false);
});
test("office-wide allergy exclusion removes a reviewed product", () => {
  const { products, reviews } = fixture();
  const b = buildSnackBasket(settings(), products, reviews.map(r => ({ ...r, officeSafe: false })), [], [], at, now);
  assert.equal(b.lines.length, 0);
  assert.equal(b.ready, false);
});
test("small budget reports a coverage gap rather than claiming success", () => {
  const { products, reviews } = fixture();
  const b = buildSnackBasket({ ...settings(), budgetCents: 1500, reserveCents: 200 }, products, reviews, [], [], at, now);
  assert.ok(b.subtotalCents <= 1300);
  assert.ok(b.blockers.includes("Not enough verified servings for every group"));
});
test("catalog rejects unsafe URLs, non-USD and out-of-stock offers", () => {
  const offer = { url: "https://shop.example/snack", domain: "shop.example", price: { price: 12.34, currency: "USD" }, availability: "InStock" };
  const raw = [
    { id: "good", title: "Snack", category: { slug: "snack-foods", path: [{ slug: "food-beverages" }] }, offers: [offer] },
    { id: "unsafe", title: "Snack", offers: [{ ...offer, url: "javascript:alert(1)" }] },
    { id: "euro", title: "Snack", offers: [{ ...offer, price: { price: 12, currency: "EUR" } }] },
    { id: "gone", title: "Snack", offers: [{ ...offer, availability: "OutOfStock" }] },
    { id: "nan", title: "Snack", offers: [{ ...offer, price: { price: NaN, currency: "USD" } }] },
  ];
  const result = normalizeSnackProducts(raw, at);
  assert.equal(result.length, 1); assert.equal(result[0].cents, 1234);
  assert.equal(result[0].source, "channel3");
  assert.equal(normalizeSnackProducts([], at).length, 0);
});
test("normalizer deduplicates products and binds review fingerprint to offer price", () => {
  const raw = { id: "snack", title: "Snack", category: { slug: "snack-foods", path: [{ slug: "food-beverages" }] }, offers: [{ url: "https://shop.example/snack", domain: "shop.example", price: { price: 12, currency: "USD" }, availability: "InStock" }] };
  const a = normalizeSnackProducts([raw, raw], at);
  const b = normalizeSnackProducts([{ ...raw, offers: [{ ...raw.offers[0], price: { price: 13, currency: "USD" } }] }], at);
  assert.equal(a.length, 1); assert.notEqual(a[0].fingerprint, b[0].fingerprint);
});
test("live catalog regressions: animal treats, toy food, baby food and snack-named footwear are excluded", () => {
  const offer = { url: "https://shop.example/snack", domain: "shop.example", price: { price: 12, currency: "USD" }, availability: "InStock" };
  const raw = [
    { id: "dog", title: "Cheddar Pretzels Dog Treats", offers: [offer] },
    { id: "boots", title: "Trail Mix", offers: [offer], category: { slug: "boots", path: [{ slug: "apparel-accessories" }] } },
    { id: "bird", title: "Trail Mix Seed Cake", offers: [offer], category: { slug: "bird-treats", path: [{ slug: "animals-pet-supplies" }] } },
    { id: "toy", title: "Popcorn Slime Snack Bar Set", offers: [offer] },
    { id: "baby", title: "Puffs Variety Pack", offers: [offer], category: { slug: "baby-snacks", path: [{ slug: "baby-toddler" }] } },
    { id: "appliance", title: "Gourmet Popcorn Starter Set", offers: [offer], category: { slug: "popcorn-makers" } },
    { id: "container", title: "Snack Box Set", offers: [offer], category: { slug: "food-storage-containers", path: [{ slug: "home-garden" }] } },
    { id: "decor", title: "Popcorn Centerpieces", offers: [offer], category: { slug: "party-supplies", path: [{ slug: "arts-entertainment" }] } },
    { id: "book", title: "Vegan Snack Recipes", offers: [offer], category: { slug: "books", path: [{ slug: "media" }] } },
    { id: "unknown", title: "Snack", offers: [offer] },
  ];
  assert.deepEqual(normalizeSnackProducts(raw, at), []);
});
test("prices older than a day prevent approval even for reviewed live sources", () => {
  const { products, reviews } = fixture();
  const old: SnackProduct[] = products.map(p => ({ ...p, source: "channel3", retrievedAt: "2026-11-08T15:00:00Z" }));
  const b = buildSnackBasket(settings(), old, reviews, [], [], at, now);
  assert.ok(b.blockers.includes("Refresh product prices"));
});
test("fortnight schedule retains its anchor and skips missed occurrences", () => {
  assert.equal(nextSnackDue(at, now), "2026-11-24T15:00:00.000Z");
  assert.equal(nextSnackDue(at, now + 30 * 86400000), "2026-12-22T15:00:00.000Z");
});
test("monthly schedule retains the original day through short months and skips missed occurrences", () => {
  const jan = "2027-01-31T15:00:00.000Z";
  assert.equal(nextMonthlySnackDue(jan, 31, Date.parse(jan)), "2027-02-28T15:00:00.000Z");
  assert.equal(nextMonthlySnackDue("2027-02-28T15:00:00.000Z", 31, Date.parse("2027-02-28T15:00:00.000Z")), "2027-03-31T15:00:00.000Z");
  assert.equal(nextMonthlySnackDue(jan, 31, Date.parse("2027-04-15T00:00:00Z")), "2027-04-30T15:00:00.000Z");
  assert.throws(() => nextMonthlySnackDue(jan, 0, Date.now()));
});
test("configuration rejects duplicate cohorts and reserve exceeding budget", () => {
  assert.equal(snackSettings.safeParse({ ...settings(), reserveCents: 20001 }).success, false);
  assert.equal(snackSettings.safeParse({ ...settings(), groups: [settings().groups[0], settings().groups[0]] }).success, false);
});
test("installed Channel3 SDK sends bounded authenticated US searches without following pagination", async () => {
  const requests: { url: string; body: any }[] = [];
  const products = [{ id: "snack", title: "Snack", category: { slug: "snack-foods", path: [{ slug: "food-beverages", title: "Food & Beverages" }], title: "Snack Foods", has_children: false }, offers: [{ url: "https://shop.example/snack", domain: "shop.example", price: { price: 12, currency: "USD" }, availability: "InStock" }] }];
  const transport = { apiKey: "synthetic-test-key", fetch: (async (url, options) => {
    const headers = new Headers(options?.headers);
    assert.equal(headers.get("x-api-key"), "synthetic-test-key");
    assert.equal(headers.get("x-channel3-country"), "US");
    assert.equal(options?.method, "POST");
    requests.push({ url: String(url), body: JSON.parse(String(options?.body)) });
    return Response.json({ products, next_page_token: "do-not-fetch" });
  }) as typeof fetch };
  const p = await searchSnackCatalog(["snack one", "snack two", "snack three", "snack four", "snack five"], 2000, transport);
  assert.equal(requests.length, 4);
  assert.ok(requests.every(r => r.url === "https://api.trychannel3.com/v1/search" && r.body.limit === 12 && r.body.filters.availability[0] === "InStock"));
  assert.equal(p.length, 1);
});
test("Channel3 rate limit is surfaced once without retries or provider body leakage", async () => {
  let calls = 0;
  await assert.rejects(() => searchSnackCatalog(["snack"], 2000, { apiKey: "synthetic", fetch: (async () => {
    calls++; return Response.json({ detail: "PRIVATE_PROVIDER_BODY" }, { status: 429 });
  }) as typeof fetch }), (e: any) => e.code === "CHANNEL3_RATE_LIMITED" && !String(e).includes("PRIVATE_PROVIDER_BODY"));
  assert.equal(calls, 1);
});

test("agent recommendations affect selection but cannot replace product review", () => {
  const settings = { ...defaultSnackSettings, onsiteDays: 1, groups: [{ id: "team", name: "Team", people: 1, likes: [], dislikes: [], dietary: [], allergies: [] }] };
  const now = Date.now();
  const products = snackFixtures(now).products.slice(0, 2).map((p, i) => ({ ...p, cents: 1000 + i }));
  const baseline = buildSnackBasket(settings, products, [], [], [], new Date(now).toISOString(), now);
  const suggested = buildSnackBasket(settings, products, [], [], [], new Date(now).toISOString(), now, [products[1].id]);
  assert.equal(baseline.lines[0].product.id, products[0].id);
  assert.equal(suggested.lines[0].product.id, products[1].id);
  assert.equal(suggested.lines[0].servings, null);
  assert.ok(suggested.blockers.includes("Verify pack sizes, dietary suitability and allergy cross-contact"));
});
