import { CapabilityError } from "../../../lib/capability-contracts";
import { armRecovery } from "../../../lib/recovery-workflow";
import {
  admittedUser,
  canStartTask,
  noStore,
  sameOrigin,
} from "../../../lib/agent-api";
import { authPool } from "../../../lib/auth";
import { conversationInput } from "../../../lib/conversation-policy";
import {
  ConversationLimitError,
  createConversation,
} from "../../../lib/conversation-store";
import { dispatchConversation } from "../../../lib/conversation-dispatch";

export async function GET(request: Request) {
  const access = await admittedUser(request);
  if (access.error) return access.error;
  const { rows } = await authPool.query(
    "SELECT id,title,status,requested_sequence,processed_sequence,latest_revision,updated_at,GREATEST(0,processed_sequence-read_sequence) AS unread FROM agent_conversations WHERE owner_id=$1 ORDER BY updated_at DESC LIMIT 100",
    [access.user.id],
  );
  return Response.json({ conversations: rows }, { headers: noStore });
}
export async function POST(request: Request) {
  if (!sameOrigin(request)) return new Response(null, { status: 403 });
  const access = await admittedUser(request);
  if (access.error) return access.error;
  if (!canStartTask(request, access.user))
    return Response.json(
      { error: "A valid preview access code is required." },
      { status: 403 },
    );
  const parsed = conversationInput.safeParse(
    await request.json().catch(() => null),
  );
  if (!parsed.success)
    return Response.json(
      { error: "Enter a message and source text within the displayed limits." },
      { status: 400 },
    );
  try {
    const admissionDeadline = await armRecovery(
      parsed.data.id,
      access.user.id,
      {
        messageId: parsed.data.messageId,
      },
    );
    const result = await createConversation(
      access.user.id,
      parsed.data,
      admissionDeadline,
    );
    if (!("id" in result))
      return Response.json(
        { error: "Conversation request conflicts with an existing request." },
        { status: result.status },
      );
    try {
      if (!parsed.data.dispatchRecoveryTest)
        await dispatchConversation(result.id);
    } catch {
      return Response.json(
        {
          ...result,
          error:
            "Your message was saved. Retry the same request or resume processing.",
        },
        { status: 503 },
      );
    }
    return Response.json(
      { id: result.id, sequence: result.sequence },
      { status: result.status, headers: noStore },
    );
  } catch (error) {
    if (error instanceof CapabilityError)
      return Response.json({ error: error.code }, { status: error.status,headers:noStore });
    if (error instanceof ConversationLimitError)
      return Response.json(
        { error: "Daily turn limit reached." },
        { status: 429 },
      );
    throw error;
  }
}
