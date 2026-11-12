import type { PoolClient } from 'pg';
import { z } from 'zod';
import { CapabilityError, type MemoryFact, type MemoryReference } from './capability-contracts';
import { MEMORY_LIMIT, MEMORY_REVISION_LIMIT, memoryMutation, normalizeMemoryKey, selectMemories, type MemoryMutation } from './memory-policy';

type MemoryRow = {
  id: string; owner_id: string; scope: 'agent' | 'conversation'; conversation_id: string | null;
  key: string; value: string; version: number; source: Record<string, unknown>;
  expires_at: Date | string | null; deleted_at: Date | string | null;
};
const iso = (date: Date | string | null) => date ? new Date(date).toISOString() : null;
function fact(row: MemoryRow): MemoryFact {
  return { id: row.id, version: row.version, key: row.key, value: row.value, scope: row.scope, conversationId: row.conversation_id, expiresAt: iso(row.expires_at), source: row.source };
}
async function assertConversation(client: PoolClient, ownerId: string, conversationId: string) {
  const result = await client.query('SELECT id FROM agent_conversations WHERE id=$1 AND owner_id=$2', [conversationId, ownerId]);
  if (!result.rowCount) throw new CapabilityError('MEMORY_SCOPE_DENIED', 404);
}
/** Caller owns the transaction. Owner is session-derived, never request-derived. */
export async function retrieveMemories(client: PoolClient, ownerId: string, conversationId: string | null, query: string, limit = 5): Promise<MemoryFact[]> {
  if (conversationId) await assertConversation(client, ownerId, conversationId);
  // Scope before lexical ranking; bounded owner rows never become a global search.
  const result = await client.query(`SELECT * FROM agent_memories WHERE owner_id=$1
    AND (scope='agent' OR (scope='conversation' AND conversation_id=$2))
    AND deleted_at IS NULL AND (expires_at IS NULL OR expires_at>clock_timestamp())
    ORDER BY id LIMIT 100`, [ownerId, conversationId]);
  return selectMemories(result.rows.map(fact), query, limit);
}
/** SHARE locks serialize a final output commit against concurrent update/forget. */
export async function assertMemoryVersions(client: PoolClient, ownerId: string, conversationId: string, refs: MemoryReference[]): Promise<void> {
  if (!refs.length) return;
  if (!z.array(z.strictObject({ id: z.uuid(), version: z.number().int().positive() })).max(5).safeParse(refs).success || new Set(refs.map(ref => ref.id)).size !== refs.length) throw new CapabilityError('MEMORY_CONTEXT_CHANGED', 409);
  const owned = await client.query('SELECT id FROM agent_conversations WHERE id=$1 AND owner_id=$2', [conversationId, ownerId]);
  if (!owned.rowCount) throw new CapabilityError('MEMORY_CONTEXT_CHANGED', 409);
  const result = await client.query(`SELECT * FROM agent_memories WHERE owner_id=$1 AND id=ANY($2::uuid[])
    AND (scope='agent' OR (scope='conversation' AND conversation_id=$3))
    AND deleted_at IS NULL AND (expires_at IS NULL OR expires_at>clock_timestamp()) ORDER BY id FOR SHARE`, [ownerId, refs.map(ref => ref.id), conversationId]);
  if (result.rows.length !== refs.length || refs.some(ref => !result.rows.some(row => row.id === ref.id && row.version === ref.version))) throw new CapabilityError('MEMORY_CONTEXT_CHANGED', 409);
}
async function validateSource(client: PoolClient, ownerId: string, input: Exclude<MemoryMutation, { action: 'forget' }>, scopeConversationId: string | null) {
  const source = input.source;
  if (!source) return { kind: 'explicit_human' };
  if (scopeConversationId && source.conversationId !== scopeConversationId) throw new CapabilityError('MEMORY_SOURCE_SCOPE_MISMATCH', 400);
  await assertConversation(client, ownerId, source.conversationId);
  if (source.sequence !== undefined || source.messageId !== undefined) {
    const result = await client.query(`SELECT sequence FROM conversation_turns WHERE conversation_id=$1
      AND ($2::integer IS NULL OR sequence=$2) AND ($3::uuid IS NULL OR message_id=$3)`, [source.conversationId, source.sequence ?? null, source.messageId ?? null]);
    if (!result.rowCount) throw new CapabilityError('MEMORY_SOURCE_MISSING', 404);
  }
  return { kind: 'explicit_human', ...source };
}
/** Exactly-once request IDs cover committed mutations, including forgotten facts.
 * Same owner/request ID + same canonical parsed payload => original revision.
 * Different payload => conflict. CAS serializes all updates and key/quota checks.
 * Caller must use a transaction, so revision and current fact commit atomically.
 */
export async function mutateMemory(client: PoolClient, ownerId: string, rawInput: MemoryMutation) {
  const input = memoryMutation.parse(rawInput);
  const canonical = JSON.stringify(input);
  await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", [`memory-owner:${ownerId}`]);
  const prior = (await client.query('SELECT request,snapshot FROM agent_memory_revisions WHERE owner_id=$1 AND request_id=$2', [ownerId, input.requestId])).rows[0];
  if (prior) {
    // JSONB changes object order; compare canonical values through the same schema.
    if (JSON.stringify(memoryMutation.parse(prior.request)) !== canonical) throw new CapabilityError('MEMORY_REQUEST_CONFLICT', 409);
    return { status: 200, memory: prior.snapshot, replayed: true };
  }
  const current: MemoryRow | undefined = (await client.query('SELECT * FROM agent_memories WHERE id=$1 AND owner_id=$2 FOR UPDATE', [input.id, ownerId])).rows[0];
  let row: MemoryRow;
  if (input.action === 'remember') {
    if (current) throw new CapabilityError('MEMORY_VERSION_CONFLICT', 409);
    const count = (await client.query('SELECT count(*)::integer AS count FROM agent_memories WHERE owner_id=$1', [ownerId])).rows[0].count;
    if (count >= MEMORY_LIMIT) throw new CapabilityError('MEMORY_LIMIT', 429);
    if (input.scope === 'conversation') await assertConversation(client, ownerId, input.conversationId!);
    const source = await validateSource(client, ownerId, input, input.conversationId ?? null);
    assertExpiry(input.expiresAt);
    const key = normalizeMemoryKey(input.key);
    const duplicate = await client.query(`SELECT id FROM agent_memories WHERE owner_id=$1 AND scope=$2
      AND conversation_id IS NOT DISTINCT FROM $3::uuid AND normalized_key=$4 AND deleted_at IS NULL`, [ownerId, input.scope, input.conversationId ?? null, key]);
    if (duplicate.rowCount) throw new CapabilityError('MEMORY_KEY_CONFLICT', 409);
    // Cross-owner ID collision reveals no record and is an opaque request conflict.
    const inserted = await client.query(`INSERT INTO agent_memories(id,owner_id,scope,conversation_id,key,normalized_key,value,source,expires_at)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9) ON CONFLICT(id) DO NOTHING RETURNING *`, [input.id, ownerId, input.scope, input.conversationId ?? null, input.key, key, input.value, JSON.stringify(source), input.expiresAt ?? null]);
    if (!inserted.rowCount) throw new CapabilityError('MEMORY_REQUEST_CONFLICT', 409);
    row = inserted.rows[0];
  } else {
    if (!current) throw new CapabilityError('MEMORY_MISSING', 404);
    if (current.deleted_at || current.version !== input.expectedVersion) throw new CapabilityError('MEMORY_VERSION_CONFLICT', 409);
    // Reserve the final revision for forgetting: exhausted memories remain deletable.
    if (current.version >= MEMORY_REVISION_LIMIT || (input.action === 'update' && current.version >= MEMORY_REVISION_LIMIT - 1)) throw new CapabilityError('MEMORY_REVISION_LIMIT', 429);
    if (input.action === 'forget') {
      row = (await client.query('UPDATE agent_memories SET version=version+1,deleted_at=clock_timestamp(),updated_at=clock_timestamp() WHERE id=$1 AND owner_id=$2 RETURNING *', [input.id, ownerId])).rows[0];
    } else {
      const source = await validateSource(client, ownerId, input, current.conversation_id);
      assertExpiry(input.expiresAt);
      row = (await client.query('UPDATE agent_memories SET version=version+1,value=$3,source=$4,expires_at=$5,updated_at=clock_timestamp() WHERE id=$1 AND owner_id=$2 RETURNING *', [input.id, ownerId, input.value, JSON.stringify(source), input.expiresAt ?? null])).rows[0];
    }
  }
  const snapshot = { ...fact(row), deletedAt: iso(row.deleted_at) };
  await client.query('INSERT INTO agent_memory_revisions(memory_id,version,owner_id,request_id,action,request,snapshot) VALUES($1,$2,$3,$4,$5,$6,$7)', [row.id, row.version, ownerId, input.requestId, input.action, canonical, JSON.stringify(snapshot)]);
  return { status: input.action === 'remember' ? 201 : 200, memory: snapshot, replayed: false };
}
function assertExpiry(expiresAt: string | null | undefined) {
  if (expiresAt && new Date(expiresAt).getTime() <= Date.now()) throw new CapabilityError('MEMORY_EXPIRY_INVALID', 400);
}
export async function memoryHistory(client: PoolClient, ownerId: string, id: string) {
  const current = (await client.query('SELECT * FROM agent_memories WHERE id=$1 AND owner_id=$2', [id, ownerId])).rows[0];
  if (!current) throw new CapabilityError('MEMORY_MISSING', 404);
  const revisions = (await client.query('SELECT version,action,snapshot,created_at FROM agent_memory_revisions WHERE memory_id=$1 AND owner_id=$2 ORDER BY version LIMIT 100', [id, ownerId])).rows;
  return { memory: { ...fact(current), deletedAt: iso(current.deleted_at) }, revisions };
}
