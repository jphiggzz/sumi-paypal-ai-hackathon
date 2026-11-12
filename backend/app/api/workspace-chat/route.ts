import { z } from "zod";
import { authPool } from "../../../lib/auth";
import { admittedUser, noStore, sameOrigin } from "../../../lib/agent-api";
import {
  snapshot,
  createChat,
  WorkspaceError,
} from "../../../lib/workspace-chat";
const id = z.uuid();
const mode = z.enum(["creators", "shopping"]);
export async function GET(req: Request) {
  const a = await admittedUser(req);
  if (a.error) return a.error;
  try {
    const cid = new URL(req.url).searchParams.get("conversationId");
    if (cid)
      return Response.json(await snapshot(a.user.id, id.parse(cid)), {
        headers: noStore,
      });
    return Response.json(
      {
        chats: (
          await authPool.query(
            "SELECT id,title,mode,revision FROM workspace_chats WHERE owner_id=$1 ORDER BY updated_at DESC LIMIT 40",
            [a.user.id],
          )
        ).rows,
      },
      { headers: noStore },
    );
  } catch (e) {
    return Response.json(
      { error: e instanceof WorkspaceError ? e.message : "Invalid chat." },
      {
        status: e instanceof WorkspaceError ? e.status : 400,
        headers: noStore,
      },
    );
  }
}
const action = z.discriminatedUnion("action", [
  z.object({ action: z.literal("create"), id, mode }).strict(),
  z
    .object({
      action: z.literal("mode"),
      id,
      mode,
      revision: z.number().int().nonnegative(),
    })
    .strict(),
  z.object({ action: z.literal("stop"), id, messageId: id }).strict(),
]);
export async function POST(req: Request) {
  if (!sameOrigin(req)) return new Response(null, { status: 403 });
  const a = await admittedUser(req);
  if (a.error) return a.error;
  try {
    const b = action.parse(await req.json());
    if (b.action === "create") {
      return Response.json(await createChat(a.user.id, b.id, b.mode), {
        headers: noStore,
      });
    }
    if (b.action === "mode") {
      const r = await authPool.query(
        "UPDATE workspace_chats SET mode=$3,revision=revision+1,updated_at=now() WHERE id=$1 AND owner_id=$2 AND revision=$4 RETURNING id",
        [b.id, a.user.id, b.mode, b.revision],
      );
      if (!r.rowCount)
        throw new WorkspaceError("Chat changed. Reload before changing modes.");
    } else
      await authPool.query(
        "UPDATE workspace_chat_messages m SET status='interrupted' FROM workspace_chats c WHERE m.id=$3 AND m.conversation_id=$1 AND c.id=m.conversation_id AND c.owner_id=$2 AND m.status='streaming'",
        [b.id, a.user.id, b.messageId],
      );
    return Response.json(await snapshot(a.user.id, b.id), { headers: noStore });
  } catch (e) {
    return Response.json(
      { error: e instanceof WorkspaceError ? e.message : "Invalid request." },
      {
        status: e instanceof WorkspaceError ? e.status : 400,
        headers: noStore,
      },
    );
  }
}
