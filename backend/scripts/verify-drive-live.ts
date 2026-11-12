/** Attended Google consent/Picker must finish first. Never provisions or fabricates a provider grant.
 * Reuses the development owner's existing SQL session for hosted API checks.
 * --refresh-token accelerates the encrypted local expiry timestamp, then requires a real Google refresh.
 * --disconnect deliberately removes this development connection after verifying its reads.
 */
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { writeFile } from "node:fs/promises";
import { setTimeout as delay } from "node:timers/promises";
import { Pool } from "pg";
import { serializeSignedCookie } from "better-call";
import { openCredential, sealCredential } from "../lib/drive-provider";

const base = new URL(process.argv[2] || "https://sume-agent-foundation.vercel.app");
const connectionId = process.argv[3];
assert.match(connectionId ?? "", /^[a-f0-9-]{36}$/);
assert.ok(!(process.argv.includes("--reuse-latest") && process.argv.includes("--refresh-token")), "Expiry acceleration requires a fresh refresh");
assert.ok(process.env.DATABASE_URL && process.env.BETTER_AUTH_SECRET && process.env.SUME_DEMO_CODE);
assert.equal(base.origin, new URL(process.env.BETTER_AUTH_URL!).origin, "Harness session may only be sent to the configured auth origin");
const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 2 });
const checks: string[] = [];
const evidence: Record<string, unknown> = {
  checkedAt: new Date().toISOString(), base: base.origin, connectionId,
  fixtureBoundary: "User performs Google consent and Picker. Harness reuses the owner's existing app session from development SQL; no provider credentials or grants are fabricated.",
  liveAgentTurns: 0, checks,
};
let credentialValues: string[] = [];
function pass(check: string) { checks.push(check); console.log("PASS", check); }
try {
  const c = (await pool.query("SELECT * FROM agent_connections WHERE id=$1 AND provider='google'", [connectionId])).rows[0];
  assert.equal(c?.status, "connected", "Attended Drive consent required");
  assert.ok(c.resource_ids.length, "Attended Picker selection required");
  const session = (await pool.query('SELECT token FROM auth_sessions WHERE "userId"=$1 AND "expiresAt">now() ORDER BY "createdAt" DESC LIMIT 1', [c.owner_id])).rows[0];
  assert.ok(session, "Existing signed-in development session required");
  const cookie = (await serializeSignedCookie("__Secure-better-auth.session_token", session.token, process.env.BETTER_AUTH_SECRET!, { secure: true, path: "/", httpOnly: true, sameSite: "lax" })).split(";")[0];
  async function call(path: string, body?: unknown, method?: string, authenticated = true) {
    const response = await fetch(new URL(path, base), {
      method: method ?? (body === undefined ? "GET" : "POST"),
      headers: { Origin: base.origin, "Content-Type": "application/json", "x-demo-code": process.env.SUME_DEMO_CODE!, ...(authenticated ? { Cookie: cookie } : {}) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    const raw = await response.text();
    for (const value of credentialValues) assert.ok(!raw.includes(value), "Credential reflection");
    return { status: response.status, data: raw ? JSON.parse(raw) : null };
  }
  assert.equal((await call(`/api/connections/${connectionId}`)).status, 200);
  assert.equal((await call(`/api/connections/${connectionId}`, undefined, undefined, false)).status, 401);
  pass("existing owner session accepted; anonymous connection access denied");
  const credential = (await pool.query("SELECT sealed FROM drive_credentials WHERE connection_id=$1 AND owner_id=$2", [connectionId, c.owner_id])).rows[0];
  assert.ok(credential);
  const binding = `${c.owner_id}:${connectionId}`;
  const token = openCredential(credential.sealed, binding);
  assert.ok(token.refresh_token && token.access_token);
  credentialValues = [token.refresh_token, token.access_token];
  assert.ok(!credential.sealed.includes(token.refresh_token));
  assert.throws(() => openCredential(credential.sealed, `wrong-owner:${connectionId}`));
  pass("real offline credential encrypted and bound to owner/connection");
  if (process.argv.includes("--refresh-token")) {
    await pool.query("UPDATE drive_credentials SET sealed=$2 WHERE connection_id=$1 AND owner_id=$3", [connectionId, sealCredential({ ...token, expiresAt: Date.now() - 1000 }, binding), c.owner_id]);
    evidence.expiryAccelerationFixture = "Only stored expiry timestamp was moved into the past. Hosted refresh still calls the real Google token endpoint with the consented refresh token.";
  }
  const denied = await call("/api/sources", { id: randomUUID(), connectionId, expectedVersion: c.version, resourceId: `unselected-${randomUUID()}` });
  assert.equal(denied.status, 403);
  assert.equal(denied.data.error, "connection_resource_denied");
  pass("unselected resource denied before provider work");
  const reuse = process.argv.includes("--reuse-latest")
    ? (await pool.query("SELECT id FROM source_refreshes WHERE connection_id=$1 AND connection_version=$2 AND state='completed' AND resource_id=$3 ORDER BY created_at DESC LIMIT 1", [connectionId, c.version, c.resource_ids[0]])).rows[0]
    : null;
  if (process.argv.includes("--reuse-latest")) assert.ok(reuse, "Completed browser refresh required");
  const refreshId = reuse?.id ?? randomUUID();
  const input = { id: refreshId, connectionId, expectedVersion: c.version, resourceId: c.resource_ids[0] };
  if (!reuse) assert.equal((await call("/api/sources", input)).status, 202);
  let result: any;
  for (let attempt = 0; attempt < 120; attempt++) {
    result = await call(`/api/sources?refreshId=${refreshId}`);
    assert.equal(result.status, 200);
    if (result.data.state === "completed") break;
    if (result.data.state === "failed" && !["PROVIDER_UNAVAILABLE", "PROVIDER_RATE_LIMITED"].includes(result.data.error_code))
      throw new Error(`Provider refresh failed: ${result.data.error_code}`);
    await delay(1000);
  }
  assert.equal(result.data.state, "completed");
  evidence.refresh = { refreshId, sourceId: result.data.source_id, attempts: result.data.attempts, workflowRunId: result.data.workflow_run_id };
  pass("hosted durable refresh reads selected real Google document");
  evidence.refreshReuse = !!reuse;
  const currentSealed = (await pool.query("SELECT sealed FROM drive_credentials WHERE connection_id=$1", [connectionId])).rows[0].sealed;
  const current = openCredential(currentSealed, binding);
  credentialValues.push(current.access_token);
  assert.ok(current.expiresAt > Date.now() + 30000);
  if (process.argv.includes("--refresh-token")) pass("real Google token refresh recovers accelerated access-token expiry");
  const source = (await pool.query("SELECT * FROM source_records WHERE id=$1 AND owner_id=$2", [result.data.source_id, c.owner_id])).rows[0];
  assert.equal(source.fixture, false);
  assert.equal(source.connection_version, c.version);
  const query = (source.content.match(/[A-Za-z][A-Za-z0-9]{2,}/) ?? [])[0];
  assert.ok(query, "Test document must contain a searchable word");
  const searchPath = `/api/sources?sourceId=${source.id}&query=${encodeURIComponent(query)}`;
  const found = await call(searchPath);
  assert.equal(found.status, 200);
  const hit = found.data.sources.find((s: any) => s.id === source.id);
  assert.ok(hit);
  assert.equal(hit.contentHash, source.content_hash);
  assert.equal(hit.citation, `[source:${source.id}@${source.version}]`);
  evidence.source = { id: source.id, version: source.version, providerVersion: source.provider_version, fixture: false, contentBytes: Buffer.byteLength(source.content) };
  pass("live content searchable with exact immutable version citation");
  const replay = await call("/api/sources", input);
  assert.equal(replay.status, 202);
  assert.equal(replay.data.replayed, true);
  const repeated = (await pool.query("SELECT attempts FROM source_refreshes WHERE id=$1", [refreshId])).rows[0];
  assert.equal(repeated.attempts, result.data.attempts);
  pass("refresh replay reuses committed receipt without another provider attempt");
  if (process.argv.includes("--live")) {
    const expected = process.argv.find(v => v.startsWith("--expected-count="))?.split("=")[1];
    assert.match(expected ?? "", /^\d{1,3}$/);
    const conversationId = randomUUID();
    const admitted = await call("/api/conversations", {
      id: conversationId, messageId: randomUUID(), source: "Read the authorized cached Drive evidence. No facts are supplied here.",
      text: `Use search_sources to find source ${source.id}, query cedar. Reply with its verification marker and service count, then the exact citation. Do not use fixture document tools or invent values. Keep it under 50 words.`,
    });
    assert.equal(admitted.status, 201);
    evidence.liveAgentTurns = 1;
    evidence.conversationId = conversationId;
    for (let attempt = 0; attempt < 180; attempt++) {
      const turn = (await pool.query("SELECT status FROM conversation_turns WHERE conversation_id=$1 AND sequence=1", [conversationId])).rows[0];
      if (turn?.status === "completed") break;
      if (["failed", "cancelled"].includes(turn?.status)) throw new Error(`Live turn ${turn.status}`);
      await delay(1000);
    }
    const reply = (await pool.query("SELECT content FROM conversation_messages WHERE conversation_id=$1 AND sequence=1 AND role='assistant'", [conversationId])).rows[0]?.content;
    assert.ok(reply, "Live assistant reply required");
    assert.match(reply, /cedar-orbit-731/);
    assert.match(reply, new RegExp(`\\b${expected}\\b`));
    assert.ok(reply.includes(`[source:${source.id}@${source.version}]`));
    assert.ok((await pool.query("SELECT 1 FROM agent_capability_invocations WHERE conversation_id=$1 AND sequence=1 AND tool_id='search_sources' AND state='completed'", [conversationId])).rowCount);
    const usage = (await pool.query("SELECT detail FROM conversation_events WHERE conversation_id=$1 AND kind='model_usage'", [conversationId])).rows.map(r => r.detail);
    evidence.estimatedInferenceUsd = usage.reduce((n, u) => n + Number(u.estimatedUsd ?? 0), 0);
    evidence.liveModel = "amazon/nova-micro";
    pass("live Nova Micro uses registered retrieval and cites independently specified marker/count from real Drive evidence");
  }
  if (process.argv.includes("--disconnect")) {
    const disconnected = await call(`/api/connections/${connectionId}`, { action: "disconnect", expectedVersion: c.version }, "PATCH");
    assert.equal(disconnected.status, 200);
    assert.equal(disconnected.data.connection.status, "disconnected");
    assert.equal((await pool.query("SELECT 1 FROM drive_credentials WHERE connection_id=$1", [connectionId])).rowCount, 0);
    const hidden = await call(searchPath);
    assert.equal(hidden.status, 200);
    assert.equal(hidden.data.sources.length, 0);
    assert.notEqual((await call("/api/sources", { ...input, id: randomUUID() })).status, 202);
    pass("application disconnect deletes credential and denies cached retrieval/new refresh");
    evidence.finalConnectionState = "disconnected; user reauthorization/selection required";
    evidence.revocationBoundary = "Application disconnect tested. Google-side token revocation is separate and not claimed.";
  } else evidence.finalConnectionState = "connected";
  evidence.status = "passed";
} catch (error) {
  evidence.status = "failed";
  evidence.error = error instanceof Error ? error.message : "Verification failed";
  process.exitCode = 1;
} finally {
  let serialized = JSON.stringify(evidence, null, 2);
  for (const value of credentialValues) serialized = serialized.replaceAll(value, "[redacted]");
  await writeFile(`../research/drive-live-verification-${process.argv.includes("--disconnect") ? "disconnect" : "read"}-2026-11-09.json`, serialized + "\n");
  console.log(JSON.stringify({ status: evidence.status, checks: checks.length, error: evidence.status === "failed" ? "See redacted evidence" : undefined }));
  await pool.end();
}
