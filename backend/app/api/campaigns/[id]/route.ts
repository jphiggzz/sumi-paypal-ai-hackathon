import { resumeHook } from 'workflow/api';
import { HookNotFoundError } from 'workflow/errors';
import { canAccess } from '../../../../lib/access';
import { db } from '../../../../lib/db';
import { eventKey, fixtureSchema } from '../../../../lib/fixtures';

type Context = { params: Promise<{ id: string }> };

export async function GET(request: Request, context: Context) {
  const { id } = await context.params;
  if (!canAccess(request, id)) return new Response(null, { status: 403 });
  const sql = db();
  const [campaign] = await sql`SELECT id, scenario, approval, status, event_log, deal, batch_id, item_id
    FROM campaigns WHERE id = ${id}`;
  if (!campaign) return new Response(null, { status: 404 });
  return Response.json(campaign, { headers: { 'Cache-Control': 'no-store' } });
}

export async function POST(request: Request, context: Context) {
  const { id } = await context.params;
  if (!canAccess(request, id)) return new Response(null, { status: 403 });
  const body = await request.json().catch(() => null);
  const event = fixtureSchema.safeParse(body?.event);
  if (!event.success) return new Response(null, { status: 400 });
  const key = eventKey(id, event.data);
  try {
    await resumeHook(key, { source: 'fixture' });
    return new Response(null, { status: 202 });
  } catch (error) {
    if (!(HookNotFoundError.is(error))) throw error;
    const sql = db();
    const [campaign] = await sql`SELECT event_log ? ${event.data} AS received FROM campaigns WHERE id = ${id}`;
    return new Response(null, { status: campaign?.received ? 204 : 409 });
  }
}
