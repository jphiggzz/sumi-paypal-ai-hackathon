import type { PoolClient } from 'pg';
import type { z } from 'zod';
import { randomUUID } from 'node:crypto';
import { CapabilityError } from './capability-contracts';
import { canonicalJson } from './canonical-json';
import { assertAdmissionWindow } from './admission-window';
import { authorizeConnectionUse } from './connection-store';
import { followUpInput } from './conversation-policy';
import { EVENT_SOURCE_LIMIT, EVENT_SOURCE_INBOX_LIMIT, EVENT_SOURCE_VERSION_LIMIT, eventSourceChange, eventSourceCreate, eventSigningSecret, eventMessageId, eventBodyDigest, sourceExpiry, type EventEnvelope, type EventSourceCreate, type EventSourceChange } from './event-policy';

export type EventSourceRow = {
  id: string; owner_id: string; conversation_id: string; version: number; signing_generation: number;
  status: 'active' | 'paused' | 'cancelled'; instruction: string;
  execution_mode: 'checkpoint' | 'capability_check'; capability_request: z.infer<typeof followUpInput>['capabilityRequest'] | null;
  create_request: EventSourceCreate; expires_at: Date | string; fixture: true;
};
export function eventSourceHandle(row: EventSourceRow) {
  return { id: row.id, conversationId: row.conversation_id, version: row.version, status: row.status, instruction: row.instruction, executionMode: row.execution_mode, capabilityRequest: row.capability_request, expiresAt: new Date(row.expires_at).toISOString(), fixture: true as const };
}
export async function getEventSource(client: PoolClient, id: string): Promise<EventSourceRow | undefined> {
  return (await client.query('SELECT * FROM agent_event_sources WHERE id=$1', [id])).rows[0];
}
async function lockOwnedConversation(client: PoolClient, owner: string, id: string) {
  const row = (await client.query('SELECT c.*,p.enabled,p.permissions FROM agent_conversations c JOIN agent_profiles p ON p.id=c.agent_id WHERE c.id=$1 AND c.owner_id=$2 FOR UPDATE OF c', [id, owner])).rows[0];
  if (!row) throw new CapabilityError('EVENT_CONVERSATION_MISSING', 404);
  return row;
}
function assertConversationGrant(row: { grants_active: boolean; enabled: boolean; permissions: string[] }) {
  if (!row.grants_active || !row.enabled || !['read_context', 'reply'].every(permission => row.permissions.includes(permission))) throw new CapabilityError('EVENT_REVOKED', 409);
}
export async function assertEventTemplate(client: PoolClient, owner: string, request: EventSourceRow['capability_request']) {
  if (request?.tool === 'propose_fixture_note') {
    await authorizeConnectionUse(client, owner, request.input.connectionId, { expectedVersion: request.input.connectionVersion, requiredScopes: ['notes:write'], resourceId: request.input.resourceId });
  }
  if (request?.tool === 'read_fixture_document' || request?.tool === 'list_fixture_documents') {
    const input = request.input;
    await authorizeConnectionUse(client, owner, input.connectionId, { expectedVersion: input.expectedVersion, requiredScopes: ['documents:read'], ...('resourceId' in input ? { resourceId: input.resourceId } : {}) });
  }
}
function assertNoSigningSecret(input: unknown, sourceId: string, generations: number[]) {
  const text = JSON.stringify(input);
  if (Array.from({ length: Math.max(...generations) }, (_, index) => index + 1).some(generation => text.includes(eventSigningSecret(sourceId, generation)))) throw new CapabilityError('EVENT_SECRET_IN_CONTENT', 400);
}
async function revision(client: PoolClient, row: EventSourceRow, action: string) {
  await client.query('INSERT INTO agent_event_source_revisions(source_id,version,owner_id,action,snapshot) VALUES($1,$2,$3,$4,$5)', [row.id, row.version, row.owner_id, action, JSON.stringify(eventSourceHandle(row))]);
}
/** Caller supplies a transaction. Lock order: conversation, source, connection. */
export async function createEventSource(client: PoolClient, owner: string, raw: EventSourceCreate) {
  const input = eventSourceCreate.parse(raw);
  const conversation = await lockOwnedConversation(client, owner, input.conversationId);
  assertConversationGrant(conversation);
  await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [`event-sources:${owner}`]);
  const prior = (await client.query('SELECT * FROM agent_event_sources WHERE id=$1 FOR UPDATE', [input.id])).rows[0] as EventSourceRow | undefined;
  if (prior) {
    if (prior.owner_id !== owner || prior.version !== 1 || canonicalJson(prior.create_request) !== canonicalJson(input)) throw new CapabilityError('EVENT_SOURCE_CONFLICT', 409);
    return { status: 200, source: eventSourceHandle(prior), signingSecret: eventSigningSecret(prior.id, prior.signing_generation) };
  }
  const count = (await client.query('SELECT count(*)::integer AS count FROM agent_event_sources WHERE owner_id=$1', [owner])).rows[0].count;
  if (count >= EVENT_SOURCE_LIMIT) throw new CapabilityError('EVENT_SOURCE_LIMIT', 429);
  assertNoSigningSecret(input, input.id, [1]);
  await assertEventTemplate(client, owner, input.capabilityRequest ?? null);
  const row = (await client.query(`INSERT INTO agent_event_sources(id,owner_id,conversation_id,instruction,execution_mode,capability_request,create_request,expires_at)
    VALUES($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *`, [input.id, owner, input.conversationId, input.instruction, input.executionMode, input.capabilityRequest ? JSON.stringify(input.capabilityRequest) : null, JSON.stringify(input), sourceExpiry(input.expiresAt)])).rows[0] as EventSourceRow;
  await revision(client, row, 'create');
  return { status: 201, source: eventSourceHandle(row), signingSecret: eventSigningSecret(row.id, row.signing_generation) };
}
export async function changeEventSource(client: PoolClient, owner: string, id: string, raw: EventSourceChange) {
  const input = eventSourceChange.parse(raw);
  // Read only the owned routing key before taking authoritative ordered locks.
  const target = (await client.query('SELECT conversation_id FROM agent_event_sources WHERE id=$1 AND owner_id=$2', [id, owner])).rows[0];
  if (!target) throw new CapabilityError('EVENT_SOURCE_MISSING', 404);
  const conversation = await lockOwnedConversation(client, owner, target.conversation_id);
  const current = (await client.query('SELECT * FROM agent_event_sources WHERE id=$1 AND owner_id=$2 FOR UPDATE', [id, owner])).rows[0] as EventSourceRow;
  if (current.version !== input.expectedVersion || current.status === 'cancelled') throw new CapabilityError('EVENT_SOURCE_VERSION_CONFLICT', 409);
  if (current.version >= EVENT_SOURCE_VERSION_LIMIT || (input.action !== 'cancel' && current.version >= EVENT_SOURCE_VERSION_LIMIT - 1)) throw new CapabilityError('EVENT_SOURCE_REVISION_LIMIT', 429);
  if (input.action === 'pause' && current.status !== 'active' || input.action === 'resume' && current.status !== 'paused') throw new CapabilityError('EVENT_SOURCE_STATE_CONFLICT', 409);
  if (input.action === 'resume' || input.action === 'edit') {
    assertConversationGrant(conversation);
    if (input.action === 'resume' && new Date(current.expires_at).getTime() <= Date.now()) throw new CapabilityError('EVENT_REVOKED', 409);
    await assertEventTemplate(client, owner, input.action === 'edit' ? input.capabilityRequest ?? null : current.capability_request);
  }
  assertNoSigningSecret(input, id, [current.signing_generation, current.signing_generation + (input.action === 'rotate' ? 1 : 0)]);
  const status = input.action === 'pause' ? 'paused' : input.action === 'resume' ? 'active' : input.action === 'cancel' ? 'cancelled' : current.status;
  const row = (await client.query(`UPDATE agent_event_sources SET version=version+1,status=$3,signing_generation=signing_generation+$4,
    instruction=$5,execution_mode=$6,capability_request=$7,expires_at=$8,updated_at=clock_timestamp() WHERE id=$1 AND owner_id=$2 RETURNING *`, [id, owner, status, input.action === 'rotate' ? 1 : 0, input.action === 'edit' ? input.instruction : current.instruction, input.action === 'edit' ? input.executionMode : current.execution_mode, (input.action === 'edit' ? input.capabilityRequest : current.capability_request) ? JSON.stringify(input.action === 'edit' ? input.capabilityRequest : current.capability_request) : null, input.action === 'edit' && input.expiresAt ? sourceExpiry(input.expiresAt) : current.expires_at])).rows[0] as EventSourceRow;
  await revision(client, row, input.action);
  // Fences both queued and running old-generation work; committed history remains.
  await client.query(`UPDATE conversation_turns t SET status='cancelled',error_code='EVENT_REVOKED'
    FROM agent_event_inbox e WHERE t.event_id=e.id AND e.source_id=$1 AND e.source_version<$2 AND t.status IN ('queued','running')`, [id, row.version]);
  const { refreshConversationStatus } = await import('./conversation-store');
  await refreshConversationStatus(client, row.conversation_id);
  return { status: 200, source: eventSourceHandle(row), ...(input.action === 'rotate' ? { signingSecret: eventSigningSecret(row.id, row.signing_generation) } : {}) };
}
export async function listEventSources(client: PoolClient, owner: string) {
  return (await client.query('SELECT * FROM agent_event_sources WHERE owner_id=$1 ORDER BY created_at DESC LIMIT 20', [owner])).rows.map(eventSourceHandle);
}
export async function ownedEventSource(client: PoolClient, owner: string, id: string, includeData = false) {
  const row = (await client.query('SELECT * FROM agent_event_sources WHERE id=$1 AND owner_id=$2', [id, owner])).rows[0] as EventSourceRow | undefined;
  if (!row) throw new CapabilityError('EVENT_SOURCE_MISSING', 404);
  const events = (await client.query(`SELECT id,event_key,source_version,occurred_at,created_at,sequence${includeData ? ',data' : ''} FROM agent_event_inbox WHERE source_id=$1 AND owner_id=$2 ORDER BY created_at DESC LIMIT 100`, [id, owner])).rows;
  return { source: eventSourceHandle(row), events };
}
/** Cheap preflight before starting a recovery watcher. Admission repeats every
 * check under its own transaction, so this never grants execution authority. */
export async function preflightEvent(client: PoolClient, sourceSnapshot: EventSourceRow): Promise<void> {
  const conversation = await lockOwnedConversation(client, sourceSnapshot.owner_id, sourceSnapshot.conversation_id);
  const source = (await client.query('SELECT * FROM agent_event_sources WHERE id=$1 AND owner_id=$2 FOR SHARE', [sourceSnapshot.id, sourceSnapshot.owner_id])).rows[0] as EventSourceRow | undefined;
  if (!source || source.signing_generation !== sourceSnapshot.signing_generation) throw new CapabilityError('EVENT_SIGNATURE_INVALID', 401);
  if (source.version !== sourceSnapshot.version || source.status !== 'active' || new Date(source.expires_at).getTime() <= Date.now()) throw new CapabilityError('EVENT_REVOKED', 409);
  assertConversationGrant(conversation);
  await assertEventTemplate(client, source.owner_id, source.capability_request);
}
/** HMAC already verified over rawBody. Recheck signing generation under locks. */
export async function admitEvent(client: PoolClient, sourceSnapshot: EventSourceRow, envelope: EventEnvelope, rawBody: Uint8Array, recoveryDeadline?: number) {
  await assertAdmissionWindow(client, recoveryDeadline);
  const conversation = await lockOwnedConversation(client, sourceSnapshot.owner_id, sourceSnapshot.conversation_id);
  const source = (await client.query('SELECT * FROM agent_event_sources WHERE id=$1 AND owner_id=$2 FOR UPDATE', [sourceSnapshot.id, sourceSnapshot.owner_id])).rows[0] as EventSourceRow | undefined;
  if (!source || source.signing_generation !== sourceSnapshot.signing_generation) throw new CapabilityError('EVENT_SIGNATURE_INVALID', 401);
  if (source.version !== sourceSnapshot.version || source.status !== 'active' || new Date(source.expires_at).getTime() <= Date.now()) throw new CapabilityError('EVENT_REVOKED', 409);
  assertConversationGrant(conversation);
  const digest = eventBodyDigest(rawBody);
  const prior = (await client.query('SELECT id,body_digest,sequence FROM agent_event_inbox WHERE source_id=$1 AND event_key=$2', [source.id, envelope.eventId])).rows[0];
  if (prior) {
    if (prior.body_digest !== digest) throw new CapabilityError('EVENT_REPLAY_CONFLICT', 409);
    return { accepted: true, replayed: true, eventId: prior.id, sequence: prior.sequence, status: 202 };
  }
  const count = (await client.query('SELECT count(*)::integer AS count FROM agent_event_inbox WHERE source_id=$1', [source.id])).rows[0].count;
  if (count >= EVENT_SOURCE_INBOX_LIMIT) throw new CapabilityError('EVENT_INBOX_LIMIT', 429);
  await assertEventTemplate(client, source.owner_id, source.capability_request);
  const eventId = randomUUID();
  await client.query(`INSERT INTO agent_event_inbox(id,source_id,source_version,owner_id,conversation_id,event_key,body_digest,occurred_at,data)
    VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)`, [eventId, source.id, source.version, source.owner_id, source.conversation_id, envelope.eventId, digest, envelope.occurredAt, JSON.stringify(envelope.data)]);
  const parsed = followUpInput.parse({ messageId: eventMessageId(source.id, envelope.eventId), text: source.instruction, executionMode: source.execution_mode, capabilityRequest: source.capability_request ?? undefined, dispatchRecoveryTest: true });
  const { appendEventTurn } = await import('./conversation-store');
  const result = await appendEventTurn(client, source.conversation_id, source.owner_id, parsed, eventId, recoveryDeadline);
  if (result.status !== 201 || !result.sequence) throw new CapabilityError(result.status === 429 ? 'EVENT_TURN_LIMIT' : 'EVENT_ADMISSION_CONFLICT', result.status === 429 ? 429 : 409);
  await client.query('UPDATE agent_event_inbox SET sequence=$2 WHERE id=$1', [eventId, result.sequence]);
  await assertAdmissionWindow(client, recoveryDeadline);
  return { accepted: true, replayed: false, eventId, sequence: result.sequence, status: 202 };
}
