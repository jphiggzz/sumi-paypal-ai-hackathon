import { admittedUser, canStartTask, noStore, sameOrigin } from '../../../lib/agent-api';
import { transaction } from '../../../lib/agent-store';
import { CapabilityError } from '../../../lib/capability-contracts';
import { eventSourceCreate, readEventBody } from '../../../lib/event-policy';
import { createEventSource, listEventSources } from '../../../lib/event-store';
export async function GET(request: Request) {
  const access = await admittedUser(request);
  if (access.error) return access.error;
  return Response.json({ sources: await transaction(client => listEventSources(client, access.user.id)) }, { headers: noStore });
}
export async function POST(request: Request) {
  if (!sameOrigin(request)) return new Response(null, { status: 403 });
  const access = await admittedUser(request);
  if (access.error) return access.error;
  if (!canStartTask(request, access.user)) return new Response(null, { status: 403 });
  try {
    const body = await readEventBody(request);
    let value: unknown;
    try { value = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(body)); } catch { return new Response(null, { status: 400 }); }
    const parsed = eventSourceCreate.safeParse(value);
    if (!parsed.success) return Response.json({ error: 'Invalid fixture event source.' }, { status: 400, headers: noStore });
    const result = await transaction(client => createEventSource(client, access.user.id, parsed.data));
    return Response.json(result, { status: result.status, headers: noStore });
  } catch (error) {
    if (error instanceof CapabilityError) return Response.json({ error: error.code }, { status: error.status, headers: noStore });
    throw error;
  }
}
