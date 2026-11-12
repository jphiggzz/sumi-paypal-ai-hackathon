import { lookup } from "node:dns/promises";
import { request } from "node:https";
import { BlockList, isIP } from "node:net";
import { CapabilityError } from "./capability-contracts";
import { validText } from "./document-policy";
export const publicDocumentHosts = [
  "raw.githubusercontent.com",
  "www.iana.org",
  "www.rfc-editor.org",
] as const;
export function publicDocumentUrl(value: string) {
  if (/[\u0000-\u0020\u007f]/u.test(value))
    throw new CapabilityError("PUBLIC_URL_DENIED", 400);
  let u: URL;
  try {
    u = new URL(value);
  } catch {
    throw new CapabilityError("PUBLIC_URL_DENIED", 400);
  }
  if (
    u.protocol !== "https:" ||
    u.username ||
    u.password ||
    (u.port && u.port !== "443") ||
    u.search ||
    u.hash ||
    !publicDocumentHosts.includes(
      u.hostname as (typeof publicDocumentHosts)[number],
    )
  )
    throw new CapabilityError("PUBLIC_URL_DENIED", 400);
  try {
    const path = decodeURIComponent(u.pathname);
    if (!validText(path) || /[\u0000-\u001f\u007f]/u.test(path))
      throw new Error();
  } catch {
    throw new CapabilityError("PUBLIC_URL_DENIED", 400);
  }
  return u;
}
function addressLists() {
  const blocked = new BlockList();
  for (const [address, prefix] of [
    ["0.0.0.0", 8],
    ["10.0.0.0", 8],
    ["100.64.0.0", 10],
    ["127.0.0.0", 8],
    ["169.254.0.0", 16],
    ["172.16.0.0", 12],
    ["192.0.0.0", 24],
    ["192.0.2.0", 24],
    ["192.168.0.0", 16],
    ["192.88.99.0", 24],
    ["198.18.0.0", 15],
    ["198.51.100.0", 24],
    ["203.0.113.0", 24],
    ["224.0.0.0", 4],
    ["240.0.0.0", 4],
  ] as const)
    blocked.addSubnet(address, prefix, "ipv4");
  blocked.addSubnet("2001::", 23, "ipv6");
  blocked.addSubnet("2001:db8::", 32, "ipv6");
  blocked.addSubnet("2002::",16,"ipv6");
  blocked.addSubnet("3ffe::",16,"ipv6");
  blocked.addSubnet("3fff::",20,"ipv6");
  const globalV6 = new BlockList();
  globalV6.addSubnet("2000::", 3, "ipv6");
  return { blocked, globalV6 };
}
export function publicAddress(address: string) {
  const { blocked, globalV6 } = addressLists();
  const family = isIP(address);
  return family === 4
    ? !blocked.check(address, "ipv4")
    : family === 6 &&
        globalV6.check(address, "ipv6") &&
        !blocked.check(address, "ipv6");
}
export function choosePublicAddress(
  records: { address: string; family: number }[],
) {
  if (!records.length || records.some((r) => !publicAddress(r.address)))
    throw new CapabilityError("PUBLIC_DNS_DENIED", 403);
  return records.find((r) => r.family === 4) ?? records[0];
}
export function publicRetryAfter(value: string | undefined, now = Date.now()) {
  const raw = value ?? '1';
  const seconds = Number(raw);
  const delay = Number.isFinite(seconds) ? seconds * 1000 : Date.parse(raw) - now;
  return Math.min(86400000, Math.max(1000, Number.isFinite(delay) ? delay : 1000));
}
export function decodePublicDocument(body: Uint8Array, contentType: string) {
  const mime = contentType.split(";")[0].trim().toLowerCase();
  if (
    !["text/plain", "text/markdown", "text/csv", "application/json"].includes(
      mime,
    ) ||
    (contentType.toLowerCase().includes("charset=") &&
      !/charset=("?utf-8"?|"?us-ascii"?)(;|$)/i.test(contentType))
  )
    throw new CapabilityError("PUBLIC_CONTENT_TYPE_DENIED", 415);
  if (body.length > 32768) throw new CapabilityError("PUBLIC_BODY_LIMIT", 413);
  let content: string;
  try {
    content = new TextDecoder("utf-8", { fatal: true })
      .decode(body)
      .replace(/\r\n/g, "\n");
  } catch {
    throw new CapabilityError("PUBLIC_ENCODING_INVALID", 422);
  }
  if (!content.trim() || !validText(content))
    throw new CapabilityError("PUBLIC_TEXT_INVALID", 422);
  return content;
}
/** No cookies/credentials, proxies, redirects, decompression, pooled sockets or DNS re-resolution. */
export async function readPublicDocument(
  value: string,
  dependencies: { lookup: typeof lookup; request: typeof request } = {
    lookup,
    request,
  },
) {
  const u = publicDocumentUrl(value);
  const deadline = Date.now() + 5000;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const records = await Promise.race([
    dependencies.lookup(u.hostname, { all: true, verbatim: true }),
    new Promise<never>((_, reject) => {
      timer = setTimeout(
        () => reject(new CapabilityError("PUBLIC_DNS_TIMEOUT", 504)),
        2000,
      );
    }),
  ]).finally(() => {
    if (timer) clearTimeout(timer);
  });
  const selected = choosePublicAddress(records);
  return new Promise<{ content: string; title: string; url: string }>(
    (resolve, reject) => {
      let settled = false;
      const fail = (error: unknown) => {
        if (!settled) {
          settled = true;
          reject(
            error instanceof CapabilityError
              ? error
              : new CapabilityError("PUBLIC_FETCH_FAILED", 502),
          );
        }
      };
      const req = dependencies.request(
        u,
        {
          method: "GET",
          agent: false,
          family: selected.family,
          servername: u.hostname,
          lookup: (_host, _options, callback) =>
            callback(null, selected.address, selected.family),
          headers: {
            Accept: "text/plain,text/markdown,text/csv,application/json",
            "Accept-Encoding": "identity",
            "User-Agent": "AgentFoundation-DocumentReader/1.0",
          },
        },
        (response) => {
          const remote = response.socket.remoteAddress;
          if (
            remote !== selected.address &&
            remote !== "::ffff:" + selected.address
          ) {
            response.destroy();
            fail(new CapabilityError("PUBLIC_ADDRESS_CHANGED", 403));
            return;
          }
          const status = response.statusCode ?? 0;
          if (status < 200 || status >= 300) {
            response.destroy();
            fail(
              new CapabilityError(
                status >= 300 && status < 400
                  ? "PUBLIC_REDIRECT_DENIED"
                  : status === 429
                    ? "PUBLIC_RATE_LIMITED"
                    : "PUBLIC_FETCH_DENIED",
                status === 429 ? 429 : 502,
                status === 429
                  ? publicRetryAfter(String(response.headers["retry-after"] ?? '1'))
                  : undefined,
              ),
            );
            return;
          }
          if (
            (response.headers["content-encoding"] &&
              response.headers["content-encoding"] !== "identity") ||
            Number(response.headers["content-length"] ?? 0) > 32768
          ) {
            response.destroy();
            fail(new CapabilityError("PUBLIC_BODY_LIMIT", 413));
            return;
          }
          let size = 0;
          const chunks: Buffer[] = [];
          response.on("data", (chunk: Buffer) => {
            size += chunk.length;
            if (size > 32768) {
              response.destroy();
              fail(new CapabilityError("PUBLIC_BODY_LIMIT", 413));
            } else chunks.push(chunk);
          });
          response.on("error", fail);
          response.on("end", () => {
            if (settled) return;
            try {
              const content = decodePublicDocument(
                Buffer.concat(chunks),
                String(response.headers["content-type"] ?? ""),
              );
              settled = true;
              resolve({
                content,
                title: decodeURIComponent(
                  u.pathname.split("/").at(-1) || u.hostname,
                ).slice(0, 160),
                url: u.toString(),
              });
            } catch (e) {
              fail(e);
            }
          });
        },
      );
      const stop = setTimeout(
        () => {
          req.destroy();
          fail(new CapabilityError("PUBLIC_FETCH_TIMEOUT", 504));
        },
        Math.max(1, deadline - Date.now()),
      );
      req.on("error", fail);
      req.on("close", () => clearTimeout(stop));
      req.end();
    },
  );
}
