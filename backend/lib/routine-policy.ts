import { capabilityCheck } from "./capability-policy";
import { z } from "zod";

export const routineInput = z
  .object({
    id: z.uuid(),
    instruction: z.string().trim().min(1).max(2000),
    executionMode: z
      .enum(["checkpoint", "assistant", "capability_check"])
      .default("checkpoint"),
    capabilityRequest: capabilityCheck.optional(),
    dueAt: z.iso.datetime({ offset: true }),
    timezone: z
      .string()
      .max(100)
      .refine((value) => {
        try {
          new Intl.DateTimeFormat("en", { timeZone: value });
          return true;
        } catch {
          return false;
        }
      }),
    intervalSeconds: z
      .number()
      .int()
      .min(60)
      .max(604800)
      .nullable()
      .default(null),
    maxRuns: z.number().int().min(1).max(10).default(1),
    expiresAt: z.iso.datetime({ offset: true }),
  })
  .superRefine((value, ctx) => {
    if (
      (value.executionMode === "capability_check") !==
      !!value.capabilityRequest
    )
      ctx.addIssue({
        code: "custom",
        message: "Capability checks require their exact tool request.",
      });
    const due = Date.parse(value.dueAt),
      expiry = Date.parse(value.expiresAt);
    if (expiry <= due || expiry > Date.now() + 7 * 86400000)
      ctx.addIssue({
        code: "custom",
        message: "Expiry must follow the first run and be within seven days.",
      });
    if (!value.intervalSeconds && value.maxRuns !== 1)
      ctx.addIssue({ code: "custom", message: "One-time routines run once." });
  });

// Fixed elapsed intervals deliberately avoid ambiguous wall-clock DST rules.
// Missed occurrences coalesce to one run; there is no catch-up burst.
export function nextDue(due: Date, seconds: number | null, now: Date) {
  if (seconds === null) return null;
  const interval = seconds * 1000;
  return new Date(
    due.getTime() +
      (Math.floor(Math.max(0, now.getTime() - due.getTime()) / interval) + 1) *
        interval,
  );
}

export function modelBudgetReservation(model: string) {
  return model === "amazon/nova-micro" ? 0.01 : 0.15;
}
export function fullRequestPrice(entry: {
  context_window: number;
  pricing: {
    input: string;
    output: string;
    regional?: Record<string, { input?: string; output?: string }>;
  };
}) {
  const prices = [
    entry.pricing,
    ...Object.values(entry.pricing.regional ?? {}),
  ];
  const input = Math.max(
    ...prices.map((p) => Number(p.input ?? entry.pricing.input)),
  );
  const output = Math.max(
    ...prices.map((p) => Number(p.output ?? entry.pricing.output)),
  );
  if (
    !Number.isFinite(entry.context_window) ||
    entry.context_window <= 0 ||
    !Number.isFinite(input) ||
    !Number.isFinite(output) ||
    input < 0 ||
    output < 0
  )
    return Infinity;
  return entry.context_window * input + 3000 * output;
}
export const cheapModels = [
  "amazon/nova-micro",
  "google/gemini-2.5-flash-lite",
];
export function dailyModelLimit(value = process.env.AGENT_MODEL_DAILY_USD) {
  const parsed = Number(value ?? 5);
  return Number.isFinite(parsed) ? Math.max(0, Math.min(10, parsed)) : 5;
}
