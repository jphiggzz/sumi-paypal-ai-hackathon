import { z } from "zod";
import { extractionMode } from "./evidence-policy";
export const validText = (v: string) => !/[\u0000\uD800-\uDFFF]/u.test(v);
const safe = z.string().refine(validText);
export const uploadInput = z
  .object({
    requestId: z.uuid(),
    sourceId: z.uuid(),
    expectedVersion: z.number().int().min(0).max(30),
    filename: safe.regex(/^[^/\\]{1,140}\.(txt|md)$/i),
    content: safe
      .min(1)
      .refine((v) => new TextEncoder().encode(v).length <= 32768),
  })
  .strict();
export const publicInput = z
  .object({
    requestId: z.uuid(),
    sourceId: z.uuid(),
    expectedVersion: z.number().int().min(0).max(30),
    url: z.string().max(1024),
    recoveryTest: z.boolean().default(false),
  })
  .strict();
export const removeDocument = z
  .object({
    requestId: z.uuid(),
    expectedVersion: z.number().int().positive().max(30),
  })
  .strict();
export const jobInput = z
  .object({
    id: z.uuid(),
    conversationId: z.uuid(),
    sources: z
      .array(
        z
          .object({ id: z.uuid(), version: z.number().int().positive() })
          .strict(),
      )
      .min(2)
      .max(3)
      .refine((v) => new Set(v.map((r) => r.id)).size === v.length),
    fields: z
      .array(
        safe
          .trim()
          .min(1)
          .max(40)
          .regex(/^[A-Za-z][A-Za-z0-9 _-]*$/),
      )
      .min(1)
      .max(8)
      .refine((v) => new Set(v.map((f) => f.toLowerCase())).size === v.length),
    extractionMode: extractionMode.optional(),
    recoveryTest: z.boolean().default(false),
    holdAfterStage: z.number().int().min(0).max(2).default(0),
  })
  .strict();
export const jobControl = z
  .object({
    action: z.enum(["pause", "resume", "cancel", "approve"]),
    expectedVersion: z.number().int().positive(),
    digest: z
      .string()
      .regex(/^[a-f0-9]{64}$/)
      .optional(),
  })
  .strict();
export const cursor = z
  .string()
  .regex(/^\d{1,19}$/)
  .refine((v) => BigInt(v) <= BigInt("9223372036854775807"))
  .default("0");
export const feedRead = z
  .object({
    after: cursor,
    limit: z.number().int().min(1).max(50).default(25),
    conversationId: z.uuid().optional(),
  })
  .strict();
export const feedAction = z.discriminatedUnion("action", [
  feedRead
    .extend({
      action: z.literal("pull"),
      requestId: z.uuid(),
      consumerId: z.string().regex(/^[A-Za-z0-9_-]{1,60}$/),
    })
    .strict(),
  z
    .object({
      action: z.literal("ack"),
      deliveryId: z.uuid(),
      consumerId: z.string().regex(/^[A-Za-z0-9_-]{1,60}$/),
    })
    .strict(),
]);
export function extractFields(
  documents: { id: string; version: number; title: string; content: string }[],
  fields: string[],
) {
  return documents.map((d) => ({
    id: d.id,
    version: d.version,
    title: d.title,
    facts: fields.map((field) => {
      const matches = d.content.split(/\r?\n/).flatMap((line, index) => {
        const m =
          /^\s*([A-Za-z][A-Za-z0-9 _-]{0,39})\s*[:=]\s*(.{1,500})\s*$/.exec(
            line,
          );
        return m &&
          m[2].trim() &&
          m[1].trim().toLowerCase() === field.toLowerCase()
          ? [{ value: m[2].trim(), line: index + 1, quote: line }]
          : [];
      });
      const distinct = [...new Set(matches.map((m) => m.value))];
      return {
        field,
        status:
          distinct.length === 1
            ? "found"
            : distinct.length > 1
              ? "ambiguous"
              : "absent",
        value: distinct.length === 1 ? distinct[0] : null,
        evidence: matches.slice(0, 3),
      };
    }),
  }));
}
export function renderComparison(
  rows: ReturnType<typeof extractFields>,
  fields: string[],
) {
  const esc = (v: string) =>
    v
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/\|/g, "\\|")
      .replace(/[\r\n]/g, " ");
  const lines = [
    "# Document comparison",
    "",
    ...rows.map((r) => `- ${esc(r.title)} [source:${r.id}@${r.version}]`),
    "",
    "| Field | " +
      rows.map((_, i) => "Source " + (i + 1)).join(" | ") +
      " | Comparison |",
    "| --- | " + rows.map(() => "---").join(" | ") + " | --- |",
  ];
  for (const field of fields) {
    const facts = rows.map((r) => r.facts.find((f) => f.field === field)!);
    const all = facts.every((f) => f.status === "found");
    const equal = all && new Set(facts.map((f) => f.value)).size === 1;
    lines.push(
      "| " +
        esc(field) +
        " | " +
        facts
          .map((f) => (f.status === "found" ? esc(f.value!) : f.status))
          .join(" | ") +
        " | " +
        (!all ? "insufficient evidence" : equal ? "same" : "different") +
        " |",
    );
  }
  return lines.join("\n");
}
