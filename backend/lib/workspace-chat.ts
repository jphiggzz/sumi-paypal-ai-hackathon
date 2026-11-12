import { authPool } from "./auth";
import { hasUnlimitedTestingAccess } from "./testing-access";
export type WorkspaceMode = "creators" | "shopping";
export class WorkspaceError extends Error {
  constructor(
    public code: string,
    public status = 409,
  ) {
    super(code);
  }
}
export async function snapshot(owner: string, id: string) {
  const chat = (
    await authPool.query(
      "SELECT * FROM workspace_chats WHERE id=$1 AND owner_id=$2",
      [id, owner],
    )
  ).rows[0];
  if (!chat) throw new WorkspaceError("Chat not found.", 404);
  await authPool.query(
    "UPDATE workspace_chat_messages SET status='interrupted' WHERE conversation_id=$1 AND status='streaming' AND lease_until<now()",
    [id],
  );
  const messages = (
    await authPool.query(
      "SELECT id,role,content,mode,status,parent_id,interaction FROM workspace_chat_messages WHERE conversation_id=$1 ORDER BY sequence",
      [id],
    )
  ).rows;
  return { chat, messages };
}
export async function createChat(
  owner: string,
  id: string,
  mode: WorkspaceMode,
) {
  const db = await authPool.connect();
  try {
    await db.query("BEGIN");
    await db.query("SELECT pg_advisory_xact_lock(hashtext($1))", [
      `workspace:${owner}`,
    ]);
    const existing = (
      await db.query("SELECT owner_id FROM workspace_chats WHERE id=$1", [id])
    ).rows[0];
    if (existing) {
      if (existing.owner_id !== owner)
        throw new WorkspaceError("Chat not found.", 404);
    } else {
      const count = (
        await db.query(
          "SELECT count(*)::int n FROM workspace_chats WHERE owner_id=$1",
          [owner],
        )
      ).rows[0].n;
      if (!hasUnlimitedTestingAccess(owner) && count >= 40) throw new WorkspaceError("Chat limit reached.", 429);
      await db.query(
        "INSERT INTO workspace_chats(id,owner_id,mode) VALUES($1,$2,$3)",
        [id, owner, mode],
      );
    }
    await db.query("COMMIT");
  } catch (e) {
    await db.query("ROLLBACK");
    throw e;
  } finally {
    db.release();
  }
  return snapshot(owner, id);
}
export async function acceptTurn(
  owner: string,
  input: {
    conversationId: string;
    requestId: string;
    messageId: string;
    text: string;
    mode: WorkspaceMode;
    revision: number;
    retryOf?: string;
  },
) {
  const db = await authPool.connect();
  try {
    await db.query("BEGIN");
    // Serialize owner-wide admission as well as this conversation's revision.
    await db.query("SELECT pg_advisory_xact_lock(hashtext($1))", [
      `workspace:${owner}`,
    ]);
    const chat = (
      await db.query(
        "SELECT * FROM workspace_chats WHERE id=$1 AND owner_id=$2 FOR UPDATE",
        [input.conversationId, owner],
      )
    ).rows[0];
    if (!chat) throw new WorkspaceError("Chat not found.", 404);
    const previous = (
      await db.query("SELECT * FROM workspace_chat_messages WHERE id=$1", [
        input.requestId,
      ])
    ).rows[0];
    if (previous)
      throw new WorkspaceError(
        "Request already accepted. Reopen the saved reply.",
        409,
      );
    if (chat.revision !== input.revision)
      throw new WorkspaceError("Chat changed. Reload before sending.");
    await db.query(
      "UPDATE workspace_chat_messages SET status='interrupted' WHERE conversation_id=$1 AND status='streaming' AND lease_until<now()",
      [chat.id],
    );
    const history = (
      await db.query(
        "SELECT * FROM workspace_chat_messages WHERE conversation_id=$1 ORDER BY sequence",
        [chat.id],
      )
    ).rows;
    if (history.some((m) => m.status === "streaming"))
      throw new WorkspaceError("A reply is already in progress.");
    if (!hasUnlimitedTestingAccess(owner) && history.length >= 200)
      throw new WorkspaceError("Start a new chat to continue.", 429);
    const count = (
      await db.query(
        "SELECT count(*)::int n FROM workspace_chat_messages m JOIN workspace_chats c ON c.id=m.conversation_id WHERE c.owner_id=$1 AND m.role='assistant' AND m.created_at>date_trunc('day',now() AT TIME ZONE 'UTC') AT TIME ZONE 'UTC'",
        [owner],
      )
    ).rows[0].n;
    if (!hasUnlimitedTestingAccess(owner) && count >= 30) throw new WorkspaceError("Daily chat limit reached.", 429);
    if (input.retryOf) {
      const last = history.at(-1);
      const parent = history.find((m) => m.id === input.messageId);
      if (
        !last ||
        last.id !== input.retryOf ||
        !["failed", "interrupted"].includes(last.status) ||
        last.parent_id !== input.messageId ||
        parent?.content !== input.text
      )
        throw new WorkspaceError(
          "Only the latest interrupted reply can be retried.",
        );
    } else {
      if (history.some((m) => m.id === input.messageId))
        throw new WorkspaceError("Message already accepted.");
      await db.query(
        "INSERT INTO workspace_chat_messages(id,conversation_id,role,content,mode,status) VALUES($1,$2,'user',$3,$4,'completed')",
        [input.messageId, chat.id, input.text, input.mode],
      );
    }
    await db.query(
      "INSERT INTO workspace_chat_messages(id,conversation_id,role,content,mode,parent_id,status,lease_until) VALUES($1,$2,'assistant','',$3,$4,'streaming',now()+interval '90 seconds')",
      [input.requestId, chat.id, input.mode, input.messageId],
    );
    await db.query(
      "UPDATE workspace_chats SET mode=$2,revision=revision+1,title=CASE WHEN title='New chat' THEN $3 ELSE title END,updated_at=now() WHERE id=$1",
      [chat.id, input.mode, input.text.slice(0, 70)],
    );
    await db.query("COMMIT");
    return [
      ...history
        .filter((m) => m.status === "completed")
        .map((m) => ({
          role: m.role as "user" | "assistant",
          content: (String(m.content) + (m.role === "assistant" && ["gift_clarification", "creator_clarification"].includes(m.interaction?.type) && Array.isArray(m.interaction.options) && m.interaction.options.length ? `\n[Options presented to the user: ${JSON.stringify(m.interaction.options)}]` : "")).slice(0, 8000),
        })),
      ...(!input.retryOf
        ? [{ role: "user" as const, content: input.text }]
        : []),
    ].slice(-24);
  } catch (e) {
    await db.query("ROLLBACK");
    throw e;
  } finally {
    db.release();
  }
}
export async function saveReply(
  id: string,
  content: string,
  status: "streaming" | "completed" | "interrupted" | "failed",
) {
  const result = await authPool.query(
    "UPDATE workspace_chat_messages SET content=$2,status=$3 WHERE id=$1 AND status='streaming' RETURNING id",
    [id, content, status],
  );
  return !!result.rowCount;
}
export const workspaceSystem = (mode: WorkspaceMode) =>
  `You are Sume, a practical agent for creator campaigns and shopping/group gifts. Starting mode: ${mode === "creators" ? "creator campaigns" : "shopping and group gifts"}, but either workflow can be used in any chat. Use tools to prepare workflow cards when asked to plan a group gift, restock office snacks, or explicitly open the fixed ChatEDU Sandbox demo. Office snacks use a simulated supplier and require explicit setup, product review, and owner payment. Only start snack collaboration when the user asks to build or compare a basket after setup. Never claim retailer fulfillment or unattended recurring payments. For other creator briefs, help clarify the brief conversationally; do not prepare the fixed demo or suggest it executes their brief. Start a gift draft without inventing a recipient or occasion. If a gift draft or group already exists, do not start another one. Use the verified workflow state already supplied when answering; do not call a workflow tool merely to acknowledge a clarification or ask a follow-up. Start gift collaboration only when the user asks for search or comparison. Consider the user's words and the gift's purpose. Clarify the uncertainty that most changes the next useful step; build on details already given, and avoid unnecessary or repeated questions. Treat interpretations as possibilities, not facts. Be concise and avoid slogans or claims of a perfect result. Budget and sharing are explicit controls. Never output private reasoning, thinking tags or internal deliberation. General personal shopping can still be discussed, but only group gifts have connected shopping execution. Never claim a tool action happened without a successful tool result. The connected creator workflow is a fixed ChatEDU Sandbox demonstration: fixed offers, simulated creator counteroffer/acceptance/delivery, real AI choice and PayPal Sandbox payout after explicit human approval. Custom chat briefs do NOT change those fixed terms. Gift agents only use context explicitly shared in the gift card, with real Channel3 products returned by the durable search. Product prices and variants require review. You cannot approve terms, change private contribution limits, share a person's private messages, send invitations, fund/capture a payment or record a retailer order through tools. Those require explicit human controls. A prepared group has a $10 reserve and no budget until a human sets a limit. Collaboration may take time; queued/running is not complete. Never invent products, receipts, private friend context or successful payments. Keep responses concise and ask focused questions.`;
