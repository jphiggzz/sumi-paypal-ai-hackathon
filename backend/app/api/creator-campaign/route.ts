import { z } from "zod";
import { WorkspaceError } from "../../../lib/workspace-chat";
import {
  admittedUser,
  canStartTask,
  sameOrigin,
  noStore,
} from "../../../lib/agent-api";
import { boundedJson, apiFailure } from "../../../lib/foundation-api";
import { readCreatorCampaign, creatorAction } from "../../../lib/creator/store";
import { CreatorValidationError } from "../../../lib/creator/policy";
import { authPool } from "../../../lib/auth";
import { campaignPayoutReady } from "../../../lib/paypal";
const command = z.discriminatedUnion("action", [
  z.object({ action: z.literal("approve_deals"), revision: z.number().int().nonnegative(), deals: z.array(z.object({ dealId: z.uuid(), digest: z.string().regex(/^[a-f0-9]{64}$/) }).strict()).min(1).max(20) }).strict(),
  z.object({ action: z.literal("approve_business"), revision: z.number().int().nonnegative(), runId: z.uuid() }).strict(),
  z.object({ action: z.literal("outreach_draft"), revision: z.number().int().nonnegative(), creatorIds: z.array(z.string().max(80)).min(1).max(20), message: z.string().trim().min(1).max(3000) }).strict(),
  z.object({ action: z.literal("outreach_send"), revision: z.number().int().nonnegative() }).strict(),
  z.object({ action: z.literal("outreach_responses"), revision: z.number().int().nonnegative(), responses: z.array(z.object({ creatorId: z.string().max(80), status: z.enum(["email", "connected", "none"]), reply: z.string().trim().max(1000).optional() }).strict()).min(1).max(20) }).strict(),
  z
    .object({
      action: z.literal("prepare"),
      creatorId: z.string().max(80),
      revision: z.number().int().nonnegative(),
      delivery: z.string().trim().min(1).max(100),
      rightsDays: z.number().int().min(1).max(365),
      paymentStructure: z.enum(["upfront", "split"]).optional(),
    })
    .strict(),
  z
    .object({
      action: z.enum(["approve", "delivery", "complete", "pay"]),
      dealId: z.uuid(),
      digest: z.string().regex(/^[a-f0-9]{64}$/),
      revision: z.number().int().nonnegative(),
      installmentId: z.enum(["upfront", "delivery"]).optional(),
    })
    .strict(),
]);
export async function GET(req: Request) {
  const a = await admittedUser(req);
  if (a.error) return a.error;
  try {
    return Response.json(
      {
        state: await readCreatorCampaign(
          a.user.id,
          z.uuid().parse(new URL(req.url).searchParams.get("conversationId")),
        ),
        payoutReady: campaignPayoutReady(),
        runs: (
          await authPool.query(
            "SELECT r.id,r.message_id,r.revision,r.status,r.activity,r.result,r.input->'brief' AS brief,r.input->'website' AS website,r.input->'audienceSuggestions' AS audience_suggestions,COALESCE((r.input->>'businessApproved')::boolean,false) AS business_approved,r.updated_at FROM creator_runs r JOIN workspace_chats c ON c.id=r.conversation_id JOIN workspace_chat_messages m ON m.id=r.message_id WHERE r.conversation_id=$1 AND c.owner_id=$2 ORDER BY m.sequence,r.id",
            [new URL(req.url).searchParams.get("conversationId"), a.user.id],
          )
        ).rows,
      },
      { headers: noStore },
    );
  } catch (e) {
    if (e instanceof z.ZodError)
      return Response.json(
        { error: "Invalid conversation." },
        { status: 400, headers: noStore },
      );
    return e instanceof WorkspaceError
      ? Response.json(
          { error: e.message },
          { status: e.status, headers: noStore },
        )
      : apiFailure(e);
  }
}
export async function POST(req: Request) {
  if (!sameOrigin(req)) return new Response(null, { status: 403 });
  const a = await admittedUser(req);
  if (a.error) return a.error;
  if (!canStartTask(req, a.user))
    return Response.json(
      { error: "Preview access required." },
      { status: 403 },
    );
  try {
    const b = z
      .object({ conversationId: z.uuid(), command })
      .strict()
      .parse(await boundedJson(req));
    return Response.json(
      {
        state: await creatorAction(a.user.id, b.conversationId, b.command),
        payoutReady: campaignPayoutReady(),
      },
      { headers: noStore },
    );
  } catch (e) {
    if (e instanceof z.ZodError)
      return Response.json(
        { error: "Invalid campaign action." },
        { status: 400, headers: noStore },
      );
    if (e instanceof WorkspaceError || e instanceof CreatorValidationError)
      return Response.json(
        { error: e.message },
        {
          status: e instanceof WorkspaceError ? e.status : 409,
          headers: noStore,
        },
      );
    return apiFailure(e);
  }
}
