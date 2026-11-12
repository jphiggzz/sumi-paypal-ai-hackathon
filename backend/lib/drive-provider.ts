import {
  createCipheriv,
  createDecipheriv,
  createHash,
  randomBytes,
} from "node:crypto";
import { z } from "zod";
import { CapabilityError } from "./capability-contracts";
// Per-file authorization. User selection through Google Picker is a consent-time gate.
export const DRIVE_SCOPE = "https://www.googleapis.com/auth/drive.file";
const text = (s: string) => !/[\u0000\uD800-\uDFFF]/u.test(s);
export function sealCredential(
  value: unknown,
  binding: string,
  secret = process.env.BETTER_AUTH_SECRET,
) {
  if (!secret) throw new Error("Missing credential encryption secret");
  const iv = randomBytes(12),
    cipher = createCipheriv(
      "aes-256-gcm",
      createHash("sha256")
        .update("drive-credentials:v1:" + secret)
        .digest(),
      iv,
    );
  cipher.setAAD(Buffer.from(binding));
  return [
    iv,
    Buffer.concat([cipher.update(JSON.stringify(value)), cipher.final()]),
    cipher.getAuthTag(),
  ]
    .map((v) => v.toString("base64url"))
    .join(".");
}
export function openCredential(
  sealed: string,
  binding: string,
  secret = process.env.BETTER_AUTH_SECRET,
) {
  if (!secret) throw new Error("Missing credential encryption secret");
  const [iv, body, tag] = sealed
    .split(".")
    .map((v) => Buffer.from(v, "base64url"));
  const cipher = createDecipheriv(
    "aes-256-gcm",
    createHash("sha256")
      .update("drive-credentials:v1:" + secret)
      .digest(),
    iv,
  );
  cipher.setAAD(Buffer.from(binding));
  cipher.setAuthTag(tag);
  return JSON.parse(
    Buffer.concat([cipher.update(body), cipher.final()]).toString(),
  );
}
export async function limitedResponse(response: Response, max = 32768) {
  if (!response.ok) {
    const raw = response.headers.get("retry-after") || "1";
    const seconds = Number(raw);
    const delay = Number.isFinite(seconds)
      ? seconds * 1000
      : Date.parse(raw) - Date.now();
    const retry = Math.min(
      86400000,
      Math.max(1000, Number.isFinite(delay) ? delay : 1000),
    );
    throw new CapabilityError(
      response.status === 429
        ? "PROVIDER_RATE_LIMITED"
        : response.status === 401
          ? "PROVIDER_REAUTH_REQUIRED"
          : response.status === 403 || response.status === 404
            ? "PROVIDER_RESOURCE_DENIED"
            : "PROVIDER_UNAVAILABLE",
      response.status === 429 ? 429 : 502,
      retry,
    );
  }
  const reader = response.body?.getReader();
  if (!reader) throw new CapabilityError("PROVIDER_RESPONSE_INVALID", 502);
  let size = 0;
  const chunks: Uint8Array[] = [];
  try {
    while (true) {
      const n = await reader.read();
      if (n.done) break;
      size += n.value.length;
      if (size > max) {
        void reader.cancel();
        throw new CapabilityError("PROVIDER_RESPONSE_LIMIT", 502);
      }
      chunks.push(n.value);
    }
  } finally {
    reader.releaseLock();
  }
  return new TextDecoder("utf-8", { fatal: true }).decode(
    Buffer.concat(chunks),
  );
}
export const driveMetadata = z.object({
  id: z.string().regex(/^[A-Za-z0-9_-]{1,160}$/),
  name: z.string().max(300).refine(text),
  mimeType: z.enum([
    "application/vnd.google-apps.document",
    "text/plain",
    "text/markdown",
  ]),
  version: z.string().regex(/^\d{1,20}$/),
  trashed: z.boolean().optional(),
});
export async function readDriveDocument(
  resourceId: string,
  token: string,
  transport: typeof fetch = fetch,
) {
  if (!/^[A-Za-z0-9_-]{1,160}$/.test(resourceId))
    throw new CapabilityError("INVALID_RESOURCE", 400);
  const signal = AbortSignal.timeout(2500);
  const headers = { Authorization: `Bearer ${token}` };
  const url = new URL(
    "https://www.googleapis.com/drive/v3/files/" + resourceId,
  );
  url.searchParams.set("fields", "id,name,mimeType,version,trashed");
  const first = driveMetadata.safeParse(
    JSON.parse(
      await limitedResponse(
        await transport(url, { headers, signal, redirect: "error" }),
        4096,
      ),
    ),
  );
  if (!first.success || first.data.id !== resourceId || first.data.trashed)
    throw new CapabilityError("PROVIDER_RESOURCE_DENIED", 403);
  const m = first.data;
  if (JSON.stringify(m).includes(token))
    throw new CapabilityError("PROVIDER_RESPONSE_INVALID", 502);
  const contentUrl = new URL(
    url.origin +
      url.pathname +
      (m.mimeType === "application/vnd.google-apps.document" ? "/export" : ""),
  );
  contentUrl.searchParams.set(
    m.mimeType === "application/vnd.google-apps.document" ? "mimeType" : "alt",
    m.mimeType === "application/vnd.google-apps.document"
      ? "text/plain"
      : "media",
  );
  const content = await limitedResponse(
    await transport(contentUrl, { headers, signal, redirect: "error" }),
    32768,
  );
  if (!text(content) || content.includes(token))
    throw new CapabilityError("PROVIDER_RESPONSE_INVALID", 502);
  const last = driveMetadata.parse(
    JSON.parse(
      await limitedResponse(
        await transport(url, { headers, signal, redirect: "error" }),
        4096,
      ),
    ),
  );
  if (last.version !== m.version || last.trashed)
    throw new CapabilityError("PROVIDER_CHANGED_DURING_READ", 409);
  return {
    title: m.name,
    content,
    providerVersion: m.version,
    url: `https://drive.google.com/file/d/${resourceId}/view`,
    fixture: false,
  };
}
