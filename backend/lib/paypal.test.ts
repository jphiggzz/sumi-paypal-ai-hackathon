import { test } from "node:test";
import assert from "node:assert/strict";
import { submit, status } from "./paypal";
import type { Offer } from "./policy";
const offer: Offer = {
  creator: "A",
  milestoneCents: 125,
  totalCents: 125,
  rightsDays: 0,
  deliveryDay: "",
  visits: 0,
};
test("sandbox adapter verifies recipient, cents, currency and identity even for pending/failed responses", async () => {
  const original = globalThis.fetch,
    env = { ...process.env };
  process.env.PAYPAL_SANDBOX_CLIENT_ID = "fixture";
  process.env.PAYPAL_SANDBOX_CLIENT_SECRET = "fixture";
  process.env.PAYPAL_SANDBOX_CREATOR_A = "sb-fixture@personal.example.com";
  let key = "request",
    receiver = "sb-fixture@personal.example.com",
    value = "1.25",
    currency = "USD",
    state = "SUCCESS";
  globalThis.fetch = async (input) => {
    const url = String(input);
    assert.ok(url.startsWith("https://api-m.sandbox.paypal.com/"));
    return Response.json(
      url.endsWith("/token")
        ? { access_token: "fixture-token" }
        : {
            batch_header: { sender_batch_header: { sender_batch_id: key } },
            items: [
              {
                transaction_status: state,
                payout_item_id: "FIXTURE_ITEM",
                payout_item: {
                  sender_item_id: "A",
                  receiver,
                  amount: { value, currency },
                },
              },
            ],
          },
    );
  };
  try {
    assert.equal((await status(offer, "request", "batch")).status, "SUCCESS");
    value = "9.00";
    await assert.rejects(() => status(offer, "request", "batch"));
    value = "1.25";
    currency = "EUR";
    await assert.rejects(() => status(offer, "request", "batch"));
    currency = "USD";
    receiver = "sb-other@personal.example.com";
    await assert.rejects(() => status(offer, "request", "batch"));
    receiver = "sb-fixture@personal.example.com";
    key = "wrong";
    await assert.rejects(() => status(offer, "request", "batch"));
    key = "request";
    for (const s of ["PENDING", "FAILED"]) {
      state = s;
      value = "9.00";
      await assert.rejects(() => status(offer, "request", "batch"));
      value = "1.25";
      assert.equal((await status(offer, "request", "batch")).status, s);
    }
  } finally {
    globalThis.fetch = original;
    for (const k of [
      "PAYPAL_SANDBOX_CLIENT_ID",
      "PAYPAL_SANDBOX_CLIENT_SECRET",
      "PAYPAL_SANDBOX_CREATOR_A",
    ])
      if (env[k] === undefined) delete process.env[k];
      else process.env[k] = env[k];
  }
});
test("duplicate submission resolves only a sandbox batch reference and preserves exact request identity", async () => {
  const original = globalThis.fetch,
    env = { ...process.env };
  process.env.PAYPAL_SANDBOX_CLIENT_ID = "fixture";
  process.env.PAYPAL_SANDBOX_CLIENT_SECRET = "fixture";
  process.env.PAYPAL_SANDBOX_CREATOR_A = "sb-fixture@personal.example.com";
  let href = "https://evil.example/v1/payments/payouts/SECRET";
  globalThis.fetch = async (input, options) => {
    const url = String(input);
    assert.ok(url.startsWith("https://api-m.sandbox.paypal.com/"));
    if (url.endsWith("/token"))
      return Response.json({ access_token: "fixture-token" });
    assert.equal((options!.headers as any)["PayPal-Request-Id"], "stable-key");
    const body = JSON.parse(options!.body as string);
    assert.equal(body.sender_batch_header.sender_batch_id, "stable-key");
    assert.equal(body.items[0].amount.value, "1.25");
    return Response.json(
      { name: "DUPLICATE_BATCH_ID", links: [{ rel: "self", href }] },
      { status: 400 },
    );
  };
  try {
    await assert.rejects(() => submit(offer, "stable-key"));
    href = "https://api-m.sandbox.paypal.com/v1/payments/payouts/FIXTURE123";
    assert.equal(await submit(offer, "stable-key"), "FIXTURE123");
  } finally {
    globalThis.fetch = original;
    for (const k of [
      "PAYPAL_SANDBOX_CLIENT_ID",
      "PAYPAL_SANDBOX_CLIENT_SECRET",
      "PAYPAL_SANDBOX_CREATOR_A",
    ])
      if (env[k] === undefined) delete process.env[k];
      else process.env[k] = env[k];
  }
});
