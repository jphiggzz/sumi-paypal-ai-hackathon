import { CapabilityError } from "./capability-contracts";
import { noStore } from "./agent-api";
export function apiFailure(error: unknown) {
  if (error instanceof CapabilityError)
    return Response.json(
      {
        error: error.code,
        ...(error.retryAfterMs ? { retryAfterMs: error.retryAfterMs } : {}),
      },
      {
        status: error.status,
        headers: {
          ...noStore,
          ...(error.retryAfterMs
            ? { "Retry-After": String(Math.ceil(error.retryAfterMs / 1000)) }
            : {}),
        },
      },
    );
  return Response.json(
    { error: "FOUNDATION_UNAVAILABLE" },
    { status: 503, headers: noStore },
  );
}
export async function boundedJson(request: Request) {
  const reader = request.body?.getReader();
  if (!reader) throw new CapabilityError("INVALID_BODY", 400);
  let n = 0;
  const chunks: Uint8Array[] = [];
  const timer = AbortSignal.timeout(2000);
  try {
    while (true) {
      timer.throwIfAborted();
      const part = await Promise.race([
        reader.read(),
        new Promise<never>((_, reject) =>
          timer.addEventListener(
            "abort",
            () => reject(new CapabilityError("BODY_TIMEOUT", 408)),
            { once: true },
          ),
        ),
      ]);
      if (part.done) break;
      n += part.value.length;
      if (n > 24000) throw new CapabilityError("BODY_LIMIT", 413);
      chunks.push(part.value);
    }
    return JSON.parse(
      new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks)),
    );
  } catch (error) {
    void reader.cancel().catch(() => {});
    if (error instanceof CapabilityError) throw error;
    throw new CapabilityError("INVALID_BODY", 400);
  } finally {
    reader.releaseLock();
  }
}
export async function boundedBytes(request: Request, max = 40000) {
  const reader = request.body?.getReader();
  if (!reader) throw new CapabilityError("INVALID_BODY", 400);
  let n = 0;
  const chunks: Uint8Array[] = [];
  const deadline = Date.now() + 2000;
  try {
    while (true) {
      const remaining = deadline - Date.now();
      if (remaining <= 0) throw new CapabilityError("BODY_TIMEOUT", 408);
      let timer: ReturnType<typeof setTimeout> | undefined;
      const part = await Promise.race([
        reader.read(),
        new Promise<never>((_, reject) => {
          timer = setTimeout(
            () => reject(new CapabilityError("BODY_TIMEOUT", 408)),
            remaining,
          );
        }),
      ]).finally(() => {
        if (timer) clearTimeout(timer);
      });
      if (part.done) break;
      n += part.value.length;
      if (n > max) throw new CapabilityError("BODY_LIMIT", 413);
      chunks.push(part.value);
    }
    return Buffer.concat(chunks);
  } catch (e) {
    void reader.cancel().catch(() => {});
    throw e;
  } finally {
    reader.releaseLock();
  }
}
