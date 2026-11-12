import { z } from 'zod';
import { admittedUser, noStore } from '../../../../lib/agent-api';
import { transaction } from '../../../../lib/agent-store';
import { CapabilityError } from '../../../../lib/capability-contracts';
import { armRecovery } from '../../../../lib/recovery-workflow';
import { eventEnvelope, eventMessageId, eventSigningSecret, readEventBody, verifyEventSignature } from '../../../../lib/event-policy';
import { admitEvent, getEventSource, ownedEventSource, preflightEvent } from '../../../../lib/event-store';
type Context = { params: Promise<{ id: string }> };
export async function GET(request: Request, context: Context) {
  const access = await admittedUser(request);
  if (access.error) return access.error;
  const { id } = await context.params;
  if (!z.uuid().safeParse(id).success) return new Response(null, { status: 404 });
  try { return Response.json(await transaction(client => ownedEventSource(client, access.user.id, id, new URL(request.url).searchParams.get('includeData') === 'true')), { headers: noStore }); }
  catch (error) {
    if (error instanceof CapabilityError) return Response.json({ error: error.code }, { status: error.status, headers: noStore });
    throw error;
  }
}
/** Fixture-only, unauthenticated HMAC intake. No provider OAuth or registration. */
export async function POST(request: Request, context: Context) {
  const { id } = await context.params;
  if (!z.uuid().safeParse(id).success) return new Response(null, { status: 401 });
  try {
    const rawBody = await readEventBody(request);
    const source = await transaction(client => getEventSource(client, id));
    if (!source) return new Response(null, { status: 401 });
    const signingSecret = eventSigningSecret(source.id, source.signing_generation);
    if (!verifyEventSignature(signingSecret, request.headers.get('x-agent-timestamp'), request.headers.get('x-agent-signature'), rawBody)) return new Response(null, { status: 401 });
    let value: unknown;
    try { value = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(rawBody)); } catch { return new Response(null, { status: 400 }); }
    const parsed = eventEnvelope.safeParse(value);
    if (!parsed.success) return Response.json({ error: 'Invalid fixture event envelope.' }, { status: 400, headers: noStore });
    const decoded = JSON.stringify(parsed.data);
    // Protect current and retired signing material from persistence or context.
    if (Array.from({ length: source.signing_generation }, (_, index) => eventSigningSecret(source.id, index + 1)).some(key => decoded.includes(key) || Buffer.from(rawBody).includes(Buffer.from(key)))) throw new CapabilityError('EVENT_SECRET_IN_CONTENT', 400);
    if (source.status !== 'active' || new Date(source.expires_at).getTime() <= Date.now()) throw new CapabilityError('EVENT_REVOKED', 409);
    await transaction(client => preflightEvent(client, source));
    // Arm a stable durable recovery watcher before atomically admitting inbox+turn.
    const deadline = await armRecovery(source.conversation_id, source.owner_id, { messageId: eventMessageId(source.id, parsed.data.eventId) });
    const result = await transaction(client => admitEvent(client, source, parsed.data, rawBody, deadline));
    return Response.json(result, { status: result.status, headers: noStore });
  } catch (error) {
    if (error instanceof CapabilityError) return Response.json({ error: error.code }, { status: error.status, headers: noStore });
    throw error;
  }
}
