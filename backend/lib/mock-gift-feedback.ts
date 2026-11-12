import { z } from "zod";

export const mockFeedbackInput = z.object({
  conversationId: z.uuid(),
  mode: z.enum(["suggestions", "feedback"]),
  feedback: z.string().trim().max(1000),
  priorFeedback: z.array(z.string().trim().min(1).max(1000)).max(10),
  shownIndices: z.array(z.number().int().min(0).max(6)).max(3),
}).strict().refine((value) => value.mode !== "feedback" || value.feedback.length > 0);

export const mockFeedbackOutput = z.object({
  productIndices: z.array(z.number().int().min(0).max(6)).max(3),
  retainShown: z.boolean(),
  excludedTerms: z.array(z.string().trim().min(3).max(40)).max(8),
  suggestions: z.array(z.string().trim().min(1).max(100)).min(2).max(3),
  discussion: z.array(z.string().trim().min(1).max(180)).length(3),
  summary: z.string().trim().min(1).max(240),
}).strict();

export function validateMockFeedback(value: z.infer<typeof mockFeedbackOutput>) {
  return { ...value, discussion: value.discussion.map((line) => line.replace(/^(scout|muse|dot)\s*:\s*/i, "")), productIndices: [...new Set(value.productIndices)], suggestions: [...new Set(value.suggestions)] };
}

// Titles are authoritative snapshot data. Do not display a candidate whose title
// contains a plainly stated excluded term, even if the model selected it.
export function filterExcludedProducts(indices: number[], excludedTerms: string[], titles: string[]) {
  return indices.filter((index) => {
    const title = titles[index]?.toLocaleLowerCase() ?? "";
    return title && !excludedTerms.some((term) => title.includes(term.trim().toLocaleLowerCase()));
  });
}

// If a suggestion refers to a term from the catalog, it must also occur in
// the displayed titles. General feedback that names no product is still valid.
export function filterGroundedSuggestions(suggestions: string[], indices: number[], titles: string[]) {
  const words = new Set(titles.flatMap((title) => title.toLocaleLowerCase().match(/[a-z]{4,}/g) ?? []));
  const shown = indices.map((index) => titles[index] ?? "").join(" ").toLocaleLowerCase();
  return suggestions.filter((suggestion) => {
    const lower = suggestion.toLocaleLowerCase();
    return [...words].every((word) => !lower.includes(word) || shown.includes(word));
  });
}
