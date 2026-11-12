import { createHash, createHmac, timingSafeEqual } from 'node:crypto';
import { z } from 'zod';
import { capabilityCheck } from './capability-policy';
import { CapabilityError } from './capability-contracts';

export const EVENT_BODY_BYTES = 8192;
export const EVENT_SOURCE_LIMIT = 20;
export const EVENT_SOURCE_INBOX_LIMIT = 100;
export const EVENT_SOURCE_VERSION_LIMIT = 100;
export const EVENT_WINDOW_SECONDS = 300;
export function validPostgresString(value: string) { return !/\u0000|[\uD800-\uDFFF]/u.test(value); }
const instruction = z.string().trim().min(1).max(2000).refine(validPostgresString);
const expiry = z.iso.datetime({ offset: true }).optional();
const template = { instruction, executionMode: z.enum(['checkpoint', 'capability_check']).default('checkpoint'), capabilityRequest: capabilityCheck.optional(), expiresAt: expiry };
function validTemplate(input: { executionMode: string; capabilityRequest?: unknown }) { return ((input.executionMode === 'capability_check') === !!input.capabilityRequest) && boundedEventData({ request: input.capabilityRequest ?? null }); }
export const eventSourceCreate = z.strictObject({ id: z.uuid(), conversationId: z.uuid(), ...template }).refine(validTemplate, 'Capability check requires its fixed tool request');
export const eventSourceChange = z.discriminatedUnion('action', [
  z.strictObject({ action: z.literal('edit'), expectedVersion: z.number().int().positive(), ...template }).refine(validTemplate),
  ...(['pause', 'resume', 'rotate', 'cancel'] as const).map(action => z.strictObject({ action: z.literal(action), expectedVersion: z.number().int().positive() })),
]);
export type EventSourceCreate = z.infer<typeof eventSourceCreate>;
export type EventSourceChange = z.infer<typeof eventSourceChange>;
// Envelope fields never become instructions or capability arguments.
export const eventEnvelope = z.strictObject({
  eventId: z.string().min(1).max(120).regex(/^[A-Za-z0-9][A-Za-z0-9_.:-]*$/),
  occurredAt: z.iso.datetime({ offset: true }),
  data: z.record(z.string().max(120), z.unknown()).refine(boundedEventData, 'Event data exceeds depth, key or byte bounds'),
});
function boundedEventData(data: Record<string, unknown>) {
  const pending: { value: unknown; depth: number }[] = [{ value: data, depth: 0 }];
  let keys = 0;
  while (pending.length) {
    const { value, depth } = pending.pop()!;
    if (depth > 8) return false;
    if (typeof value === 'string' && !validPostgresString(value)) return false;
    if (value && typeof value === 'object') {
      const entries = Object.entries(value);
      keys += entries.length;
      if (keys > 100 || entries.some(([key]) => key.length > 120 || !validPostgresString(key))) return false;
      for (const [, nested] of entries) pending.push({ value: nested, depth: depth + 1 });
    }
  }
  return Buffer.byteLength(JSON.stringify(data), 'utf8') <= 6000;
}
export type EventEnvelope = z.infer<typeof eventEnvelope>;
export function sourceExpiry(value: string | undefined, now = Date.now()) {
  const date = value ? Date.parse(value) : now + 7 * 86400000;
  if (!Number.isFinite(date) || date <= now || date > now + 7 * 86400000) throw new CapabilityError('EVENT_SOURCE_EXPIRY_INVALID', 400);
  return new Date(date).toISOString();
}
export function eventSigningSecret(sourceId: string, signingGeneration: number, serverSecret = process.env.BETTER_AUTH_SECRET): string {
  if (!serverSecret) throw new CapabilityError('EVENT_SIGNING_UNAVAILABLE', 503);
  return createHmac('sha256', serverSecret).update(`agent-fixture-event-signing:v1\0${sourceId}\0${signingGeneration}`).digest('hex');
}
export function eventSignature(secret: string, timestamp: string, rawBody: string | Uint8Array) {
  return createHmac('sha256', secret).update(timestamp).update('.').update(rawBody).digest('hex');
}
export function verifyEventSignature(secret: string, timestamp: string | null, signature: string | null, rawBody: string | Uint8Array, now = Date.now()) {
  if (!timestamp || !/^\d{10}$/.test(timestamp) || !signature || !/^[0-9a-f]{64}$/i.test(signature)) return false;
  if (Math.abs(now / 1000 - Number(timestamp)) > EVENT_WINDOW_SECONDS) return false;
  return timingSafeEqual(Buffer.from(signature, 'hex'), Buffer.from(eventSignature(secret, timestamp, rawBody), 'hex'));
}
export function eventMessageId(sourceId: string, eventId: string) {
  const hash = createHash('sha256').update(`agent-fixture-event-message:v1\0${sourceId}\0${eventId}`).digest();
  hash[6] = (hash[6] & 15) | 128; // UUIDv8: application-specific, deterministic hash.
  hash[8] = (hash[8] & 63) | 128;
  const value = hash.subarray(0, 16).toString('hex');
  return `${value.slice(0, 8)}-${value.slice(8, 12)}-${value.slice(12, 16)}-${value.slice(16, 20)}-${value.slice(20)}`;
}
export const eventBodyDigest = (rawBody: string | Uint8Array) => createHash('sha256').update(rawBody).digest('hex');
export async function readEventBody(request: Request): Promise<Uint8Array> {
  if (Number(request.headers.get('content-length') ?? 0) > EVENT_BODY_BYTES) throw new CapabilityError('EVENT_BODY_LIMIT', 413);
  const reader = request.body?.getReader();
  if (!reader) throw new CapabilityError('EVENT_BODY_INVALID', 400);
  const chunks: Uint8Array[] = []; let size = 0;
  const deadline = Date.now() + 2000;
  try {
    while (true) {
      const remaining = deadline - Date.now();
      if (remaining <= 0) { void reader.cancel().catch(() => {}); throw new CapabilityError('EVENT_BODY_TIMEOUT', 408); }
      let timer: ReturnType<typeof setTimeout> | undefined;
      const next = await Promise.race([reader.read(), new Promise<never>((_, reject) => { timer = setTimeout(() => { reject(new CapabilityError('EVENT_BODY_TIMEOUT', 408)); void reader.cancel().catch(() => {}); }, remaining); })]).finally(() => { if (timer) clearTimeout(timer); });
      if (next.done) break;
      size += next.value.byteLength;
      if (size > EVENT_BODY_BYTES) { void reader.cancel().catch(() => {}); throw new CapabilityError('EVENT_BODY_LIMIT', 413); }
      chunks.push(next.value);
    }
  } finally { reader.releaseLock(); }
  return Buffer.concat(chunks, size);
}
