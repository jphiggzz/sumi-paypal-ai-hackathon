import { start } from "workflow/api";
import { sleep } from "workflow";
import { getRun } from "workflow/api";
import { authPool } from "./auth";
import { transaction } from "./agent-store";
import {
  conversationEvent,
  refreshConversationStatus,
} from "./conversation-store";
import {
  dispatchRevisionSave,
  recoverConversation,
} from "./conversation-dispatch";

export type RecoveryIntent =
  | { messageId: string; attempt?: number }
  | { revision: number; dispatch?: number }
  | { routineId: string; version: number; dueAt: string };
export function recoveryKey(id: string, intent: RecoveryIntent) {
  return "messageId" in intent
    ? `message:${id}:${intent.messageId}:${intent.attempt ?? 1}`
    : "revision" in intent
      ? `save:${id}:${intent.revision}:${intent.dispatch ?? 1}`
      : `routine:${intent.routineId}:${intent.version}:${intent.dueAt}`;
}
// Arm BEFORE the admission transaction. If Workflow is unavailable, admission
// fails closed. Once SQL commits, no client connection is needed for dispatch.
export async function armRecovery(
  id: string,
  owner: string,
  intent: RecoveryIntent,
) {
  const deadline = Date.now() + 30000;
  await start(recoveryWorkflow, [id, owner, intent]);
  return deadline;
}
export async function recoveryWorkflow(
  id: string,
  owner: string,
  intent: RecoveryIntent,
) {
  "use workflow";
  await sleep("2s");
  for (let i = 0; i < 180; i++) {
    const state = await recoverIntent(id, owner, intent);
    if (state === "done") return;
    if (state === "missing" && i >= 29) return; // admission never committed
    await sleep(state === "missing" ? "2s" : "10s");
  }
  await recoveryExhausted(id, owner, intent);
}
async function recoverIntent(
  id: string,
  owner: string,
  intent: RecoveryIntent,
) {
  "use step";
  const c = (
    await authPool.query(
      "SELECT * FROM agent_conversations WHERE id=$1 AND owner_id=$2",
      [id, owner],
    )
  ).rows[0];
  if (!c) return "missing";
  const turn =
    "messageId" in intent
      ? (
          await authPool.query(
            "SELECT * FROM conversation_turns WHERE conversation_id=$1 AND message_id=$2",
            [id, intent.messageId],
          )
        ).rows[0]
      : "routineId" in intent
        ? (
            await authPool.query(
              "SELECT t.* FROM routine_occurrences o JOIN conversation_turns t ON t.occurrence_id=o.id WHERE o.routine_id=$1 AND o.version=$2 AND o.due_at=$3 AND t.conversation_id=$4",
              [intent.routineId, intent.version, intent.dueAt, id],
            )
          ).rows[0]
        : null;
  if (!("revision" in intent) && !turn) return "missing";
  if ("messageId" in intent && intent.attempt && turn.attempt < intent.attempt)
    return "missing";
  const sequence = "revision" in intent ? intent.revision : turn.sequence;
  const key = `${"revision" in intent ? "save" : "turn"}:${id}:${sequence}`;
  const outbox = (
    await authPool.query("SELECT * FROM agent_dispatch_outbox WHERE id=$1", [
      key,
    ])
  ).rows[0];
  if (!outbox) return "missing";
  if (["completed", "failed", "cancelled"].includes(outbox.state))
    return "done";
  const finish = async (state: string) => {
    await authPool.query(
      "UPDATE agent_dispatch_outbox SET state=$2,updated_at=now() WHERE id=$1",
      [key, state],
    );
    return "done";
  };
  if (!c.grants_active) return finish("cancelled");
  if ("revision" in intent) {
    const a = (
      await authPool.query(
        "SELECT a.*,r.state AS artifact_state FROM conversation_approvals a JOIN conversation_revisions r USING(conversation_id,revision) WHERE a.conversation_id=$1 AND a.revision=$2",
        [id, sequence],
      )
    ).rows[0];
    if (intent.dispatch && a && a.save_dispatches < intent.dispatch)
      return "missing";
    if (a?.artifact_state === "saved") return finish("completed");
    if (
      !a ||
      a.state !== "approved" ||
      c.requested_sequence !== sequence ||
      new Date(a.expires_at) <= new Date()
    )
      return finish("cancelled");
    if (a.save_run_id) {
      const status = await getRun(a.save_run_id).status;
      if (!["completed", "failed", "cancelled"].includes(status)) return "wait";
      if (a.save_dispatches >= 3) return finish("failed");
      await authPool.query(
        "UPDATE conversation_approvals SET save_run_id=NULL,save_dispatches=save_dispatches+1 WHERE conversation_id=$1 AND revision=$2 AND save_run_id=$3",
        [id, sequence, a.save_run_id],
      );
    }
    await dispatchRevisionSave(id, sequence);
  } else {
    if (turn.status === "completed") return finish("completed");
    if (turn.status === "cancelled") return finish("cancelled");
    if (turn.status === "failed") {
      if (
        turn.attempt >= 3 ||
        /BUDGET|MODEL_|CAPABILITY_/.test(turn.error_code ?? "")
      )
        return finish("failed");
      await transaction(async (client) => {
        await client.query(
          "SELECT id FROM agent_conversations WHERE id=$1 FOR UPDATE",
          [id],
        );
        await client.query(
          "UPDATE conversation_turns SET status='queued',attempt=attempt+1,error_code=NULL WHERE conversation_id=$1 AND sequence=$2 AND status='failed' AND attempt<3",
          [id, sequence],
        );
        await refreshConversationStatus(client, id);
        await conversationEvent(
          client,
          id,
          `auto_retry:${sequence}:${turn.attempt}`,
          "automatic_retry",
          { sequence, attempt: turn.attempt + 1 },
        );
      });
    }
    await recoverConversation(id, owner);
  }
  await authPool.query(
    "UPDATE agent_dispatch_outbox SET state='dispatched',attempts=attempts+1,last_attempt_at=now(),updated_at=now() WHERE id=$1",
    [key],
  );
  return "wait";
}
async function recoveryExhausted(
  id: string,
  owner: string,
  intent: RecoveryIntent,
) {
  "use step";
  if (
    !(
      await authPool.query(
        "SELECT 1 FROM agent_conversations WHERE id=$1 AND owner_id=$2",
        [id, owner],
      )
    ).rowCount
  )
    return;
  await transaction((client) =>
    conversationEvent(
      client,
      id,
      `recovery_exhausted:${recoveryKey(id, intent)}`,
      "recovery_exhausted",
      { intent: recoveryKey(id, intent) },
    ),
  );
}
