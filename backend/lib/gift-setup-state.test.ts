import test from 'node:test';
import assert from 'node:assert/strict';
import { nextGiftSetupState, readGiftSetupState } from './gift-setup-state';

test('setup starts in brief and caps optional questions at two', () => {
  let state = readGiftSetupState(null, []);
  state = nextGiftSetupState(state, 'question-1', 'question');
  assert.equal(state.questions, 1);
  assert.deepEqual(nextGiftSetupState(state, 'question-1', 'question'), state);
  state = nextGiftSetupState(state, 'question-2', 'question');
  assert.equal(state.questions, 2);
  state = nextGiftSetupState(state, 'ready', 'ready');
  assert.deepEqual({ phase: state.phase, questions: state.questions }, { phase: 'ready', questions: 2 });
});

test('legacy conversations recover their progress without asking again', () => {
  assert.equal(readGiftSetupState(null, ['gift_clarification', 'gift_mock_handoff']).phase, 'ready');
  assert.equal(readGiftSetupState(null, ['gift_clarification']).questions, 1);
  assert.equal(readGiftSetupState(null, ['gift_clarification', 'gift_clarification', 'gift_clarification']).questions, 2);
});

test('ready can follow zero or one preference question', () => {
  const state = readGiftSetupState(null, []);
  assert.equal(nextGiftSetupState(state, 'ready', 'ready').questions, 0);
  assert.equal(nextGiftSetupState(nextGiftSetupState(state, 'q', 'question'), 'ready', 'ready').questions, 1);
});
