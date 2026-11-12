import test from "node:test";
import assert from "node:assert/strict";
import { NoObjectGeneratedError } from "ai";
import { retryMalformed } from "./creator/format-retry";
const malformed = () =>
  new NoObjectGeneratedError({
    response: undefined as any,
    usage: undefined as any,
    finishReason: "error",
  });
test("malformed output gets one separately admitted retry", async () => {
  let calls = 0,
    reservations = 0,
    waited = 0;
  const result = await retryMalformed(
    async () => {
      if (++calls === 1) throw malformed();
      return "valid";
    },
    async () => {
      reservations++;
      return 10;
    },
    async (ms) => {
      waited = ms;
    },
  );
  assert.equal(result, "valid");
  assert.equal(calls, 2);
  assert.equal(reservations, 1);
  assert.equal(waited, 10);
});
test("other failures and busy capacity do not trigger another inference", async () => {
  let calls = 0,
    reservations = 0;
  await assert.rejects(
    retryMalformed(
      async () => {
        calls++;
        throw Error("provider");
      },
      async () => {
        reservations++;
        return 0;
      },
      async () => {},
    ),
  );
  assert.equal(calls, 1);
  assert.equal(reservations, 0);
  await assert.rejects(
    retryMalformed(
      async () => {
        calls++;
        throw malformed();
      },
      async () => {
        reservations++;
        return 30001;
      },
      async () => {},
    ),
    /Capacity busy/,
  );
  assert.equal(calls, 2);
  assert.equal(reservations, 1);
});
test("a second malformed response is returned as failure, not retried indefinitely", async () => {
  let calls = 0;
  await assert.rejects(
    retryMalformed(
      async () => {
        calls++;
        throw malformed();
      },
      async () => 0,
      async () => {},
    ),
  );
  assert.equal(calls, 2);
});
