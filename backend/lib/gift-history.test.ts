import test from "node:test";
import assert from "node:assert/strict";
import { canUsePriorRound } from "./gift-history";
test("earlier results remain available only while their shared sources and participants remain", () => {
  const input = { facts: [{ id: "one" }, { id: "two" }], members: [{ id: "a" }, { id: "b" }] };
  assert.equal(canUsePriorRound(input, ["one", "two", "new"], ["a", "b"]), true);
  assert.equal(canUsePriorRound(input, ["one"], ["a", "b"]), false);
  assert.equal(canUsePriorRound(input, ["one", "two"], ["a", "c"]), false);
  assert.equal(canUsePriorRound(input, ["one", "two"], ["a"]), false);
  assert.equal(canUsePriorRound({ facts: [] }, [], ["a"]), false);
});
