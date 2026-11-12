import { start } from "workflow/api";
import {
  admittedUser,
  canStartTask,
  sameOrigin,
  noStore,
} from "../../../../lib/agent-api";
import { apiFailure, boundedJson } from "../../../../lib/foundation-api";
import { publicInput } from "../../../../lib/document-policy";
import { publicDocumentUrl } from "../../../../lib/public-document";
import {
  documentRequest,
  admitPublicDocument,
} from "../../../../lib/document-store";
import { transaction } from "../../../../lib/agent-store";
import { inputHash } from "../../../../lib/result-store";
import { publicDocumentWorkflow } from "../../../../lib/public-workflow";
export async function POST(request: Request) {
  if (!sameOrigin(request)) return new Response(null, { status: 403 });
  const a = await admittedUser(request);
  if (a.error) return a.error;
  if (!canStartTask(request, a.user))
    return new Response(null, { status: 403 });
  try {
    const p = publicInput.safeParse(await boundedJson(request));
    if (!p.success) return new Response(null, { status: 400 });
    publicDocumentUrl(p.data.url);
    const prior = await transaction((c) =>
      documentRequest(c, a.user.id, p.data.requestId, inputHash(p.data)),
    );
    if (prior)
      return Response.json(
        {
          requestId: prior.id,
          state: prior.state,
          workflowRunId: prior.workflow_run_id,
          replayed: true,
        },
        { status: 202, headers: noStore },
      );
    const deadline = Date.now() + 30000,
      run = await start(publicDocumentWorkflow, [a.user.id, p.data.requestId]);
    const row = await admitPublicDocument(
      a.user.id,
      p.data,
      run.runId,
      deadline,
    );
    return Response.json(
      {
        requestId: row.id,
        state: row.state,
        workflowRunId: row.workflow_run_id,
      },
      { status: 202, headers: noStore },
    );
  } catch (e) {
    return apiFailure(e);
  }
}
export async function GET(request: Request) {
  const a = await admittedUser(request);
  if (a.error) return a.error;
  try {
    const id = new URL(request.url).searchParams.get("requestId");
    if (!id || !publicInput.shape.requestId.safeParse(id).success)
      return new Response(null, { status: 400 });
    const row = await transaction(
      async (c) =>
        (
          await c.query(
            "SELECT id,source_id,state,result,error_code,retry_after_ms,workflow_run_id,execution_attempts,provider_attempts FROM document_requests WHERE id=$1 AND owner_id=$2 AND kind='public'",
            [id, a.user.id],
          )
        ).rows[0],
    );
    return Response.json(row ?? { error: "DOCUMENT_REQUEST_NOT_FOUND" }, {
      status: row ? 200 : 404,
      headers: noStore,
    });
  } catch (e) {
    return apiFailure(e);
  }
}
