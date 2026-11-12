import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { setTimeout as delay } from 'node:timers/promises';

const base = new URL(process.argv[2]);
const code = process.env.SUME_DEMO_CODE ??
  (await readFile(new URL('../.env.demo-code', import.meta.url), 'utf8')).trim();
const campaigns = new URL('/api/campaigns', base);

async function create(body) {
  return fetch(campaigns, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

async function begin(scenario, recoveryTest = false) {
  const request = { id: randomUUID(), code, approved: true, scenario, recoveryTest };
  const response = await create(request);
  assert.equal(response.status, 201, await response.clone().text());
  const session = await response.json();
  const duplicate = await create(request);
  assert.equal(duplicate.status, 201);
  assert.deepEqual(await duplicate.json(), session);
  return {
    url: new URL(campaigns.pathname + '/' + session.id, base),
    headers: { Authorization: 'Bearer ' + session.token },
  };
}

async function waitFor(session, expected) {
  const end = Date.now() + 180_000;
  let campaign;
  while (Date.now() < end) {
    const response = await fetch(session.url, { headers: session.headers });
    assert.equal(response.status, 200);
    campaign = await response.json();
    if (campaign.status === expected) return campaign;
    if (['failed', 'payment_review', 'review', 'paid'].includes(campaign.status)) break;
    await delay(3000);
  }
  assert.fail('Expected ' + expected + ', got ' + campaign?.status + ' with events ' +
    Object.keys(campaign?.event_log ?? {}).join(', '));
}

const unauthorized = await create({ id: randomUUID(), code: 'invalid', approved: true, scenario: 'payout' });
assert.equal(unauthorized.status, 403);
const unapproved = await create({ id: randomUUID(), code, approved: false, scenario: 'payout' });
assert.equal(unapproved.status, 400);
const [payout, review] = await Promise.all([begin('payout', true), begin('review')]);
assert.equal((await fetch(payout.url)).status, 403);
assert.equal((await fetch(payout.url, { headers: review.headers })).status, 403);

// No browser or polling client is needed during the background transition.
await delay(25_000);
const [paid, paused] = await Promise.all([waitFor(payout, 'paid'), waitFor(review, 'review')]);
assert.ok(paid.batch_id && paid.item_id);
assert.ok(paid.event_log.counteroffer.model);
assert.equal(paid.event_log.acceptance.source, 'fixture');
assert.equal(paid.event_log.delivery.source, 'fixture');
assert.equal(paid.event_log.interruption.source, 'test');
assert.equal(paused.deal, null);
assert.equal(paused.batch_id, null);
assert.equal(paused.item_id, null);
assert.ok(paused.event_log.counteroffer.problems.length);

const replay = await fetch(payout.url, {
  method: 'POST',
  headers: { ...payout.headers, 'Content-Type': 'application/json' },
  body: JSON.stringify({ event: 'delivery' }),
});
assert.equal(replay.status, 204);
const afterReplay = await waitFor(payout, 'paid');
assert.equal(afterReplay.item_id, paid.item_id);
assert.equal(afterReplay.batch_id, paid.batch_id);
console.log('PASS: authorization, isolated sessions, duplicate approval, live review, interrupted payout retry, and delivery replay.');
console.log('Confirmed Sandbox milestone:', paid.deal.milestoneCents / 100, 'USD');
