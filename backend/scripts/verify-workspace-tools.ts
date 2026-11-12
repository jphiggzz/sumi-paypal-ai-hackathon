import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
const base = "http://localhost:3000",
  state = JSON.parse(
    await readFile("/tmp/workspace-connected-browser.json", "utf8"),
  );
const cookie = state.cookies.map((c: any) => `${c.name}=${c.value}`).join("; ");
const headers = {
  Origin: base,
  "Content-Type": "application/json",
  Cookie: cookie,
  "x-demo-code": process.env.SUME_DEMO_CODE || "",
};
async function request(path: string, body?: unknown) {
  const r = await fetch(base + path, {
    headers,
    method: body ? "POST" : "GET",
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  const data = await r.json();
  assert.ok(r.ok, JSON.stringify(data));
  return data;
}
const chats: string[] = [];
for (const kind of ["campaign", "gift"]) {
  const id = randomUUID();
  chats.push(id);
  await request("/api/workspace-chat", {
    action: "create",
    id,
    mode: kind === "campaign" ? "creators" : "shopping",
  });
  const r = await fetch(base + "/api/workspace-chat/stream", {
    method: "POST",
    headers,
    body: JSON.stringify({
      conversationId: id,
      requestId: randomUUID(),
      messageId: randomUUID(),
      revision: 0,
      mode: kind === "campaign" ? "creators" : "shopping",
      text:
        kind === "campaign"
          ? "Use prepare_campaign to prepare the existing fixed ChatEDU Sandbox campaign card now. Do not approve or run it."
          : "Use prepare_group_gift now to create a real group thank-you gift for Sam who hosted our birthday weekend. Do not share any private messages or grant payment authority.",
    }),
  });
  assert.equal(r.status, 200);
  const stream = await r.text();
  assert.ok(!stream.includes("errorText"), stream.slice(-400));
  const flows = await request(
    "/api/workspace-chat/workflows?conversationId=" + id,
  );
  const linked = flows.flows.find((f: any) => f.kind === kind);
  assert.ok(linked, JSON.stringify(flows));
  if (kind === "campaign") assert.equal(linked.state, null);
  else {
    assert.equal(linked.state.me.limitCents, 0);
    assert.equal(linked.state.facts.length, 0);
  }
  console.log(`Live chat tool prepared ${kind} without payment authority`);
}
const prepared = await request(
  "/api/workspace-chat/workflows?conversationId=" + chats[0],
);
const ready = prepared.flows.find(
  (f: any) => f.kind === "campaign",
).payoutReady;
if (!ready) {
  const r = await fetch(base + "/api/workspace-chat/workflows", {
    method: "POST",
    headers,
    body: JSON.stringify({
      conversationId: chats[0],
      command: {
        action: "approve_campaign",
        approved: true,
        scenario: "payout",
      },
    }),
  });
  assert.equal(r.status, 409);
  console.log(
    "Missing Sandbox creator recipients block approval before enqueue",
  );
}
await request("/api/workspace-chat/workflows", {
  conversationId: chats[0],
  command: {
    action: "approve_campaign",
    approved: true,
    scenario: ready ? "payout" : "review",
  },
});
for (let i = 0; i < 90; i++) {
  const state = await request(
    "/api/workspace-chat/workflows?conversationId=" + chats[0],
  );
  const c = state.flows.find((f: any) => f.kind === "campaign").state;
  if (["review", "failed", "payment_review", "paid"].includes(c.status)) {
    assert.equal(c.status, ready ? "paid" : "review", JSON.stringify(c));
    if (ready) assert.ok(c.batch_id && c.item_id);
    else assert.equal(c.batch_id, null);
    console.log(
      ready
        ? "Configured campaign model completed actual Sandbox payout"
        : "Configured campaign model completed real review with no payout",
    );
    break;
  }
  if (i === 89) throw Error("Review timeout");
  await delay(2000);
}
await writeFile(
  "/tmp/workspace-connected-tool-chats.json",
  JSON.stringify(chats),
  { mode: 0o600 },
);
const report = JSON.parse(
  await readFile(
    "../research/workspace-connected-flows-verification-2026-11-10.json",
    "utf8",
  ),
);
report.checks.push(
  "Actual Nova tool calls in streamed chat created linked campaign and gift cards without payment authority or implicit sharing",
  ready
    ? "Configured campaign model completed real Sandbox payout"
    : "Configured campaign model completed review; missing Sandbox recipients block payout approval",
);
if (!ready)
  report.limits.push("Creator payouts need configured Sandbox recipients.");
await writeFile(
  "../research/workspace-connected-flows-verification-2026-11-10.json",
  JSON.stringify(report, null, 2) + "\n",
);
