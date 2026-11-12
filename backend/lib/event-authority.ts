import type { PoolClient } from 'pg';
import { CapabilityError } from './capability-contracts';
import { assertEventTemplate, type EventSourceRow } from './event-store';

/** Caller holds conversation lock before source lock. Ordinary turns have no event. */
export async function assertEventTurnAuthority(client: PoolClient, conversationId: string, sequence: number): Promise<void> {
  const turn = (await client.query('SELECT event_id FROM conversation_turns WHERE conversation_id=$1 AND sequence=$2', [conversationId, sequence])).rows[0];
  if (!turn?.event_id) return;
  const row = (await client.query(`SELECT s.*,e.source_version,e.owner_id AS event_owner,e.conversation_id AS event_conversation,c.owner_id AS conversation_owner,c.grants_active,p.enabled,p.permissions
    FROM agent_event_inbox e JOIN agent_event_sources s ON s.id=e.source_id
    JOIN agent_conversations c ON c.id=e.conversation_id JOIN agent_profiles p ON p.id=c.agent_id
    WHERE e.id=$1 AND e.conversation_id=$2 AND e.sequence=$3 FOR SHARE OF s`, [turn.event_id, conversationId, sequence])).rows[0];
  if (!row || row.conversation_id !== conversationId || row.event_conversation !== conversationId || row.owner_id !== row.event_owner || row.owner_id !== row.conversation_owner || row.version !== row.source_version || row.status !== 'active' || new Date(row.expires_at).getTime() <= Date.now() || !row.grants_active || !row.enabled || !['read_context', 'reply'].every(permission => row.permissions.includes(permission))) throw new CapabilityError('EVENT_REVOKED', 409);
  try { await assertEventTemplate(client, row.owner_id, (row as EventSourceRow).capability_request); }
  catch { throw new CapabilityError('EVENT_REVOKED', 409); }
}
export async function getEventContext(client: PoolClient, conversationId: string, sequence: number): Promise<{ id: string; sourceId: string; sourceVersion: number; occurredAt: string; data: Record<string, unknown>; untrusted: true } | null> {
  await assertEventTurnAuthority(client, conversationId, sequence);
  const row = (await client.query(`SELECT e.id,e.source_id,e.source_version,e.occurred_at,e.data FROM conversation_turns t JOIN agent_event_inbox e ON e.id=t.event_id
    WHERE t.conversation_id=$1 AND t.sequence=$2 AND e.conversation_id=t.conversation_id AND e.sequence=t.sequence`, [conversationId, sequence])).rows[0];
  return row ? { id: row.id, sourceId: row.source_id, sourceVersion: row.source_version, occurredAt: new Date(row.occurred_at).toISOString(), data: row.data, untrusted: true } : null;
}
