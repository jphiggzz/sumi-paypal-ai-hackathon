import { test } from "node:test";
import assert from "node:assert/strict";
import { confirmedModelCost } from "./model-charge-policy";
const model = "google/gemini-2.5-flash-lite",
  id = "gen_example123456789";
const receipt = {
  id,
  model,
  isByok: false,
  finishReason: "stop",
  totalCost: 0.0000011,
  promptTokens: 100,
  completionTokens: 10,
};
test("confirmed costs round up and include the actual amount debited", () => {
  assert.equal(confirmedModelCost(model, id, receipt), 0.000002);
  assert.equal(
    confirmedModelCost(model, id, { ...receipt, gatewayCost: 0.0000041 }),
    0.000005,
  );
  assert.equal(confirmedModelCost(model, id, { ...receipt, totalCost: 0 }), 0);
});
test("missing costs and uncertain completion never release reservations", () => {
  for (const patch of [
    { totalCost: undefined },
    { totalCost: NaN },
    { totalCost: -1 },
    { totalCost: Infinity },
    { promptTokens: 0 },
    { promptTokens: undefined },
    { completionTokens: -1 },
    { finishReason: "pending" },
    { isByok: true },
    { gatewayCost: NaN },
  ])
    assert.equal(confirmedModelCost(model, id, { ...receipt, ...patch }), null);
});
test("a receipt must match the exact generation and allowed model", () => {
  assert.equal(confirmedModelCost("amazon/nova-micro", id, receipt), null);
  assert.equal(confirmedModelCost(model, "gen_different", receipt), null);
  assert.equal(confirmedModelCost(model, id, null), null);
});
