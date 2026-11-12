import { randomUUID } from "node:crypto";
import { z } from "zod";
import { start } from "workflow/api";
import { admittedUser, canStartTask, noStore, sameOrigin } from "../../../../lib/agent-api";
import { boundedJson } from "../../../../lib/foundation-api";
import { authPool } from "../../../../lib/auth";
import { creatorDiscoveryWorkflow } from "../../../../lib/creator/workflow";

export async function POST(req: Request) {
  if (!sameOrigin(req)) return new Response(null, { status: 403 });
  const auth = await admittedUser(req);
  if (auth.error) return auth.error;
  if (!canStartTask(req, auth.user)) return Response.json({ error: "Preview access required." }, { status: 403, headers: noStore });
  const body = z.object({ runId: z.uuid() }).strict().safeParse(await boundedJson(req).catch(() => null));
  if (!body.success) return Response.json({ error: "Invalid run." }, { status: 400, headers: noStore });
  const attempt = randomUUID();
  const updated = await authPool.query(
    "UPDATE creator_runs r SET status='queued',attempt=$3,updated_at=now() FROM workspace_chats c,creator_campaigns cc WHERE r.id=$1 AND r.conversation_id=c.id AND c.owner_id=$2 AND cc.conversation_id=c.id AND (cc.state->>'revision')::integer=r.revision AND r.status='draft' AND r.input->>'businessApproved'='true' RETURNING r.id",
    [body.data.runId, auth.user.id, attempt],
  );
  if (!updated.rowCount) {
    const existing = await authPool.query(
      "SELECT r.status FROM creator_runs r JOIN workspace_chats c ON c.id=r.conversation_id JOIN creator_campaigns cc ON cc.conversation_id=c.id WHERE r.id=$1 AND c.owner_id=$2 AND (cc.state->>'revision')::integer=r.revision",
      [body.data.runId, auth.user.id],
    );
    if (["queued", "running", "ready"].includes(existing.rows[0]?.status)) return Response.json({ ok: true }, { headers: noStore });
    return Response.json({ error: "The campaign changed. Review the latest direction." }, { status: 409, headers: noStore });
  }
  try {
    await start(creatorDiscoveryWorkflow, [body.data.runId, attempt]);
  } catch {
    await authPool.query(
      "UPDATE creator_runs SET status='failed',updated_at=now() WHERE id=$1 AND status='queued' AND attempt=$2",
      [body.data.runId, attempt],
    );
    return Response.json({ error: "Could not start discovery." }, { status: 503, headers: noStore });
  }
  return Response.json({ ok: true }, { headers: noStore });
}
