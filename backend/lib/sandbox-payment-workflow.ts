import { sleep, getWorkflowMetadata } from "workflow";
import { getRun, start } from "workflow/api";
import { advancePayment } from "./sandbox-payment-store";
import { authPool } from "./auth";
import { transaction } from "./agent-store";
import { assertWork, chargeWork, workUuid } from "./work-store";
import { armRecovery } from "./recovery-workflow";
import { appendTurn, lockConversation } from "./conversation-store";
import { dispatchConversation } from "./conversation-dispatch";
import { resultEvent } from "./result-store";
import { CapabilityError } from "./capability-contracts";
export async function sandboxPaymentWorkflow(owner: string, id: string) {
  "use workflow";
  const runId = getWorkflowMetadata().workflowRunId;
  for (let i = 0; i < 42; i++) {
    const state = await paymentStep(owner, id, runId);
    if (state === "other") return;
    if (state === "done") {
      await paymentFollowUp(owner, id);
      return;
    }
    if (state === "missing" && i >= 12) return;
    await sleep("5s");
  }
  await paymentExhausted(owner, id, runId);
  await paymentFollowUp(owner, id);
}
async function paymentStep(owner: string, id: string, runId: string) {
  "use step";
  return advancePayment(owner, id, runId);
}
async function paymentExhausted(owner: string, id: string, runId: string) {
  "use step";
  await authPool.query(
    "UPDATE sandbox_payment_proposals SET state='needs_review',error_code='PAYMENT_WORKFLOW_EXHAUSTED' WHERE id=$1 AND owner_id=$2 AND workflow_run_id=$3 AND state IN ('approved','submitting','pending_provider')",
    [id, owner, runId],
  );
}
async function paymentFollowUp(owner: string, id: string) {
  "use step";
  const p = (
    await authPool.query(
      "SELECT p.*,w.conversation_id FROM sandbox_payment_proposals p JOIN agent_work w ON w.id=p.work_id WHERE p.id=$1 AND p.owner_id=$2",
      [id, owner],
    )
  ).rows[0];
  if (!p) return;
  await transaction((c) =>
    resultEvent(
      c,
      owner,
      "payment:" + id + ":terminal:" + p.state,
      "payment." + p.state,
      {
        paymentId: id,
        state: p.state,
        cents: p.payload.cents,
        currency: "USD",
        sandbox: true,
        itemId: p.item_id,
        errorCode: p.error_code,
      },
      p.conversation_id,
    ),
  );
  const messageId = workUuid("payment-result:" + id + ":" + p.state),
    deadline = await armRecovery(p.conversation_id, owner, { messageId });
  try {
    await transaction(async (c) => {
      await lockConversation(c, p.conversation_id);
      const w = await assertWork(c, p.work_id, owner);
      await resultEvent(
        c,
        owner,
        "payment:" + id + ":terminal:" + p.state,
        "payment." + p.state,
        {
          paymentId: id,
          state: p.state,
          cents: p.payload.cents,
          currency: "USD",
          sandbox: true,
          itemId: p.item_id,
          errorCode: p.error_code,
        },
        p.conversation_id,
        w.job_id,
      );
      if (
        (
          await c.query(
            "SELECT 1 FROM sandbox_payment_followups WHERE payment_id=$1 AND state=$2",
            [id, p.state],
          )
        ).rowCount
      )
        return;
      const root = (
        await c.query(
          "SELECT execution_mode FROM conversation_turns WHERE conversation_id=$1 AND sequence=$2",
          [w.conversation_id, w.origin_sequence],
        )
      ).rows[0];
      const mode =
        root.execution_mode === "assistant" ? "assistant" : "checkpoint";
      const result = await appendTurn(
        c,
        p.conversation_id,
        owner,
        {
          messageId,
          text: `Application PayPal sandbox payment result: ${p.state}. Amount ${p.payload.cents} cents USD. Item ${p.item_id ?? "unconfirmed"}. Report the recorded outcome only; this does not authorize another payment or job.`,
          recoveryTest: false,
          executionMode: mode,
          dispatchRecoveryTest: false,
        },
        { workId: w.id, internalKind: "payment_result", mode },
        deadline,
      );
      if (![200, 201].includes(result.status))
        throw new CapabilityError("PAYMENT_FOLLOWUP_FAILED", result.status);
      await chargeWork(
        c,
        w,
        "dispatch",
        1,
        "payment-result:" + id + ":" + p.state,
      );
      await c.query(
        "INSERT INTO sandbox_payment_followups(payment_id,state,sequence) VALUES($1,$2,$3)",
        [id, p.state, result.sequence],
      );
      await c.query(
        "UPDATE sandbox_payment_proposals SET followup_sequence=$2 WHERE id=$1",
        [id, result.sequence],
      );
    });
    await dispatchConversation(p.conversation_id);
  } catch (e) {
    if (!(e instanceof CapabilityError))
      throw e; /* Terminal provider receipt survives revoked task/follow-up allowance. */
  }
}

export async function sandboxPaymentRecoveryWorkflow(
  owner: string,
  id: string,
) {
  "use workflow";
  const recoveryRunId = getWorkflowMetadata().workflowRunId;
  for (let i = 0; i < 70; i++) {
    const result = await recoverPaymentStep(owner, id, recoveryRunId);
    if (result === "done" || (result === "missing" && i >= 12)) return;
    await sleep("5s");
  }
}
async function recoverPaymentStep(
  owner: string,
  id: string,
  recoveryRunId: string,
) {
  "use step";
  const p = (
    await authPool.query(
      "SELECT * FROM sandbox_payment_proposals WHERE id=$1 AND owner_id=$2",
      [id, owner],
    )
  ).rows[0];
  if (!p || p.state === "pending") return "missing";
  if (p.recovery_run_id !== recoveryRunId) return "done";
  if (
    ["succeeded", "failed", "blocked", "rejected", "needs_review"].includes(
      p.state,
    )
  ) {
    await paymentFollowUp(owner, id);
    return "done";
  }
  const status = await getRun(p.workflow_run_id).status;
  if (!["cancelled", "failed", "completed"].includes(status)) return "waiting";
  if (p.recovery_attempts >= 2) {
    await paymentExhausted(owner, id, p.workflow_run_id);
    await paymentFollowUp(owner, id);
    return "done";
  }
  const replacement = await start(sandboxPaymentWorkflow, [owner, id]);
  await authPool.query(
    "UPDATE sandbox_payment_proposals SET workflow_run_id=$3,recovery_attempts=recovery_attempts+1 WHERE id=$1 AND owner_id=$2 AND workflow_run_id=$4 AND recovery_run_id=$5",
    [id, owner, replacement.runId, p.workflow_run_id, recoveryRunId],
  );
  return "waiting";
}
