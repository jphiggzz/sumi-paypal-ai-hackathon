import { z } from "zod";
import { start } from "workflow/api";
import {
  admittedUser,
  canStartTask,
  sameOrigin,
  noStore,
} from "../../../lib/agent-api";
import { boundedJson, apiFailure } from "../../../lib/foundation-api";
import { transaction } from "../../../lib/agent-store";
import { assertWork, chargeWork } from "../../../lib/work-store";
import { resultCorrection } from "../../../lib/evidence-policy";
import { workspaceState } from "../../../lib/workspace-policy";
import { correctResult } from "../../../lib/evidence-store";
import { readWorkspace, saveWorkspace } from "../../../lib/workspace-store";
import { workspaceRequestWorkflow } from "../../../lib/workspace-workflow";
import { CapabilityError } from "../../../lib/capability-contracts";
const input = z.discriminatedUnion("action", [
  resultCorrection,
  z
    .object({
      action: z.literal("save"),
      workId: z.uuid(),
      expectedRevision: z.number().int().min(0),
      state: workspaceState,
    })
    .strict(),
  z
    .object({
      action: z.literal("request"),
      id: z.uuid(),
      workId: z.uuid(),
      expectedRevision: z.number().int().min(0),
      prompt: z.string().trim().min(1).max(500),
    })
    .strict(),
  z
    .object({
      action: z.literal("cancel_request"),
      id: z.uuid(),
      workId: z.uuid(),
    })
    .strict(),
]);
export async function GET(request: Request) {
  const a = await admittedUser(request);
  if (a.error) return a.error;
  try {
    const id = z.uuid().parse(new URL(request.url).searchParams.get("workId"));
    return Response.json(await readWorkspace(a.user.id, id), {
      headers: noStore,
    });
  } catch (e) {
    return e instanceof z.ZodError
      ? new Response(null, { status: 400 })
      : apiFailure(e);
  }
}
export async function POST(request: Request) {
  if (!sameOrigin(request)) return new Response(null, { status: 403 });
  const a = await admittedUser(request);
  if (a.error) return a.error;
  if (!canStartTask(request, a.user))
    return new Response(null, { status: 403 });
  try {
    const p = input.safeParse(await boundedJson(request));
    if (!p.success) return new Response(null, { status: 400 });
    const v = p.data;
    if (v.action === "correct")
      return Response.json(
        await correctResult(a.user.id, { ...v, value: v.value ?? null }),
        { headers: noStore },
      );
    if (v.action === "save")
      return Response.json(
        await saveWorkspace(a.user.id, v.workId, v.expectedRevision, v.state),
        { headers: noStore },
      );
    if (v.action === "cancel_request") {
      await transaction(async (c) => {
        await assertWork(c, v.workId, a.user.id);
        await c.query(
          "UPDATE agent_workspace_requests SET status='cancelled' WHERE id=$1 AND owner_id=$2 AND work_id=$3 AND status IN ('queued','running')",
          [v.id, a.user.id, v.workId],
        );
      });
      return Response.json({ cancelled: true });
    }
    const existing = await transaction(async (c) => {
      await assertWork(c, v.workId, a.user.id);
      return (
        await c.query("SELECT * FROM agent_workspace_requests WHERE id=$1", [
          v.id,
        ])
      ).rows[0];
    });
    if (existing) {
      if (
        existing.owner_id !== a.user.id ||
        existing.work_id !== v.workId ||
        existing.prompt !== v.prompt ||
        existing.expected_revision !== v.expectedRevision
      )
        throw new CapabilityError("WORKSPACE_REQUEST_CONFLICT", 409);
      return Response.json({ id: v.id, replayed: true });
    }
    const deadline = Date.now() + 30000,
      run = await start(workspaceRequestWorkflow, [a.user.id, v.id]);
    await transaction(async (c) => {
      await c.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", [
        "workspace:" + v.id,
      ]);
      const raced = (
        await c.query("SELECT * FROM agent_workspace_requests WHERE id=$1", [
          v.id,
        ])
      ).rows[0];
      if (raced) {
        if (
          raced.owner_id !== a.user.id ||
          raced.work_id !== v.workId ||
          raced.prompt !== v.prompt ||
          raced.expected_revision !== v.expectedRevision
        )
          throw new CapabilityError("WORKSPACE_REQUEST_CONFLICT", 409);
        return;
      }
      const w = await assertWork(c, v.workId, a.user.id);
      if (Date.now() > deadline)
        throw new CapabilityError("WORKSPACE_ADMISSION_EXPIRED", 409);
      const currentRevision =
        (
          await c.query(
            "SELECT revision FROM agent_workspaces WHERE work_id=$1",
            [v.workId],
          )
        ).rows[0]?.revision ?? 0;
      if (currentRevision !== v.expectedRevision)
        throw new CapabilityError("WORKSPACE_REVISION_CONFLICT", 409);
      await chargeWork(c, w, "dispatch", 1, "workspace:" + v.id);
      await c.query(
        "INSERT INTO agent_workspace_requests(id,work_id,owner_id,prompt,expected_revision,workflow_run_id) VALUES($1,$2,$3,$4,$5,$6)",
        [v.id, w.id, a.user.id, v.prompt, v.expectedRevision, run.runId],
      );
    });
    return Response.json({ id: v.id });
  } catch (e) {
    return apiFailure(e);
  }
}
