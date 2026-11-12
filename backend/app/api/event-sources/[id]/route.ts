import { z } from 'zod';
import { admittedUser, canStartTask, noStore, sameOrigin } from '../../../../lib/agent-api';
import { transaction } from '../../../../lib/agent-store';
import { CapabilityError } from '../../../../lib/capability-contracts';
import { eventSourceChange, readEventBody } from '../../../../lib/event-policy';
import { changeEventSource, ownedEventSource } from '../../../../lib/event-store';
type Context = { params: Promise<{ id: string }> };
export async function GET(request: Request, context: Context) {
  const access = await admittedUser(request);
  if (access.error) return access.error;
  const { id } = await context.params;
  if (!z.uuid().safeParse(id).success) return new Response(null, { status: 404 });
  try { return Response.json(await transaction(client => ownedEventSource(client, access.user.id, id)), { headers: noStore }); }
  catch (error) {
    if (error instanceof CapabilityError) return Response.json({ error: error.code }, { status: error.status, headers: noStore });
    throw error;
  }
}
export async function POST(request: Request, context: Context) {
  if (!sameOrigin(request)) return new Response(null, { status: 403 });
  const access = await admittedUser(request);
  if (access.error) return access.error;
  const { id } = await context.params;
  if (!z.uuid().safeParse(id).success) return new Response(null, { status: 404 });
  try {
    const body = await readEventBody(request);
    let value: unknown;
    try { value = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(body)); } catch { return new Response(null, { status: 400 }); }
    const parsed = eventSourceChange.safeParse(value);
    if (!parsed.success) return new Response(null, { status: 400 });
    if (!['pause', 'cancel'].includes(parsed.data.action) && !canStartTask(request, access.user)) return new Response(null, { status: 403 });
    const result = await transaction(client => changeEventSource(client, access.user.id, id, parsed.data));
    return Response.json(result, { status: result.status, headers: noStore });
  } catch (error) {
    if (error instanceof CapabilityError) return Response.json({ error: error.code }, { status: error.status, headers: noStore });
    throw error;
  }
}
