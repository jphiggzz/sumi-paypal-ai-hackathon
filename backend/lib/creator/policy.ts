import { z } from "zod";
import { creators } from "./catalog";
import type { Installment, PaymentStructure } from "./installments";
export class CreatorValidationError extends Error {}
export const briefSchema = z.object({
  brand: z.string().max(100).nullable(),
  goal: z.string().max(500).nullable(),
  audience: z
    .enum(["developers", "students", "businesses", "consumers", "other"])
    .nullable(),
  audienceDetail: z.string().max(300).nullable(),
  topics: z.array(z.string().max(80)).max(8),
  exclusions: z.array(z.string().max(150)).max(8),
  budgetCents: z.number().int().min(0).max(10000000).nullable(),
  deadline: z.string().max(100).nullable(),
});
export const answerSchema = z.object({
  brief: briefSchema,
  reply: z.string().min(1).max(1500),
  options: z.array(z.string().min(1).max(100)).max(3),
  next: z.enum(["clarify", "compare", "explain"]),
  sources: z
    .array(
      z.object({
        field: z.enum(["brand", "audience", "goal", "budgetCents", "deadline"]),
        messageIndex: z.number().int().nonnegative(),
        quote: z.string().min(1).max(500),
      }),
    )
    .max(5),
  candidates: z
    .array(
      z.object({
        id: z.string(),
        reason: z.string().max(500),
        evidenceIndexes: z.array(z.number().int().min(0).max(1)).min(1).max(2),
      }),
    )
    .max(20),
});
export type Brief = z.infer<typeof briefSchema>;
export type Answer = z.infer<typeof answerSchema>;
export const emptyBrief: Brief = {
  brand: null,
  goal: null,
  audience: null,
  audienceDetail: null,
  topics: [],
  exclusions: [],
  budgetCents: null,
  deadline: null,
};
export type Deal = {
  id: string;
  creatorId: string;
  revision: number;
  stage: "negotiating" | "agreed" | "delivering" | "complete";
  totalCents: number;
  milestoneCents: number;
  deliverable: string;
  rightsDays: number;
  requestedRightsDays?: number;
  counteroffer?: string;
  delivery: string;
  digest: string;
  approved: boolean;
  payment: "none" | "pending" | "confirmed" | "review";
  paymentLease?: number;
  paymentAttempt?: string;
  batchId?: string;
  itemId?: string;
  paymentStructure?: PaymentStructure;
  installments?: (Installment & {
    payment: "none" | "pending" | "confirmed" | "review";
    paymentLease?: number;
    paymentAttempt?: string;
    batchId?: string;
    itemId?: string;
  })[];
};
export type Campaign = {
  outreach?: {
    revision: number;
    creatorIds: string[];
    message: string;
    status: "draft" | "sent" | "responded";
    responses?: { creatorId: string; status: "email" | "connected" | "none"; reply?: string }[];
  };
  setup?: {
    awaitingWebsite?: boolean;
    websiteOffered?: boolean;
    audienceSuggestions?: string[];
    website?: { url: string; title: string; excerpt: string; iconUrl?: string; iconUrls?: string[]; readable?: boolean };
  };
  facts?: { field: string; value: string | number | null; quote: string; origin?: "user" | "website"; url?: string }[];
  revision: number;
  brief: Brief;
  candidates: Answer["candidates"];
  previous: Answer["candidates"];
  deals: Deal[];
  lastReplyId?: string;
  lastAction?: Answer["next"];
};
export const initialCampaign = (): Campaign => ({
  revision: 0,
  brief: emptyBrief,
  candidates: [],
  previous: [],
  deals: [],
});

export function withoutWebsiteEvidence(
  state: Campaign,
  messages: { role: string; content: string }[],
): Campaign {
  const websiteFields = new Set(
    (state.facts || []).filter((fact) => fact.origin === "website").map((fact) => fact.field),
  );
  const userMessages = messages.filter((message) => message.role === "user");
  const userSaid = (value: string) => userMessages.some((message) =>
    message.content.toLowerCase().includes(value.toLowerCase()),
  );
  return {
    ...state,
    brief: {
      ...state.brief,
      brand: websiteFields.has("brand") ? null : state.brief.brand,
      audience: websiteFields.has("audience") ? null : state.brief.audience,
      audienceDetail: state.brief.audienceDetail && userSaid(state.brief.audienceDetail)
        ? state.brief.audienceDetail : null,
      topics: state.brief.topics.filter(userSaid),
      goal: state.brief.goal && userSaid(state.brief.goal) ? state.brief.goal : null,
    },
    facts: state.facts?.filter((fact) => fact.origin !== "website"),
  };
}

export function shortlistExclusion(state: Campaign, message: string, allowEmpty = false): Answer | null {
  const match = message.trim().match(
    /^(?:please\s+)?(?:exclude|remove|drop)\s+(.+?)(?:\s+from (?:the|my) shortlist)?(?:\s+and (?:find|show me) another creator)?[.!]?$/i,
  );
  const excluded = creators.find(
    (creator) => creator.name.toLowerCase() === match?.[1].toLowerCase(),
  );
  if (!excluded || !state.brief.brand || !state.brief.audience) return null;
  const candidates = state.candidates.filter((candidate) => candidate.id !== excluded.id);
  // If nothing remains, let the discovery workflow look for alternatives.
  if (!candidates.length && !allowEmpty) return null;
  const exclusions = state.brief.exclusions.some(
    (entry) => entry.toLowerCase().includes(excluded.name.toLowerCase()),
  )
    ? state.brief.exclusions
    : [...state.brief.exclusions, excluded.name];
  if (exclusions.length > 8) return null;
  const names = candidates.map(
    (candidate) => creators.find((creator) => creator.id === candidate.id)?.name,
  );
  if (names.some((name) => !name)) return null;
  return {
    brief: { ...state.brief, exclusions },
    reply: `Removed ${excluded.name}. ${names.length} ${names.length === 1 ? "creator remains" : "creators remain"} on the shortlist.`,
    next: "compare",
    options: [],
    sources: [],
    candidates,
  };
}
export function validateAnswer(
  answer: Answer,
  catalog: readonly {
    id: string;
    audience: string;
    cents: number;
    evidence: readonly string[];
  }[] = creators,
): Answer {
  const seen = new Set<string>();
  for (const candidate of answer.candidates) {
    const profile = catalog.find((c) => c.id === candidate.id);
    if (!profile || seen.has(candidate.id))
      throw new CreatorValidationError("Invalid creator reference");
    if (!answer.brief.audience || profile.audience !== answer.brief.audience)
      throw new CreatorValidationError("Creator audience mismatch");
    if (
      answer.brief.budgetCents !== null &&
      profile.cents > answer.brief.budgetCents
    )
      throw new CreatorValidationError("Creator exceeds budget");
    for (const index of candidate.evidenceIndexes)
      if (!profile.evidence[index])
        throw new CreatorValidationError("Invalid evidence reference");
    seen.add(candidate.id);
  }
  if (
    answer.next === "compare" &&
    (!answer.brief.brand || !answer.brief.audience)
  )
    throw new CreatorValidationError("Clarify brand and audience first");
  return answer;
}
export function applyAnswer(
  current: Campaign,
  answer: Answer,
  replyId: string,
): Campaign {
  validateAnswer(answer);
  const changed =
    JSON.stringify(briefSchema.parse(current.brief)) !==
    JSON.stringify(briefSchema.parse(answer.brief));
  return {
    ...current,
    revision: current.revision + 1,
    brief: answer.brief,
    previous:
      answer.next === "compare" || changed
        ? current.candidates
        : current.previous,
    candidates:
      answer.next === "compare"
        ? answer.candidates
        : changed
          ? []
          : current.candidates,
    // Committed agreements and receipts are immutable; unapproved drafts are retired on a brief change.
    deals: changed
      ? current.deals.filter((d) => d.approved || d.payment !== "none")
      : current.deals.map((d) =>
          d.approved ? d : { ...d, revision: current.revision + 1 },
        ),
    facts: [
      ...new Map(
        [
          ...(current.facts || []).filter(
            (f) =>
              !answer.sources.some((s) => s.field === f.field) &&
              f.value ===
                answer.brief[
                  f.field as "brand" | "audience" | "budgetCents" | "deadline"
                ],
          ),
          ...answer.sources.map((s) => ({
            field: s.field,
            value: answer.brief[s.field],
            quote: s.quote,
            ...("origin" in s ? { origin: (s as typeof s & { origin: "user" | "website" }).origin } : {}),
            ...("url" in s ? { url: (s as typeof s & { url: string }).url } : {}),
          })),
        ].map((f) => [f.field, f]),
      ).values(),
    ],
    lastReplyId: replyId,
    lastAction: answer.next,
  };
}
export function validateCommit(c: Campaign, d: Deal) {
  if (d.approved) return;
  if (c.brief.budgetCents === null)
    throw new CreatorValidationError(
      "Set a campaign budget before approving an agreement.",
    );
  const committed = c.deals
    .filter((x) => x.approved)
    .reduce((sum, x) => sum + x.totalCents, 0);
  if (committed + d.totalCents > c.brief.budgetCents)
    throw new CreatorValidationError(
      "Agreement exceeds the remaining campaign budget.",
    );
  if (d.revision !== c.revision)
    throw new CreatorValidationError(
      "Campaign changed. Prepare a new agreement.",
    );
}

// Approve exactly the terms reviewed, atomically. This never initiates payment.
export function approveDeals(c: Campaign, reviewed: { dealId: string; digest: string }[]): Campaign {
  if (!reviewed.length || new Set(reviewed.map((item) => item.dealId)).size !== reviewed.length)
    throw new CreatorValidationError("Review the current deals again.");
  const deals = reviewed.map((item) => c.deals.find((deal) => deal.id === item.dealId && deal.digest === item.digest));
  if (deals.some((deal) => !deal)) throw new CreatorValidationError("A deal changed. Review the current terms again.");
  if (deals.every((deal) => deal!.approved)) return c;
  const pending = c.deals.filter((deal) => !deal.approved && deal.revision === c.revision);
  if (deals.some((deal) => deal!.approved) || pending.length !== reviewed.length || pending.some((deal) => !reviewed.some((item) => item.dealId === deal.id)))
    throw new CreatorValidationError("Deals changed. Review the current terms again.");
  const next = structuredClone(c);
  for (const item of reviewed) {
    const deal = next.deals.find((entry) => entry.id === item.dealId)!;
    validateCommit(next, deal);
    deal.approved = true;
    deal.stage = "agreed";
  }
  return next;
}

function canCite(
  message: { role: string; content: string },
  current: Campaign,
  field: string,
) {
  return message.role === "user" || (
    message.role === "website" &&
    (field === "brand" || field === "audience") &&
    !!current.setup?.website &&
    message.content === `${current.setup.website.title}\n${current.setup.website.excerpt}`
  );
}

export function validateSources(
  answer: Answer,
  current: Campaign,
  messages: { role: string; content: string }[],
) {
  answer = { ...answer, sources: [...answer.sources] };
  // Repair a misquoted brand or date only when the actual value occurs in an allowed source.
  for (const field of ["brand", "deadline"] as const) {
    const value = answer.brief[field];
    if (!value || value === current.brief[field]) continue;
    const matching = answer.sources.filter(
      (s) =>
        s.field === field &&
        messages.some(
          (m) =>
            canCite(m, current, field) &&
            m.content.toLowerCase().includes(s.quote.toLowerCase()),
        ),
    );
    if (matching.length) {
      answer.sources = answer.sources.filter(
        (s) => s.field !== field || matching.includes(s),
      );
      continue;
    }
    const messageIndex = messages.findLastIndex(
      (m) =>
        canCite(m, current, field) &&
        m.content.toLowerCase().includes(value.toLowerCase()),
    );
    if (messageIndex >= 0)
      answer.sources = [
        ...answer.sources.filter((s) => s.field !== field),
        { field, messageIndex, quote: value },
      ];
  }
  // Models can miscount transcript indexes. Resolve a verbatim source quote
  // against the actual transcript; never substitute assistant text or fuzzy matches.
  answer = {
    ...answer,
    sources: answer.sources
      .filter(
        (source) =>
          answer.brief[source.field] !== null &&
          answer.brief[source.field] !== current.brief[source.field],
      )
      .map((source) => {
        const matches = (message: { role: string; content: string }) =>
          canCite(message, current, source.field) &&
          message.content.toLowerCase().includes(source.quote.toLowerCase());
        if (
          messages[source.messageIndex] &&
          matches(messages[source.messageIndex])
        )
          return source;
        const index = messages.findLastIndex(matches);
        return index < 0 ? source : { ...source, messageIndex: index };
      }),
  };
  for (const source of answer.sources) {
    const message = messages[source.messageIndex];
    if (
      !message ||
      !canCite(message, current, source.field) ||
      !message.content.toLowerCase().includes(source.quote.toLowerCase())
    )
      throw new CreatorValidationError("Invalid brief source");
  }
  for (const field of [
    "brand",
    "audience",
    "goal",
    "budgetCents",
    "deadline",
  ] as const) {
    if (
      answer.brief[field] !== null &&
      answer.brief[field] !== current.brief[field] &&
      !answer.sources.some((s) => s.field === field)
    )
      throw new CreatorValidationError(
        "Changed brief field needs user evidence",
      );
  }
  const amount = answer.sources.find((s) => s.field === "budgetCents");
  if (amount && answer.brief.budgetCents !== null) {
    const numbers = [
      ...amount.quote
        .replaceAll(",", "")
        .matchAll(/(\d+(?:\.\d+)?)\s*(k|thousand)?/gi),
    ].map((m) => Math.round(Number(m[1]) * (m[2] ? 1000 : 1) * 100));
    if (!numbers.includes(answer.brief.budgetCents))
      throw new CreatorValidationError("Budget does not match user evidence");
  }
  answer.sources = answer.sources.map((source) => {
    const website = messages[source.messageIndex]?.role === "website";
    return {
      ...source,
      origin: website ? "website" : "user",
      ...(website && current.setup?.website ? { url: current.setup.website.url } : {}),
    };
  });
  return answer;
}

// A brand name alone is not evidence that the user chose an audience.
export function groundAudience(
  answer: Answer,
  current: Campaign,
  messages: { role: string; content: string }[] = [],
): Answer {
  const audience = answer.brief.audience;
  if (!audience || audience === current.brief.audience || audience === "other")
    return answer;
  const valid = answer.sources.filter(
    (s) =>
      s.field === "audience" &&
      (!messages.length ||
        messages.some(
          (m) =>
            canCite(m, current, "audience") &&
            m.content.toLowerCase().includes(s.quote.toLowerCase()),
        )),
  );
  let quote = valid.map((s) => s.quote).join(" ");
  if (messages.length)
    answer = {
      ...answer,
      sources: [
        ...answer.sources.filter((s) => s.field !== "audience"),
        ...valid,
      ],
    };
  const audiencePattern = {
    developers:
      /develop|engineer|programmer|coder|frontend|front.end|backend|back.end|app builders|API builders|\bReact\b|component library|\bAPI\b|\bSDKs?\b|programming|coding|web apps?|software/i,
    students: /student|college|university|school|learner|pupil/i,
    businesses:
      /business|merchant|seller|retailer|shop owner|store owner|entrepreneur/i,
    consumers: /consumer|shopper|buyer|everyday people|individuals|families/i,
  }[audience];
  if (!quote) {
    let index = messages.findLastIndex(
      (m) => canCite(m, current, "audience") && audiencePattern.test(m.content),
    );
    const websiteStudentPattern = /\b(?:stud(?:y|ying)|learn(?:ing)?|quiz(?:zes)?|lectures?)\b/i;
    if (index < 0 && audience === "students") {
      index = messages.findLastIndex((m) =>
        m.role === "website" && canCite(m, current, "audience") && websiteStudentPattern.test(m.content),
      );
    }
    if (index >= 0) {
      quote = messages[index].content.match(audiencePattern)?.[0] ||
        messages[index].content.match(websiteStudentPattern)?.[0] || "";
      answer = {
        ...answer,
        sources: [
          ...answer.sources,
          { field: "audience", messageIndex: index, quote },
        ],
      };
    }
  }
  const siteSupportsStudents = audience === "students" && valid.some((source) =>
    messages.some((message) => message.role === "website" &&
      canCite(message, current, "audience") &&
      message.content.toLowerCase().includes(source.quote.toLowerCase()) &&
      /\b(?:stud(?:y|ying)|learn(?:ing)?|quiz(?:zes)?|lectures?)\b/i.test(source.quote)),
  );
  const inferredFromSite = audience === "students" && messages.some((message) =>
    message.role === "website" && canCite(message, current, "audience") &&
    message.content.toLowerCase().includes(quote.toLowerCase()) &&
    /\b(?:stud(?:y|ying)|learn(?:ing)?|quiz(?:zes)?|lectures?)\b/i.test(quote),
  );
  if (audiencePattern.test(quote) || siteSupportsStudents || inferredFromSite) return answer;
  return {
    ...answer,
    brief: { ...answer.brief, audience: null, audienceDetail: null },
    sources: answer.sources.filter((s) => s.field !== "audience"),
    next: "clarify",
    reply: "Who should this campaign reach?",
    options: [
      audience.charAt(0).toUpperCase() + audience.slice(1),
      ...(audience === "developers"
        ? ["Businesses", "Consumers"]
        : ["Developers"]),
    ],
    candidates: [],
  };
}

export function confirmHistoricalBudget(
  answer: Answer,
  current: Campaign,
  messages: { role: string; content: string }[],
): Answer {
  if (
    answer.brief.budgetCents === null ||
    answer.brief.budgetCents === current.brief.budgetCents
  )
    return answer;
  const latest = messages.findLast((m) => m.role === "user")?.content || "";
  const historical =
    /\b(last (year|month|time)|previous|prior|historical|used to|we paid)\b/i.test(
      latest,
    );
  const currentInstruction =
    /\b(?:budget|spend|allocate)\s+(?:is\s+|of\s+|up to\s+)?\$?\d/i.test(
      latest,
    ) || /^(?:yes[, ]+)?(?:use|reuse|repeat)\b[^?]*$/i.test(latest.trim());
  if (!historical || currentInstruction) return answer;
  const amount = new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
    maximumFractionDigits: 2,
  }).format(answer.brief.budgetCents / 100);
  return {
    ...answer,
    brief: { ...answer.brief, budgetCents: current.brief.budgetCents },
    sources: answer.sources.filter((s) => s.field !== "budgetCents"),
    next: "clarify",
    reply: `Use ${amount} as this campaign’s total budget?`,
    options: [`Use ${amount}`, "Choose another budget"],
    candidates: [],
  };
}

export function disclosePaidCatalog(
  answer: Answer,
  messages: { role: string; content: string }[],
): Answer {
  const latest = messages.findLast((m) => m.role === "user")?.content || "";
  const rejectsPaid =
    /\b(no|without|avoid)\s+(paid|sponsored)|\b(only|keep it)\s+organic\b/i;
  if (/paid.*(?:okay|acceptable|fine)/i.test(latest))
    return {
      ...answer,
      brief: {
        ...answer.brief,
        exclusions: answer.brief.exclusions.filter((e) => !rejectsPaid.test(e)),
      },
    };
  if (
    !rejectsPaid.test(latest) &&
    !answer.brief.exclusions.some((e) => rejectsPaid.test(e))
  )
    return answer;
  const brief = {
    ...answer.brief,
    exclusions: [
      ...new Set([...answer.brief.exclusions, "No paid collaborations"]),
    ].slice(0, 8),
  };
  if (/keep it organic/i.test(latest))
    return {
      ...answer,
      brief,
      next: "compare",
      candidates: [],
      reply:
        "No matching sample creators: this catalog contains paid collaborations.",
      options: [],
    };
  return {
    ...answer,
    brief,
    next: "clarify",
    candidates: [],
    reply:
      "This sample catalog contains paid collaborations. Is paid educational content an option?",
    options: ["Paid tutorials are okay", "Keep it organic"],
  };
}

export function suggestBudget(
  answer: Answer,
  current: Campaign,
  messages: { role: string; content: string }[],
): Answer {
  const latest = messages.findLast((m) => m.role === "user")?.content || "";
  if (
    !/budget/i.test(latest) ||
    !/no idea|not sure|suggest|recommend|help.*set|how much/i.test(latest)
  )
    return answer;
  const prices = [
    ...new Set(
      creators
        .filter(
          (c) => !answer.brief.audience || c.audience === answer.brief.audience,
        )
        .map((c) => c.cents),
    ),
  ].sort((a, b) => a - b);
  if (!prices.length)
    return {
      ...answer,
      brief: { ...answer.brief, budgetCents: current.brief.budgetCents },
      sources: answer.sources.filter((s) => s.field !== "budgetCents"),
      next: "clarify",
      candidates: [],
      reply:
        "There are no sample quotes for this audience. What total would you like to explore?",
      options: [],
    };
  const amounts = [
    ...new Set([
      prices[0],
      prices[Math.floor(prices.length / 2)],
      prices.at(-1)!,
    ]),
  ];
  return {
    ...answer,
    brief: { ...answer.brief, budgetCents: current.brief.budgetCents },
    sources: answer.sources.filter((s) => s.field !== "budgetCents"),
    next: "clarify",
    candidates: [],
    reply: "Which total should we explore?",
    options: amounts.map((c) =>
      new Intl.NumberFormat("en-US", {
        style: "currency",
        currency: "USD",
        maximumFractionDigits: 0,
      }).format(c / 100),
    ),
  };
}

export function existingExplanation(
  state: Campaign,
  text: string,
): Answer | null {
  if (
    !state.candidates.length ||
    !/^(?:why\b|what makes\b|how did you (?:choose|pick)\b)/i.test(
      text.trim(),
    ) ||
    /\b(?:instead|exclude|different|change|find|add|not)\b/i.test(text)
  )
    return null;
  return answerSchema.parse({
    brief: state.brief,
    reply: state.candidates
      .map(
        (c) =>
          `${creators.find((p) => p.id === c.id)?.name || c.id}: ${c.reason}`,
      )
      .join("\n\n"),
    options: [],
    next: "explain",
    sources: [],
    candidates: [],
  });
}
