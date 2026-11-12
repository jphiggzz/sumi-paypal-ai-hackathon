import { lookup } from "node:dns/promises";
import { request } from "node:https";
import { BlockList, isIP } from "node:net";

const blocked = new BlockList();
for (const [address, prefix] of [
  ["0.0.0.0", 8], ["10.0.0.0", 8], ["100.64.0.0", 10], ["127.0.0.0", 8],
  ["169.254.0.0", 16], ["172.16.0.0", 12], ["192.0.0.0", 24],
  ["192.0.2.0", 24], ["192.168.0.0", 16], ["198.18.0.0", 15],
  ["198.51.100.0", 24], ["203.0.113.0", 24], ["224.0.0.0", 4],
  ["240.0.0.0", 4],
] as const) blocked.addSubnet(address, prefix, "ipv4");

export function websiteFromMessage(message: string): string | null {
  const match = message.match(/(?:https?:\/\/|\bwww\.)[^\s<>]+|(?<![@\w])[a-z0-9][a-z0-9-]*(?:\.[a-z0-9-]+)*\.[a-z]{2,}(?:[/?#][^\s<>]*)?/i);
  if (!match) return null;
  const value = match[0].replace(/[.,!?;:]+$/, "");
  return /^https?:\/\//i.test(value) ? value : `https://${value}`;
}

export function isWebsiteOnly(message: string): boolean {
  return /^(?:(?:my )?(?:website|site)(?: is|:)?\s+)?(?:https?:\/\/|www\.)?[^\s]+\.[a-z]{2,}(?:[/?#][^\s]*)?\s*$/i.test(message.trim());
}

function textFromHtml(html: string): { title: string; excerpt: string } {
  const clean = (value: string) => value.replace(/<[^>]*>/g, " ")
    .replace(/&(?:amp|#38);/gi, "&").replace(/&(?:quot|#34);/gi, '"')
    .replace(/&#(?:39|x27);/gi, "'").replace(/&(?:nbsp|#160);/gi, " ")
    .replace(/\s+/g, " ").trim();
  const title = clean(html.match(/<title\b[^>]*>([\s\S]*?)<\/title\s*>/i)?.[1] || "").slice(0, 150);
  const descriptionTag = html.match(/<meta\b(?=[^>]*\b(?:name|property)\s*=\s*["'](?:description|og:description|twitter:description)["'])[^>]*>/i)?.[0] || "";
  const description = clean(descriptionTag.match(/\bcontent\s*=\s*["']([^"']*)["']/i)?.[1] || "");
  const body = html.replace(/<(script|style|noscript|svg)\b[^>]*>[\s\S]*?<\/\1\s*>/gi, " ")
    .replace(/<head\b[^>]*>[\s\S]*?<\/head\s*>/gi, " ");
  return { title, excerpt: (description || clean(body)).slice(0, 4000) };
}

export function websiteIconsFromHtml(html: string, pageUrl: string): string[] {
  const page = new URL(pageUrl);
  const candidates: { url: string; priority: number }[] = [];
  for (const match of html.matchAll(/<link\b[^>]*>/gi)) {
    const attrs: Record<string, string> = {};
    for (const attr of match[0].matchAll(/([\w-]+)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/g)) {
      attrs[attr[1].toLowerCase()] = (attr[2] ?? attr[3] ?? attr[4] ?? "").replace(/&amp;/gi, "&");
    }
    const rel = (attrs.rel || "").toLowerCase().split(/\s+/);
    const priority = rel.includes("apple-touch-icon") || rel.includes("apple-touch-icon-precomposed") ? 0 : rel.includes("icon") ? 1 : 2;
    if (priority === 2 || !attrs.href) continue;
    try {
      const icon = new URL(attrs.href, page);
      if (icon.protocol === "https:" && icon.origin === page.origin && !icon.username && !icon.password) candidates.push({ url: icon.href, priority });
    } catch { /* Ignore malformed icon references. */ }
  }
  candidates.sort((a, b) => a.priority - b.priority);
  return [...new Set([...candidates.map((candidate) => candidate.url), new URL("/favicon.ico", page).href])];
}

export function secureRedirect(location: string, current: URL): URL {
  const next = new URL(location, current);
  if (next.protocol === "http:" && !next.port && !next.username && !next.password) next.protocol = "https:";
  return next;
}

export async function readCampaignWebsite(input: string): Promise<{url: string; title: string; excerpt: string; iconUrl: string; iconUrls: string[]; readable?: boolean}> {
  let target = new URL(input);
  for (let redirects = 0; redirects <= 3; redirects++) {
    if (target.protocol !== "https:" || target.username || target.password || (target.port && target.port !== "443") || isIP(target.hostname)) throw new Error("Invalid public website");
    const addresses = await lookup(target.hostname, { all: true, family: 4 });
    if (!addresses.length || addresses.some(({ address }) => blocked.check(address, "ipv4"))) throw new Error("Invalid public website");
    const address = addresses[0].address;
    const response = await new Promise<{ status: number; location?: string; html: string }>((resolve, reject) => {
      const req = request(target, {
        method: "GET",
        headers: { "User-Agent": "SumeCampaignPreview/1.0", Accept: "text/html", "Accept-Encoding": "identity" },
        family: 4,
        lookup: (_host, _options, callback) => callback(null, address, 4),
        signal: AbortSignal.timeout(8000),
      }, (res) => {
        const status = res.statusCode || 0;
        if (status >= 300 && status < 400) {
          res.resume();
          resolve({ status, location: res.headers.location, html: "" });
          return;
        }
        if (status === 403) {
          res.resume();
          resolve({ status, html: "" });
          return;
        }
        if (status !== 200 || !String(res.headers["content-type"] || "").toLowerCase().includes("text/html")) {
          res.resume();
          reject(new Error("Website unavailable"));
          return;
        }
        let size = 0;
        const chunks: Buffer[] = [];
        res.on("data", (chunk: Buffer) => {
          size += chunk.length;
          if (size > 1_000_000) { res.destroy(new Error("Website too large")); return; }
          chunks.push(chunk);
        });
        res.on("end", () => resolve({ status, html: Buffer.concat(chunks).toString("utf8") }));
        res.on("error", reject);
      });
      req.on("error", reject);
      req.end();
    });
    if (response.status >= 300 && response.status < 400) {
      if (!response.location || redirects === 3) throw new Error("Website unavailable");
      target = secureRedirect(response.location, target);
      continue;
    }
    if (response.status === 403) {
      target.hash = "";
      const iconUrls = websiteIconsFromHtml("", target.toString());
      return { url: target.toString(), title: target.hostname, excerpt: "", iconUrl: iconUrls[0], iconUrls, readable: false };
    }
    const content = textFromHtml(response.html);
    if (!content.excerpt) throw new Error("Website has no readable content");
    target.hash = "";
    const iconUrls = websiteIconsFromHtml(response.html, target.toString());
    return { url: target.toString(), ...content, iconUrl: iconUrls[0], iconUrls };
  }
  throw new Error("Website unavailable");
}
