import { defaultSnackSettings, type SnackProduct, type ProductReview } from "./snack-policy";

/** Illustrative inventory and prices. Never used by the real Channel3 workflow. */
export function snackFixtures(now = Date.now()) {
  const names = ["Sea salt pretzels", "White cheddar popcorn", "Chocolate protein bars", "Spicy chickpeas", "Dried mango fruit", "Cinnamon oat bites", "Lime popcorn", "Chili rice crackers", "Apple fruit crisps", "Roasted broad beans", "Maple oat bars", "Dairy-free dark chocolate bites"];
  const products: SnackProduct[] = names.map((title, i) => ({
    id: `sample-${i}`, title, description: "Illustrative 24-serving snack multipack",
    url: "https://example.com/sample-snacks", imageUrl: null,
    merchant: "Sample pantry", cents: 1200 + i * 50, currency: "USD",
    retrievedAt: new Date(now).toISOString(), fingerprint: `sample-v1-${i}`, source: "fixture",
  }));
  const reviews: ProductReview[] = products.map((p, i) => ({
    productId: p.id, fingerprint: p.fingerprint, servingsPerPack: 24,
    suitableGroupIds: i === 1 ? ["team", "gluten-free"] : i === 2 ? ["team"] : [0, 5, 10].includes(i) ? ["team", "plant-based"] : defaultSnackSettings.groups.map(g => g.id),
    officeSafe: true, evidence: "Synthetic dietary evidence for interactive demo only",
  }));
  return { products, reviews };
}
