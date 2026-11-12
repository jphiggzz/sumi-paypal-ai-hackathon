import { start } from "workflow/api";
import {
  admittedUser,
  canStartTask,
  sameOrigin,
  noStore,
} from "../../../lib/agent-api";
import { apiFailure, boundedJson } from "../../../lib/foundation-api";
import { jobInput } from "../../../lib/document-policy";
import { admitJob } from "../../../lib/job-store";
import { documentJobWorkflow } from "../../../lib/job-workflow";
import { transaction } from "../../../lib/agent-store";
import { inputHash } from "../../../lib/result-store";
import { CapabilityError } from "../../../lib/capability-contracts";
export async function POST(request: Request) {
  if (!sameOrigin(request)) return new Response(null, { status: 403 });
  const a = await admittedUser(request);
  if (a.error) return a.error;
  if (!canStartTask(request, a.user))
    return new Response(null, { status: 403 });
  try {
    const p = jobInput.safeParse(await boundedJson(request));
    if (!p.success) return new Response(null, { status: 400 });
    const prior = await transaction(
      async (c) =>
        (
          await c.query(
            "SELECT owner_id,input_digest,version,workflow_run_id FROM document_jobs WHERE id=$1",
            [p.data.id],
          )
        ).rows[0],
    );
    if (prior) {
      if (
        prior.owner_id !== a.user.id ||
        prior.input_digest !== inputHash(p.data)
      )
        throw new CapabilityError("JOB_ID_CONFLICT", 409);
      return Response.json(
        {
          id: p.data.id,
          version: prior.version,
          workflowRunId: prior.workflow_run_id,
          replayed: true,
        },
        { status: 202, headers: noStore },
      );
    }
    const deadline = Date.now() + 30000,
      run = await start(documentJobWorkflow, [a.user.id, p.data.id, 1]);
    const row = await admitJob(a.user.id, p.data, run.runId, deadline);
    return Response.json(
      { id: row.id, version: row.version, workflowRunId: row.workflow_run_id },
      { status: 202, headers: noStore },
    );
  } catch (e) {
    return apiFailure(e);
  }
}
