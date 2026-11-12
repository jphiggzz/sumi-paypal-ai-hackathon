import test from "node:test";
import assert from "node:assert/strict";
import { mockFeedbackInput, mockFeedbackOutput, validateMockFeedback, filterExcludedProducts, filterGroundedSuggestions } from "./mock-gift-feedback";

test("preview input bounds owner-scoped feedback and catalogue indexes", () => {
  const base = { conversationId: "11111111-1111-4111-8111-111111111111", mode: "feedback", feedback: "Less glass", priorFeedback: [], shownIndices: [0, 1] };
  assert.equal(mockFeedbackInput.safeParse(base).success, true);
  assert.equal(mockFeedbackInput.safeParse({ ...base, shownIndices: [7] }).success, false);
  assert.equal(mockFeedbackInput.safeParse({ ...base, feedback: "" }).success, false);
  assert.equal(mockFeedbackInput.safeParse({ ...base, ownerId: "injected" }).success, false);
});

test("preview results only resolve bounded existing products and deduplicate", () => {
  const result = { productIndices: [1, 1, 3], retainShown: false, excludedTerms: [], suggestions: ["More like the board", "Less glassware"], discussion: ["a", "b", "c"], summary: "Ideas" };
  assert.deepEqual(validateMockFeedback(mockFeedbackOutput.parse(result)).productIndices, [1, 3]);
  assert.equal(mockFeedbackOutput.safeParse({ ...result, productIndices: [7] }).success, false);
  assert.equal(mockFeedbackOutput.safeParse({ ...result, productIndices: [] }).success, true);
});


test("explicitly excluded terms remove even a model-selected product", () => {
  assert.deepEqual(filterExcludedProducts([0, 1, 2], ["wood", "glass"], ["Wood serving board", "Cocktail Glass Set", "Ceramic bowl"]), [2]);
});


test("feedback chips referring to product types only mention displayed titles", () => {
  assert.deepEqual(filterGroundedSuggestions(["Less glassware", "More like the wood board", "Make it personal"], [0], ["Wood Serving Board", "Cocktail Glass Set"]), ["More like the wood board", "Make it personal"]);
});
