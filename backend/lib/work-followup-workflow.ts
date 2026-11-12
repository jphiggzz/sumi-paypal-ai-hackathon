import { sleep, getWorkflowMetadata } from "workflow";
import {
  sourceWaitState,
  queueSourceFollowUp,
  recordWorkBlocked,
} from "./work-dispatch";
import { CapabilityError } from "./capability-contracts";
export async function sourceWaitWorkflow(workId: string, refreshId: string) {
  "use workflow";
  const runId = getWorkflowMetadata().workflowRunId;
  for (let i = 0; i < 35; i++) {
    const state = await sourceState(workId, refreshId, runId);
    if (state === "done") return;
    if (state === "ready") {
      await sourceNotify(workId, refreshId);
      return;
    }
    await sleep("2s");
  }
  await sourceNotify(workId, refreshId);
}
async function sourceState(workId: string, refreshId: string, runId: string) {
  "use step";
  return sourceWaitState(workId, refreshId, runId);
}
async function sourceNotify(workId: string, refreshId: string) {
  "use step";
  try {
    await queueSourceFollowUp(workId, refreshId);
  } catch (e) {
    if (e instanceof CapabilityError && e.status !== 503) {
      await recordWorkBlocked(workId, e.code);
      return;
    }
    throw e;
  }
}
