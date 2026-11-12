import { randomUUID } from "node:crypto";
import { boundedJson } from "../../../../lib/foundation-api";
import { z } from "zod";
import { start } from "workflow/api";
import {
  admittedUser,
  canStartTask,
  noStore,
  sameOrigin,
} from "../../../../lib/agent-api";
import { authPool } from "../../../../lib/auth";
import { creatorDiscoveryWorkflow } from "../../../../lib/creator/workflow";
export async function POST(req: Request) {
  if (!sameOrigin(req)) return new Response(null, { status: 403 });
  const a = await admittedUser(req);
  if (a.error) return a.error;
  if (!canStartTask(req, a.user))
    return Response.json(
      { error: "Preview access required." },
      { status: 403, headers: noStore },
    );
  const parsed = z
    .object({ runId: z.uuid() })
    .strict()
    .safeParse(await boundedJson(req).catch(() => null));
  if (!parsed.success)
    return Response.json(
      { error: "Invalid run." },
      { status: 400, headers: noStore },
    );
  const id = parsed.data.runId;
  const attempt = randomUUID();
  const r = await authPool.query(
    "UPDATE creator_runs r SET status='queued',activity='[]',attempt=$3,updated_at=now() FROM workspace_chats c,creator_campaigns cc WHERE r.id=$1 AND r.conversation_id=c.id AND c.owner_id=$2 AND cc.conversation_id=c.id AND (cc.state->>'revision')::integer=r.revision AND (r.status='failed' OR (r.status='queued' AND r.updated_at < now()-interval '60 seconds') OR (r.status='running' AND r.updated_at < now()-interval '3 minutes')) RETURNING r.id",
    [id, a.user.id, attempt],
  );
  if (!r.rowCount)
    return Response.json(
      { error: "Run is unavailable or the brief has changed." },
      { status: 409, headers: noStore },
    );
  try {
    await start(creatorDiscoveryWorkflow, [id, attempt]);
  } catch {
    await authPool.query(
      "UPDATE creator_runs SET status='failed' WHERE id=$1 AND status='queued' AND attempt=$2",
      [id, attempt],
    );
    return Response.json(
      { error: "Could not start discovery." },
      { status: 503, headers: noStore },
    );
  }
  return Response.json({ ok: true }, { headers: noStore });
}
