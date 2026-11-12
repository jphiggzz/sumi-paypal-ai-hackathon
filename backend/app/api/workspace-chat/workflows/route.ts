import { z } from "zod";
import {
  admittedUser,
  canStartTask,
  noStore,
  sameOrigin,
} from "../../../../lib/agent-api";
import { snackSettings } from "../../../../lib/snack-policy";
import { boundedJson, apiFailure } from "../../../../lib/foundation-api";
import {
  readWorkspaceFlows,
  startSnackDraft, setupWorkspaceSnack, joinWorkspaceSnack,
  shareGroupFeedback,
  hasWorkspaceGiftMembership,
  prepareCampaign,
  prepareGift,
  updateGiftDraft,
  workspaceGiftAction,
  shareWorkspaceContext,
  joinWorkspaceGift,
  approveWorkspaceCampaign,
} from "../../../../lib/workspace-flows";
const action = z.discriminatedUnion("action", [
  z.object({ action: z.literal("prepare_snacks") }).strict(),
  z.object({ action: z.literal("snack_setup"), settings: snackSettings }).strict(),
  z.object({ action: z.literal("join_snacks"), token: z.string().regex(/^[A-Za-z0-9_-]{43}$/) }).strict(),
  z
    .object({
      action: z.literal("group_feedback"),
      id: z.uuid(),
      text: z.string().trim().min(1).max(1500),
    })
    .strict(),
  z.object({ action: z.literal("prepare_campaign") }),
  z.object({ action: z.literal("gift_draft"), participantChoice: z.enum(["solo", "invite"]).optional(), title: z.string().trim().min(1).max(80).optional(), inviteComplete: z.boolean().optional(), readyForBudget: z.boolean().optional() }).strict(),
  z.object({
    action: z.literal("prepare_gift"),
    recipient: z.string().trim().min(1).max(80),
    occasion: z.string().trim().min(3).max(600),
    reserveCents: z.number().int().min(0).max(10000),
  }),
  z.object({
    action: z.literal("gift"),
    payload: z.record(z.string(), z.unknown()),
  }),
  z.object({
    action: z.literal("share_context"),
    messageId: z.uuid(),
    active: z.boolean(),
  }),
  z.object({
    action: z.literal("join_gift"),
    token: z.string().regex(/^[A-Za-z0-9_-]{43}$/),
  }),
  z.object({
    action: z.literal("approve_campaign"),
    approved: z.literal(true),
    scenario: z.enum(["payout", "review"]),
  }),
]);
const schema = z.object({ conversationId: z.uuid(), command: action });
export async function GET(req: Request) {
  const a = await admittedUser(req);
  if (a.error) return a.error;
  try {
    return Response.json(
      {
        flows: await readWorkspaceFlows(
          a.user.id,
          z.uuid().parse(new URL(req.url).searchParams.get("conversationId")),
        ),
      },
      { headers: noStore },
    );
  } catch (e) {
    return e instanceof z.ZodError
      ? Response.json(
          { error: "INVALID_INPUT" },
          { status: 400, headers: noStore },
        )
      : apiFailure(e);
  }
}
export async function POST(req: Request) {
  if (!sameOrigin(req)) return new Response(null, { status: 403 });
  const a = await admittedUser(req);
  if (a.error) return a.error;
  try {
    const { conversationId, command: c } = schema.parse(await boundedJson(req));
    const giftScope =
      ["gift", "share_context", "group_feedback"].includes(c.action) &&
      (await hasWorkspaceGiftMembership(a.user.id, conversationId));
    if (!canStartTask(req, a.user) && c.action !== "join_gift" && c.action !== "join_snacks" && !giftScope)
      return Response.json(
        { error: "Preview access required." },
        { status: 403, headers: noStore },
      );
    let result: unknown;
    if (c.action === "prepare_snacks") result = await startSnackDraft(a.user.id, conversationId);
    else if (c.action === "snack_setup") await setupWorkspaceSnack(a.user, conversationId, c.settings);
    else if (c.action === "join_snacks") await joinWorkspaceSnack(a.user, conversationId, c.token);
    else if (c.action === "group_feedback")
      await shareGroupFeedback(a.user.id, conversationId, c.id, c.text);
    else if (c.action === "prepare_campaign")
      result = await prepareCampaign(a.user.id, conversationId);
    else if (c.action === "gift_draft") {
      const { action: _, ...patch } = c;
      result = await updateGiftDraft(a.user, conversationId, patch);
    }
    else if (c.action === "prepare_gift")
      result = await prepareGift(a.user, conversationId, c);
    else if (c.action === "gift")
      result = await workspaceGiftAction(
        a.user,
        conversationId,
        c.payload,
        new URL(req.url).origin,
      );
    else if (c.action === "share_context")
      await shareWorkspaceContext(
        a.user.id,
        conversationId,
        c.messageId,
        c.active,
      );
    else if (c.action === "join_gift")
      await joinWorkspaceGift(a.user, conversationId, c.token);
    else await approveWorkspaceCampaign(a.user.id, conversationId, c.scenario);
    return Response.json(
      { result, flows: await readWorkspaceFlows(a.user.id, conversationId) },
      { headers: noStore },
    );
  } catch (e) {
    return e instanceof z.ZodError
      ? Response.json(
          { error: "INVALID_INPUT" },
          { status: 400, headers: noStore },
        )
      : apiFailure(e);
  }
}
