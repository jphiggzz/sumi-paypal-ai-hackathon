import { z } from "zod";
import { start } from "workflow/api";
import { giftGroupInput } from "./gift-policy";
import { giftAgentWorkflow } from "./gift-workflow";
import { admitGiftJob, approveGiftOption, captureGift, createGiftGroup, fundGift, giftAccess, giftError, joinGiftGroup, readGiftState, recordGiftPurchase, rotateGiftInvite, selectGiftOption, setGiftLimit, shareGiftMessage } from "./gift-store";
import { authPool } from "./auth";
const g = { groupId: z.uuid() }, digest = z.string().regex(/^[a-f0-9]{64}$/);
export const giftActionInput = z.discriminatedUnion("action", [
  giftGroupInput.extend({ action: z.literal("create") }),
  z.object({ action: z.literal("join"), token: z.string().regex(/^[A-Za-z0-9_-]{43}$/) }).strict(),
  z.object({ action: z.literal("invite"), ...g }).strict(),
  z.object({ action: z.literal("limit"), ...g, cents: z.number().int().min(0).max(20000) }).strict(),
  z.object({ action: z.literal("chat"), ...g, id: z.uuid(), text: z.string().trim().min(1).max(1500) }).strict(),
  z.object({ action: z.literal("share"), ...g, messageId: z.uuid(), active: z.boolean() }).strict(),
  z.object({ action: z.literal("plan"), ...g, id: z.uuid(), seed: z.object({ jobId: z.uuid(), productId: z.string().min(1).max(200), similar: z.boolean(), chatMessageId: z.uuid().optional() }).strict().optional() }).strict(),
  z.object({ action: z.literal("recover"), ...g, id: z.uuid() }).strict(),
  z.object({ action: z.literal("select"), ...g, jobId: z.uuid(), optionId: z.string().regex(/^[0-2]$/) }).strict(),
  z.object({ action: z.literal("approve"), ...g, digest }).strict(),
  z.object({ action: z.literal("fund"), ...g, id: z.uuid(), digest, cents: z.number().int().min(100).max(20000) }).strict(),
  z.object({ action: z.literal("checkout"), ...g, id: z.uuid(), digest, cents: z.number().int().min(100).max(20000) }).strict(),
  z.object({ action: z.enum(["capture", "reconcile"]), ...g, id: z.uuid() }).strict(),
  z.object({ action: z.literal("record_order"), ...g, digest, reference: z.string().trim().min(3).max(200) }).strict(),
]);
export async function executeGiftAction(account: { id: string; name: string }, v: z.infer<typeof giftActionInput>, origin: string, returnPath?: string) {
  if (v.action === "create") return createGiftGroup(account, v);
  if (v.action === "join") return joinGiftGroup(account, v.token);
    const user = account.id, id = v.groupId;
    if (v.action === "invite") return { inviteToken: await rotateGiftInvite(user, id) };
    if (v.action === "limit") await setGiftLimit(user, id, v.cents);
    else if (v.action === "share") await shareGiftMessage(user, id, v.messageId, v.active);
    else if (v.action === "chat" || v.action === "plan") {
      await giftAccess(authPool, user, id);
      const deadline = Date.now() + 30000;
      await start(giftAgentWorkflow, [v.id]);
      await admitGiftJob(user, id, v.id, v.action, v.action === "chat" ? v.text : undefined, deadline, v.action === "plan" ? v.seed : undefined);
    } else if (v.action === "recover") {
      const { m } = await giftAccess(authPool, user, id);
      const r = (await authPool.query("SELECT kind,member_id,status FROM gift_jobs WHERE id=$1 AND group_id=$2", [v.id, id])).rows[0];
      if (!r || (r.kind === "chat" && r.member_id !== m.id) || !["queued", "running"].includes(r.status)) giftError("GIFT_JOB_NOT_FOUND", 404);
      await start(giftAgentWorkflow, [v.id]);
    } else if (v.action === "select") await selectGiftOption(user, id, v.jobId, v.optionId);
    else if (v.action === "approve") await approveGiftOption(user, id, v.digest);
    else if (v.action === "fund") await fundGift(user, id, v.id, v.digest, v.cents, origin, returnPath);
    else if (v.action === "checkout") await fundGift(user, id, v.id, v.digest, v.cents, origin, returnPath, true);
    else if (v.action === "capture" || v.action === "reconcile") await captureGift(user, id, v.id, v.action === "reconcile");
    else if (v.action === "record_order") await recordGiftPurchase(user, id, v.digest, v.reference);
    return readGiftState(user, id);
}
