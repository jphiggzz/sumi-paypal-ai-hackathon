import assert from 'node:assert/strict';
import { test } from 'node:test';
import { artifactDigest } from './agent-hash.ts';
import { decisionInput, draftInput, sameDecision, sourceStats, taskInput } from './agent-policy.ts';

test('approvals bind both title and content, not just task identity', () => {
  const original = artifactDigest('Report', 'Version one');
  assert.notEqual(original, artifactDigest('Report', 'Version two'));
  assert.notEqual(original, artifactDigest('Other title', 'Version one'));
  assert.equal(original, artifactDigest('Report', 'Version one'));
  assert.equal(sameDecision({ decision: 'approve', digest: original }, { decision: 'reject', digest: original }), false);
});
test('task and artifact boundaries reject empty or oversized input', () => {
  assert.equal(taskInput.safeParse({ id: 'invalid', instruction: 'test', source: 'text' }).success, false);
  assert.equal(draftInput.safeParse({ title: 'x', markdown: ' ' }).success, false);
  assert.equal(draftInput.safeParse({ title: 'x', markdown: 'x'.repeat(20001) }).success, false);
  assert.equal(decisionInput.safeParse({ decision: 'approve', digest: 'anything' }).success, false);
});
test('source tool returns independently checkable text statistics', () => {
  assert.deepEqual(sourceStats('One two\nthree'), { characters: 13, words: 3, lines: 2 });
});
