import { waitForModelCapacity } from "./model-capacity";
import { sleep, getWorkflowMetadata } from "workflow";
import { generateText, Output } from "ai";
import { transaction } from "./agent-store";
import { CapabilityError } from "./capability-contracts";
import { authPool } from "./auth";
import { assertWork, chargeWork } from "./work-store";
import { reserveModelBudget } from "./model-budget";
import {
  workspacePlan,
  applyWorkspacePlan,
  initialWorkspace,
} from "./workspace-policy";
export async function workspaceRequestWorkflow(owner: string, id: string) {
  "use workflow";
  const runId = getWorkflowMetadata().workflowRunId;
  await waitForModelCapacity("amazon/nova-micro");
  for (let i = 0; i < 40; i++) {
    if (await requestStep(owner, id, runId)) return;
    await sleep("2s");
  }
}
async function requestStep(owner: string, id: string, runId: string) {
  "use step";
  const r = await transaction(async (c) => {
    const r = (
      await c.query(
        "SELECT * FROM agent_workspace_requests WHERE id=$1 AND owner_id=$2 FOR UPDATE",
        [id, owner],
      )
    ).rows[0];
    if (!r) return null;
    if (
      r.workflow_run_id !== runId ||
      !["queued", "running"].includes(r.status)
    )
      return { done: true };
    if (
      r.status === "running" &&
      r.lease_until &&
      new Date(r.lease_until) > new Date()
    )
      return null;
    if (r.attempts >= 2) {
      await c.query(
        "UPDATE agent_workspace_requests SET status='failed',error_code='WORKSPACE_RETRIES_EXHAUSTED' WHERE id=$1",
        [id],
      );
      return { done: true };
    }
    const w = await assertWork(c, r.work_id, owner);
    const revision =
      (
        await c.query(
          "SELECT revision FROM agent_workspaces WHERE work_id=$1",
          [r.work_id],
        )
      ).rows[0]?.revision ?? 0;
    if (revision !== r.expected_revision)
      throw new CapabilityError("WORKSPACE_REVISION_CONFLICT", 409);
    await chargeWork(c, w, "model", 1);
    await c.query(
      "UPDATE agent_workspace_requests SET status='running',attempts=attempts+1,lease_until=now()+interval '45 seconds' WHERE id=$1",
      [id],
    );
    return r;
  }).catch(async (error) => {
    await authPool.query(
      "UPDATE agent_workspace_requests SET status='failed',error_code=$3 WHERE id=$1 AND owner_id=$2 AND status IN ('queued','running')",
      [
        id,
        owner,
        error instanceof CapabilityError
          ? error.code
          : "WORKSPACE_ADMISSION_FAILED",
      ],
    );
    return { done: true };
  });
  if (!r) return false;
  if (r.done) return true;
  try {
    await reserveModelBudget("amazon/nova-micro");
    const result = await generateText({
      model: "amazon/nova-micro",
      maxRetries: 0,
      maxOutputTokens: 400,
      abortSignal: AbortSignal.timeout(30000),
      output: Output.object({ schema: workspacePlan }),
      system:
        "Translate this workspace request into exactly one allowed action. add_evidence: evidence custom widget. add_payments: payment custom widget. show_missing: grid of absent/ambiguous facts. show_all: grid of all extracted facts. unsupported: everything else including executing or approving payments, messages, code, URLs, changing permissions or new extraction work. Never claim to execute a payment. Message is a concise description of chosen workspace action.",
      prompt: r.prompt,
    });
    const output = workspacePlan.parse(result.output);
    await transaction(async (c) => {
      await assertWork(c, r.work_id, owner);
      const request = (
        await c.query(
          "SELECT status FROM agent_workspace_requests WHERE id=$1 FOR UPDATE",
          [id],
        )
      ).rows[0];
      if (request.status !== "running") return;
      const current = (
        await c.query(
          "SELECT revision,state FROM agent_workspaces WHERE work_id=$1 FOR UPDATE",
          [r.work_id],
        )
      ).rows[0] ?? { revision: 0, state: initialWorkspace() };
      if (current.revision !== r.expected_revision)
        throw new Error("WORKSPACE_REVISION_CONFLICT");
      const state = applyWorkspacePlan(current.state, output.action),
        revision = current.revision + 1;
      await c.query(
        "INSERT INTO agent_workspaces(work_id,owner_id,revision,state) VALUES($1,$2,$3,$4) ON CONFLICT(work_id) DO UPDATE SET revision=$3,state=$4",
        [r.work_id, owner, revision, JSON.stringify(state)],
      );
      await c.query(
        "INSERT INTO agent_workspace_versions(work_id,revision,state) VALUES($1,$2,$3)",
        [r.work_id, revision, JSON.stringify(state)],
      );
      const usage = {
        model: "amazon/nova-micro",
        inputTokens: result.usage.inputTokens ?? 0,
        outputTokens: result.usage.outputTokens ?? 0,
        estimatedUsd:
          ((result.usage.inputTokens ?? 0) * 0.035 +
            (result.usage.outputTokens ?? 0) * 0.14) /
          1e6,
        estimate: true,
      };
      await c.query(
        "UPDATE agent_workspace_requests SET status='completed',output=$2,usage=$3 WHERE id=$1",
        [id, JSON.stringify(output), JSON.stringify(usage)],
      );
    });
  } catch {
    await authPool.query(
      "UPDATE agent_workspace_requests SET status='failed',error_code='WORKSPACE_REQUEST_FAILED' WHERE id=$1 AND status='running'",
      [id],
    );
  }
  return true;
}
requestStep.maxRetries = 0;
