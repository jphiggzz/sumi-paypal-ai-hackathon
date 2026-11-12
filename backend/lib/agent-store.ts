import { authPool } from './auth';
import { draftInput, sameDecision } from './agent-policy';
import { artifactDigest } from './agent-hash';
import { FatalError } from 'workflow';
import type { PoolClient } from 'pg';

export async function transaction<T>(execute: (client: PoolClient) => Promise<T>): Promise<T> {
  const client = await authPool.connect();
  try { await client.query('BEGIN'); const value = await execute(client); await client.query('COMMIT'); return value; }
  catch (error) { await client.query('ROLLBACK'); throw error; }
  finally { client.release(); }
}
export async function taskForOwner(id: string, owner: string) {
  return (await authPool.query('SELECT * FROM agent_tasks WHERE id=$1 AND owner_id=$2', [id, owner])).rows[0];
}
export async function event(client: PoolClient, id: string, key: string, kind: string, detail = {}) {
  return client.query('INSERT INTO agent_events(task_id,event_key,kind,detail) VALUES($1,$2,$3,$4) ON CONFLICT DO NOTHING RETURNING id', [id, key, kind, JSON.stringify(detail)]);
}
export async function message(client: PoolClient, id: string, key: string, role: string, content: string) {
  await client.query('INSERT INTO agent_messages(task_id,message_key,role,content) VALUES($1,$2,$3,$4) ON CONFLICT DO NOTHING', [id, key, role, content]);
}
export async function lockedTask(client: PoolClient, id: string, permission?: string) {
  const task = (await client.query('SELECT * FROM agent_tasks WHERE id=$1 FOR UPDATE', [id])).rows[0];
  if (!task || !task.grants_active || ['cancelled','rejected'].includes(task.status)) throw new FatalError('Task authorization revoked');
  if (permission && !task.permissions.includes(permission)) throw new FatalError('Tool permission denied');
  return task;
}
export async function storeDraft(id: string, input: unknown) {
  const draft = draftInput.parse(input);
  return transaction(async client => {
    await lockedTask(client, id, 'create_draft');
    const existing = (await client.query('SELECT * FROM agent_artifacts WHERE task_id=$1', [id])).rows[0];
    if (existing) return { title: existing.title, digest: existing.digest };
    const read = await client.query("SELECT 1 FROM agent_actions WHERE task_id=$1 AND kind='read_source'", [id]);
    if (!read.rowCount) throw new FatalError('Read the source before creating an artifact');
    const digest = artifactDigest(draft.title, draft.markdown);
    await client.query('INSERT INTO agent_artifacts(task_id,title,markdown,digest) VALUES($1,$2,$3,$4)', [id, draft.title, draft.markdown, digest]);
    await client.query("INSERT INTO agent_actions(task_id,kind,result) VALUES($1,'create_draft',$2)", [id, JSON.stringify({ digest })]);
    await message(client, id, 'draft', 'assistant', draft.markdown);
    await event(client, id, 'draft', 'draft_created', { title: draft.title, digest });
    return { title: draft.title, digest };
  });
}
export async function decideArtifact(id: string, owner: string, input: { decision: string; digest: string }) {
  return transaction(async client => {
    const task = (await client.query('SELECT * FROM agent_tasks WHERE id=$1 AND owner_id=$2 FOR UPDATE', [id, owner])).rows[0];
    if (!task) return { status: 404 };
    const approval = (await client.query('SELECT * FROM agent_approvals WHERE task_id=$1', [id])).rows[0];
    if (!approval || approval.digest !== input.digest) return { status: 409 };
    if (approval.decision) return { status: sameDecision(approval, input) ? 200 : 409, duplicate: true };
    if (task.status !== 'awaiting_approval' || !task.grants_active || new Date(approval.expires_at) <= new Date()) return { status: 409 };
    await client.query('UPDATE agent_approvals SET decision=$2,decided_by=$3,decided_at=now() WHERE task_id=$1', [id, input.decision, owner]);
    await message(client, id, 'decision', 'user', input.decision === 'approve' ? 'Approve this artifact.' : 'Reject this artifact.');
    await event(client, id, 'decision', 'approval_decided', input);
    return { status: 200 };
  });
}
