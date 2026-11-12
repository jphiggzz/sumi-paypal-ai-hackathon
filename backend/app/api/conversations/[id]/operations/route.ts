import { armRecovery } from "../../../../../lib/recovery-workflow";
import {
  appendTurn,
  conversationEvent,
} from "../../../../../lib/conversation-store";
import { dispatchConversation } from "../../../../../lib/conversation-dispatch";
import { followUpInput } from "../../../../../lib/conversation-policy";
import { z } from "zod";
import {
  admittedUser,
  noStore,
  sameOrigin,
  canStartTask,
} from "../../../../../lib/agent-api";
import { transaction } from "../../../../../lib/agent-store";
import { operations } from "../../../../../lib/operations";
import { apiFailure, boundedJson } from "../../../../../lib/foundation-api";
import { POST as conversationPost } from "../route";
import { recoverConversation } from "../../../../../lib/conversation-dispatch";
export async function GET(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const a = await admittedUser(request);
  if (a.error) return a.error;
  try {
    const { id } = await params;
    if (!z.uuid().safeParse(id).success)
      return new Response(null, { status: 404 });
    return Response.json(
      await transaction((c) => operations(c, a.user.id, id)),
      { headers: noStore },
    );
  } catch (e) {
    return apiFailure(e);
  }
}
export async function POST(
  request: Request,
  context: { params: Promise<{ id: string }> },
) {
  if (!sameOrigin(request)) return new Response(null, { status: 403 });
  const a = await admittedUser(request);
  if (a.error) return a.error;
  if (!canStartTask(request, a.user))
    return new Response(null, { status: 403 });
  try {
    const p = z
      .object({
        operation: z.enum(["retry_turn", "retry_exhausted", "reconcile"]),
        requestId: z.uuid().optional(),
      })
      .strict()
      .safeParse(await boundedJson(request));
    if (!p.success) return new Response(null, { status: 400 });
    const { id } = await context.params;
    if (!z.uuid().safeParse(id).success)
      return new Response(null, { status: 404 });
    await transaction((c) => operations(c, a.user.id, id));
    if (p.data.operation === "retry_exhausted") {
      if (!p.data.requestId) return new Response(null, { status: 400 });
      const requestId = p.data.requestId;
      const deadline = await armRecovery(id, a.user.id, {
        messageId: requestId,
      });
      const result = await transaction(async (c) => {
        const conversation = (
          await c.query(
            "SELECT requested_sequence FROM agent_conversations WHERE id=$1 AND owner_id=$2 FOR UPDATE",
            [id, a.user.id],
          )
        ).rows[0];
        if (!conversation) return { status: 404 };
        const prior = (
          await c.query(
            "SELECT new_sequence FROM agent_repairs WHERE id=$1 AND owner_id=$2 AND conversation_id=$3",
            [requestId, a.user.id, id],
          )
        ).rows[0];
        if (prior) return { status: 200, sequence: prior.new_sequence };
        const turn = (
          await c.query(
            "SELECT * FROM conversation_turns WHERE conversation_id=$1 AND sequence=$2 AND status='failed' AND attempt>=3",
            [id, conversation.requested_sequence],
          )
        ).rows[0];
        if (!turn) return { status: 409 };
        if (
          (
            await c.query(
              "SELECT 1 FROM conversation_messages WHERE conversation_id=$1 AND message_key='reply:'||($2::integer)::text UNION ALL SELECT 1 FROM conversation_revisions WHERE conversation_id=$1 AND revision=$2::integer UNION ALL SELECT 1 FROM fixture_note_effects WHERE proposal_id IN (SELECT id FROM agent_action_proposals WHERE conversation_id=$1 AND sequence=$2::integer)",
              [id, turn.sequence],
            )
          ).rowCount
        )
          return { status: 409 };
        const follow = followUpInput.parse({
          messageId: requestId,
          text: turn.text,
          executionMode: turn.execution_mode,
          capabilityRequest: turn.capability_request ?? undefined,
        });
        const admitted = await appendTurn(
          c,
          id,
          a.user.id,
          follow,
          undefined,
          deadline,
        );
        if (admitted.status !== 201) return admitted;
        await c.query(
          "INSERT INTO agent_repairs(id,owner_id,conversation_id,original_sequence,new_sequence) VALUES($1,$2,$3,$4,$5)",
          [requestId, a.user.id, id, turn.sequence, admitted.sequence],
        );
        await conversationEvent(
          c,
          id,
          "repair:" + requestId,
          "repair_admitted",
          {
            originalSequence: turn.sequence,
            newSequence: admitted.sequence,
            manualOwnerRequest: true,
          },
        );
        return admitted;
      });
      if ([200, 201].includes(result.status)) await dispatchConversation(id);
      return Response.json(result, { status: result.status, headers: noStore });
    }
    if (p.data.operation === "retry_turn")
      return conversationPost(
        new Request(request.url, {
          method: "POST",
          headers: request.headers,
          body: JSON.stringify({ action: "retry" }),
        }),
        context,
      );
    const r = await recoverConversation(id, a.user.id);
    return Response.json(
      { accepted: r.status === 200 },
      { status: r.status, headers: noStore },
    );
  } catch (e) {
    return apiFailure(e);
  }
}
