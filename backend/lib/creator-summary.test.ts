import test from "node:test";
import assert from "node:assert/strict";
import { compactAgentSummary, checkedAgentSummary } from "./creator/summary";

test("contradictory agent summaries are identified instead of presented as fact", () => {
  assert.equal(checkedAgentSummary("No exclusions or budget were supplied.", { exclusions: ["Maya Chen"], budgetCents: null }), "Agent summary conflicted with the saved brief.");
  assert.equal(checkedAgentSummary("No exclusions or budget were supplied.", { exclusions: [], budgetCents: null }), "No exclusions or budget were supplied.");
});

test("agent updates use a complete sentence or mark truncation", () => {
  assert.equal(compactAgentSummary("Scout found matches. Further review follows."), "Scout found matches.");
  assert.equal(compactAgentSummary("   "), "Review complete.");
  const long = compactAgentSummary("Relevant creator evidence ".repeat(20));
  assert.ok(long.length <= 240);
  assert.ok(long.endsWith("…"));
});
