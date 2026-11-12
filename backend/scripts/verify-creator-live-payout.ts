import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";
const f = JSON.parse(
  await readFile("/tmp/sume-creator-run-browser.json", "utf8"),
);
if (!/^http:\/\/localhost:\d+$/.test(f.base))
  throw Error("Local verification only");
const headers = {
  Origin: f.base,
  "Content-Type": "application/json",
  "x-demo-code": f.code,
  Cookie: f.cookie,
};
async function get() {
  const r = await fetch(
    `${f.base}/api/creator-campaign?conversationId=${f.conversationId}`,
    { headers },
  );
  assert.equal(r.status, 200);
  return r.json();
}
async function act(command: object) {
  const r = await fetch(`${f.base}/api/creator-campaign`, {
    method: "POST",
    headers,
    body: JSON.stringify({ conversationId: f.conversationId, command }),
  });
  const b = await r.json();
  if (!r.ok) throw Error(`${r.status}: ${b.error}`);
  return b.state;
}
let s = (await get()).state;
assert.equal(s.brief.brand, "PayPal");
assert.equal(s.brief.budgetCents, 200000);
assert.ok(s.candidates.some((c: any) => c.id === "api-educator"));
s = await act({
  action: "prepare",
  creatorId: "api-educator",
  revision: s.revision,
  delivery: "Friday",
  rightsDays: 30,
});
let d = s.deals.find((x: any) => x.creatorId === "api-educator");
for (const action of ["approve", "delivery", "complete", "pay"]) {
  s = await act({
    action,
    dealId: d.id,
    digest: d.digest,
    revision: s.revision,
  });
  d = s.deals.find((x: any) => x.id === d.id);
}
const deadline = Date.now() + 90000;
while (d.payment !== "confirmed" && Date.now() < deadline) {
  await new Promise((r) => setTimeout(r, 5000));
  s = await act({
    action: "pay",
    dealId: d.id,
    digest: d.digest,
    revision: s.revision,
  });
  d = s.deals.find((x: any) => x.id === d.id);
}
assert.equal(d.payment, "confirmed");
assert.ok(d.batchId && d.itemId);
const receipt = {
  batchId: d.batchId,
  itemId: d.itemId,
  amountCents: d.milestoneCents,
};
s = await act({
  action: "pay",
  dealId: d.id,
  digest: d.digest,
  revision: s.revision,
});
d = s.deals.find((x: any) => x.id === d.id);
assert.deepEqual(
  { batchId: d.batchId, itemId: d.itemId, amountCents: d.milestoneCents },
  receipt,
);
await writeFile(
  new URL(
    "../../research/creator-agent-live-payout-2026-11-10.json",
    import.meta.url,
  ),
  JSON.stringify(
    {
      fixtureCreators: true,
      delivery: "simulated",
      payment: "real PayPal Sandbox",
      receipt,
      duplicate: "same confirmed receipt",
    },
    null,
    2,
  ) + "\n",
);
console.log(
  JSON.stringify({ confirmed: true, receipt, duplicate: "same receipt" }),
);
