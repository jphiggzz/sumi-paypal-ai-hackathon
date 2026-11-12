import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";
const f = JSON.parse(
  await readFile("/tmp/sume-creator-run-browser.json", "utf8"),
);
if (!/^http:\/\/localhost:\d+$/.test(f.base))
  throw Error("Local verification only");
const headers = { Origin: f.base, "x-demo-code": f.code, Cookie: f.cookie };
const until = Date.now() + 240000;
let state: any, run: any;
do {
  const r = await fetch(
    `${f.base}/api/creator-campaign?conversationId=${f.conversationId}`,
    { headers },
  );
  assert.equal(r.status, 200);
  state = await r.json();
  run = state.runs.at(-1);
  if (run && !["running", "queued"].includes(run.status)) break;
  if (Date.now() > until) throw Error("Retry timed out");
  await new Promise((r) => setTimeout(r, 2500));
} while (true);
assert.equal(run.status, "ready", JSON.stringify(run));
assert.equal(run.activity.length, 3);
assert.deepEqual(
  run.activity.map((x: any) => x.name),
  ["Scout", "Muse", "Dot"],
);
assert.ok(run.result.candidates.some((x: any) => x.id === "api-educator"));
assert.equal(run.message_id, run.id);
assert.equal(state.state.brief.budgetCents, 200000);
await writeFile(
  new URL(
    "../../research/creator-agent-paypal-recovered-2026-11-10.json",
    import.meta.url,
  ),
  JSON.stringify(
    {
      method:
        "Real local workflow retry from browser after malformed structured output; synthetic creator catalog.",
      run,
    },
    null,
    2,
  ) + "\n",
);
console.log(
  JSON.stringify({
    status: run.status,
    roles: run.activity.map((x: any) => x.name),
    candidates: run.result.candidates.map((x: any) => x.id),
    runId: run.id,
  }),
);
