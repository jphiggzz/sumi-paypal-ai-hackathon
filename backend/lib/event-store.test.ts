import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { PoolClient } from 'pg';
import { CapabilityError } from './capability-contracts';
import { admitEvent, assertEventTemplate, preflightEvent, createEventSource, changeEventSource, eventSourceHandle, type EventSourceRow } from './event-store';
import { eventBodyDigest, eventSigningSecret } from './event-policy';
const id = 'b2d505cb-3266-49c1-85bc-3a8cac63aa1b';
const cid = 'b2d505cb-3266-49c1-85bc-3a8cac63aa1c';
const request = () => ({ id, conversationId: cid, instruction: 'Record a checkpoint.', executionMode: 'checkpoint' as const });
const source = (patch = {}): EventSourceRow => ({ id, owner_id: 'owner', conversation_id: cid, version: 1, signing_generation: 1, status: 'active', instruction: 'Record a checkpoint.', execution_mode: 'checkpoint', capability_request: null, create_request: request(), expires_at: '2099-11-09T12:00:00Z', fixture: true, ...patch });
type Step = { sql: RegExp; rows?: unknown[]; inspect?: (values: unknown[]) => void };
function scripted(steps: Step[]) { let index = 0; return { client: { async query(sql: string, values: unknown[] = []) { const step = steps[index++]; assert.ok(step, sql); assert.match(sql, step.sql); step.inspect?.(values); return { rows: step.rows ?? [], rowCount: step.rows?.length ?? 0 }; } } as unknown as PoolClient, done() { assert.equal(index, steps.length); } }; }
const conversation = (): Step => ({ sql: /FOR UPDATE OF c/, rows: [{ grants_active: true, enabled: true, permissions: ['read_context', 'reply'] }] });
const envelope = { eventId: 'fixture-1', occurredAt: '2026-11-09T12:00:00Z', data: { instruction: 'untrusted' } };
const body = Buffer.from(JSON.stringify(envelope));
const error = (code: string) => (value: unknown) => value instanceof CapabilityError && value.code === code;
test('source handles never expose derivation state, registration request or secret', () => {
  const handle = eventSourceHandle(source());
  assert.equal('signing_generation' in handle, false); assert.equal('create_request' in handle, false); assert.equal('owner_id' in handle, false); assert.equal('signingSecret' in handle, false); assert.equal(handle.fixture, true);
});
test('registration serializes conversation and owner quota, exposes secret only in creation result', async () => {
  const saved = process.env.BETTER_AUTH_SECRET; process.env.BETTER_AUTH_SECRET = 'fixture-secret';
  try {
    const db = scripted([conversation(), { sql: /pg_advisory_xact_lock/ }, { sql: /agent_event_sources WHERE id=\$1 FOR UPDATE/ }, { sql: /count\(\*\)/, rows: [{ count: 0 }] }, { sql: /INSERT INTO agent_event_sources/, rows: [source()] }, { sql: /INSERT INTO agent_event_source_revisions/, inspect: values => assert.equal(JSON.stringify(values).includes(eventSigningSecret(id, 1)), false) }]);
    const result = await createEventSource(db.client, 'owner', request());
    assert.equal(result.status, 201); assert.equal(result.signingSecret, eventSigningSecret(id, 1)); assert.equal(JSON.stringify(result.source).includes(result.signingSecret), false); db.done();
  } finally { if (saved === undefined) delete process.env.BETTER_AUTH_SECRET; else process.env.BETTER_AUTH_SECRET = saved; }
});
test('source changes reject stale CAS and cancelled state before writes', async () => {
  for (const current of [source({ version: 2 }), source({ status: 'cancelled' })]) {
    const db = scripted([{ sql: /SELECT conversation_id/, rows: [{ conversation_id: cid }] }, conversation(), { sql: /FOR UPDATE$/, rows: [current] }]);
    await assert.rejects(changeEventSource(db.client, 'owner', id, { action: 'pause', expectedVersion: 1 }), error('EVENT_SOURCE_VERSION_CONFLICT')); db.done();
  }
  const foreign = scripted([{ sql: /owner_id=\$2/, rows: [] }]);
  await assert.rejects(changeEventSource(foreign.client, 'other', id, { action: 'rotate', expectedVersion: 1 }), error('EVENT_SOURCE_MISSING')); foreign.done();
});
test('event replay returns existing inbox and sequence without appending a turn', async () => {
  const db = scripted([conversation(), { sql: /agent_event_sources[\s\S]*FOR UPDATE/, rows: [source()] }, { sql: /agent_event_inbox WHERE source_id=\$1 AND event_key=\$2/, rows: [{ id, body_digest: eventBodyDigest(body), sequence: 3 }] }]);
  assert.deepEqual(await admitEvent(db.client, source(), envelope, body), { accepted: true, replayed: true, eventId: id, sequence: 3, status: 202 }); db.done();
  const conflict = scripted([conversation(), { sql: /FOR UPDATE$/, rows: [source()] }, { sql: /body_digest/, rows: [{ id, body_digest: 'different', sequence: 3 }] }]);
  await assert.rejects(admitEvent(conflict.client, source(), envelope, body), error('EVENT_REPLAY_CONFLICT')); conflict.done();
});
test('intake rechecks source generation, status and signing rotation under ordered locks', async () => {
  for (const [patch, code] of [[{ version: 2 }, 'EVENT_REVOKED'], [{ status: 'paused' }, 'EVENT_REVOKED'], [{ expires_at: '2000-01-01T00:00:00Z' }, 'EVENT_REVOKED'], [{ signing_generation: 2 }, 'EVENT_SIGNATURE_INVALID']] as const) {
    const db = scripted([conversation(), { sql: /FOR UPDATE$/, rows: [source(patch)] }]);
    await assert.rejects(admitEvent(db.client, source(), envelope, body), error(code)); db.done();
  }
});
test('inbox is lifetime-bounded before any insertion or turn admission', async () => {
  const db = scripted([conversation(), { sql: /FOR UPDATE$/, rows: [source()] }, { sql: /SELECT id,body_digest,sequence/, rows: [] }, { sql: /count\(\*\)/, rows: [{ count: 100 }] }]);
  await assert.rejects(admitEvent(db.client, source(), envelope, body), error('EVENT_INBOX_LIMIT')); db.done();
});
test('checkpoint control updates preserve SQL NULL capability arguments', async () => {
  const saved = process.env.BETTER_AUTH_SECRET; process.env.BETTER_AUTH_SECRET = 'fixture-secret';
  const stopBeforeCommit = new Error('stop before real refresh import');
  try {
    const db = scripted([{ sql: /SELECT conversation_id/, rows: [{ conversation_id: cid }] }, conversation(), { sql: /FOR UPDATE$/, rows: [source()] }, { sql: /UPDATE agent_event_sources SET version=version\+1/, rows: [source({ version: 2, status: 'paused' })], inspect: values => { assert.equal(values[2], 'paused'); assert.equal(values[3], 0); assert.equal(values[6], null); throw stopBeforeCommit; } }]);
    await assert.rejects(changeEventSource(db.client, 'owner', id, { action: 'pause', expectedVersion: 1 }), value => value === stopBeforeCommit); db.done();
  } finally { if (saved === undefined) delete process.env.BETTER_AUTH_SECRET; else process.env.BETTER_AUTH_SECRET = saved; }
});

test('fixed note proposal templates require exact owned connection version and notes write grant', async () => {
  const template = { tool: 'propose_fixture_note' as const, input: { connectionId: id, connectionVersion: 2, resourceId: 'doc-alpha' as const, note: 'Owner-fixed note', expectedTargetVersion: 1 } };
  const connection = { id, owner_id: 'owner', provider: 'fixture', version: 2, status: 'connected', scopes: ['notes:write'], resource_ids: ['doc-alpha'], expires_at: '2099-11-09T12:00:00Z' };
  const valid = scripted([{ sql: /agent_connections WHERE id=\$1 AND owner_id=\$2 FOR SHARE/, rows: [connection], inspect: values => assert.deepEqual(values, [id, 'owner']) }]);
  await assertEventTemplate(valid.client, 'owner', template); valid.done();
  for (const patch of [{ scopes: ['documents:read'] }, { version: 1 }, { resource_ids: ['doc-beta'] }]) {
    const denied = scripted([{ sql: /FOR SHARE/, rows: [{ ...connection, ...patch }] }]);
    await assert.rejects(assertEventTemplate(denied.client, 'owner', template), value => value instanceof CapabilityError); denied.done();
  }
});

test('preflight rejects revoked conversations and changed sources before recovery is armed', async () => {
  const valid = scripted([conversation(), { sql: /FOR SHARE$/, rows: [source()] }]);
  await preflightEvent(valid.client, source()); valid.done();
  for (const patch of [{ grants_active: false }, { enabled: false }, { permissions: ['read_context'] }]) {
    const db = scripted([{ sql: /FOR UPDATE OF c/, rows: [{ grants_active: true, enabled: true, permissions: ['read_context', 'reply'], ...patch }] }, { sql: /FOR SHARE$/, rows: [source()] }]);
    await assert.rejects(preflightEvent(db.client, source()), error('EVENT_REVOKED')); db.done();
  }
  for (const [patch, code] of [[{ version: 2 }, 'EVENT_REVOKED'], [{ status: 'paused' }, 'EVENT_REVOKED'], [{ signing_generation: 2 }, 'EVENT_SIGNATURE_INVALID']] as const) {
    const db = scripted([conversation(), { sql: /FOR SHARE$/, rows: [source(patch)] }]);
    await assert.rejects(preflightEvent(db.client, source()), error(code)); db.done();
  }
});
