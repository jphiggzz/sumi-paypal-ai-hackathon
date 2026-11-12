import { z } from "zod";
import { start } from "workflow/api";
import {
  admittedUser,
  canStartTask,
  sameOrigin,
  noStore,
} from "../../../../lib/agent-api";
import { apiFailure, boundedJson } from "../../../../lib/foundation-api";
import { transaction } from "../../../../lib/agent-store";
import { jobControl } from "../../../../lib/document-policy";
import { jobByOwner, inspectJob, controlJob } from "../../../../lib/job-store";
import { documentJobWorkflow,workJobRecoveryWorkflow } from "../../../../lib/job-workflow";
export async function GET(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const a = await admittedUser(request);
  if (a.error) return a.error;
  try {
    const { id } = await params;
    if (!z.uuid().safeParse(id).success)
      return new Response(null, { status: 404 });
    return Response.json(
      await transaction((c) => inspectJob(c, a.user.id, id)),
      { headers: noStore },
    );
  } catch (e) {
    return apiFailure(e);
  }
}
export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  if (!sameOrigin(request)) return new Response(null, { status: 403 });
  const a = await admittedUser(request);
  if (a.error) return a.error;
  if (!canStartTask(request, a.user))
    return new Response(null, { status: 403 });
  try {
    const { id } = await params;
    if (!z.uuid().safeParse(id).success)
      return new Response(null, { status: 404 });
    const p = jobControl.safeParse(await boundedJson(request));
    if (!p.success) return new Response(null, { status: 400 });
    let resumption;
    if (p.data.action === "resume") {
      const job=await transaction((c) => jobByOwner(c, a.user.id, id));
      const deadline = Date.now() + 30000,
        run = await start(documentJobWorkflow, [
          a.user.id,
          id,
          p.data.expectedVersion + 1,
        ]);
      const recovery=job.work_id?await start(workJobRecoveryWorkflow,[a.user.id,id]):null;
      resumption = { runId: run.runId, deadline,recoveryRunId:recovery?.runId };
    }
    return Response.json(await controlJob(a.user.id, id, p.data, resumption), {
      headers: noStore,
    });
  } catch (e) {
    return apiFailure(e);
  }
}
