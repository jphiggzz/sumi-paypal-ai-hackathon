import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
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
async function state() {
  const r = await fetch(
    `${f.base}/api/creator-campaign?conversationId=${f.conversationId}`,
    { headers },
  );
  assert.equal(r.status, 200);
  return r.json();
}
const before = await state();
const cr = await fetch(
  `${f.base}/api/workspace-chat?conversationId=${f.conversationId}`,
  { headers },
);
assert.equal(cr.status, 200);
const chat = await cr.json();
const r = await fetch(`${f.base}/api/workspace-chat/stream`, {
  method: "POST",
  headers,
  body: JSON.stringify({
    conversationId: f.conversationId,
    requestId: randomUUID(),
    messageId: randomUUID(),
    text: "Why did you choose these creators?",
    mode: "creators",
    revision: chat.chat.revision,
  }),
});
assert.equal(r.status, 200);
const text = await r.text();
assert.ok(!text.includes('"type":"error"'), text);
const after = await state();
assert.equal(
  after.runs.length,
  before.runs.length,
  "Explanation launched another discovery",
);
assert.deepEqual(after.state.brief, before.state.brief);
assert.deepEqual(after.state.candidates, before.state.candidates);
console.log(
  JSON.stringify({
    explanation: "completed",
    newDiscovery: false,
    briefPreserved: true,
    candidatesPreserved: true,
  }),
);
