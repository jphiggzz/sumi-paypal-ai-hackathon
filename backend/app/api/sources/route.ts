import { existingRefresh, admitSourceRefresh } from "../../../lib/source-store";
import { start } from "workflow/api";
import { sourceRefreshWorkflow } from "../../../lib/source-workflow";
import { authorizeConnectionUse } from "../../../lib/connection-store";
import { z } from "zod";
import {
  admittedUser,
  sameOrigin,
  noStore,
  canStartTask,
} from "../../../lib/agent-api";
import { transaction } from "../../../lib/agent-store";
import {
  sourceRefreshInput,
  sourceSearchInput,
} from "../../../lib/knowledge-policy";
import { refreshSource, searchSources } from "../../../lib/source-store";
import { apiFailure, boundedJson } from "../../../lib/foundation-api";
export async function GET(request: Request) {
  const a = await admittedUser(request);
  if (a.error) return a.error;
  try {
    const u = new URL(request.url);
    if (u.searchParams.has("refreshId")) {
      const id = u.searchParams.get("refreshId");
      if (!z.uuid().safeParse(id).success)
        return new Response(null, { status: 400 });
      const row = await transaction(
        async (c) =>
          (
            await c.query(
              "SELECT id,state,source_id,error_code,retry_after_ms,attempts,workflow_run_id FROM source_refreshes WHERE id=$1 AND owner_id=$2",
              [id, a.user.id],
            )
          ).rows[0],
      );
      return Response.json(row ?? { error: "REFRESH_NOT_FOUND" }, {
        status: row ? 200 : 404,
        headers: noStore,
      });
    }
    const p = sourceSearchInput.safeParse({
      query: u.searchParams.get("query"),
      ...(u.searchParams.has("sourceId")
        ? { sourceId: u.searchParams.get("sourceId") }
        : {}),
    });
    if (!p.success) return new Response(null, { status: 400 });
    return Response.json(
      await transaction((c) => searchSources(c, a.user.id, p.data)),
      { headers: noStore },
    );
  } catch (e) {
    return apiFailure(e);
  }
}
export async function POST(request: Request) {
  if (!sameOrigin(request)) return new Response(null, { status: 403 });
  const a = await admittedUser(request);
  if (a.error) return a.error;
  if (!canStartTask(request, a.user))
    return new Response(null, { status: 403 });
  try {
    const p = sourceRefreshInput.safeParse(await boundedJson(request));
    if (!p.success) return new Response(null, { status: 400 });
    await transaction((c) =>
      authorizeConnectionUse(c, a.user.id, p.data.connectionId, {
        expectedVersion: p.data.expectedVersion,
        requiredScopes: ["documents:read"],
        resourceId: p.data.resourceId,
      }),
    );
    const prior = await transaction((c) =>
      existingRefresh(c, a.user.id, p.data),
    );
    if (prior)
      return Response.json(
        {
          accepted: true,
          refreshId: prior.id,
          workflowRunId: prior.workflow_run_id,
          state: prior.state,
          replayed: true,
        },
        { status: 202, headers: noStore },
      );
    const deadline = Date.now() + 30000;
    const run = await start(sourceRefreshWorkflow, [a.user.id, p.data]);
    const admitted = await admitSourceRefresh(
      a.user.id,
      p.data,
      run.runId,
      deadline,
    );
    return Response.json(
      {
        accepted: true,
        refreshId: admitted.id,
        workflowRunId: admitted.workflow_run_id,
      },
      { status: 202, headers: noStore },
    );
  } catch (e) {
    return apiFailure(e);
  }
}
