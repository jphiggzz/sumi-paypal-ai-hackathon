import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { writeFile } from 'node:fs/promises';
import { betterAuth } from 'better-auth';
import { Pool } from 'pg';

const base = new URL(process.argv[2] || 'http://localhost:3000');
if (!process.env.DATABASE_URL || !process.env.BETTER_AUTH_SECRET || !process.env.SUME_DEMO_CODE) throw new Error('Load the target preview database, auth secret, and access code into the verifier environment.');
const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 2 });
// Privileged test harness: issues normal Better Auth sessions against disposable
// fixture accounts. No test-login endpoint or password provider is shipped.
const fixtureAuth = betterAuth({
  secret: process.env.BETTER_AUTH_SECRET, baseURL: base.origin, database: pool,
  user: { modelName: 'auth_users' }, session: { modelName: 'auth_sessions' },
  account: { modelName: 'auth_accounts' }, verification: { modelName: 'auth_verifications' },
  emailAndPassword: { enabled: true },
});
const headers = { Origin: base.origin, 'Content-Type': 'application/json' };
const password = randomUUID() + randomUUID();
const email = `agent-verifier-${randomUUID()}@example.invalid`;
const evidence: Record<string, unknown> = { checkedAt: new Date().toISOString(), target: base.origin, authentication: 'Normal Better Auth sessions issued to synthetic accounts by the local privileged test harness; Google OAuth is checked separately.' };
function cookie(response: Response) {
  const result = response.headers.getSetCookie().filter(value => value.split('=')[0].includes('session_token')).map(value => value.split(';')[0]).join('; ');
  assert.ok(result, 'Expected signed session cookie');
  return result;
}
async function account(address: string) {
  const response = await fixtureAuth.api.signUpEmail({ body: { email: address, password, name: 'Foundation verifier' }, headers: new Headers(headers), asResponse: true });
  assert.equal(response.status, 200);
  return cookie(response);
}
async function call(path: string, session?: string, body?: unknown, extra = {}) {
  return fetch(new URL(path, base), {
    method: body === undefined ? 'GET' : 'POST',
    headers: { ...headers, ...(session ? { Cookie: session } : {}), ...extra },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}
async function waitFor(id: string, session: string, status: string) {
  for (let attempt = 0; attempt < 180; attempt++) {
    const response = await call('/api/tasks/' + id, session);
    assert.equal(response.status, 200);
    const detail = await response.json();
    if (detail.task.status === status) return detail;
    assert.notEqual(detail.task.status, 'failed', JSON.stringify({ error: detail.task.error_code, events: detail.events }));
    await delay(2000);
  }
  throw new Error('Timed out waiting for ' + status);
}
try {
  const first = await account(email);
  const other = await account(`agent-verifier-${randomUUID()}@example.invalid`);
  const signedIn = await fixtureAuth.api.signInEmail({ body: { email, password }, headers: new Headers(headers), asResponse: true });
  const secondDevice = cookie(signedIn);
  assert.notEqual(first, secondDevice, 'Separate authenticated device sessions');
  assert.equal((await call('/api/tasks')).status, 401);
  const source = 'The service has 3 workers. Review date: November 9, 2026. Backups are due November 12, 2026. Owner: unassigned.';
  const input = { id: randomUUID(), instruction: 'Create a Markdown checklist from the source. Preserve both dates and the worker count. Name the missing owner as an open question.', source, recoveryTest: true };
  assert.equal((await call('/api/tasks', first, input)).status, 403, 'Metered task creation requires preview admission');
  assert.equal((await call('/api/tasks', first, input, { 'x-demo-code': process.env.SUME_DEMO_CODE, Origin: 'https://untrusted.invalid' })).status, 403);
  const admission = { 'x-demo-code': process.env.SUME_DEMO_CODE };
  const starts = await Promise.all([call('/api/tasks', first, input, admission), call('/api/tasks', first, input, admission)]);
  assert.deepEqual(starts.map(response => response.status).sort(), [200, 201]);
  assert.equal((await call('/api/tasks/' + input.id, other)).status, 404);
  assert.equal((await call('/api/tasks/' + input.id + '/artifact', other)).status, 404);
  assert.equal((await call('/api/tasks/' + input.id, other, { action: 'cancel' })).status, 404);
  assert.equal((await call('/api/tasks/' + input.id, first, { action: 'decision', decision: 'approve', digest: '0'.repeat(64) })).status, 409);
  // No client, stream, or browser remains connected during this interval.
  await delay(15_000);
  const draft = await waitFor(input.id, secondDevice, 'awaiting_approval');
  assert.ok(draft.artifact.markdown.length);
  assert.equal(draft.artifact.state, 'draft');
  assert.equal(draft.actions.some(action => action.kind === 'save_approved_artifact'), false);
  assert.ok(draft.actions.some(action => action.kind === 'read_source' && action.result.words === source.split(/\s+/).length));
  assert.equal((await call('/api/tasks/' + input.id, secondDevice, { action: 'decision', decision: 'approve', digest: '0'.repeat(64) })).status, 409);
  const decision = { action: 'decision', decision: 'approve', digest: draft.artifact.digest };
  const decisions = await Promise.all([call('/api/tasks/' + input.id, secondDevice, decision), call('/api/tasks/' + input.id, secondDevice, decision)]);
  assert.deepEqual(decisions.map(response => response.status), [200, 200]);
  const complete = await waitFor(input.id, first, 'completed');
  const action = complete.actions.find(action => action.kind === 'save_approved_artifact');
  assert.equal(action.attempts, 2);
  assert.equal(complete.artifact.digest, draft.artifact.digest);
  assert.equal(complete.artifact.state, 'saved');
  assert.equal(complete.events.filter(event => event.kind === 'artifact_saved').length, 1);
  assert.equal(complete.events.filter(event => event.kind === 'test_interruption').length, 1);
  assert.equal((await call('/api/tasks/' + input.id, first, decision)).status, 200);
  assert.equal((await call('/api/tasks/' + input.id, first, { ...decision, decision: 'reject' })).status, 409);
  const download = await call('/api/tasks/' + input.id + '/artifact', secondDevice);
  assert.equal(await download.text(), draft.artifact.markdown);
  evidence.completedTask = { id: input.id, model: complete.task.model, sourceStats: complete.actions.find(action => action.kind === 'read_source').result, saveAttempts: action.attempts, savedEvents: 1, digest: complete.artifact.digest };

  const revoke = { ...input, id: randomUUID(), recoveryTest: false };
  assert.equal((await call('/api/tasks', first, revoke, admission)).status, 201);
  await waitFor(revoke.id, first, 'awaiting_approval');
  assert.equal((await call('/api/tasks/' + revoke.id, secondDevice, { action: 'cancel' })).status, 200);
  const cancelled = await (await call('/api/tasks/' + revoke.id, first)).json();
  assert.equal(cancelled.task.status, 'cancelled');
  assert.equal(cancelled.task.grants_active, false);
  assert.equal((await call('/api/tasks/' + revoke.id, first, { action: 'decision', decision: 'approve', digest: cancelled.artifact.digest })).status, 409);
  assert.equal(cancelled.actions.some(action => action.kind === 'save_approved_artifact'), false);
  evidence.cancelledTask = revoke.id;
  const reject = { ...input, id: randomUUID(), recoveryTest: false };
  assert.equal((await call('/api/tasks', first, reject, admission)).status, 201);
  const rejectedDraft = await waitFor(reject.id, first, 'awaiting_approval');
  assert.equal((await call('/api/tasks/' + reject.id, secondDevice, { action: 'decision', decision: 'reject', digest: rejectedDraft.artifact.digest })).status, 200);
  const rejected = await waitFor(reject.id, first, 'rejected');
  assert.equal(rejected.artifact.state, 'draft');
  assert.equal(rejected.actions.some(action => action.kind === 'save_approved_artifact'), false);
  evidence.rejectedTask = reject.id;
  evidence.checks = ['unauthenticated denial', 'cross-owner read/write/download denial', 'origin check', 'preview admission', 'concurrent duplicate start', 'background work without a connected client', 'separate device session', 'read tool correctness', 'stale approval refusal', 'concurrent duplicate approval', 'interruption after committed save', 'one saved artifact', 'conflicting decision refusal', 'artifact download equality', 'permission revocation blocks save', 'rejection blocks save'];
  if (process.env.AGENT_EVIDENCE_PATH) await writeFile(process.env.AGENT_EVIDENCE_PATH, JSON.stringify(evidence, null, 2) + '\n');
  console.log('PASS: persistent agent, ownership, approval, recovery, artifact and revocation checks.');
  console.log(JSON.stringify(evidence, null, 2));
} finally { await pool.end(); }
