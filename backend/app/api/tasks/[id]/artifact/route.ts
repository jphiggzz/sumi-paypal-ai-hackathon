import { admittedUser, noStore } from '../../../../../lib/agent-api';
import { authPool } from '../../../../../lib/auth';
import { z } from 'zod';

export async function GET(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const access = await admittedUser(request);
  if (access.error) return access.error;
  const { id } = await params;
  if (!z.uuid().safeParse(id).success) return new Response(null, { status: 404 });
  const { rows } = await authPool.query('SELECT a.markdown,a.title FROM agent_artifacts a JOIN agent_tasks t ON t.id=a.task_id WHERE t.id=$1 AND t.owner_id=$2', [id, access.user.id]);
  if (!rows.length) return new Response(null, { status: 404 });
  return new Response(rows[0].markdown, { headers: { ...noStore, 'Content-Type': 'text/markdown; charset=utf-8', 'Content-Disposition': `attachment; filename="artifact-${id}.md"`, 'X-Content-Type-Options': 'nosniff' } });
}
