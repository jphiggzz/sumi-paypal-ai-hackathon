import test from "node:test";
import assert from "node:assert/strict";
import { cleanAudienceSuggestions } from "./creator/audience-suggestions";

test("audience suggestions are trimmed, deduplicated and bounded", () => {
  assert.deepEqual(cleanAudienceSuggestions([" College students ", "college students.", "University students", "Medical students", "High school students", "Nursing students", "Law students"]), ["College students", "Medical students", "High school students", "Nursing students"]);
});
