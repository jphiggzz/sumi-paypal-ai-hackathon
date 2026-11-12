import { z } from "zod";
import { extractionMode, paymentScope } from "./evidence-policy";
import { jobInput } from "./document-policy";
export const comparisonFields = jobInput.shape.fields;
export const workInput = z
  .object({
    sources: z
      .array(
        z.discriminatedUnion("kind", [
          z
            .object({
              kind: z.literal("source"),
              id: z.uuid(),
              version: z.number().int().positive(),
            })
            .strict(),
          z
            .object({
              kind: z.literal("connection"),
              connectionId: z.uuid(),
              expectedVersion: z.number().int().positive(),
              resourceId: z.string().regex(/^[A-Za-z0-9_-]{1,160}$/),
            })
            .strict(),
        ]),
      )
      .min(2)
      .max(3),
    fields: comparisonFields.optional(),
    extractionMode: extractionMode.optional(),
    payment: paymentScope.optional(),
    maxModelCalls: z.number().int().min(0).max(24).default(18),
    maxTools: z.number().int().min(1).max(60).default(40),
    maxStages: z.number().int().min(1).max(12).default(9),
    maxDispatches: z.number().int().min(1).max(12).default(12),
    maxProviderCalls: z.number().int().min(0).max(36).default(24),
    maxSourceBytes: z.number().int().min(0).max(589824).default(393216),
    expiresInMinutes: z.number().int().min(1).max(1440).default(120),
    recoveryTest: z.boolean().default(false),
    holdAfterStage: z.number().int().min(0).max(2).default(0),
  })
  .strict()
  .refine(
    (v) =>
      new Set(
        v.sources.map((s) =>
          s.kind === "source" ? s.id : `${s.connectionId}:${s.resourceId}`,
        ),
      ).size === v.sources.length,
    "Duplicate sources",
  );
export const workToolInputs = {
  list_connected_sources: z.object({}).strict(),
  refresh_connected_source: z
    .object({ sourceIndex: z.number().int().min(0).max(2) })
    .strict(),
  start_document_job: z.object({}).strict(),
  inspect_document_job: z.object({}).strict(),
  control_document_job: z
    .object({
      action: z.enum(["pause", "resume", "cancel"]),
      expectedVersion: z.number().int().positive(),
    })
    .strict(),
  propose_sandbox_payment: z.object({}).strict(),
  request_clarification: z
    .object({
      question: z.string().trim().min(1).max(500),
      field: z.literal("fields"),
    })
    .strict(),
} as const;
export const workAnswer = z
  .object({
    action: z.literal("answer"),
    questionId: z.uuid(),
    expectedVersion: z.number().int().positive(),
    answerId: z.uuid(),
    fields: comparisonFields,
  })
  .strict();
/** Allowed task phase is application state, never a model's proposed plan. */
export function workPhaseTools(
  w: {
    internal_kind?: string;
    state: string;
    job_id?: string;
    request: { fields?: string[]; sources: unknown[]; payment?: unknown };
    resolved_sources: unknown[];
  },
  jobState: string | null,
  completed: string[],
) {
  if (w.internal_kind === "payment_result") return ["reply"];
  if (w.internal_kind === "job_result")
    return completed.includes(
      jobState === "completed" ? "read_job_result" : "inspect_document_job",
    )
      ? (w.request.payment && jobState === "completed" && !completed.includes("propose_sandbox_payment") ? ["propose_sandbox_payment"] : ["reply", "create_draft"])
      : [jobState === "completed" ? "read_job_result" : "inspect_document_job"];
  if (
    [
      "waiting_source",
      "needs_reconnect",
      "budget_exhausted",
      "failed",
    ].includes(w.state)
  )
    return ["reply"];
  if (w.job_id) {
    if (
      w.internal_kind === "owner_resume" &&
      ["failed", "paused"].includes(jobState ?? "")
    )
      return completed.includes("inspect_document_job")
        ? ["control_document_job"]
        : ["inspect_document_job"];
    return ["reply"];
  }
  if (!w.request.fields) return ["request_clarification"];
  return w.resolved_sources.length < w.request.sources.length
    ? ["refresh_connected_source"]
    : ["start_document_job"];
}
