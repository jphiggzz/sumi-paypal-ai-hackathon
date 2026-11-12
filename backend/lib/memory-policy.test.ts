import assert from 'node:assert/strict';
import { test } from 'node:test';
import { memoryMutation, normalizeMemoryKey, selectMemories, MEMORY_CONTEXT_CHARS } from './memory-policy';
import type { MemoryFact } from './capability-contracts';
const id = 'b2d505cb-3266-49c1-85bc-3a8cac63aa1b';
const requestId = 'b2d505cb-3266-49c1-85bc-3a8cac63aa1c';
const valid = () => ({ action: 'remember', id, requestId, expectedVersion: 0, scope: 'agent', key: 'Writing style', value: 'Use concise paragraphs.' });
const fact = (id: string, key: string, value: string): MemoryFact => ({ id, key, value, version: 1, scope: 'agent', conversationId: null, expiresAt: null, source: { kind: 'explicit_human' } });
test('memory writes require explicit operation, bounded values and matching scope', () => {
  assert.ok(memoryMutation.safeParse(valid()).success);
  for (const patch of [{ ownerId: 'other' }, { scope: 'conversation' }, { conversationId: id }, { expectedVersion: 1 }, { key: ' ' }, { key: 'a'.repeat(121) }, { value: 'a'.repeat(501) }, { value: '\u0000' }, { key: 'ﷺ'.repeat(120) }, { expiresAt: 'yesterday' }, { source: { conversationId: id, sequence: 0 } }, { source: { conversationId: id, text: 'fabricated content' } }]) assert.equal(memoryMutation.safeParse({ ...valid(), ...patch }).success, false, JSON.stringify(patch));
  assert.ok(memoryMutation.safeParse({ ...valid(), scope: 'conversation', conversationId: id, source: { conversationId: id, sequence: 2, messageId: requestId } }).success);
});
test('updates and forgets require CAS and cannot change scope or key', () => {
  assert.ok(memoryMutation.safeParse({ action: 'forget', id, requestId, expectedVersion: 1 }).success);
  assert.ok(memoryMutation.safeParse({ action: 'update', id, requestId, expectedVersion: 2, value: 'French' }).success);
  for (const patch of [{ expectedVersion: 0 }, { scope: 'agent' }, { key: 'renamed' }, { ownerId: 'someone' }]) assert.equal(memoryMutation.safeParse({ action: 'update', id, requestId, expectedVersion: 1, value: 'French', ...patch }).success, false);
});
test('normalized keys deduplicate case, Unicode width and spacing', () => {
  assert.equal(normalizeMemoryKey('  ＷＲＩＴＩＮＧ   Style  '), 'writing style');
});
test('lexical lookup ranks exact keys, plural/prefix matches and preference phrases', () => {
  const facts = [fact('3', 'Language', 'French'), fact('2', 'Project', 'A writing assignment'), fact('1', 'Writing style', 'Use concise paragraphs')];
  assert.equal(selectMemories(facts, 'writing style')[0].id, '1');
  assert.equal(selectMemories(facts, 'What are my preferred writing styles?')[0].id, '1');
  assert.equal(selectMemories(facts, 'Which language do I prefer?')[0].value, 'French');
  assert.deepEqual(selectMemories(facts, 'unknown antelopes'), []);
  assert.deepEqual(selectMemories(facts, "%%% '; DROP TABLE --"), []);
});
test('memory context preserves whole facts, count and serialized character budgets', () => {
  const facts = Array.from({ length: 10 }, (_, index) => fact(String(index), `item ${index}`, 'x'.repeat(500)));
  const result = selectMemories(facts, '', 100);
  assert.ok(result.length > 0 && result.length <= 5);
  assert.ok(JSON.stringify(result).length <= MEMORY_CONTEXT_CHARS);
  assert.ok(result.every(item => item.value.length === 500));
  assert.deepEqual(selectMemories(facts, '', 0), []);
  assert.deepEqual(selectMemories(facts, '', -2), []);
  assert.equal(selectMemories(facts.reverse(), '', NaN)[0].id, '0');
});
