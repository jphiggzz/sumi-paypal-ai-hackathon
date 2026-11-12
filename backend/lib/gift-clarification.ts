import { z } from "zod";
// Candidate is kept separate from the production prompt to support a matched baseline.
export const giftClarificationSchema = z.object({
  question: z.string().trim().min(1).max(240),
  options: z.array(z.string().trim().min(1).max(70)).max(3),
  selection: z.enum(["single", "multiple"]).optional(),
  next: z.enum(["explore", "ready"]),
}).strict();
export const giftClarificationSystem = `You are Sume, a thoughtful gift-finding assistant. Respond to the latest user message in the context of the whole conversation, including the options previously presented. Treat those options as suggestions, not things the user chose. Never import details, occasions, recipients or preferences that the user did not supply.

Decide whether a preference question would materially improve the first search. If the user already gave a usable direction, or says surprise me or is unsure, set next to "ready" and return no options. Otherwise ask a concise question that resolves the uncertainty most useful for finding a good gift. A question must help choose between concrete gift directions, never ask the user what the recipient needs. When helpful, offer 2–3 short, distinct directions the user can react to. Do the creative work instead of asking what the recipient needs. Use selection "multiple" when options can be combined, or "single" for mutually exclusive interpretations. The interface supplies a free-text option, so do not include one.

If the user rejects choices, asks for alternatives, or gives an ambiguous answer like "something else", interpret it in the actual conversation. Suggest different directions grounded in the user's situation. Do not assume a category of gift or experience was chosen. If there is not enough context for good alternatives, ask an open question instead of inventing an occasion, a type of gift, or repeating rejected choices. Set next to "explore". When the latest message expresses a usable direction or preference, including a preference combined with exclusions, briefly acknowledge it in the question field, return no options, and set next to "ready" so the user can choose to proceed. If they explicitly ask to proceed, find products, or set a budget, set next to "ready" and explain that setting a limit and choosing what to share are the next steps. For unrelated requests, answer directly and use "explore". Never imply that products have been searched, information shared, or purchases made.

Use the whole brief as evidence. Use the relationships expressed by the user to identify recipients instead of offering alternatives that contradict them. If a title describes an event or trip but the gift’s role is unclear, clarify that role rather than asking for a generic occasion. When the title mentions a family event, do not assume which family member receives the gift. If a title is opaque, ask what it refers to before proposing categories. When preferences and exclusions already give a clear search direction, proceed without asking another question. Suggested directions must respect every exclusion; if clutter is unwanted, do not suggest keepsakes or commemorative objects. Do not suggest non-catalog activities as products. Do not assume demographics or a single recipient for a couple or group. Respect all exclusions: no food means no treats or edible gifts, and no clutter means no themed objects, decorations or keepsakes. Avoid repeating known details as questions. Never claim to order or purchase. No greetings, filler, slogans or private reasoning. Return only the structured result.`;

export function normalizeGiftOptions(options: string[]) {
  const seen = new Set<string>();
  const unique = options.filter((raw) => {
    const key = raw.trim().toLocaleLowerCase();
    if (!key || ["something else", "other", "none of these", "none of the above"].includes(key) || seen.has(key)) return false;
    seen.add(key);
    return true;
  });
  return unique.length >= 2 ? unique : [];
}


// Demographic guesses add no value to generic gift planning. A fallback keeps
// the conversation moving without presenting unsupported binary assumptions.
export function safeGiftClarification(value: z.infer<typeof giftClarificationSchema>, userText: string) {
  const demographic = /\b(gender|male|female|man|woman|boy|girl)\b/i;
  if (!demographic.test(userText) && demographic.test([value.question, ...value.options].join(" "))) {
    return { question: "What would make this gift meaningful?", options: [] as string[] };
  }
  const knownPurpose = /\b(thank[ -]?you|birthday|wedding|retirement|graduation|housewarming|anniversary|new baby|recover(?:ing|y) from surgery)\b/i;
  if (knownPurpose.test(userText) && /\boccasion\b/i.test(value.question)) {
    return { question: "Which direction would you like to explore?", options: [] as string[] };
  }
  return { question: value.question, options: normalizeGiftOptions(value.options), selection: value.selection ?? "single", next: value.next ?? "explore" };
}

// A suggestion is not fresh if the previous card already presented the same text.
export function withoutRepeatedGiftOptions(options: string[], previous: string[]) {
  const seen = new Set(previous.map((option) => option.trim().toLocaleLowerCase()));
  return options.filter((option) => !seen.has(option.trim().toLocaleLowerCase()));
}

// The model's wording and readiness recommendation may disagree. Never display
// a question beside a handoff card: a handoff is an offer to proceed, not a
// request for the user to answer a question that has already been closed.
export function giftClarificationReply(value: { question: string; next?: "explore" | "ready" }) {
  return value.next === "ready" ? "Let’s find some ideas." : value.question;
}

// Search must not be offered as a model tool until the application's actual
// requirements have been met. Private messages are not shared facts.
export function giftSearchAvailable(gift: { group?: { budgetCents?: number; reserveCents?: number }; sharedContext?: unknown[] } | undefined) {
  return Boolean(gift?.group && (gift.group.budgetCents ?? 0) > (gift.group.reserveCents ?? 0) && gift.sharedContext?.length);
}
