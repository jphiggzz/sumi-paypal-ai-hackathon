import assert from "node:assert/strict";
import { test } from "node:test";
import { providerBackoff } from "./provider-backoff.ts";

test("provider rate limits wait beyond the observed team quota window", () => {
  assert.equal(
    providerBackoff(
      new Error("GatewayRateLimitError: Rate limit exceeded. Retry after 60s."),
      0,
    ),
    65000,
  );
  assert.equal(providerBackoff(new Error("HTTP 429"), 2), 65000);
  assert.equal(
    providerBackoff(new Error("HTTP 503 temporarily unavailable"), 1),
    10000,
  );
});
test("authorization and permanent input failures do not enter provider retry", () => {
  assert.equal(
    providerBackoff(new Error("Conversation permission revoked"), 0),
    null,
  );
  assert.equal(providerBackoff(new Error("Invalid tool input"), 0), null);
});
