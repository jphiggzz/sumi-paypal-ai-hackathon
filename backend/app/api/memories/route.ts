import { z } from 'zod';
import { admittedUser, noStore, sameOrigin } from '../../../lib/agent-api';
import { transaction } from '../../../lib/agent-store';
import { CapabilityError } from '../../../lib/capability-contracts';
import { memoryLookup, memoryMutation } from '../../../lib/memory-policy';
import { memoryHistory, mutateMemory, retrieveMemories } from '../../../lib/memory-store';

function failure(error: unknown) {
  if (error instanceof CapabilityError) return Response.json({ error: error.code }, { status: error.status, headers: noStore });
  throw error;
}
export async function GET(request: Request) {
  const access = await admittedUser(request);
  if (access.error) return access.error;
  const params = new URL(request.url).searchParams;
  try {
    if (params.has('id')) {
      const id = z.uuid().safeParse(params.get('id'));
      if (!id.success) return new Response(null, { status: 400 });
      return Response.json(await transaction(client => memoryHistory(client, access.user.id, id.data)), { headers: noStore });
    }
    const parsed = memoryLookup.safeParse(Object.fromEntries(params));
    if (!parsed.success) return new Response(null, { status: 400 });
    const { conversationId, query, limit } = parsed.data;
    const memories = await transaction(client => retrieveMemories(client, access.user.id, conversationId ?? null, query, limit));
    return Response.json({ memories }, { headers: noStore });
  } catch (error) { return failure(error); }
}
export async function POST(request: Request) {
  if (!sameOrigin(request)) return new Response(null, { status: 403 });
  const access = await admittedUser(request);
  if (access.error) return access.error;
  // No model/tool route calls this mutation endpoint. Session owns every write.
  const body = await request.text();
  if (body.length > 6000) return new Response(null, { status: 413 });
  let value: unknown;
  try { value = JSON.parse(body); } catch { return new Response(null, { status: 400 }); }
  const parsed = memoryMutation.safeParse(value);
  if (!parsed.success) return Response.json({ error: 'Invalid memory action.' }, { status: 400, headers: noStore });
  try {
    const result = await transaction(client => mutateMemory(client, access.user.id, parsed.data));
    return Response.json(result, { status: result.status, headers: noStore });
  } catch (error) { return failure(error); }
}
