import { test } from 'node:test';
import assert from 'node:assert/strict';
import { checkJudgeCode, isJudgeEmail } from './judge-access';

test('judge access requires the configured code and a synthetic judge identity', () => {
  const previous = process.env.SUME_JUDGE_CODE;
  try {
    process.env.SUME_JUDGE_CODE = 'a-private-test-code';
    assert.equal(checkJudgeCode('a-private-test-code'), true);
    assert.equal(checkJudgeCode('wrong'), false);
    assert.equal(isJudgeEmail('judge-12345678-1234-1234-1234-123456789abc@sumi.invalid'), true);
    assert.equal(isJudgeEmail('person@example.com'), false);
    assert.equal(isJudgeEmail('judge-anything@sumi.invalid'), false);
    delete process.env.SUME_JUDGE_CODE;
    assert.equal(checkJudgeCode('a-private-test-code'), false);
    assert.equal(checkJudgeCode(''), false);
  } finally {
    if (previous === undefined) delete process.env.SUME_JUDGE_CODE;
    else process.env.SUME_JUDGE_CODE = previous;
  }
});
