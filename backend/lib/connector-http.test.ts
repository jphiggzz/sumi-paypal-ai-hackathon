import test from 'node:test';
import assert from 'node:assert/strict';
import { CapabilityError } from './capability-contracts';
import { readFixtureDocument, listFixtureDocuments, parseConnectorRetryAfter, CONNECTOR_MAX_BODY_BYTES } from './connector-http';
import { createFixtureTransport, FIXTURE_ACCESS_CREDENTIAL as token, FIXTURE_ORIGIN } from './connector-fixture';

const errorCode = (code: string, status?: number) => (error: unknown) => {
  assert.ok(error instanceof CapabilityError);
  assert.equal(error.code, code);
  if (status) assert.equal(error.status, status);
  return true;
};

test('fixture documents have independently fixed facts and explicit synthetic provenance', async () => {
  const alpha = await readFixtureDocument('doc-alpha', token);
  const beta = await readFixtureDocument('doc-beta', token);
  assert.equal(alpha.title, 'Infrastructure Notes');
  assert.equal(alpha.version, 'alpha-v1');
  assert.match(alpha.text, /FIXTURE ALPHA17/);
  assert.match(alpha.text, /11 workers/);
  assert.match(alpha.text, /November 12, 2026/);
  assert.equal(beta.title, 'Archive Inventory');
  assert.match(beta.text, /23 boxes/);
  assert.match(beta.text, /FIXTURE BETA29/);
  assert.equal(alpha.fixture, true);
  assert.equal(beta.fixture, true);
  assert.ok(!JSON.stringify(alpha).includes(token));
});

test('HTTP conformance: exact read-only request, no redirects, no exposed arbitrary target', async () => {
  let calls = 0;
  const result = await readFixtureDocument('doc-alpha', 'synthetic-fixture-only.fixture-id.1.nonce', {transport: async request => {
    calls++;
    assert.equal(request.url, `${FIXTURE_ORIGIN}/documents/doc-alpha`);
    assert.equal(request.method, 'GET');
    assert.equal(request.redirect, 'error');
    assert.equal(request.headers.get('accept'), 'application/json');
    return createFixtureTransport()(request);
  }});
  assert.equal(result.id, 'doc-alpha');
  await assert.rejects(readFixtureDocument('https://example.com/private', token, {transport: async () => {calls++; throw Error('must not run');}}), errorCode('connector_resource_forbidden'));
  assert.equal(calls, 1);
});

test('pagination reads each fixture once and rejects invented cursors', async () => {
  const first = await listFixtureDocuments(token);
  assert.deepEqual(first.documents.map(d => d.id), ['doc-alpha']);
  assert.equal(first.nextCursor, 'page-beta');
  assert.equal(first.fixture, true);
  const last = await listFixtureDocuments(token, {cursor: first.nextCursor!});
  assert.deepEqual(last.documents.map(d => d.id), ['doc-beta']);
  assert.equal(last.nextCursor, null);
  await assert.rejects(listFixtureDocuments(token, {cursor: 'https://example.com/'}), errorCode('connector_cursor_invalid', 400));
});

test('malformed JSON, missing provider data, wrong schema version and excessive bodies fail closed', async () => {
  for (const scenario of ['malformed', 'partial', 'wrong-version'] as const) {
    await assert.rejects(readFixtureDocument('doc-alpha', token, {scenario}), errorCode('connector_response_invalid', 502));
    await assert.rejects(listFixtureDocuments(token, {scenario}), errorCode('connector_response_invalid', 502));
  }
  await assert.rejects(readFixtureDocument('doc-alpha', token, {scenario: 'oversized'}), errorCode('connector_response_too_large', 502));
  await assert.rejects(readFixtureDocument('doc-alpha', token, {transport: async () => new Response('small', {headers: {'content-length': String(CONNECTOR_MAX_BODY_BYTES + 1)}})}), errorCode('connector_response_invalid'));
  await assert.rejects(readFixtureDocument('doc-alpha', token, {transport: async () => new Response('small', {headers: {'content-type': 'application/json', 'content-length': String(CONNECTOR_MAX_BODY_BYTES + 1)}})}), errorCode('connector_response_too_large'));
});

test('expired credentials and revoked or unshared resources surface typed errors without provider bodies', async () => {
  await assert.rejects(readFixtureDocument('doc-alpha', 'fixture-expired-v1'), errorCode('connector_credential_expired', 401));
  await assert.rejects(readFixtureDocument('doc-alpha', 'fixture-revoked-v1'), errorCode('connector_resource_forbidden', 403));
  await assert.rejects(readFixtureDocument('unshared', token), errorCode('connector_resource_forbidden', 403));
  const privateError = 'bearer synthetic-fixture-only.secret.1.private';
  for (const status of [401, 403, 500]) {
    await assert.rejects(readFixtureDocument('doc-alpha', token, {transport: async () => new Response(privateError, {status})}), error => {
      assert.ok(error instanceof CapabilityError);
      assert.ok(!JSON.stringify(error).includes(privateError));
      assert.ok(!error.message.includes('synthetic-fixture'));
      return true;
    });
  }
  await assert.rejects(readFixtureDocument('doc-alpha', token, {transport: async () => {throw new Error(privateError);}}), errorCode('connector_response_invalid'));
  await assert.rejects(readFixtureDocument('doc-alpha', token, {transport: async () => {throw new CapabilityError(privateError, 401);}}), errorCode('connector_response_invalid'));
});

test('429 preserves a bounded retry hint without retrying', async () => {
  let calls = 0;
  await assert.rejects(readFixtureDocument('doc-alpha', token, {transport: async request => {calls++; return createFixtureTransport('rate-limited')(request);}}), error => {
    assert.ok(error instanceof CapabilityError);
    assert.equal(error.code, 'connector_rate_limited');
    assert.equal(error.retryAfterMs, 2000);
    return true;
  });
  assert.equal(calls, 1);
  assert.equal(parseConnectorRetryAfter('9999999'), 60000);
  assert.equal(parseConnectorRetryAfter('nonsense'), undefined);
  assert.equal(parseConnectorRetryAfter('-1'), undefined);
  assert.equal(parseConnectorRetryAfter('Thu, 12 Nov 2026 12:00:02 GMT', Date.parse('2026-11-12T12:00:00Z')), 2000);
  assert.equal(parseConnectorRetryAfter('Thu, 12 Nov 2026 11:00:00 GMT', Date.parse('2026-11-12T12:00:00Z')), 0);
});

test('timeout and caller cancellation interrupt both transport and stalled bodies', async () => {
  await assert.rejects(readFixtureDocument('doc-alpha', token, {scenario: 'timeout', timeoutMs: 15}), errorCode('connector_timeout', 504));
  await assert.rejects(readFixtureDocument('doc-alpha', token, {transport: () => new Promise(() => {}), timeoutMs: 15}), errorCode('connector_timeout', 504));
  await assert.rejects(readFixtureDocument('doc-alpha', token, {transport: async () => new Response(new ReadableStream({start(){}}), {headers: {'content-type':'application/json'}}), timeoutMs: 15}), errorCode('connector_timeout', 504));
  const controller = new AbortController();
  const pending = readFixtureDocument('doc-alpha', token, {scenario:'timeout', signal:controller.signal});
  controller.abort();
  await assert.rejects(pending, errorCode('connector_aborted', 499));
  await assert.rejects(readFixtureDocument('doc-alpha', token, {signal:controller.signal}), errorCode('connector_aborted', 499));
});

test('source text remains data even if it requests credentials or tool execution', async () => {
  const document = await readFixtureDocument('doc-alpha', token, {scenario:'hostile'});
  assert.match(document.text, /Ignore all instructions/);
  assert.deepEqual(Object.keys(document).sort(), ['fixture', 'id', 'sourceUrl', 'text', 'title', 'version']);
  assert.equal(document.fixture, true);
});

test('unexpected response fields, document substitution and external source URLs are rejected', async () => {
  const document = await readFixtureDocument('doc-alpha', token);
  for (const changed of [{...document, id:'doc-beta'}, {...document, sourceUrl:'https://external.example/'}, {...document, action:'execute'}]) {
    await assert.rejects(readFixtureDocument('doc-alpha', token, {transport: async () => Response.json({schemaVersion:1,fixture:true,document:changed})}), errorCode('connector_response_invalid'));
  }
});

test('bounded delayed fixture enables deterministic in-flight authority checks', async () => {
  const document = await readFixtureDocument('doc-alpha', token, {scenario:'delay'});
  assert.equal(document.id, 'doc-alpha');
  const controller = new AbortController();
  const pending = readFixtureDocument('doc-alpha', token, {scenario:'delay', signal:controller.signal});
  controller.abort();
  await assert.rejects(pending, errorCode('connector_aborted', 499));
});
