import { z } from 'zod';
import type { MemoryFact } from './capability-contracts';

export const MEMORY_LIMIT = 100;
export const MEMORY_CONTEXT_CHARS = 2000;
export const MEMORY_REVISION_LIMIT = 100;
const text = (max: number) => z.string().trim().min(1).max(max).refine(value => !/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/u.test(value));
export const memorySource = z.strictObject({
  conversationId: z.uuid(),
  sequence: z.number().int().positive().optional(),
  // The public message ID is conversation_turns.message_id, not a database row ID.
  messageId: z.uuid().optional(),
});
const metadata = {
  value: text(500),
  expiresAt: z.iso.datetime({ offset: true }).nullable().optional(),
  source: memorySource.optional(),
};
export const memoryMutation = z.discriminatedUnion('action', [
  z.strictObject({ action: z.literal('remember'), requestId: z.uuid(), id: z.uuid(), expectedVersion: z.literal(0), scope: z.enum(['agent', 'conversation']), conversationId: z.uuid().optional(), key: text(120).refine(key => normalizeMemoryKey(key).length <= 240), ...metadata }).refine(input => input.scope === 'conversation' ? !!input.conversationId : !input.conversationId, 'Scope requires its matching conversation'),
  z.strictObject({ action: z.literal('update'), requestId: z.uuid(), id: z.uuid(), expectedVersion: z.number().int().positive(), ...metadata }),
  z.strictObject({ action: z.literal('forget'), requestId: z.uuid(), id: z.uuid(), expectedVersion: z.number().int().positive() }),
]);
export type MemoryMutation = z.infer<typeof memoryMutation>;
export const memoryLookup = z.strictObject({
  conversationId: z.uuid().optional(), query: z.string().max(2000).default(''), limit: z.coerce.number().int().min(1).max(5).default(5),
});
export function normalizeMemoryKey(key: string) { return key.normalize('NFKC').trim().toLocaleLowerCase('en-US').replace(/\s+/gu, ' '); }
const stop = new Set('a an and are as at be by do for from how i in is it me my of on or our please the their them there these they this to use we what when where which who with would you your remember recall know tell prefer preferred preference preferences'.split(' '));
function terms(value: string) {
  return [...new Set(normalizeMemoryKey(value).match(/[\p{L}\p{N}]+/gu) ?? [])].filter(word => word.length > 1 && !stop.has(word)).slice(0, 80);
}
export function memoryScore(fact: Pick<MemoryFact, 'key' | 'value'>, query: string) {
  if (!query.trim()) return 1;
  const normalized = normalizeMemoryKey(query);
  const key = normalizeMemoryKey(fact.key);
  if (key === normalized) return 1000;
  const queryTerms = terms(query);
  if (!queryTerms.length) return 0;
  const keyTerms = terms(key), valueTerms = terms(fact.value);
  const matches = (a: string, b: string) => a === b || (Math.min(a.length, b.length) >= 3 && (a.startsWith(b) || b.startsWith(a)));
  return queryTerms.reduce((score, term) => score + (keyTerms.some(word => matches(word, term)) ? 10 : valueTerms.some(word => matches(word, term)) ? 2 : 0), 0);
}
export function selectMemories(facts: MemoryFact[], query: string, limit = 5): MemoryFact[] {
  const count = Number.isFinite(limit) ? Math.max(0, Math.min(5, Math.floor(limit))) : 5;
  const ranked = facts.map(fact => ({ fact, score: memoryScore(fact, query.slice(0, 2000)) })).filter(row => row.score > 0).sort((a, b) => b.score - a.score || a.fact.id.localeCompare(b.fact.id));
  const selected: MemoryFact[] = [];
  for (const { fact } of ranked) {
    if (selected.length === count) break;
    if (JSON.stringify([...selected, fact]).length <= MEMORY_CONTEXT_CHARS) selected.push(fact);
  }
  return selected;
}
