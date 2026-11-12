import { z } from "zod";
import { admittedUser, noStore } from "../../../../../lib/agent-api";
import { ownedConversation } from "../../../../../lib/conversation-store";
import { authPool } from "../../../../../lib/auth";
export async function GET(
  request: Request,
  context: { params: Promise<{ id: string }> },
) {
  const access = await admittedUser(request);
  if (access.error) return access.error;
  const { id } = await context.params;
  if (
    !z.uuid().safeParse(id).success ||
    !(await ownedConversation(id, access.user.id))
  )
    return new Response(null, { status: 404 });
  const invocations = (
    await authPool.query(
      "SELECT id,sequence,tool_id,tool_version,input_digest,state,attempts,connection_id,connection_version,error_code,retry_after_ms,duration_ms,output_bytes,started_at,completed_at FROM agent_capability_invocations WHERE conversation_id=$1 AND owner_id=$2 ORDER BY started_at,id LIMIT 500",
      [id, access.user.id],
    )
  ).rows;
  return Response.json({ invocations }, { headers: noStore });
}
