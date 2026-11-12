import assert from "node:assert/strict";
import { test } from "node:test";
import {
  nextDue,
  routineInput,
  dailyModelLimit,
  fullRequestPrice,
  modelBudgetReservation,
} from "./routine-policy";
const valid = () => ({
  id: "b2d505cb-3266-49c1-85bc-3a8cac63aa1b",
  instruction: "Record a checkpoint.",
  dueAt: new Date(Date.now() + 60000).toISOString(),
  expiresAt: new Date(Date.now() + 86400000).toISOString(),
  timezone: "America/New_York",
  maxRuns: 1,
});
test("missed intervals coalesce to one occurrence and do not create catch-up bursts", () => {
  assert.equal(
    nextDue(
      new Date("2026-11-09T12:00Z"),
      60,
      new Date("2026-11-09T12:07:31Z"),
    )?.toISOString(),
    "2026-11-09T12:08:00.000Z",
  );
  assert.equal(nextDue(new Date(), null, new Date()), null);
});
test("elapsed intervals remain unambiguous across daylight-saving changes", () => {
  assert.equal(
    nextDue(
      new Date("2026-11-01T05:30Z"),
      3600,
      new Date("2026-11-01T05:30Z"),
    )?.toISOString(),
    "2026-11-01T06:30:00.000Z",
  );
});
test("routines require bounded runs, a real timezone and expiry", () => {
  assert.ok(routineInput.safeParse(valid()).success);
  for (const patch of [
    { maxRuns: 11, intervalSeconds: 60 },
    { maxRuns: 2 },
    { timezone: "Fake/Zone" },
    { expiresAt: new Date(Date.now() + 8 * 86400000).toISOString() },
    { intervalSeconds: 1 },
  ])
    assert.equal(
      routineInput.safeParse({ ...valid(), ...patch }).success,
      false,
    );
});
test("model budget defaults conservatively and cannot exceed the development ceiling", () => {
  assert.equal(dailyModelLimit(undefined), 5);
  assert.equal(dailyModelLimit("0"), 0);
  assert.equal(dailyModelLimit("100"), 10);
  assert.equal(dailyModelLimit("NaN"), 5);
});
test("reservation covers full context and regional prices; price increases and unknown bounds fail closed", () => {
  const entry = {
    context_window: 128000,
    pricing: {
      input: "0.000000035",
      output: "0.00000014",
      regional: { eu: { input: "0.000000046", output: "0.000000184" } },
    },
  };
  assert.ok(
    fullRequestPrice(entry) < modelBudgetReservation("amazon/nova-micro"),
  );
  assert.ok(
    fullRequestPrice({
      ...entry,
      pricing: { input: "0.0000001", output: "0.0000004" },
    }) > modelBudgetReservation("amazon/nova-micro"),
  );
  assert.equal(fullRequestPrice({ ...entry, context_window: NaN }), Infinity);
});
