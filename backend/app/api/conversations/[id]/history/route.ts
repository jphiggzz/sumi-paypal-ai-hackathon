import {z} from "zod";
import { admittedUser, noStore } from "../../../../../lib/agent-api";
import { transaction } from "../../../../../lib/agent-store";
import { readHistory } from "../../../../../lib/history-store";
import { historyInput } from "../../../../../lib/knowledge-policy";
import { apiFailure } from "../../../../../lib/foundation-api";
export async function GET(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const a = await admittedUser(request);
  if (a.error) return a.error;
  try {
    const { id } = await params;
    if(!z.uuid().safeParse(id).success)return new Response(null,{status:404});
    const u = new URL(request.url),
      input = historyInput.safeParse(
        Object.fromEntries(
          [...u.searchParams].map(([k, v]) => [
            k,
            ["limit", "beforeSequence"].includes(k) ? Number(v) : v,
          ]),
        ),
      );
    if (!input.success) return new Response(null, { status: 400 });
    return Response.json(
      await transaction(async (c) => {
        const row = (
          await c.query(
            "SELECT requested_sequence FROM agent_conversations WHERE id=$1 AND owner_id=$2",
            [id, a.user.id],
          )
        ).rows[0];
        return readHistory(
          c,
          a.user.id,
          id,
          row?.requested_sequence ?? 0,
          input.data,
        );
      }),
      { headers: noStore },
    );
  } catch (e) {
    return apiFailure(e);
  }
}
