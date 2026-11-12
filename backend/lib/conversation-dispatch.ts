import { getRun, start } from "workflow/api";
import { authPool } from "./auth";
import { transaction } from "./agent-store";
import {
  conversationWorkflow,
  saveConversationRevision,
} from "./conversation-workflow";
import {
  conversationEvent,
  refreshConversationStatus,
} from "./conversation-store";

export async function dispatchConversation(id: string) {
  const row = (
    await authPool.query(
      "SELECT c.id FROM agent_conversations c WHERE c.id=$1 AND c.grants_active AND c.worker_run_id IS NULL AND EXISTS(SELECT 1 FROM conversation_turns t WHERE t.conversation_id=c.id AND t.status='queued')",
      [id],
    )
  ).rows[0];
  if (row) await start(conversationWorkflow, [id]);
}
export async function dispatchRevisionSave(id: string, revision: number) {
  await start(saveConversationRevision, [id, revision]);
}
export async function recoverConversation(id: string, owner: string) {
  const conversation = (
    await authPool.query(
      "SELECT * FROM agent_conversations WHERE id=$1 AND owner_id=$2",
      [id, owner],
    )
  ).rows[0];
  if (!conversation) return { status: 404 };
  if (!conversation.grants_active) return { status: 409 };
  if (conversation.worker_run_id) {
    const state = await getRun(conversation.worker_run_id).status;
    if (["completed", "failed", "cancelled"].includes(state))
      await transaction(async (client) => {
        const locked = (
          await client.query(
            "SELECT * FROM agent_conversations WHERE id=$1 FOR UPDATE",
            [id],
          )
        ).rows[0];
        if (locked.worker_run_id !== conversation.worker_run_id) return;
        await client.query(
          "UPDATE conversation_turns SET status=CASE WHEN attempt<3 THEN 'queued' ELSE 'failed' END,attempt=attempt+1,error_code='WORKER_RECOVERY' WHERE conversation_id=$1 AND status='running'",
          [id],
        );
        await client.query(
          "UPDATE agent_conversations SET worker_run_id=NULL WHERE id=$1",
          [id],
        );
        await conversationEvent(
          client,
          id,
          `recovered:${conversation.worker_run_id}`,
          "worker_recovered",
        );
        await refreshConversationStatus(client, id);
      });
  }
  await dispatchConversation(id);
  return { status: 200 };
}
