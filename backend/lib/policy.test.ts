import assert from 'node:assert/strict';
import { test } from 'node:test';
import { approval, offers, violations } from './policy.ts';

test('payout candidates fit the saved authorization', () => {
  for (const offer of offers('payout')) assert.deepEqual(violations(offer, approval), []);
});

test('review candidates independently exceed budget and lack required rights', () => {
  const [maya, sam] = offers('review');
  assert.match(violations(maya, approval).join(' '), /budget/);
  assert.match(violations(sam, approval).join(' '), /usage rights/);
});

test('a compliant milestone cannot authorize an over-budget deal', () => {
  const [offer] = offers('payout');
  assert.equal(violations({ ...offer, totalCents: approval.capCents }, approval).length, 0);
  assert.equal(violations({ ...offer, totalCents: approval.capCents + 1 }, approval).length, 1);
  assert.equal(violations({ ...offer, milestoneCents: offer.totalCents + 1 }, approval).length, 1);
});
