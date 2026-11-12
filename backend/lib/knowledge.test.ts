import {appendSourceCitations} from "./source-citations";
import assert from "node:assert/strict";
import { test } from "node:test";
import {
  boundedHistory,
  historyInput,
  sourceRefreshInput,
  configInput,
} from "./knowledge-policy";
import {
  openCredential,
  sealCredential,
  readDriveDocument,
} from "./drive-provider";
import { failureCategory } from "./operations";
import { CapabilityError } from "./capability-contracts";
test("bounded history retains whole latest messages under a UTF8 byte allowance", () => {
  const rows = Array.from({ length: 100 }, (_, i) => ({
    sequence: i + 1,
    content: "🚀".repeat(200),
  }));
  const result = boundedHistory(rows, 5000);
  assert.ok(Buffer.byteLength(JSON.stringify(result)) <= 5000);
  assert.equal(result.at(-1)?.sequence, 100);
  assert.ok(result.length < 10);
  assert.equal(rows.length, 100);
});
test("configuration and history inputs have strict bounded server-owned limits", () => {
  const valid = {
    expectedVersion: 1,
    instructions: "Answer with citations",
    tools: ["read_context", "reply"],
  };
  assert.ok(configInput.safeParse(valid).success);
  for (const patch of [
    { model: "expensive" },
    { tools: ["reply"] },
    { tools: ["read_context", "reply", "send_email"] },
    { contextBytes: 999999 },
    { instructions: "x\0y" },
    { ownerId: "injected" },
  ])
    assert.equal(configInput.safeParse({ ...valid, ...patch }).success, false);
  assert.ok(
    historyInput.safeParse({ beforeCursor: "51:123", query: "old fact" })
      .success,
  );
  assert.equal(historyInput.safeParse({ limit: 100 }).success, false);
  assert.equal(
    sourceRefreshInput.safeParse({ resourceId: "https://evil.example" })
      .success,
    false,
  );
});
test("credential encryption binds owner and connection and detects any tampering", () => {
  const value = {
    refresh_token: "private-refresh",
    access_token: "private-access",
  };
  const sealed = sealCredential(value, "owner:connection", "test-secret");
  assert.doesNotMatch(sealed, /private/);
  assert.deepEqual(
    openCredential(sealed, "owner:connection", "test-secret"),
    value,
  );
  assert.throws(() =>
    openCredential(sealed, "other:connection", "test-secret"),
  );
  assert.throws(() =>
    openCredential(sealed, "owner:connection", "different-key"),
  );
  assert.notEqual(
    sealed,
    sealCredential(value, "owner:connection", "test-secret"),
  );
});
function driveTransport(responses: Response[]) {
  const calls: { url: string; init?: RequestInit }[] = [];
  return {
    calls,
    fetch: (async (url: any, init: any) => {
      calls.push({ url: String(url), init });
      assert.equal(new URL(String(url)).hostname, "www.googleapis.com");
      assert.equal(init.redirect, "error");
      assert.equal(init.headers.Authorization, "Bearer fixture-secret");
      return responses.shift()!;
    }) as typeof fetch,
  };
}
const metadata = (version = "1", patch = {}) =>
  Response.json({
    id: "file_a",
    name: "Test document",
    mimeType: "application/vnd.google-apps.document",
    version,
    trashed: false,
    ...patch,
  });
test("real Drive adapter issues only bounded read requests and preserves exact source version", async () => {
  const f = driveTransport([
    metadata(),
    new Response("KNOWN FACT47"),
    metadata(),
  ]);
  const doc = await readDriveDocument("file_a", "fixture-secret", f.fetch);
  assert.equal(doc.content, "KNOWN FACT47");
  assert.equal(doc.fixture, false);
  assert.equal(f.calls.length, 3);
  assert.ok(f.calls[1].url.includes("/export?mimeType=text%2Fplain"));
  for (const c of f.calls) assert.equal(c.init?.method, undefined);
});
test("Drive adapter rejects unauthorized, changing, oversized and credential-reflecting sources", async () => {
  for (const responses of [
    [new Response("", { status: 403 })],
    [metadata(), new Response("text"), metadata("2")],
    [metadata(), new Response("x".repeat(32769))],
    [metadata(), new Response("fixture-secret")],
    [metadata("1", { trashed: true })],
  ]) {
    const f = driveTransport(responses);
    await assert.rejects(
      readDriveDocument("file_a", "fixture-secret", f.fetch),
      (e) => e instanceof CapabilityError,
    );
  }
  const f = driveTransport([]);
  await assert.rejects(
    readDriveDocument("../secrets", "fixture-secret", f.fetch),
  );
  assert.equal(f.calls.length, 0);
});
test("provider throttling preserves bounded retry advice and operational errors remain distinguishable", async () => {
  const f = driveTransport([
    new Response("", { status: 429, headers: { "Retry-After": "300" } }),
  ]);
  await assert.rejects(
    readDriveDocument("file_a", "fixture-secret", f.fetch),
    (e) =>
      e instanceof CapabilityError &&
      e.code === "PROVIDER_RATE_LIMITED" &&
      e.retryAfterMs === 300000,
  );
  assert.equal(failureCategory("PROVIDER_REAUTH_REQUIRED"), "authorization");
  assert.equal(failureCategory("CONNECTOR_BUDGET_EXHAUSTED"), "budget");
  assert.equal(failureCategory("SOURCE_CHANGED"), "stale_context");
});

test('source citations are application-bound, deterministic and part of the final output bound',()=>{const refs=[{id:'27cdd9ea-8d9a-4c17-b930-fbd9fbb1ee45',version:2}];const citation='[source:'+refs[0].id+'@2]';assert.equal(appendSourceCitations('Known fact',refs,4000),'Known fact\n\n'+citation);assert.equal(appendSourceCitations(citation,refs,4000),citation);assert.throws(()=>appendSourceCitations(citation,[],4000),e=>e instanceof CapabilityError&&e.code==='UNBOUND_SOURCE_CITATION');assert.throws(()=>appendSourceCitations('x'.repeat(4000),refs,4000),e=>e instanceof CapabilityError&&e.code==='OUTPUT_CITATION_LIMIT');});
