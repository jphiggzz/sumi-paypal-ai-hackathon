import { authPool } from "./auth";
import {
  FatalError,
  RetryableError,
  sleep,
  getWorkflowMetadata,
} from "workflow";
import { refreshSource } from "./source-store";
import { CapabilityError } from "./capability-contracts";
import type { z } from "zod";
import type { sourceRefreshInput } from "./knowledge-policy";
export async function sourceRefreshWorkflow(
  owner: string,
  input: z.infer<typeof sourceRefreshInput>,
) {
  "use workflow";
  const runId = getWorkflowMetadata().workflowRunId;
  for (let i = 0; i < 30; i++) {
    const state = await refreshAdmissionState(owner, input.id, runId);
    if (state === "admitted") return refreshStep(owner, input, runId);
    if (state === "other") return;
    if (i < 29) await sleep("2s");
  }
  return;
}
async function refreshStep(
  owner: string,
  input: z.infer<typeof sourceRefreshInput>,
  runId: string,
) {
  "use step";
  try {
    return await refreshSource(owner, input, runId);
  } catch (error) {
    if (
      error instanceof CapabilityError &&
      ["PROVIDER_UNAVAILABLE", "PROVIDER_RATE_LIMITED"].includes(error.code) &&
      (error.retryAfterMs ?? 0) <= 60000
    )
      throw new RetryableError(error.code, {
        retryAfter: Math.max(1000, error.retryAfterMs ?? 2000),
      });
    throw new FatalError(
      error instanceof CapabilityError ? error.code : "SOURCE_REFRESH_FAILED",
    );
  }
}
refreshStep.maxRetries = 2;

async function refreshAdmissionState(owner: string, id: string, runId: string) {
  "use step";
  const row = (
    await authPool.query(
      "SELECT workflow_run_id FROM source_refreshes WHERE id=$1 AND owner_id=$2",
      [id, owner],
    )
  ).rows[0];
  return !row
    ? "missing"
    : row.workflow_run_id === runId
      ? "admitted"
      : "other";
}
