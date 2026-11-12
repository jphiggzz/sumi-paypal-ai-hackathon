import { getRun, resumeHook, start } from 'workflow/api';
import { HookNotFoundError } from 'workflow/errors';
import { z } from 'zod';
import { admittedUser, noStore, sameOrigin } from '../../../../lib/agent-api';
import { decisionInput } from '../../../../lib/agent-policy';
import { agentWorkflow, approvalToken } from '../../../../lib/agent-workflow';
import { authPool } from '../../../../lib/auth';
import { decideArtifact, event, message, taskForOwner, transaction } from '../../../../lib/agent-store';

type Context = { params: Promise<{ id: string }> };
async function accessTask(request: Request, context: Context) {
  const access = await admittedUser(request);
  if (access.error) return { error: access.error };
  const { id } = await context.params;
  if (!z.uuid().safeParse(id).success) return { error: new Response(null, { status: 404 }) };
  const task = await taskForOwner(id, access.user.id);
  return task ? { task, user: access.user } : { error: new Response(null, { status: 404 }) };
}
export async function GET(request: Request, context: Context) {
  const access = await accessTask(request, context);
  if (access.error) return access.error;
  const id = access.task.id;
  const [messages, events, artifacts, actions, approvals] = await Promise.all([
    authPool.query('SELECT role,content,created_at FROM agent_messages WHERE task_id=$1 ORDER BY id', [id]),
    authPool.query('SELECT id,kind,detail,created_at FROM agent_events WHERE task_id=$1 ORDER BY id', [id]),
    authPool.query('SELECT title,markdown,digest,state,saved_at FROM agent_artifacts WHERE task_id=$1', [id]),
    authPool.query('SELECT kind,result,attempts FROM agent_actions WHERE task_id=$1 ORDER BY created_at', [id]),
    authPool.query('SELECT digest,decision,expires_at FROM agent_approvals WHERE task_id=$1', [id]),
  ]);
  return Response.json({ task: access.task, messages: messages.rows, events: events.rows, artifact: artifacts.rows[0] ?? null, actions: actions.rows, approval: approvals.rows[0] ?? null }, { headers: noStore });
}
export async function POST(request: Request, context: Context) {
  if (!sameOrigin(request)) return new Response(null, { status: 403 });
  const access = await accessTask(request, context);
  if (access.error) return access.error;
  const { task, user } = access;
  const body = await request.json().catch(() => null);
  if (body?.action === 'decision') {
    const parsed = decisionInput.safeParse(body);
    if (!parsed.success) return new Response(null, { status: 400 });
    const result = await decideArtifact(task.id, user.id, parsed.data);
    if (result.status !== 200) return Response.json({ error: 'Approval is stale or no longer available.' }, { status: result.status });
    try { await resumeHook(approvalToken(task.id, task.attempt), { wake: true }); }
    catch (error) {
      // SQL owns the decision. The sleeping workflow will reconcile it even if
      // the hook is unavailable or the delivery acknowledgement is lost.
      if (!HookNotFoundError.is(error)) console.error('Approval wakeup failed', { taskId: task.id });
    }
    return Response.json({ accepted: true, duplicate: result.duplicate ?? false });
  }
  if (body?.action === 'cancel') {
    await transaction(async client => {
      const updated = await client.query("UPDATE agent_tasks SET status='cancelled',grants_active=false,updated_at=now() WHERE id=$1 AND owner_id=$2 AND status NOT IN ('completed','rejected','cancelled') RETURNING id", [task.id, user.id]);
      if (updated.rowCount) {
        await message(client, task.id, 'cancelled', 'user', 'Cancel this task and revoke its tool permissions.');
        await event(client, task.id, 'cancelled', 'task_cancelled');
      }
    });
    if (task.workflow_run_id) try { await getRun(task.workflow_run_id).cancel(); } catch { /* SQL revocation is authoritative. */ }
    return Response.json({ accepted: true });
  }
  if (body?.action === 'retry') {
    const updated = await authPool.query("UPDATE agent_tasks SET status='queued',workflow_run_id=NULL,attempt=attempt+1,error_code=NULL,updated_at=now() WHERE id=$1 AND owner_id=$2 AND status='failed' AND grants_active AND attempt<3 RETURNING id", [task.id, user.id]);
    if (!updated.rowCount) return new Response(null, { status: 409 });
    try { await start(agentWorkflow, [task.id]); }
    catch { return Response.json({ error: 'Could not confirm restart. Use Resume start.' }, { status: 503 }); }
    return Response.json({ accepted: true });
  }
  if (body?.action === 'resume' && task.status === 'queued') {
    try { await start(agentWorkflow, [task.id]); return Response.json({ accepted: true }); }
    catch { return new Response(null, { status: 503 }); }
  }
  return new Response(null, { status: 400 });
}
