import { z } from "zod";
const safe = z.string().refine((v) => !/[\u0000\uD800-\uDFFF]/u.test(v));
export const historyInput = z
  .object({
    beforeCursor: z
      .string()
      .regex(/^\d{1,8}:\d{1,19}$/)
      .refine((v) => {
        try {
          return BigInt(v.split(":")[1]) <= BigInt("9223372036854775807");
        } catch {
          return false;
        }
      })
      .optional(),
    beforeSequence: z.number().int().positive().optional(),
    query: safe.trim().max(100).default(""),
    limit: z.number().int().min(1).max(10).default(5),
  })
  .strict();
export const sourceSearchInput = z
  .object({
    query: safe.trim().min(1).max(200),
    sourceId: z.uuid().optional(),
    limit: z.number().int().min(1).max(3).default(3),
  })
  .strict();
export const sourceRefreshInput = z
  .object({
    id: z.uuid(),
    connectionId: z.uuid(),
    expectedVersion: z.number().int().positive(),
    resourceId: z.string().regex(/^[A-Za-z0-9_-]{1,160}$/),
    fixtureRevision: z.number().int().min(1).max(2).default(1),
  })
  .strict();
export const configurableTools = [
  "propose_sandbox_payment",
  'list_connected_sources','refresh_connected_source','start_document_job','inspect_document_job','control_document_job','request_clarification',
  "read_job_result",
  "read_context",
  "read_revision",
  "create_draft",
  "reply",
  "read_fixture_document",
  "list_fixture_documents",
  "propose_fixture_note",
  "search_memory",
  "read_history",
  "search_sources",
] as const;
export const configInput = z
  .object({
    expectedVersion: z.number().int().positive(),
    instructions: safe.trim().max(2000),
    tools: z
      .array(z.enum(configurableTools))
      .min(2)
      .max(18)
      .refine(
        (t) =>
          t.includes("read_context") &&
          t.includes("reply") &&
          new Set(t).size === t.length,
      ),
    model: z.literal("amazon/nova-micro").default("amazon/nova-micro"),
    maxOutputTokens: z.number().int().min(512).max(3000).default(1500),
    contextBytes: z.number().int().min(8000).max(32000).default(16000),
  })
  .strict();
/** UTF-8 upper bound: preserve complete messages; omitted history stays retrievable. */
export function boundedHistory<T>(rows: T[], maxBytes: number) {
  const selected: T[] = [];
  let bytes = 2;
  for (const row of [...rows].reverse()) {
    const size = new TextEncoder().encode(JSON.stringify(row)).length + 1;
    if (bytes + size > maxBytes) break;
    selected.unshift(row);
    bytes += size;
  }
  return selected;
}
