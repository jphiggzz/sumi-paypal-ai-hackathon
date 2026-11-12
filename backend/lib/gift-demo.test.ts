import { test } from "node:test";
import assert from "node:assert/strict";
import { giftDemoActor, giftDemoCookie, giftDemoEnabled, giftDemoReturnPath } from "./gift-demo";
test("demo mode needs explicit enablement and a loopback origin", () => {
  const prior = process.env.GIFT_DEMO_ENABLED;
  try {
    delete process.env.GIFT_DEMO_ENABLED; assert.equal(giftDemoEnabled(new Request("http://localhost:3000/api/gifts/demo")), false);
    process.env.GIFT_DEMO_ENABLED = "true";
    assert.equal(giftDemoEnabled(new Request("http://localhost:3000/api/gifts/demo")), true);
    assert.equal(giftDemoEnabled(new Request("https://example.com/api/gifts/demo")), false);
  } finally { if (prior === undefined) delete process.env.GIFT_DEMO_ENABLED; else process.env.GIFT_DEMO_ENABLED = prior; }
});
test("demo friend keys cannot name a real user or arbitrary actor", () => {
  assert.equal(giftDemoActor.safeParse("alex").success, true);
  for (const input of ["admin", "real-user-id", "../casey", "Alex", ""]) assert.equal(giftDemoActor.safeParse(input).success, false);
});
test("demo cookie parsing does not reuse real authentication cookies", () => {
  assert.equal(giftDemoCookie(new Request("http://localhost", { headers: { cookie: "better-auth.session_token=secret; gift_demo=demo-token; other=value" } })), "demo-token");
  assert.equal(giftDemoCookie(new Request("http://localhost", { headers: { cookie: "better-auth.session_token=secret" } })), "");
});
test("Sandbox return paths preserve the selected fictional friend", () => {
  assert.equal(giftDemoReturnPath("casey"), "/gifts/demo?friend=casey");
});
