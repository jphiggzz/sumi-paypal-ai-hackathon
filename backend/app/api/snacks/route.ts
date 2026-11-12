import { z } from "zod";
import { start } from "workflow/api";
import { admittedUser, canStartTask, noStore, sameOrigin } from "../../../lib/agent-api";
import { boundedJson, apiFailure } from "../../../lib/foundation-api";
import { snackSettings, snackStock, productReview } from "../../../lib/snack-policy";
import { admitSnackCycle, claimSnackCycle, finishSnackCycle, simulateSnackOrder, configureSnackSchedule, decideSnackCycle, reviewSnackCycle, saveSnackOffice, saveSnackStock, snackOfficeState, ownedSnackOffice } from "../../../lib/snack-store";
import { createSnackPayment, captureSnackPayment } from "../../../lib/snack-payment";
import { authPool } from "../../../lib/auth";
import { snackCycleWorkflow, snackScheduleWorkflow } from "../../../lib/snack-workflow";
import { CapabilityError } from "../../../lib/capability-contracts";
const base = { officeId: z.uuid() };
const version = { ...base, revision: z.number().int().nonnegative() };
const cycle = { ...base, cycleId: z.uuid(), digest: z.string().regex(/^[a-f0-9]{64}$/) };
const input = z.discriminatedUnion("action", [
  z.object({ action: z.literal("save"), ...version, settings: snackSettings }).strict(),
  z.object({ action: z.literal("stock"), ...version, stock: snackStock }).strict(),
  z.object({ action: z.literal("plan"), ...version, cycleId: z.uuid() }).strict(),
  z.object({ action: z.literal("plan_simulated"), ...version, cycleId: z.uuid() }).strict(),
  z.object({ action: z.literal("simulate_order"), ...cycle }).strict(),
  z.object({ action: z.literal("checkout"), ...cycle, paymentId: z.uuid(), conversationId: z.uuid().optional() }).strict(),
  z.object({ action: z.enum(["capture", "reconcile_payment"]), ...base, paymentId: z.uuid() }).strict(),
  z.object({ action: z.literal("recover"), ...base, cycleId: z.uuid() }).strict(),
  z.object({ action: z.literal("review"), ...cycle, review: productReview }).strict(),
  z.object({ action: z.enum(["approve", "reject"]), ...cycle }).strict(),
  z.object({ action: z.literal("record_order"), ...cycle, reference: z.string().trim().min(3).max(200) }).strict(),
  z.object({ action: z.literal("schedule"), ...version, scheduleVersion: z.number().int().nonnegative(), active: z.boolean(), dueAt: z.iso.datetime().optional(), cadence: z.enum(["fortnight", "monthly"]).optional(), anchorDay: z.number().int().min(1).max(31).optional(), source: z.enum(["channel3", "simulated"]).optional() }).strict(),
]);
export async function GET(request: Request) {
  const a = await admittedUser(request);
  if (a.error) return a.error;
  try {
    const raw = new URL(request.url).searchParams.get("officeId");
    const id = raw ? z.uuid().parse(raw) : undefined;
    return Response.json(await snackOfficeState(a.user.id, id), { headers: noStore });
  } catch (e) { return e instanceof z.ZodError ? Response.json({ error: "INVALID_INPUT" }, { status: 400 }) : apiFailure(e); }
}
export async function POST(request: Request) {
  if (!sameOrigin(request)) return new Response(null, { status: 403 });
  const a = await admittedUser(request);
  if (a.error) return a.error;
  try {
    const v = input.parse(await boundedJson(request));
    // Pausing, stock reporting and rejection remain available without metered admission.
    if (!(v.action === "stock" || v.action === "reject" || v.action === "capture" || v.action === "reconcile_payment" || (v.action === "schedule" && !v.active)) && !canStartTask(request, a.user)) return new Response(null, { status: 403 });
    const owner = a.user.id;
    if (v.action === "save") await saveSnackOffice(owner, v.officeId, v.revision, v.settings);
    else if (v.action === "stock") await saveSnackStock(owner, v.officeId, v.revision, v.stock);
    else if (v.action === "review") await reviewSnackCycle(owner, v.officeId, v.cycleId, v.digest, v.review);
    else if (v.action === "checkout") {
      if (v.conversationId) {
        const linked = await authPool.query("SELECT 1 FROM workspace_workflow_links l JOIN workspace_chats c ON c.id=l.conversation_id WHERE c.id=$1 AND c.owner_id=$2 AND l.kind='snack' AND l.resource_id=$3", [v.conversationId, owner, v.officeId]);
        if (!linked.rowCount) throw new CapabilityError("WORKSPACE_NOT_FOUND", 404);
      }
      await createSnackPayment(owner, v.officeId, v.cycleId, v.digest, v.paymentId, new URL(request.url).origin, undefined, v.conversationId);
    }
    else if (v.action === "capture" || v.action === "reconcile_payment") await captureSnackPayment(owner, v.officeId, v.paymentId, v.action === "reconcile_payment");
    else if (v.action === "simulate_order") await simulateSnackOrder(owner, v.officeId, v.cycleId, v.digest);
    else if (v.action === "plan_simulated") {
      await ownedSnackOffice(authPool, owner, v.officeId);
      const deadline = Date.now() + 30000;
      await start(snackCycleWorkflow, [owner, v.officeId, v.cycleId, true]);
      await admitSnackCycle(owner, v.officeId, v.revision, v.cycleId, deadline, "simulated");
    }
    else if (v.action === "approve" || v.action === "reject" || v.action === "record_order") await decideSnackCycle(owner, v.officeId, v.cycleId, v.digest, v.action, v.action === "record_order" ? v.reference : undefined);
    else if (v.action === "plan") {
      if (!process.env.CHANNEL3_API_KEY) throw new CapabilityError("CHANNEL3_NOT_CONFIGURED", 503);
      const o = await ownedSnackOffice(authPool, owner, v.officeId);
      if (o.revision !== v.revision) throw new CapabilityError("SNACK_REVISION_CONFLICT", 409);
      // Start before publishing the cycle so an interrupted request cannot leave
      // an admitted job without an executor. Duplicate runs share a SQL lease.
      const deadline = Date.now() + 30000;
      await start(snackCycleWorkflow, [owner, v.officeId, v.cycleId]);
      await admitSnackCycle(owner, v.officeId, v.revision, v.cycleId, deadline);
    } else if (v.action === "recover") {
      const office = await ownedSnackOffice(authPool, owner, v.officeId);
      const r = (await authPool.query("SELECT * FROM snack_cycles WHERE id=$1 AND office_id=$2", [v.cycleId, v.officeId])).rows[0];
      if (!r || !["queued", "running"].includes(r.status)) throw new CapabilityError("SNACK_RECOVERY_CONFLICT", 409);
      await start(snackCycleWorkflow, [owner, v.officeId, v.cycleId, r.source === "simulated"]);
    } else if (v.action === "schedule") {
      const o = await ownedSnackOffice(authPool, owner, v.officeId);
      if (o.revision !== v.revision || o.schedule_version !== v.scheduleVersion) throw new CapabilityError("SNACK_REVISION_CONFLICT", 409);
      const deadline = Date.now() + 30000;
      if (v.active) {
        if ((v.source ?? "channel3") === "channel3" && !process.env.CHANNEL3_API_KEY) throw new CapabilityError("CHANNEL3_NOT_CONFIGURED", 503);
        if (!v.dueAt || Date.parse(v.dueAt) < Date.now() - 5000 || Date.parse(v.dueAt) > Date.now() + (v.cadence === "monthly" ? 32 : 14) * 86400000) throw new CapabilityError("SNACK_DUE_INVALID", 400);
        await start(snackScheduleWorkflow, [owner, v.officeId, v.scheduleVersion + 1]);
      }
      await configureSnackSchedule(owner, v.officeId, v.revision, v.scheduleVersion, v.active, v.dueAt, v.active ? deadline : undefined, v.cadence, v.anchorDay, v.source);
    }
    return Response.json(await snackOfficeState(owner, v.officeId), { headers: noStore });
  } catch (e) { return e instanceof z.ZodError ? Response.json({ error: "INVALID_INPUT", details: e.issues.map(i => i.message) }, { status: 400, headers: noStore }) : apiFailure(e); }
}
