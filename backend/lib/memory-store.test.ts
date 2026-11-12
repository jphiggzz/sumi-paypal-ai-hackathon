import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { PoolClient } from 'pg';
import { CapabilityError } from './capability-contracts';
import { assertMemoryVersions, memoryHistory, mutateMemory, retrieveMemories } from './memory-store';
import type { MemoryMutation } from './memory-policy';
const id = 'b2d505cb-3266-49c1-85bc-3a8cac63aa1b';
const cid = 'b2d505cb-3266-49c1-85bc-3a8cac63aa1c';
const rid = 'b2d505cb-3266-49c1-85bc-3a8cac63aa1d';
const row = (patch = {}) => ({ id, owner_id: 'owner', scope: 'agent', conversation_id: null, key: 'Language', value: 'French', version: 1, source: { kind: 'explicit_human' }, expires_at: null, deleted_at: null, ...patch });
const input = (patch = {}): MemoryMutation => ({ action: 'remember', id, requestId: rid, expectedVersion: 0, scope: 'agent', key: 'Language', value: 'French', ...patch } as MemoryMutation);
type Step = { sql: RegExp; rows?: unknown[]; inspect?: (values: unknown[]) => void };
function scripted(steps: Step[]) {
  let cursor = 0;
  return { client: { async query(sql: string, values: unknown[] = []) { const step = steps[cursor++]; assert.ok(step, `Unexpected SQL: ${sql}`); assert.match(sql, step.sql); step.inspect?.(values); return { rows: step.rows ?? [], rowCount: step.rows?.length ?? 0 }; } } as unknown as PoolClient, done() { assert.equal(cursor, steps.length); } };
}
const lock = (): Step => ({ sql: /pg_advisory_xact_lock/, inspect: values => assert.deepEqual(values, ['memory-owner:owner']) });
const prior = (): Step => ({ sql: /SELECT request,snapshot/, rows: [] });
const current = (rows: unknown[] = []): Step => ({ sql: /SELECT \* FROM agent_memories WHERE id=\$1 AND owner_id=\$2 FOR UPDATE/, rows });
const error = (code: string) => (value: unknown) => value instanceof CapabilityError && value.code === code;
test('retrieval validates conversation owner before querying bounded scoped live facts', async () => {
  const db = scripted([{ sql: /agent_conversations WHERE id=\$1 AND owner_id=\$2/, rows: [{ id: cid }], inspect: values => assert.deepEqual(values, [cid, 'owner']) }, { sql: /owner_id=\$1[\s\S]*scope='agent'[\s\S]*conversation_id=\$2[\s\S]*deleted_at IS NULL[\s\S]*expires_at>clock_timestamp\(\)[\s\S]*LIMIT 100/, rows: [row()], inspect: values => assert.deepEqual(values, ['owner', cid]) }]);
  assert.equal((await retrieveMemories(db.client, 'owner', cid, 'preferred language'))[0].value, 'French'); db.done();
  const denied = scripted([{ sql: /agent_conversations/, rows: [] }]);
  await assert.rejects(retrieveMemories(denied.client, 'other', cid, ''), error('MEMORY_SCOPE_DENIED')); denied.done();
});
test('empty-query agent listing passes a null conversation and SQL remains parameterized', async () => {
  const query = "' OR 1=1 --";
  const db = scripted([{ sql: /SELECT \* FROM agent_memories/, rows: [row()], inspect: values => assert.deepEqual(values, ['owner', null]) }]);
  assert.deepEqual(await retrieveMemories(db.client, 'owner', null, query), []); db.done();
});
test('snapshot checks lock ordered current live scoped rows and reject missing or changed versions', async () => {
  for (const rows of [[], [row({ version: 2 })]]) {
    const db = scripted([{ sql: /agent_conversations/, rows: [{ id: cid }] }, { sql: /owner_id=\$1[\s\S]*id=ANY\(\$2::uuid\[\]\)[\s\S]*conversation_id=\$3[\s\S]*deleted_at IS NULL[\s\S]*expires_at>clock_timestamp\(\)[\s\S]*ORDER BY id FOR SHARE/, rows }]);
    await assert.rejects(assertMemoryVersions(db.client, 'owner', cid, [{ id, version: 1 }]), error('MEMORY_CONTEXT_CHANGED')); db.done();
  }
  const valid = scripted([{ sql: /agent_conversations/, rows: [{ id: cid }] }, { sql: /FOR SHARE/, rows: [row()] }]);
  await assertMemoryVersions(valid.client, 'owner', cid, [{ id, version: 1 }]); valid.done();
  const empty = scripted([]); await assertMemoryVersions(empty.client, 'owner', cid, []); empty.done();
});
test('memory version check denies foreign conversation and duplicate references', async () => {
  const db = scripted([{ sql: /agent_conversations/, rows: [] }]);
  await assert.rejects(assertMemoryVersions(db.client, 'other', cid, [{ id, version: 1 }]), error('MEMORY_CONTEXT_CHANGED')); db.done();
  await assert.rejects(assertMemoryVersions(scripted([]).client, 'owner', cid, [{ id, version: 1 }, { id, version: 1 }]), error('MEMORY_CONTEXT_CHANGED'));
});
test('remember serializes quota and uniqueness, then records immutable human provenance', async () => {
  const db = scripted([lock(), prior(), current(), { sql: /count\(\*\)/, rows: [{ count: 0 }] }, { sql: /normalized_key=\$4 AND deleted_at IS NULL/, rows: [], inspect: values => assert.deepEqual(values, ['owner', 'agent', null, 'language']) }, { sql: /INSERT INTO agent_memories/, rows: [row()], inspect: values => assert.equal(values[7], '{"kind":"explicit_human"}') }, { sql: /INSERT INTO agent_memory_revisions/, inspect: values => { assert.equal(values[2], 'owner'); assert.equal(values[3], rid); assert.equal(JSON.parse(values[6] as string).version, 1); } }]);
  assert.equal((await mutateMemory(db.client, 'owner', input())).status, 201); db.done();
});
test('exact request retries return the original revision after edits/deletion; payload reuse conflicts', async () => {
  const snapshot = { id, version: 1, value: 'French' };
  const db = scripted([lock(), { sql: /SELECT request,snapshot/, rows: [{ request: input(), snapshot }] }]);
  assert.deepEqual(await mutateMemory(db.client, 'owner', input()), { status: 200, memory: snapshot, replayed: true }); db.done();
  const changed = scripted([lock(), { sql: /SELECT request,snapshot/, rows: [{ request: input(), snapshot }] }]);
  await assert.rejects(mutateMemory(changed.client, 'owner', input({ value: 'Spanish' })), error('MEMORY_REQUEST_CONFLICT')); changed.done();
});
test('CAS rejects stale writes, deleted records and foreign IDs without mutation', async () => {
  for (const [rows, code] of [[[], 'MEMORY_MISSING'], [[row({ version: 2 })], 'MEMORY_VERSION_CONFLICT'], [[row({ deleted_at: new Date() })], 'MEMORY_VERSION_CONFLICT']] as const) {
    const db = scripted([lock(), prior(), current([...rows])]);
    await assert.rejects(mutateMemory(db.client, 'owner', { action: 'forget', id, requestId: rid, expectedVersion: 1 }), error(code)); db.done();
  }
});
test('owner quota and normalized scoped key conflicts fail closed', async () => {
  const quota = scripted([lock(), prior(), current(), { sql: /count\(\*\)/, rows: [{ count: 100 }] }]);
  await assert.rejects(mutateMemory(quota.client, 'owner', input()), error('MEMORY_LIMIT')); quota.done();
  const duplicate = scripted([lock(), prior(), current(), { sql: /count\(\*\)/, rows: [{ count: 1 }] }, { sql: /normalized_key=\$4/, rows: [{ id: 'existing' }] }]);
  await assert.rejects(mutateMemory(duplicate.client, 'owner', input()), error('MEMORY_KEY_CONFLICT')); duplicate.done();
});
test('provenance rejects nonexistent or cross-owner conversations and mismatched turn/message', async () => {
  const base = () => [lock(), prior(), current(), { sql: /count\(\*\)/, rows: [{ count: 0 }] }];
  const foreign = scripted([...base(), { sql: /agent_conversations/, rows: [] }]);
  await assert.rejects(mutateMemory(foreign.client, 'owner', input({ source: { conversationId: cid } })), error('MEMORY_SCOPE_DENIED')); foreign.done();
  const missing = scripted([...base(), { sql: /agent_conversations/, rows: [{ id: cid }] }, { sql: /conversation_turns[\s\S]*sequence=\$2[\s\S]*message_id=\$3/, rows: [], inspect: values => assert.deepEqual(values, [cid, 2, rid]) }]);
  await assert.rejects(mutateMemory(missing.client, 'owner', input({ source: { conversationId: cid, sequence: 2, messageId: rid } })), error('MEMORY_SOURCE_MISSING')); missing.done();
});
test('forget writes a tombstone and revision; the last reserved revision stays deletable', async () => {
  const deletedAt = '2026-11-09T00:00:00.000Z';
  const db = scripted([lock(), prior(), current([row({ version: 99 })]), { sql: /version=version\+1,deleted_at=clock_timestamp\(\)/, rows: [row({ version: 100, deleted_at: deletedAt })] }, { sql: /INSERT INTO agent_memory_revisions/, inspect: values => assert.equal(JSON.parse(values[6] as string).deletedAt, deletedAt) }]);
  const result = await mutateMemory(db.client, 'owner', { action: 'forget', id, requestId: rid, expectedVersion: 99 });
  assert.equal(result.memory.version, 100); assert.equal(result.memory.deletedAt, deletedAt); db.done();
  const exhausted = scripted([lock(), prior(), current([row({ version: 99 })])]);
  await assert.rejects(mutateMemory(exhausted.client, 'owner', { action: 'update', id, requestId: rid, expectedVersion: 99, value: 'Spanish' }), error('MEMORY_REVISION_LIMIT')); exhausted.done();
});
test('history reads are scoped to the authenticated owner including tombstones', async () => {
  const db = scripted([{ sql: /id=\$1 AND owner_id=\$2/, rows: [], inspect: values => assert.deepEqual(values, [id, 'other']) }]);
  await assert.rejects(memoryHistory(db.client, 'other', id), error('MEMORY_MISSING')); db.done();
});
test('updates append new explicit provenance and replace value and expiry atomically', async () => {
  const expiresAt = '2099-11-09T00:00:00.000Z';
  const db = scripted([lock(), prior(), current([row()]), { sql: /UPDATE agent_memories SET version=version\+1,value=\$3,source=\$4,expires_at=\$5/, rows: [row({ value: 'Spanish', version: 2, expires_at: expiresAt })], inspect: values => assert.deepEqual(values, [id, 'owner', 'Spanish', '{"kind":"explicit_human"}', expiresAt]) }, { sql: /INSERT INTO agent_memory_revisions/, inspect: values => assert.equal(values[4], 'update') }]);
  const result = await mutateMemory(db.client, 'owner', { action: 'update', id, requestId: rid, expectedVersion: 1, value: 'Spanish', expiresAt });
  assert.equal(result.memory.version, 2); assert.equal(result.memory.value, 'Spanish'); db.done();
});
test('expired mutations fail without SQL writes but exact retries remain valid', async () => {
  const db = scripted([lock(), prior(), current([row()])]);
  await assert.rejects(mutateMemory(db.client, 'owner', { action: 'update', id, requestId: rid, expectedVersion: 1, value: 'Spanish', expiresAt: '2000-01-01T00:00:00.000Z' }), error('MEMORY_EXPIRY_INVALID')); db.done();
});
test('conversation-scoped facts cannot cite an unrelated conversation', async () => {
  const db = scripted([lock(), prior(), current([row({ scope: 'conversation', conversation_id: cid })])]);
  await assert.rejects(mutateMemory(db.client, 'owner', { action: 'update', id, requestId: rid, expectedVersion: 1, value: 'Spanish', source: { conversationId: rid } }), error('MEMORY_SOURCE_SCOPE_MISMATCH')); db.done();
});

test('malformed snapshot references fail closed before SQL', async () => {
  const db = scripted([]);
  await assert.rejects(assertMemoryVersions(db.client, 'owner', cid, [{ id: 'invalid', version: 1 }]), error('MEMORY_CONTEXT_CHANGED'));
  await assert.rejects(assertMemoryVersions(db.client, 'owner', cid, [{ id, version: 0 }]), error('MEMORY_CONTEXT_CHANGED'));
  db.done();
});
