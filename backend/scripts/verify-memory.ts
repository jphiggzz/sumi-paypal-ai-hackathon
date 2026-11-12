/** Hosted model-free memory verification. Uses synthetic signed sessions, real
 * target APIs/Workflow/SQL, and one explicitly labelled past-expiry SQL fixture.
 * Run only after target migration and deployment; never provisions a provider.
 */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { writeFile } from 'node:fs/promises';
import { betterAuth } from 'better-auth';
import { Pool } from 'pg';
import { assertMemoryVersions, retrieveMemories } from '../lib/memory-store';
import { CapabilityError, type MemoryFact } from '../lib/capability-contracts';

const base = new URL(process.argv[2] || 'http://localhost:3000');
if (!process.env.DATABASE_URL || !process.env.BETTER_AUTH_SECRET || !process.env.SUME_DEMO_CODE) throw new Error('Load matching target database, auth secret and preview code.');
const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 3 });
const fixtureAuth = betterAuth({ secret: process.env.BETTER_AUTH_SECRET, baseURL: base.origin, database: pool, user: { modelName: 'auth_users' }, session: { modelName: 'auth_sessions' }, account: { modelName: 'auth_accounts' }, verification: { modelName: 'auth_verifications' }, emailAndPassword: { enabled: true } });
const headers = { 'Content-Type': 'application/json', Origin: base.origin, 'x-demo-code': process.env.SUME_DEMO_CODE };
type Account = { cookie: string; ownerId: string };
const checks: string[] = [];
const fixtureConversations: string[] = [];
const evidence: Record<string, unknown> = {
  target: base.origin,
  authentication: 'Synthetic fixture accounts with ordinary signed Better Auth sessions; no deployed test login.',
  noPayments: true, liveModelCalls: 0,
  fixtures: 'All stored preferences and source text are synthetic. Expiry is accelerated by one labelled SQL fixture update. Other mutations use authenticated APIs.',
  limitations: ['Deterministic lexical retrieval and infrastructure checks do not measure natural-language reasoning or customer value.', 'No OAuth, external provider calls, payments or human usability timing.', 'Immutable historical snapshots and revisions retain old facts; forget prevents future retrieval and new output from stale references.'],
};
function pass(label: string) { checks.push(label); console.log('PASS', label); }
async function account(): Promise<Account> {
  const response = await fixtureAuth.api.signUpEmail({ body: { email: `memory-verifier-${randomUUID()}@example.invalid`, password: randomUUID() + randomUUID(), name: 'Memory verifier' }, headers: new Headers(headers), asResponse: true });
  assert.equal(response.status, 200);
  const cookie = response.headers.getSetCookie().filter(value => value.split('=')[0].includes('session_token')).map(value => value.split(';')[0]).join('; ');
  assert.ok(cookie);
  const session = await fixtureAuth.api.getSession({ headers: new Headers({ ...headers, Cookie: cookie }) });
  assert.ok(session?.user.id);
  return { cookie, ownerId: session.user.id };
}
async function call(path: string, owner?: Account, body?: unknown, extra: Record<string, string> = {}) {
  return fetch(new URL(path, base), { method: body === undefined ? 'GET' : 'POST', headers: { ...headers, ...(owner ? { Cookie: owner.cookie } : {}), ...extra }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
}
async function json(path: string, owner: Account, body?: unknown, status = 200): Promise<any> {
  const result = await call(path, owner, body);
  assert.equal(result.status, status, `${path}: ${await result.clone().text()}`);
  return result.json();
}
const remember = (key: string, value: string, patch: Record<string, unknown> = {}) => ({ action: 'remember', requestId: randomUUID(), id: randomUUID(), expectedVersion: 0, scope: 'agent', key, value, ...patch });
const checkRequest = (query: string) => ({ tool: 'search_memory', input: { query, limit: 5 } });
async function waitFor<T>(read: () => Promise<T>, ready: (value: T) => boolean, label: string, seconds = 180): Promise<T> {
  for (let index = 0; index < seconds; index++) { const value = await read(); if (ready(value)) return value; await delay(1000); }
  throw new Error(`Timed out: ${label}`);
}
async function waitTurn(id: string, sequence: number) {
  const result = await waitFor(async () => (await pool.query('SELECT * FROM conversation_turns WHERE conversation_id=$1 AND sequence=$2', [id, sequence])).rows[0], row => !!row && ['completed', 'failed', 'cancelled'].includes(row.status), 'model-free memory turn');
  assert.equal(result.status, 'completed', result.error_code);
  return result;
}
async function conversation(owner: Account, query: string) {
  const id = randomUUID(), messageId = randomUUID();
  await json('/api/conversations', owner, { id, messageId, text: query, source: 'MEMORY_FIXTURE. Synthetic project with three milestones.', executionMode: 'capability_check', capabilityRequest: checkRequest(query), dispatchRecoveryTest: true }, 201);
  fixtureConversations.push(id);
  const turn = await waitTurn(id, 1);
  return { id, messageId, turn };
}
async function find(owner: Account, query: string, conversationId?: string): Promise<MemoryFact[]> {
  const params = new URLSearchParams({ query, limit: '5', ...(conversationId ? { conversationId } : {}) });
  return (await json(`/api/memories?${params}`, owner)).memories;
}
async function changed(owner: Account, conversationId: string, id: string, version: number) {
  const client = await pool.connect();
  try { await client.query('BEGIN'); await assert.rejects(assertMemoryVersions(client, owner.ownerId, conversationId, [{ id, version }]), error => error instanceof CapabilityError && error.code === 'MEMORY_CONTEXT_CHANGED' && error.status === 409); }
  finally { await client.query('ROLLBACK'); client.release(); }
}
function snapshotHas(turn: any, id: string) { return (turn.context_snapshot?.memories ?? []).some((fact: MemoryFact) => fact.id === id); }
function containsMemory(value: unknown, id: string): boolean {
  if (Array.isArray(value)) return value.some(item => containsMemory(item, id));
  if (value && typeof value === 'object') return (value as Record<string, unknown>).id === id || Object.values(value).some(item => containsMemory(item, id));
  if (typeof value === 'string') { const start = value.indexOf('{'); if (start >= 0) { try { return containsMemory(JSON.parse(value.slice(start)), id); } catch {} } }
  return false;
}
let failure: unknown;
try {
  const owner = await account(), other = await account();
  assert.equal((await call('/api/memories')).status, 401);
  assert.equal((await call('/api/memories', undefined, remember('test', 'test'))).status, 401);
  assert.equal((await call('/api/memories', owner, remember('test', 'test'), { Origin: 'https://foreign.invalid' })).status, 403);
  assert.equal((await call('/api/memories', owner, { ...remember('test', 'test'), ownerId: other.ownerId })).status, 400);
  pass('authentication, same-origin mutation and session-derived ownership enforced');

  const writing = remember('Writing style', 'Use concise paragraphs.');
  const duplicates = await Promise.all([call('/api/memories', owner, writing), call('/api/memories', owner, writing)]);
  assert.deepEqual(duplicates.map(result => result.status).sort(), [200, 201]);
  assert.equal((await call('/api/memories', owner, { ...writing, value: 'A conflicting payload.' })).status, 409);
  pass('concurrent identical requests deduplicate; reused request IDs with different content conflict');
  const language = remember('Language', 'French');
  await json('/api/memories', owner, language, 201);
  const foreign = remember('Writing style', 'Cross-owner secret fixture');
  await json('/api/memories', other, foreign, 201);
  assert.equal((await call(`/api/memories?id=${writing.id}`, other)).status, 404);
  assert.equal((await call('/api/memories', other, { action: 'forget', id: writing.id, requestId: randomUUID(), expectedVersion: 1 })).status, 404);
  assert.deepEqual((await find(other, 'writing style')).map(fact => fact.id), [foreign.id]);
  assert.equal((await find(owner, 'writing style')).some(fact => fact.id === foreign.id), false);
  pass('two authenticated owners cannot read, edit, forget or retrieve each other’s memory');

  const a = await conversation(owner, 'What is my preferred writing style?');
  assert.ok(snapshotHas(a.turn, writing.id));
  assert.ok(a.turn.context_snapshot.memoryReferences.some((ref: any) => ref.id === writing.id && ref.version === 1));
  const initialApi = await json(`/api/conversations/${a.id}`, owner);
  assert.ok(initialApi.messages.some((message: any) => message.role === 'assistant' && containsMemory(message.content, writing.id)));
  pass('a fresh conversation retrieves shared owner memory through read_context and registered search_memory');
  const scoped = remember('Project codename', 'Cobalt', { scope: 'conversation', conversationId: a.id, source: { conversationId: a.id, sequence: 1, messageId: a.messageId } });
  await json('/api/memories', owner, scoped, 201);
  assert.ok((await find(owner, 'Project codename', a.id)).some(fact => fact.id === scoped.id));
  const b = await conversation(owner, 'What is my project codename?');
  assert.equal(snapshotHas(b.turn, scoped.id), false);
  assert.equal((await find(owner, 'Project codename', b.id)).some(fact => fact.id === scoped.id), false);
  const c = await conversation(other, 'What is my project codename?');
  assert.equal((await call(`/api/memories?conversationId=${c.id}`, owner)).status, 404);
  await changed(owner, b.id, scoped.id, 1);
  await changed(other, c.id, writing.id, 1);
  pass('conversation facts remain in their owned conversation and never enter another conversation snapshot');

  for (const source of [{ conversationId: randomUUID() }, { conversationId: c.id }, { conversationId: a.id, sequence: 999 }, { conversationId: a.id, sequence: 1, messageId: randomUUID() }]) {
    assert.equal((await call('/api/memories', owner, remember('Invalid provenance', 'Reject me', { source }))).status, 404);
  }
  assert.equal((await call('/api/memories', owner, remember('Wrong source scope', 'Reject me', { scope: 'conversation', conversationId: b.id, source: { conversationId: a.id } }))).status, 400);
  pass('source provenance rejects nonexistent conversations/turns, foreign owners and mismatched message or conversation');

  const cas = await Promise.all(['Spanish', 'German'].map(value => call('/api/memories', owner, { action: 'update', id: language.id, requestId: randomUUID(), expectedVersion: 1, value })));
  assert.deepEqual(cas.map(result => result.status).sort(), [200, 409]);
  const languageHistory = await json(`/api/memories?id=${language.id}`, owner);
  assert.equal(languageHistory.memory.version, 2); assert.equal(languageHistory.revisions.length, 2);
  assert.equal(languageHistory.revisions[0].snapshot.value, 'French');
  await changed(owner, a.id, language.id, 1);
  const immutableClient = await pool.connect();
  try {
    await immutableClient.query('BEGIN');
    await assertMemoryVersions(immutableClient, owner.ownerId, a.id, [{ id: language.id, version: 2 }]);
    await assert.rejects(immutableClient.query("UPDATE agent_memory_revisions SET snapshot='{}'::jsonb WHERE memory_id=$1 AND version=1", [language.id]), /Memory revisions are immutable/);
  } finally { await immutableClient.query('ROLLBACK'); immutableClient.release(); }
  pass('concurrent updates use exact-version CAS, database-enforced immutable revision history and stale-reference rejection');
  const keyRace = await Promise.all([call('/api/memories', owner, remember(' ＤＡＴＥ   Format ', 'ISO 8601')), call('/api/memories', owner, remember('date format', 'YYYY-MM-DD'))]);
  assert.deepEqual(keyRace.map(result => result.status).sort(), [201, 409]);
  pass('normalized per-scope key uniqueness survives concurrent inserts');

  const scheduledId = randomUUID();
  await json(`/api/conversations/${a.id}/routines`, owner, { action: 'create', id: scheduledId, instruction: 'What is my preferred writing style?', executionMode: 'capability_check', capabilityRequest: checkRequest('writing style'), dueAt: new Date(Date.now() + 7000).toISOString(), expiresAt: new Date(Date.now() + 180000).toISOString(), timezone: 'America/New_York', maxRuns: 1, intervalSeconds: null }, 201);
  const occurrence = await waitFor(async () => (await pool.query('SELECT * FROM routine_occurrences WHERE routine_id=$1 ORDER BY sequence DESC LIMIT 1', [scheduledId])).rows[0], row => !!row?.sequence, 'scheduled memory search');
  const scheduledTurn = await waitTurn(a.id, occurrence.sequence);
  assert.ok(snapshotHas(scheduledTurn, writing.id));
  assert.equal(scheduledTurn.execution_mode, 'capability_check');
  pass('a durable scheduled capability check reads fresh shared memory without model inference');

  const forget = { action: 'forget', id: writing.id, requestId: randomUUID(), expectedVersion: 1 };
  await json('/api/memories', owner, forget);
  assert.equal((await json('/api/memories', owner, forget)).replayed, true);
  const forgotten = await json(`/api/memories?id=${writing.id}`, owner);
  assert.ok(forgotten.memory.deletedAt); assert.equal(forgotten.memory.version, 2);
  assert.equal(forgotten.revisions[0].snapshot.value, writing.value);
  assert.equal((await find(owner, 'writing style', a.id)).some(fact => fact.id === writing.id), false);
  await changed(owner, a.id, writing.id, 1);
  const originalReplay = await json('/api/memories', owner, writing);
  assert.equal(originalReplay.memory.version, 1); assert.equal(originalReplay.replayed, true);
  await json(`/api/conversations/${a.id}`, owner, { action: 'message', messageId: randomUUID(), text: 'What is my preferred writing style?', executionMode: 'capability_check', capabilityRequest: checkRequest('writing style'), dispatchRecoveryTest: true }, 201);
  const afterForget = await waitTurn(a.id, occurrence.sequence + 1);
  assert.equal(snapshotHas(afterForget, writing.id), false);
  pass('forget tombstones retain immutable history and exact retry results while future retrieval and turn snapshots omit the fact');

  const expiring = remember('Temporary room', 'Room Seven', { expiresAt: new Date(Date.now() + 3600000).toISOString() });
  await json('/api/memories', owner, expiring, 201);
  assert.ok((await find(owner, 'Temporary room', a.id)).some(fact => fact.id === expiring.id));
  await pool.query("UPDATE agent_memories SET expires_at=now()-interval '1 second' WHERE id=$1 AND owner_id=$2", [expiring.id, owner.ownerId]);
  assert.equal((await find(owner, 'Temporary room', a.id)).some(fact => fact.id === expiring.id), false);
  await changed(owner, a.id, expiring.id, 1);
  pass('explicit past-expiry SQL fixture blocks retrieval and invalidates pre-expiry references');

  const cases = [
    { key: 'Keyboard layout', value: 'Dvorak', query: 'Which keyboard layout do I use?' },
    { key: 'Meeting timezone', value: 'America/New_York', query: 'What is my preferred meeting timezone?' },
    { key: 'Distance units', value: 'Kilometres', query: 'Which distance units should you use?' },
    { key: 'Report audience', value: 'Operations leads', query: 'Who is my report audience?' },
    { key: 'Output language', value: 'Portuguese', query: 'Output language' },
    { key: 'Writing format', value: 'Short numbered sections', query: 'What writing formats do I prefer?' },
  ];
  const golden = [];
  for (const item of cases) { const memory = remember(item.key, item.value); await json('/api/memories', owner, memory, 201); golden.push({ ...item, id: memory.id }); }
  for (const [key, value] of [['Layout sample', 'An old keyboard catalogue'], ['Travel notes', 'Distances between stations'], ['Project notes', 'Reports from our former audience']]) await json('/api/memories', owner, remember(key, value), 201);
  const measurements = [];
  for (const item of golden) { const result = await find(owner, item.query, a.id); measurements.push({ query: item.query, expectedKey: item.key, returned: result.length, correctTop: result[0]?.id === item.id, covered: result.some(fact => fact.id === item.id) }); }
  const abstentions = [];
  for (const query of ['unicorn saddle preferences', 'quantum thermodynamics']) abstentions.push({ query, correct: (await find(owner, query, a.id)).length === 0 });
  evidence.retrievalMeasurement = { fixtureFacts: golden.length, distractorFacts: 3, positiveQueries: measurements.length, covered: measurements.filter(item => item.covered).length, correctTop: measurements.filter(item => item.correctTop).length, coverage: measurements.filter(item => item.covered).length / measurements.length, topAccuracy: measurements.filter(item => item.correctTop).length / measurements.length, abstentions, queries: measurements, correctionEffort: { explicitConcurrentCorrectionRequests: 2, acceptedCorrections: 1, reviewerCorrectionsToGoldenResults: 0, humanReviewSeconds: null, note: 'Fixture scoring is independent exact-ID comparison; no model judging and no timed human study.' } };
  assert.ok(measurements.every(item => item.correctTop && item.covered)); assert.ok(abstentions.every(item => item.correct));
  pass('independent six-case lexical gold set beats topical decoys with full coverage and correct abstentions');

  for (let index = 0; index < 8; index++) await json('/api/memories', owner, remember(`Capacity fixture ${index}`, 'x'.repeat(500)), 201);
  const bounded = await find(owner, '', a.id);
  assert.ok(bounded.length > 0 && bounded.length <= 5); assert.ok(JSON.stringify(bounded).length <= 2000);
  const client = await pool.connect();
  try { await client.query('BEGIN'); const direct = await retrieveMemories(client, owner.ownerId, a.id, '', 100); assert.ok(direct.length <= 5 && JSON.stringify(direct).length <= 2000); await client.query('COMMIT'); } catch (error) { await client.query('ROLLBACK'); throw error; } finally { client.release(); }
  pass('API and direct store enforce five-fact and 2000 serialized character bounds');

  const events = (await pool.query("SELECT count(*)::integer AS count FROM conversation_events WHERE conversation_id=ANY($1::uuid[]) AND kind='model_usage'", [fixtureConversations])).rows[0].count;
  assert.equal(events, 0);
  const runtimeModes = (await pool.query('SELECT DISTINCT execution_mode FROM conversation_turns WHERE conversation_id=ANY($1::uuid[])', [fixtureConversations])).rows.map(row => row.execution_mode);
  assert.deepEqual(runtimeModes, ['capability_check']);
  pass('all verified turns use deterministic capability checks and record no model usage');
  evidence.success = true;
} catch (error) { failure = error; evidence.success = false; evidence.failure = error instanceof Error ? error.message : String(error); }
finally {
  evidence.completedAt = new Date().toISOString(); evidence.checks = checks;
  if (process.env.AGENT_EVIDENCE_PATH) await writeFile(process.env.AGENT_EVIDENCE_PATH, JSON.stringify(evidence, null, 2) + '\n');
  console.log(JSON.stringify(evidence, null, 2));
  await pool.end();
}
if (failure) throw failure;
