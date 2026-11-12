import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { PoolClient } from 'pg';
import { CapabilityError } from './capability-contracts';
import { assertEventTurnAuthority, getEventContext } from './event-authority';
const id = 'b2d505cb-3266-49c1-85bc-3a8cac63aa1b';
const sourceId = 'b2d505cb-3266-49c1-85bc-3a8cac63aa1c';
const row = (patch = {}) => ({ id: sourceId, conversation_id: id, source_version: 1, version: 1, event_owner: 'owner', owner_id: 'owner', event_conversation: id, conversation_owner: 'owner', status: 'active', expires_at: '2099-11-09T00:00:00Z', grants_active: true, enabled: true, permissions: ['read_context', 'reply'], capability_request: null, ...patch });
function scripted(steps: { sql: RegExp; rows: unknown[] }[]) {
  let index = 0;
  return { client: { async query(sql: string) { const step = steps[index++]; assert.ok(step, sql); assert.match(sql, step.sql); return { rows: step.rows, rowCount: step.rows.length }; } } as unknown as PoolClient, done() { assert.equal(index, steps.length); } };
}
const first = () => ({ sql: /SELECT event_id/, rows: [{ event_id: sourceId }] });
test('ordinary turns require no event authority or payload lookup', async () => {
  const db = scripted([{ sql: /SELECT event_id/, rows: [{ event_id: null }] }]);
  await assertEventTurnAuthority(db.client, id, 1); db.done();
});
test('event authority holds source shared lock and validates every source/grant boundary', async () => {
  const valid = scripted([first(), { sql: /e.sequence=\$3 FOR SHARE OF s/, rows: [row()] }]);
  await assertEventTurnAuthority(valid.client, id, 1); valid.done();
  for (const patch of [{ version: 2 }, { status: 'paused' }, { status: 'cancelled' }, { expires_at: '2000-01-01T00:00:00Z' }, { grants_active: false }, { enabled: false }, { permissions: ['read_context'] }, { owner_id: 'other' }, { event_conversation: sourceId }, { conversation_id: sourceId }, { conversation_owner: 'other' }]) {
    const db = scripted([first(), { sql: /FOR SHARE OF s/, rows: [row(patch)] }]);
    await assert.rejects(assertEventTurnAuthority(db.client, id, 1), error => error instanceof CapabilityError && error.code === 'EVENT_REVOKED'); db.done();
  }
});
test('event context is distinctly untrusted and includes no source secret or instruction', async () => {
  const db = scripted([first(), { sql: /FOR SHARE OF s/, rows: [row()] }, { sql: /e.data FROM conversation_turns/, rows: [{ id: sourceId, source_id: sourceId, source_version: 1, occurred_at: '2026-11-09T12:00:00Z', data: { instruction: 'Untrusted fixture' } }] }]);
  const context = await getEventContext(db.client, id, 1);
  assert.deepEqual(context, { id: sourceId, sourceId, sourceVersion: 1, occurredAt: '2026-11-09T12:00:00.000Z', data: { instruction: 'Untrusted fixture' }, untrusted: true }); db.done();
});
