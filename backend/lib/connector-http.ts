import { z } from 'zod';
import { CapabilityError, connectorDocument, type ConnectorDocument } from './capability-contracts';
import { createFixtureTransport, FIXTURE_ORIGIN, isSyntheticFixtureCredential, type ConnectorTransport, type FixtureScenario } from './connector-fixture';

// Only errors constructed by this boundary may pass through provider error redaction.
class ConnectorBoundaryError extends CapabilityError {}

export const CONNECTOR_MAX_BODY_BYTES = 32_768;
export const CONNECTOR_MAX_RETRY_AFTER_MS = 60_000;
const documentEnvelope = z.object({schemaVersion: z.literal(1), fixture: z.literal(true), document: connectorDocument.strict()}).strict();
const listEnvelope = z.object({schemaVersion: z.literal(1), fixture: z.literal(true), documents: z.array(z.object({id: z.enum(['doc-alpha', 'doc-beta']), title: z.string().min(1).max(160), version: z.string().min(1).max(100)}).strict()).max(2), nextCursor: z.enum(['page-beta']).nullable()}).strict();
export type ConnectorOptions = {signal?: AbortSignal; scenario?: FixtureScenario; transport?: ConnectorTransport; timeoutMs?: number};

/** Parse once and return a bounded scheduling hint. The adapter never retries or sleeps. */
export function parseConnectorRetryAfter(value: string | null, now = Date.now()): number | undefined {
  if (!value || value.length > 100 || /^[-+]/.test(value.trim())) return undefined;
  const seconds = /^\d+(?:\.\d+)?$/.test(value.trim()) ? Number(value) : undefined;
  const ms = seconds === undefined ? Date.parse(value) - now : seconds * 1000;
  if (!Number.isFinite(ms)) return undefined;
  return Math.min(CONNECTOR_MAX_RETRY_AFTER_MS, Math.max(0, Math.ceil(ms)));
}

async function readBoundedBody(response: Response, signal: AbortSignal): Promise<string> {
  const declared = response.headers.get('content-length');
  if (declared && Number(declared) > CONNECTOR_MAX_BODY_BYTES) {
    await response.body?.cancel();
    throw new ConnectorBoundaryError('connector_response_too_large', 502);
  }
  if (!response.body) throw new ConnectorBoundaryError('connector_response_invalid', 502);
  const reader = response.body.getReader();
  const abort = () => {void reader.cancel().catch(() => {});};
  signal.addEventListener('abort', abort, {once: true});
  if (signal.aborted) abort();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const next = await reader.read();
      if (next.done) break;
      total += next.value.byteLength;
      if (total > CONNECTOR_MAX_BODY_BYTES) {
        void reader.cancel().catch(() => {});
        throw new ConnectorBoundaryError('connector_response_too_large', 502);
      }
      chunks.push(next.value);
    }
  } finally { signal.removeEventListener('abort', abort); reader.releaseLock(); }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {bytes.set(chunk, offset); offset += chunk.byteLength;}
  return new TextDecoder('utf-8', {fatal: true}).decode(bytes);
}

async function requestFixture<T>(path: string, credential: string, schema: z.ZodType<T>, options: ConnectorOptions): Promise<T> {
  if (typeof credential !== 'string' || (!isSyntheticFixtureCredential(credential) && !['fixture-expired-v1', 'fixture-revoked-v1'].includes(credential))) throw new ConnectorBoundaryError('connector_credential_invalid', 401);
  if (options.signal?.aborted) throw new ConnectorBoundaryError('connector_aborted', 499);
  const timeoutMs = options.timeoutMs ?? 1500;
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 10_000) throw new ConnectorBoundaryError('connector_timeout_invalid', 400);
  const controller = new AbortController();
  let timedOut = false;
  let response: Response | undefined;
  const cancel = () => controller.abort();
  options.signal?.addEventListener('abort', cancel, {once: true});
  const timer = setTimeout(() => {timedOut = true; controller.abort();}, timeoutMs);
  let onAbort: () => void;
  const interrupted = new Promise<never>((_resolve, reject) => {
    onAbort = () => {
      void response?.body?.cancel().catch(() => {});
      reject(new ConnectorBoundaryError(timedOut ? 'connector_timeout' : 'connector_aborted', timedOut ? 504 : 499));
    };
    controller.signal.addEventListener('abort', onAbort, {once: true});
  });
  const operation = async () => {
    const request = new Request(`${FIXTURE_ORIGIN}${path}`, {method: 'GET', redirect: 'error', headers: {authorization: `Bearer ${credential}`, accept: 'application/json'}, signal: controller.signal});
    response = await (options.transport ?? createFixtureTransport(options.scenario))(request);
    if (controller.signal.aborted) {void response.body?.cancel().catch(() => {}); throw new ConnectorBoundaryError('connector_aborted', 499);}
    if (response.status === 401) throw new ConnectorBoundaryError('connector_credential_expired', 401);
    if (response.status === 403) throw new ConnectorBoundaryError('connector_resource_forbidden', 403);
    if (response.status === 429) throw new ConnectorBoundaryError('connector_rate_limited', 429, parseConnectorRetryAfter(response.headers.get('retry-after')));
    if (!response.ok) throw new ConnectorBoundaryError('connector_provider_failed', 502);
    if (response.redirected || response.url && new URL(response.url).origin !== FIXTURE_ORIGIN) throw new ConnectorBoundaryError('connector_redirect_rejected', 502);
    if (!/^application\/json(?:\s*;|$)/i.test(response.headers.get('content-type') ?? '')) throw new ConnectorBoundaryError('connector_response_invalid', 502);
    const parsed = schema.safeParse(JSON.parse(await readBoundedBody(response, controller.signal)));
    if (!parsed.success) throw new ConnectorBoundaryError('connector_response_invalid', 502);
    return parsed.data;
  };
  try { return await Promise.race([operation(), interrupted]); }
  catch (error) {
    if (error instanceof ConnectorBoundaryError) throw error;
    // Provider bodies, URLs, tokens and raw exception messages never cross this boundary.
    throw new ConnectorBoundaryError(controller.signal.aborted ? timedOut ? 'connector_timeout' : 'connector_aborted' : 'connector_response_invalid', controller.signal.aborted ? timedOut ? 504 : 499 : 502);
  } finally {
    clearTimeout(timer);
    options.signal?.removeEventListener('abort', cancel);
    controller.signal.removeEventListener('abort', onAbort!);
    if (response && !response.bodyUsed) void response.body?.cancel().catch(() => {});
  }
}

export async function readFixtureDocument(resourceId: string, credential: string, options: ConnectorOptions = {}): Promise<ConnectorDocument> {
  if (!['doc-alpha', 'doc-beta'].includes(resourceId)) throw new ConnectorBoundaryError('connector_resource_forbidden', 403);
  const envelope = await requestFixture(`/documents/${resourceId}`, credential, documentEnvelope, options);
  if (envelope.document.id !== resourceId || envelope.document.sourceUrl !== `${FIXTURE_ORIGIN}/documents/${resourceId}`) throw new ConnectorBoundaryError('connector_response_invalid', 502);
  return envelope.document;
}

export async function listFixtureDocuments(credential: string, options: ConnectorOptions & {cursor?: string} = {}) {
  if (options.cursor !== undefined && options.cursor !== 'page-beta') throw new ConnectorBoundaryError('connector_cursor_invalid', 400);
  const page = await requestFixture(`/documents${options.cursor ? '?cursor=page-beta' : ''}`, credential, listEnvelope, options);
  return {documents: page.documents, nextCursor: page.nextCursor, fixture: true as const};
}
