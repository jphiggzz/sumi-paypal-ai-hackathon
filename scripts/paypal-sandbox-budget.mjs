import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { mkdir, writeFile } from 'node:fs/promises';
import { setTimeout as delay } from 'node:timers/promises';

import { campaignBudgetCents as budgetCents, runBudget } from './payout-budget-policy.mjs';

const sandbox = 'https://api-m.sandbox.paypal.com';
const payouts = '/v1/payments/payouts';
const fixture = [
  { creator: 'A', cents: 50000 },
  { creator: 'B', cents: 25000 },
  { creator: 'C', cents: 10000 },
];

function validateAgentPlan(plan) {
  assert.ok(Array.isArray(plan) && [2, 3].includes(plan.length), 'Expected one or two payouts and one budget probe');
  const selected = plan.slice(0, -1);
  const probe = plan.at(-1);
  const creators = selected.map(proposal => proposal?.creator);
  assert.ok(creators.every(creator => ['A', 'B'].includes(creator)), 'Unknown payout recipient');
  assert.equal(new Set(creators).size, creators.length, 'Duplicate payout recipient');
  assert.equal(probe?.creator, 'C');
  for (const proposal of plan) {
    assert.ok(Number.isSafeInteger(proposal.cents) && proposal.cents > 0, 'Invalid payout amount');
  }
  const total = selected.reduce((sum, { cents }) => sum + cents, 0);
  assert.ok(total <= budgetCents, 'Selected creator payouts exceed the budget');
  assert.ok(probe.cents > budgetCents - total, 'Third proposal must exceed the remaining budget');
  return plan.map(({ creator, cents }) => ({ creator, cents }));
}

async function selfTest() {
  const calls = [];
  const events = [];
  await runBudget(fixture, async (...args) => {
    calls.push(args);
    return { status: 'SUCCESS' };
  }, event => events.push(event));
  assert.deepEqual(calls, [['A', '500.00'], ['B', '250.00']]);
  assert.deepEqual(events.at(-1), {
    creator: 'C', cents: 10000, remaining: 5000, status: 'BLOCKED_BUDGET',
  });
  let attempts = 0;
  await assert.rejects(runBudget(fixture, async () => {
    attempts++;
    return { status: 'PENDING' };
  }, () => {}), /reconciliation/);
  assert.equal(attempts, 1);
  const agentPlan = [
    { creator: 'B', cents: 32000 },
    { creator: 'A', cents: 41000 },
    { creator: 'C', cents: 8000 },
  ];
  assert.deepEqual(validateAgentPlan(agentPlan), agentPlan);
  assert.throws(() => validateAgentPlan([
    ...agentPlan.slice(0, 2), { creator: 'C', cents: 7000 },
  ]), /Third proposal must exceed/);
  console.log('Local fixture passed: two payout calls, third blocked, pending stops further sends.');
}

export async function sandboxTest(proposals, source, options = {}) {
  const { config = process.env, onEvent = console.log, details, journal: customJournal, limit = budgetCents } = options;
  if (source === 'campaign') {
    assert.ok(customJournal && Number.isSafeInteger(limit) && limit > 0, 'Campaign requires a journal and authorized limit');
    assert.equal(proposals.length, 1, 'Expected one campaign payout');
    const [{ creator, cents }] = proposals;
    assert.ok(['A', 'B'].includes(creator) && Number.isSafeInteger(cents) && cents > 0 && cents <= limit, 'Invalid campaign payout');
  } else if (source !== 'fixture') proposals = validateAgentPlan(proposals);
  const names = ['CLIENT_ID', 'CLIENT_SECRET', 'CREATOR_A', 'CREATOR_B'];
  const values = names.map(name => config['PAYPAL_SANDBOX_' + name]?.trim());
  if (values.some(value => !value)) throw new Error('Missing PayPal sandbox credentials or recipients');
  const [client, secret, creatorA, creatorB] = values;
  const recipients = { A: creatorA, B: creatorB };
  const normalize = value => value.toLowerCase();
  if (normalize(creatorA) === normalize(creatorB) ||
      [creatorA, creatorB].some(value => !/^sb-[^@\s]+@(?:personal|business)\.example\.com$/i.test(value))) {
    throw new Error('Use two distinct PayPal-generated sandbox account emails');
  }

  async function request(path, options) {
    let response;
    try {
      response = await fetch(sandbox + path, {
        ...options, redirect: 'error', signal: AbortSignal.timeout(15000),
      });
    } catch {
      throw new Error('PayPal sandbox request interrupted');
    }
    if (!response.ok) throw new Error('PayPal sandbox returned HTTP ' + response.status);
    return response.json();
  }

  const { access_token: token } = await request('/v1/oauth2/token', {
    method: 'POST',
    headers: {
      Authorization: 'Basic ' + Buffer.from(client + ':' + secret).toString('base64'),
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: 'grant_type=client_credentials',
  });
  if (!token) throw new Error('PayPal sandbox did not return an access token');
  const headers = { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' };

  const journalName = source === 'agent' ? 'paypal-agent-budget-run.jsonl' : 'paypal-budget-run.jsonl';
  const journal = customJournal ?? new URL('../research/private/' + journalName, import.meta.url);
  await mkdir(new URL('.', journal), { recursive: true, mode: 0o700 });
  const runId = randomUUID();
  try {
    await writeFile(journal, JSON.stringify({ runId, budgetCents: limit, source, proposals, details }) + '\n', {
      flag: 'wx', mode: 0o600,
    });
  } catch (error) {
    if (error.code === 'EEXIST') throw new Error('A sandbox run already exists. Inspect its journal before any rerun.');
    throw error;
  }

  async function report(event) {
    await writeFile(journal, JSON.stringify(event) + '\n', { flag: 'a' });
    onEvent(event);
  }

  await runBudget(proposals, async (creator, value) => {
    const requestId = runId + '-' + creator;
    const receiver = recipients[creator];
    if (!receiver) throw new Error('Creator has no configured sandbox recipient');
    await report({ creator, requestId, status: 'SUBMITTING' });
    const batch = await request(payouts, {
      method: 'POST',
      headers: { ...headers, 'PayPal-Request-Id': requestId },
      body: JSON.stringify({
        sender_batch_header: { sender_batch_id: requestId, email_subject: 'Sandbox creator payout' },
        items: [{ recipient_type: 'EMAIL', receiver, amount: { currency: 'USD', value }, sender_item_id: creator }],
      }),
    });
    const batchId = batch.batch_header?.payout_batch_id;
    if (!batchId) throw new Error('Payout submission has no batch ID. Reconcile before retrying.');
    await report({ creator, batchId, status: 'SUBMITTED' });
    for (let poll = 0; poll < 12; poll++) {
      const details = await request(payouts + '/' + encodeURIComponent(batchId), { headers });
      const item = details.items?.find(entry => entry.payout_item?.sender_item_id === creator);
      if (item?.transaction_status === 'SUCCESS') {
        const payout = item.payout_item;
        if (normalize(payout.receiver ?? '') !== normalize(receiver) ||
            payout.amount?.currency !== 'USD' || payout.amount?.value !== value ||
            !item.payout_item_id) {
          throw new Error('PayPal payout details differ from the expected recipient or amount');
        }
        return { status: 'SUCCESS', batchId, itemId: item.payout_item_id };
      }
      if (item?.transaction_status && !['PENDING', 'PROCESSING'].includes(item.transaction_status)) {
        return { status: item.transaction_status, batchId };
      }
      if (poll < 11) await delay(2500);
    }
    return { status: 'PENDING', batchId };
  }, report, limit);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) try {
  if (process.argv[2] === '--self-test') await selfTest();
  else if (process.argv[2] === '--sandbox') await sandboxTest(fixture, 'fixture', { onEvent: event => console.log(JSON.stringify(event)) });
  else if (process.argv[2] === '--agent-sandbox') {
    await sandboxTest(JSON.parse(process.argv[3]), 'agent', { onEvent: event => console.log(JSON.stringify(event)) });
  } else throw new Error('Specify --self-test, --sandbox or --agent-sandbox');
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}
