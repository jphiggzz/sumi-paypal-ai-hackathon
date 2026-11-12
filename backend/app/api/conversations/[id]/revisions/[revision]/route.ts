import { z } from "zod";
import { admittedUser, noStore } from "../../../../../../lib/agent-api";
import { authPool } from "../../../../../../lib/auth";

export async function GET(
  request: Request,
  { params }: { params: Promise<{ id: string; revision: string }> },
) {
  const access = await admittedUser(request);
  if (access.error) return access.error;
  const { id, revision } = await params;
  const number = Number(revision);
  if (
    !z.uuid().safeParse(id).success ||
    !Number.isSafeInteger(number) ||
    number < 1
  )
    return new Response(null, { status: 404 });
  const row = (
    await authPool.query(
      "SELECT r.title,r.markdown,r.digest,r.state FROM conversation_revisions r JOIN agent_conversations c ON c.id=r.conversation_id WHERE r.conversation_id=$1 AND r.revision=$2 AND c.owner_id=$3",
      [id, number, access.user.id],
    )
  ).rows[0];
  if (!row) return new Response(null, { status: 404 });
  if (new URL(request.url).searchParams.get("format") === "json")
    return Response.json({ revision: number, ...row }, { headers: noStore });
  return new Response(row.markdown, {
    headers: {
      ...noStore,
      "Content-Type": "text/markdown; charset=utf-8",
      "Content-Disposition": `attachment; filename="artifact-${id}-v${number}.md"`,
      "X-Content-Type-Options": "nosniff",
    },
  });
}
