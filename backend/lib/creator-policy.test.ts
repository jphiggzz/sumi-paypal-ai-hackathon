import test from "node:test";
import assert from "node:assert/strict";
import {
  applyAnswer,
  initialCampaign,
  shortlistExclusion,
  validateSources,
  groundAudience,
  withoutWebsiteEvidence,
  answerSchema,
  validateAnswer,
  validateCommit,
  emptyBrief,
  type Answer,
  type Deal,
} from "./creator/policy";
import { creators } from "./creator/catalog";

test("a sample discovery can retain twenty grounded creators", () => {
  const available = creators.filter((creator) => creator.audience === "students");
  assert.ok(available.length > 20);
  const profiles = available.slice(0, 20);
  const candidates = profiles.map((creator) => ({
    id: creator.id, reason: "Relevant study content", evidenceIndexes: [0],
  }));
  const answer: Answer = {
    brief: { ...emptyBrief, brand: "ChatEDU", audience: "students" },
    reply: "Here are the creators.", options: [], next: "compare", sources: [], candidates,
  };
  assert.equal(validateAnswer(answerSchema.parse(answer)).candidates.length, 20);
  assert.equal(answerSchema.safeParse({ ...answer, candidates: [...candidates, candidates[0]] }).success, false);
});

test("website evidence can ground a proposed audience but cannot authorize a budget", () => {
  const website = { url: "https://example.com/", title: "Example Study", excerpt: "Turn notes into study guides. Plans cost $500." };
  const state = { ...initialCampaign(), setup: { websiteOffered: true, website } };
  const messages = [
    { role: "user", content: "Help me plan a campaign." },
    { role: "website", content: `${website.title}\n${website.excerpt}` },
  ];
  const proposal: Answer = {
    brief: { ...emptyBrief, brand: "Example Study", audience: "students" },
    reply: "Here is a direction.",
    options: [], next: "compare", candidates: [],
    sources: [
      { field: "brand", messageIndex: 1, quote: "Example Study" },
      { field: "audience", messageIndex: 1, quote: "study guides" },
    ],
  };
  const grounded = validateSources(groundAudience(proposal, state, messages), state, messages);
  assert.equal(grounded.brief.audience, "students");
  const next = applyAnswer(state, grounded, "reply");
  assert.equal(next.facts?.find((fact) => fact.field === "audience")?.origin, "website");
  assert.equal(next.facts?.find((fact) => fact.field === "audience")?.url, website.url);
  assert.throws(() => validateSources({
    ...grounded,
    brief: { ...grounded.brief, budgetCents: 50000 },
    sources: [...grounded.sources, { field: "budgetCents", messageIndex: 1, quote: "$500" }],
  }, state, messages));
  assert.throws(() => validateSources(proposal, { ...state, setup: undefined }, messages));
});

test("removing a website clears its inferred facts while keeping user context", () => {
  const website = { url: "https://example.com/", title: "Example", excerpt: "Study guides." };
  const state = {
    ...initialCampaign(),
    brief: { ...emptyBrief, brand: "Example", audience: "students" as const, audienceDetail: "students using study guides", topics: ["study guides", "college"], goal: "Help Example reach college students" },
    setup: { websiteOffered: true, website },
    facts: [
      { field: "brand", value: "Example", quote: "Example", origin: "user" as const },
      { field: "audience", value: "students", quote: "Study guides", origin: "website" as const, url: website.url },
    ],
  };
  const next = withoutWebsiteEvidence(state, [{ role: "user", content: "Help Example reach college students" }]);
  assert.equal(next.brief.brand, "Example");
  assert.equal(next.brief.audience, null);
  assert.equal(next.brief.audienceDetail, null);
  assert.deepEqual(next.brief.topics, ["college"]);
  assert.equal(next.brief.goal, "Help Example reach college students");
  assert.deepEqual(next.facts?.map((fact) => fact.field), ["brand"]);
});

test("a named exclusion keeps other reviewed creators and the saved brief", () => {
  const state = {
    ...initialCampaign(),
    brief: { ...emptyBrief, brand: "ChatEDU", audience: "students" as const },
    candidates: [
      { id: "student-educator", reason: "Study workflow", evidenceIndexes: [0] },
      { id: "student-community", reason: "Exam preparation", evidenceIndexes: [0] },
    ],
  };
  for (const message of [
    "Exclude Maya Chen and find another creator.",
    "Please remove Maya Chen from the shortlist.",
    "DROP MAYA CHEN.",
  ]) {
    const result = shortlistExclusion(state, message);
    assert.deepEqual(result?.brief, { ...state.brief, exclusions: ["Maya Chen"] });
    assert.deepEqual(result?.candidates, state.candidates.slice(1));
  }
  assert.equal(shortlistExclusion(state, "Exclude Maya Chen and switch to YouTube."), null);
  assert.deepEqual(shortlistExclusion({ ...state, candidates: state.candidates.slice(0, 1) }, "Exclude Maya Chen and find another creator.", true)?.candidates, []);
  assert.equal(
    shortlistExclusion({ ...state, candidates: state.candidates.slice(0, 1) }, "Exclude Maya Chen."),
    null,
  );
});
const answer: Answer = {
  brief: {
    ...emptyBrief,
    brand: "Sample",
    audience: "developers",
    budgetCents: 200000,
  },
  reply: "Here are options.",
  options: [],
  sources: [],
  next: "compare",
  candidates: [
    {
      id: "api-educator",
      reason: "API tutorial evidence",
      evidenceIndexes: [0],
    },
  ],
};
const deal: Deal = {
  id: "one",
  creatorId: "api-educator",
  revision: 1,
  stage: "negotiating",
  totalCents: 120000,
  milestoneCents: 12000,
  deliverable: "One tutorial",
  rightsDays: 30,
  delivery: "Friday",
  digest: "a",
  approved: false,
  payment: "none",
};
test("creator results reject invented IDs, audiences, duplicate candidates and unaffordable quotes", () => {
  assert.throws(() =>
    validateAnswer({
      ...answer,
      candidates: [{ ...answer.candidates[0], id: "invented" }],
    }),
  );
  assert.throws(() =>
    validateAnswer({
      ...answer,
      brief: { ...answer.brief, audience: "students" },
    }),
  );
  assert.throws(() =>
    validateAnswer({
      ...answer,
      candidates: [answer.candidates[0], answer.candidates[0]],
    }),
  );
  assert.throws(() =>
    validateAnswer({
      ...answer,
      brief: { ...answer.brief, budgetCents: 10000 },
    }),
  );
  assert.doesNotThrow(() =>
    validateAnswer({
      ...answer,
      brief: { ...answer.brief, budgetCents: null },
    }),
  );
});
test("exploration needs brand and audience; commitments need available budget and current revision", () => {
  assert.throws(() =>
    validateAnswer({ ...answer, brief: { ...answer.brief, brand: null } }),
  );
  const c = applyAnswer(initialCampaign(), answer, "first");
  assert.doesNotThrow(() => validateCommit(c, deal));
  assert.throws(() =>
    validateCommit({ ...c, brief: { ...c.brief, budgetCents: null } }, deal),
  );
  assert.throws(() =>
    validateCommit(
      { ...c, deals: [{ ...deal, id: "prior", approved: true }] },
      deal,
    ),
  );
  assert.throws(() => validateCommit({ ...c, revision: 2 }, deal));
});
test("revisions retire unapproved drafts but retain commitments and receipts", () => {
  const c = applyAnswer(initialCampaign(), answer, "one");
  c.deals = [
    deal,
    {
      ...deal,
      id: "paid",
      approved: true,
      payment: "confirmed",
      itemId: "receipt",
    },
  ];
  const next = applyAnswer(
    c,
    {
      ...answer,
      brief: { ...answer.brief, budgetCents: 10000 },
      candidates: [],
    },
    "two",
  );
  assert.equal(next.deals.length, 1);
  assert.equal(next.deals[0].itemId, "receipt");
  assert.equal(next.previous[0].id, "api-educator");
  const explained = applyAnswer(
    c,
    { ...answer, next: "explain", candidates: [] },
    "three",
  );
  assert.equal(explained.candidates.length, 1);
  assert.equal(explained.deals[0].revision, explained.revision);
});

test("changed facts require literal user evidence; assistant suggestions do not authorize a budget", async () => {
  const { validateSources } = await import("./creator/policy");
  const current = initialCampaign();
  const a = {
    ...answer,
    sources: [
      { field: "brand" as const, messageIndex: 0, quote: "Sample" },
      { field: "audience" as const, messageIndex: 0, quote: "developers" },
      { field: "budgetCents" as const, messageIndex: 0, quote: "$2,000" },
    ],
  };
  assert.doesNotThrow(() =>
    validateSources(a, current, [
      { role: "user", content: "Sample for developers, budget $2,000" },
    ]),
  );
  assert.throws(() =>
    validateSources(a, current, [
      { role: "assistant", content: "Sample for developers, budget $2,000" },
    ]),
  );
  assert.throws(() =>
    validateSources(
      { ...a, brief: { ...a.brief, budgetCents: 300000 } },
      current,
      [{ role: "user", content: "Sample for developers, budget $2,000" }],
    ),
  );
});

test("uncertain payout retry reuses identity; a saved batch is checked rather than resubmitted", async () => {
  const { reconcileCreatorPayout, payoutKey } =
    await import("./creator/payments");
  const calls: string[] = [];
  let unknown = true;
  const transport = {
    submit: async (_offer: unknown, key: string) => {
      calls.push(key);
      if (unknown) {
        unknown = false;
        throw Error("timeout after provider accepted");
      }
      return "original-batch";
    },
    status: async () => ({ status: "SUCCESS", itemId: "verified-item" }),
  };
  const pending = await reconcileCreatorPayout(deal, transport);
  assert.equal(pending.payment, "review");
  const recovered = await reconcileCreatorPayout(
    { ...deal, ...pending },
    transport,
  );
  assert.equal(recovered.payment, "confirmed");
  assert.deepEqual(calls, [payoutKey(deal.id), payoutKey(deal.id)]);
  await reconcileCreatorPayout({ ...deal, ...recovered }, transport);
  assert.equal(calls.length, 2);
});
test("provider lookup failure preserves the batch reference for reconciliation", async () => {
  const { reconcileCreatorPayout } = await import("./creator/payments");
  const result = await reconcileCreatorPayout(deal, {
    submit: async () => "saved-batch",
    status: async () => {
      throw Error("unavailable");
    },
  });
  assert.equal(result.batchId, "saved-batch");
  assert.equal(result.payment, "review");
  assert.equal(result.itemId, undefined);
});

test("a late failed payment attempt cannot downgrade a confirmed receipt or a newer reservation", async () => {
  const { mergePaymentReceipt } = await import("./creator/payments");
  const target = {
    ...deal,
    payment: "pending" as const,
    paymentAttempt: "newer",
  } as Deal;
  mergePaymentReceipt(target, { payment: "review" }, "older");
  assert.equal(target.payment, "pending");
  mergePaymentReceipt(
    target,
    { payment: "confirmed", batchId: "batch", itemId: "item" },
    "older",
  );
  assert.equal(target.payment, "confirmed");
  mergePaymentReceipt(target, { payment: "review" }, "newer");
  assert.equal(target.payment, "confirmed");
  assert.equal(target.itemId, "item");
});

test("source resolution repairs transcript counting, ignores inherited citations and deduplicates facts", async () => {
  const { validateSources } = await import("./creator/policy");
  const current = initialCampaign();
  const a = {
    ...answer,
    sources: [
      { field: "brand" as const, messageIndex: 99, quote: "Sample" },
      { field: "brand" as const, messageIndex: 0, quote: "Sample" },
      { field: "audience" as const, messageIndex: 99, quote: "developers" },
      { field: "budgetCents" as const, messageIndex: 0, quote: "$2,000" },
    ],
  };
  const resolved = validateSources(a, current, [
    { role: "user", content: "Sample for developers, $2,000" },
  ]);
  assert.equal(resolved.sources[0].messageIndex, 0);
  const saved = applyAnswer(current, resolved, "one");
  assert.equal(saved.facts?.length, 3);
  const explained = validateSources(
    {
      ...answer,
      next: "explain",
      sources: [
        {
          field: "brand",
          messageIndex: 99,
          quote: "invented redundant reference",
        },
      ],
    },
    saved,
    [],
  );
  assert.equal(explained.sources.length, 0);
  assert.equal(applyAnswer(saved, explained, "two").facts?.length, 3);
  assert.throws(() =>
    validateSources(
      {
        ...a,
        sources: a.sources.map((s) =>
          s.field === "budgetCents" ? { ...s, quote: "$9,000" } : s,
        ),
      },
      current,
      [{ role: "user", content: "Sample for developers, $2,000" }],
    ),
  );
});

test("a company name cannot silently confirm a target audience", async () => {
  const { groundAudience, validateSources } = await import("./creator/policy");
  const proposed = {
    ...answer,
    brief: { ...answer.brief, brand: "AG Grid", budgetCents: null },
    sources: [
      {
        field: "audience" as const,
        messageIndex: 0,
        quote: "I work on AG Grid.",
      },
    ],
  };
  const grounded = groundAudience(proposed, initialCampaign());
  assert.equal(grounded.next, "clarify");
  assert.equal(grounded.brief.audience, null);
  assert.equal(grounded.candidates.length, 0);
  assert.equal(
    validateSources(grounded, initialCampaign(), [
      { role: "user", content: "I work on AG Grid." },
    ]).sources.find((s) => s.field === "brand")?.quote,
    "AG Grid",
  );
  const explicit = groundAudience(
    {
      ...proposed,
      sources: [
        { field: "audience", messageIndex: 0, quote: "React developers" },
      ],
    },
    initialCampaign(),
  );
  assert.equal(explicit.next, "compare");
  assert.equal(explicit.brief.audience, "developers");
});

test("historical terms require confirmation and an organic-only brief cannot receive paid samples", async () => {
  const { confirmHistoricalBudget, disclosePaidCatalog, groundAudience } =
    await import("./creator/policy");
  const current = initialCampaign();
  const historical = confirmHistoricalBudget(answer, current, [
    {
      role: "user",
      content: "Last year we paid $2,000. Should we repeat that?",
    },
  ]);
  assert.equal(historical.brief.budgetCents, null);
  assert.equal(historical.next, "clarify");
  assert.match(historical.options[0], /2,000/);
  assert.equal(
    confirmHistoricalBudget(answer, current, [
      { role: "user", content: "Use $2,000" },
    ]).brief.budgetCents,
    200000,
  );
  const organic = disclosePaidCatalog(answer, [
    { role: "user", content: "No sponsored content" },
  ]);
  assert.equal(organic.candidates.length, 0);
  assert.match(organic.reply, /catalog.*paid/);
  const kept = disclosePaidCatalog(organic, [
    { role: "user", content: "Keep it organic" },
  ]);
  assert.equal(kept.next, "compare");
  assert.equal(kept.options.length, 0);
  assert.deepEqual(
    disclosePaidCatalog(kept, [
      { role: "user", content: "Paid tutorials are okay" },
    ]).brief.exclusions,
    [],
  );
  const described = groundAudience(
    {
      ...answer,
      sources: [
        {
          field: "audience",
          messageIndex: 0,
          quote: "React tutorials for my component library",
        },
      ],
    },
    current,
  );
  assert.equal(described.brief.audience, "developers");
});

test("budget advice uses catalog prices without adopting a model-suggested amount", async () => {
  const { suggestBudget, groundAudience } = await import("./creator/policy");
  const current = initialCampaign();
  const a = suggestBudget(answer, current, [
    {
      role: "user",
      content:
        "I have no idea what budget to use. You suggest a starting point.",
    },
  ]);
  assert.equal(a.brief.budgetCents, null);
  assert.equal(a.next, "clarify");
  assert.equal(a.options.length, 3);
  assert.ok(a.options.every((o) => /^\$/.test(o)));
  const inferred = groundAudience({ ...answer, sources: [] }, current, [
    { role: "user", content: "React tutorials for my component library" },
  ]);
  assert.equal(inferred.brief.audience, "developers");
  assert.equal(inferred.sources[0].quote, "React");
});

test("paraphrased audience citations resolve only to literal user evidence", async () => {
  const { groundAudience, validateSources } = await import("./creator/policy");
  const current = initialCampaign();
  const input = {
    ...answer,
    brief: { ...answer.brief, brand: "Elastic", budgetCents: null },
    sources: [
      { field: "brand" as const, messageIndex: 0, quote: "Elastic platform" },
      {
        field: "audience" as const,
        messageIndex: 1,
        quote: "search specialists",
      },
    ],
  };
  const messages = [
    { role: "user", content: "Help more people discover Elastic." },
    { role: "assistant", content: "Who is the audience?" },
    {
      role: "user",
      content: "Search engineers building retrieval for AI applications.",
    },
  ];
  const result = validateSources(
    groundAudience(input, current, messages),
    current,
    messages,
  );
  assert.equal(result.brief.audience, "developers");
  assert.ok(
    result.sources.every(
      (s) =>
        messages[s.messageIndex].role === "user" &&
        messages[s.messageIndex].content
          .toLowerCase()
          .includes(s.quote.toLowerCase()),
    ),
  );
  assert.equal(
    result.sources.find((s) => s.field === "brand")?.quote,
    "Elastic",
  );
});

test("a database-reordered brief does not invalidate a shortlist on explanation", () => {
  const c = applyAnswer(initialCampaign(), answer, "one");
  c.brief = Object.fromEntries(
    Object.entries(c.brief).sort(([a], [b]) => a.localeCompare(b)),
  ) as typeof c.brief;
  const explained = applyAnswer(
    c,
    { ...answer, next: "explain", candidates: [] },
    "two",
  );
  assert.deepEqual(explained.candidates, c.candidates);
  assert.deepEqual(explained.previous, c.previous);
});

test("explanations reuse the saved evidence and cannot change the brief or trigger discovery", async () => {
  const { existingExplanation } = await import("./creator/policy");
  const state = applyAnswer(initialCampaign(), answer, "first");
  const explanation = existingExplanation(
    state,
    "Why did you choose these creators?",
  );
  assert.ok(explanation);
  assert.equal(explanation.next, "explain");
  assert.deepEqual(explanation.brief, state.brief);
  assert.match(explanation.reply, /Alex Morgan/);
  assert.deepEqual(
    applyAnswer(state, explanation, "second").candidates,
    state.candidates,
  );
  assert.equal(
    existingExplanation(
      state,
      "Why not exclude Alex Morgan and find someone else?",
    ),
    null,
  );
});

test("campaign goals require user evidence and persist with the saved brief", () => {
  const user = { role: "user", content: "Help us get more students using ChatEDU." };
  const current = initialCampaign();
  const proposal: Answer = {
    brief: { ...emptyBrief, brand: "ChatEDU", audience: "students", goal: "Get more students using ChatEDU" },
    reply: "Here's a direction.", options: [], next: "compare", candidates: [],
    sources: [
      { field: "brand", messageIndex: 0, quote: "ChatEDU" },
      { field: "audience", messageIndex: 0, quote: "students" },
      { field: "goal", messageIndex: 0, quote: user.content },
    ],
  };
  const grounded = validateSources(answerSchema.parse(proposal), current, [user]);
  const saved = applyAnswer(current, grounded, "reply");
  assert.equal(saved.brief.goal, "Get more students using ChatEDU");
  assert.equal(saved.facts?.find((fact) => fact.field === "goal")?.quote, user.content);
  assert.throws(() => validateSources({ ...proposal, sources: proposal.sources.filter((source) => source.field !== "goal") }, current, [user]));
  assert.throws(() => validateSources(proposal, current, [{ role: "assistant", content: user.content }]));
});
