import assert from "node:assert/strict";
import { test } from "node:test";
import {
  capabilitySpecs,
  capabilityCheck,
  capabilityManifest,
} from "./capability-policy";
import { canonicalJson } from "./canonical-json";
test("closed manifest separates bounded reads from local draft/reply writes", () => {
  const entries = capabilityManifest();
  assert.equal(entries.length, 18);
  assert.ok(entries.every((e) => e.version === 1 && e.timeoutMs <= (e.id==='refresh_connected_source'?20000:5000)));
  assert.deepEqual(
    entries
      .filter((e) => e.effect !== "read")
      .map((e) => e.id)
      .sort(),
    ['control_document_job',"create_draft", "propose_fixture_note", "propose_sandbox_payment", 'refresh_connected_source',"reply",'request_clarification','start_document_job'],
  );
  assert.equal("send_email" in capabilitySpecs, false);
  assert.equal("remember" in capabilitySpecs, false);
});
test("fixture tools cannot accept arbitrary URLs, credentials, write actions or injected owner IDs", () => {
  const good = {
    connectionId: "a5baf15c-b182-447f-a342-568cf147fcfe",
    expectedVersion: 1,
    resourceId: "doc-alpha",
  };
  assert.ok(
    capabilitySpecs.read_fixture_document.inputSchema.safeParse(good).success,
  );
  for (const patch of [
    { url: "http://169.254.169.254/" },
    { ownerId: "other" },
    { credential: "secret" },
    { resourceId: "private-file" },
  ])
    assert.equal(
      capabilitySpecs.read_fixture_document.inputSchema.safeParse({
        ...good,
        ...patch,
      }).success,
      false,
    );
  assert.equal(
    capabilityCheck.safeParse({ tool: "send_email", input: {} }).success,
    false,
  );
});
test("canonical request identity ignores JSON object ordering and preserves changed arguments", () => {
  assert.equal(
    canonicalJson({ input: { b: 2, a: 1 }, tool: "read" }),
    canonicalJson({ tool: "read", input: { a: 1, b: 2 } }),
  );
  assert.notEqual(
    canonicalJson({ resourceId: "doc-alpha" }),
    canonicalJson({ resourceId: "doc-beta" }),
  );
});
