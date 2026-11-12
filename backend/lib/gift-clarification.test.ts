import test from "node:test";
import assert from "node:assert/strict";
import { giftClarificationSchema, normalizeGiftOptions, safeGiftClarification, withoutRepeatedGiftOptions, giftClarificationReply, giftSearchAvailable } from "./gift-clarification";
import { giftBudgetAvailability, giftBudgetResponse } from "./gift-planning";

test("clarification choices are bounded and do not duplicate the free-text escape", () => {
  assert.deepEqual(normalizeGiftOptions(["Take it", "take it", "Something else", "Bring it back"]), ["Take it", "Bring it back"]);
  assert.deepEqual(normalizeGiftOptions(["A person"]), []);
  assert.equal(giftClarificationSchema.safeParse({ question: "Who is it for?", options: ["A", "B", "C", "D"] }).success, false);
  assert.equal(giftClarificationSchema.safeParse({ question: "", options: [] }).success, false);
});

test("budget is offered rather than forced after an interactive answer", () => {
  const base = { newDraft: true, limitCents: 0, hasSharedFacts: false, readyForBudget: false, answered: true, interactive: true, responseFinished: true };
  assert.deepEqual(giftBudgetAvailability(base), { show: false, offer: true });
  assert.deepEqual(giftBudgetAvailability({ ...base, readyForBudget: true }), { show: true, offer: false });
  assert.deepEqual(giftBudgetAvailability({ ...base, responseFinished: false }), { show: false, offer: false });
  assert.deepEqual(giftBudgetAvailability({ ...base, interactive: false }), { show: true, offer: false });
});

test("demographic guesses fall back without inventing a binary", () => {
  assert.deepEqual(safeGiftClarification({ question: "Is Alex a man or a woman?", options: ["Man", "Woman"], next: "explore" }, "Alex new apartment"), { question: "What would make this gift meaningful?", options: [] });
  assert.equal(safeGiftClarification({ question: "Does the baby prefer blue?", options: [], next: "explore" }, "A gift for my baby").question, "Does the baby prefer blue?");
});

test("does not ask for an occasion already stated in the user’s brief", () => {
  assert.deepEqual(safeGiftClarification({ question: "What is the occasion?", options: ["Birthday", "Holiday"], next: "explore" }, "A thank-you gift for our cabin host"), { question: "Which direction would you like to explore?", options: [] });
  assert.equal(safeGiftClarification({ question: "What is the occasion?", options: [], next: "explore" }, "A gift for Alex").question, "What is the occasion?");
});

test("clarification selection mode is bounded and older interactions remain valid", () => {
  assert.equal(giftClarificationSchema.safeParse({ question: "Which direction?", options: ["Useful", "Personal"], selection: "multiple", next: "explore" }).success, true);
  assert.equal(giftClarificationSchema.safeParse({ question: "Which direction?", options: ["Useful", "Personal"], selection: "unlimited" }).success, false);
  assert.equal(safeGiftClarification({ question: "Which direction?", options: ["Useful", "Personal"], next: "explore" }, "A gift").selection, "single");
  assert.equal(safeGiftClarification({ question: "Which direction?", options: [], next: "ready" }, "A gift").next, "ready");
});


test("budget is offered only after a completed ready response, not exploration or failure", () => {
  const base = { id: "question", role: "assistant", content: "What direction?", status: "completed", interaction: { type: "gift_clarification", next: "explore" as const } };
  assert.equal(giftBudgetResponse([base]).eligible, false);
  const ready = { ...base, id: "ready", interaction: { ...base.interaction, next: "ready" as const } };
  assert.deepEqual(giftBudgetResponse([base, ready]), { anchorId: "ready", eligible: true });
  assert.equal(giftBudgetResponse([base, ready, { id: "stream", role: "assistant", content: "", status: "streaming" }]).eligible, false);
  assert.equal(giftBudgetResponse([base, ready, { id: "error", role: "assistant", content: "A workflow action could not complete.", status: "completed" }]).eligible, false);
  assert.equal(giftBudgetResponse([base, ready, { ...base, id: "next" }]).eligible, false);
});


test("rejected suggestions do not return as fresh choices", () => {
  assert.deepEqual(withoutRepeatedGiftOptions(["COZY touches", "An experience", "Useful"], ["Cozy touches", "Useful"]), ["An experience"]);
});

test("a ready handoff never presents the model's conflicting follow-up question", () => {
  assert.equal(giftClarificationReply({ question: "What style does Alex like?", next: "ready" }), "Let’s find some ideas.");
  assert.equal(giftClarificationReply({ question: "What style does Alex like?", next: "explore" }), "What style does Alex like?");
});

test("search is available only after funding and explicit shared context", () => {
  assert.equal(giftSearchAvailable(undefined), false);
  assert.equal(giftSearchAvailable({ group: { budgetCents: 0, reserveCents: 1000 }, sharedContext: [{}] }), false);
  assert.equal(giftSearchAvailable({ group: { budgetCents: 15000, reserveCents: 1000 }, sharedContext: [] }), false);
  assert.equal(giftSearchAvailable({ group: { budgetCents: 15000, reserveCents: 1000 }, sharedContext: [{}] }), true);
});
