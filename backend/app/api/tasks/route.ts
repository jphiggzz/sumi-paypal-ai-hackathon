import { start } from 'workflow/api';
import { admittedUser, canStartTask, noStore, sameOrigin } from '../../../lib/agent-api';
import { permissions, taskInput } from '../../../lib/agent-policy';
import { agentWorkflow } from '../../../lib/agent-workflow';
import { authPool } from '../../../lib/auth';
import { event, message, transaction } from '../../../lib/agent-store';

export async function GET(request: Request) {
  const access = await admittedUser(request);
  if (access.error) return access.error;
  const { rows } = await authPool.query('SELECT id,instruction,status,error_code,created_at,updated_at FROM agent_tasks WHERE owner_id=$1 ORDER BY created_at DESC LIMIT 100', [access.user.id]);
  return Response.json({ tasks: rows }, { headers: noStore });
}
export async function POST(request: Request) {
  if (!sameOrigin(request)) return new Response(null, { status: 403 });
  const access = await admittedUser(request);
  if (access.error) return access.error;
  if (!canStartTask(request, access.user)) return Response.json({ error: 'A valid preview access code is required.' }, { status: 403 });
  const input = taskInput.safeParse(await request.json().catch(() => null));
  if (!input.success) return Response.json({ error: 'Enter a task and source text within the displayed limits.' }, { status: 400 });
  const { id, instruction, source, recoveryTest } = input.data;
  const owner = access.user.id;
  const result = await transaction(async client => {
    // Serializes simultaneous retries for the same id, including the first insert.
    await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [id]);
    const existing = (await client.query('SELECT * FROM agent_tasks WHERE id=$1', [id])).rows[0];
    if (existing) return existing.owner_id === owner && existing.instruction === instruction && existing.source === source && existing.recovery_test === recoveryTest
      ? { status: 200, task: existing } : { status: 409 };
    const quota = await client.query('INSERT INTO agent_daily_quota(day,owner_id,tasks) VALUES(current_date,$1,1) ON CONFLICT(day,owner_id) DO UPDATE SET tasks=agent_daily_quota.tasks+1 WHERE agent_daily_quota.tasks<20 RETURNING tasks', [owner]);
    if (!quota.rowCount) return { status: 429 };
    const task = (await client.query('INSERT INTO agent_tasks(id,owner_id,instruction,source,permissions,model,recovery_test) VALUES($1,$2,$3,$4,$5,$6,$7) RETURNING *', [id, owner, instruction, source, JSON.stringify(permissions), process.env.AGENT_MODEL || 'amazon/nova-micro', recoveryTest])).rows[0];
    await message(client, id, 'instruction', 'user', instruction);
    await event(client, id, 'created', 'task_created', { permissions });
    return { status: 201, task };
  });
  if (!result.task) return Response.json({ error: result.status === 429 ? 'Daily task limit reached.' : 'Task request conflicts with an existing request.' }, { status: result.status });
  try {
    if (result.task.status === 'queued' && !result.task.workflow_run_id) await start(agentWorkflow, [id]);
  } catch {
    return Response.json({ error: 'Could not confirm task start. Retry the same request.', id }, { status: 503 });
  }
  return Response.json({ id }, { status: result.status, headers: noStore });
}
