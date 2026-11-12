import {performPublicImport} from "./public-store";
import {
  sleep,
  getWorkflowMetadata,
  FatalError,
  RetryableError,
} from "workflow";
import { authPool } from "./auth";
import { CapabilityError } from "./capability-contracts";
export async function publicDocumentWorkflow(owner: string, requestId: string) {
  "use workflow";
  const runId = getWorkflowMetadata().workflowRunId;
  for (let i = 0; i < 30; i++) {
    const s = await admission(owner, requestId, runId);
    if (s === "other") return;
    if (s === "ready") {
      await importPublic(owner, requestId, runId);
      return;
    }
    if (i < 29) await sleep("2s");
  }
}
async function admission(owner: string, id: string, runId: string) {
  "use step";
  const r = (
    await authPool.query(
      "SELECT workflow_run_id FROM document_requests WHERE id=$1 AND owner_id=$2",
      [id, owner],
    )
  ).rows[0];
  return !r ? "missing" : r.workflow_run_id === runId ? "ready" : "other";
}
async function importPublic(owner: string, id: string, runId: string) {
  "use step";
  let result: { injectRecovery: boolean };
  try {
    result = await performPublicImport(owner, id, runId);
  } catch (error) {
    if (
      error instanceof CapabilityError &&
      [
        "PUBLIC_FETCH_FAILED",
        "PUBLIC_FETCH_TIMEOUT",
        "PUBLIC_DNS_TIMEOUT",
        "PUBLIC_RATE_LIMITED",
      ].includes(error.code) &&
      (error.retryAfterMs ?? 0) <= 60000
    )
      throw new RetryableError(error.code, {
        retryAfter: Math.max(1000, error.retryAfterMs ?? 2000),
      });
    throw new FatalError(
      error instanceof CapabilityError ? error.code : "PUBLIC_IMPORT_FAILED",
    );
  }
  if (result.injectRecovery)
    throw new RetryableError(
      "Synthetic interruption after committed public source",
      { retryAfter: "1s" },
    );
}
importPublic.maxRetries = 2;
