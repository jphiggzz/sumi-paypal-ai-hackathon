import { z } from "zod";
const fieldId = z.enum([
  "facts.title",
  "facts.field",
  "facts.status",
  "facts.value",
  "facts.evidence",
  "facts.revision",
  "missing.title",
  "missing.field",
  "missing.status",
  "missing.value",
  "payments.state",
  "payments.cents",
  "payments.currency",
  "payments.payee",
  "payments.item",
]);
const widget = z.object({
  type: z.enum(["grid", "evidence-card", "payment-card"]),
  dataMapping: z
    .object({ cols: z.array(z.object({ id: fieldId })).max(8) })
    .optional(),
  format: z
    .object({
      title: z.object({ text: z.string().max(80) }).optional(),
      style: z
        .object({
          columnWidth: z.number().min(100).max(360).optional(),
          columnAutoSize: z.boolean().optional(),
        })
        .optional(),
    })
    .optional(),
});
const layout = z.object({
  xTrack: z.number().int().min(0).max(23),
  yTrack: z.number().int().min(0).max(200),
  xSpan: z.number().int().min(1).max(24),
  ySpan: z.number().int().min(4).max(80),
});
export const workspaceState = z
  .object({
    pages: z
      .array(
        z.object({
          id: z.string().regex(/^[a-z0-9-]{1,40}$/),
          widgets: z
            .record(z.string().regex(/^[a-z0-9-]{1,60}$/), widget)
            .refine((v) => Object.keys(v).length <= 8),
          widgetLayout: z.record(z.string().regex(/^[a-z0-9-]{1,60}$/), layout),
        }),
      )
      .min(1)
      .max(3),
    selectedPageId: z.string().max(40),
    panels: z
      .record(
        z.enum(["ai", "filters", "edit", "data"]),
        z.object({
          collapsed: z.boolean().optional(),
          width: z.number().min(180).max(600).optional(),
        }),
      )
      .optional(),
  })
  .refine(
    (s) =>
      s.pages.some((p) => p.id === s.selectedPageId) &&
      s.pages.every((p) =>
        Object.keys(p.widgets).every((k) => p.widgetLayout[k]),
      ),
  );
export const workspacePlan = z
  .object({
    action: z.enum([
      "add_evidence",
      "add_payments",
      "show_missing",
      "show_all",
      "unsupported",
    ]),
    message: z.string().max(300),
  })
  .strict();
export function initialWorkspace() {
  return {
    pages: [
      {
        id: "work",
        widgets: {
          comparison: {
            type: "grid",
            dataMapping: {
              cols: [
                "facts.title",
                "facts.field",
                "facts.value",
                "facts.status",
              ].map((id) => ({ id })),
            },
          },
          evidence: { type: "evidence-card" },
          payment: { type: "payment-card" },
        },
        widgetLayout: {
          comparison: { xTrack: 0, yTrack: 0, xSpan: 24, ySpan: 14 },
          evidence: { xTrack: 0, yTrack: 14, xSpan: 14, ySpan: 14 },
          payment: { xTrack: 14, yTrack: 14, xSpan: 10, ySpan: 14 },
        },
      },
    ],
    selectedPageId: "work",
    panels: {
      ai: { collapsed: false, width: 320 },
      filters: { collapsed: true },
      edit: { collapsed: true },
      data: { collapsed: true },
    },
  };
}
export function applyWorkspacePlan(
  state: unknown,
  action: z.infer<typeof workspacePlan>["action"],
) {
  const s = workspaceState.parse(state),
    p = s.pages[0];
  if (action === "unsupported") return s;
  const id =
    action === "add_evidence"
      ? "evidence"
      : action === "add_payments"
        ? "payment"
        : action === "show_missing"
          ? "missing"
          : "comparison";
  const type =
    id === "evidence"
      ? "evidence-card"
      : id === "payment"
        ? "payment-card"
        : "grid";
  const source = id === "missing" ? "missing" : "facts";
  p.widgets[id] = {
    type,
    ...(type === "grid"
      ? {
          dataMapping: {
            cols: [
              `${source}.title`,
              `${source}.field`,
              `${source}.value`,
              `${source}.status`,
            ].map((id) => ({ id: id as any })),
          },
        }
      : {}),
  };
  if (!p.widgetLayout[id]) {
    const y = Math.max(
      0,
      ...Object.values(p.widgetLayout).map((l) => l.yTrack + l.ySpan),
    );
    if (y > 180) throw new Error("Workspace layout limit");
    p.widgetLayout[id] = { xTrack: 0, yTrack: y, xSpan: 24, ySpan: 12 };
  }
  return workspaceState.parse(s);
}
