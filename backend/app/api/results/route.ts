import { admittedUser, sameOrigin, noStore } from "../../../lib/agent-api";
import { apiFailure, boundedJson } from "../../../lib/foundation-api";
import { transaction } from "../../../lib/agent-store";
import { feedRead, feedAction } from "../../../lib/document-policy";
import { readResults, deliveryAction } from "../../../lib/result-store";
export async function GET(request: Request) {
  const a = await admittedUser(request);
  if (a.error) return a.error;
  try {
    const u = new URL(request.url);
    if (u.searchParams.has("consumerId")) {
      const id = u.searchParams.get("consumerId") ?? "";
      if (
        !/^[A-Za-z0-9_-]{1,60}$/.test(id) ||
        [...u.searchParams.keys()].some((k) => k !== "consumerId")
      )
        return new Response(null, { status: 400 });
      const row = await transaction(
        async (c) =>
          (
            await c.query(
              "SELECT consumer_id,ack_cursor::text,scope FROM result_consumers WHERE owner_id=$1 AND consumer_id=$2",
              [a.user.id, id],
            )
          ).rows[0],
      );
      return Response.json(row ?? { error: "CONSUMER_NOT_FOUND" }, {
        status: row ? 200 : 404,
        headers: noStore,
      });
    }

    const p = feedRead.safeParse(
      Object.fromEntries(
        [...u.searchParams].map(([k, v]) => [k, k === "limit" ? Number(v) : v]),
      ),
    );
    if (!p.success) return new Response(null, { status: 400 });
    return Response.json(
      await transaction((c) => readResults(c, a.user.id, p.data)),
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
  try {
    const p = feedAction.safeParse(await boundedJson(request));
    if (!p.success) return new Response(null, { status: 400 });
    return Response.json(
      await transaction((c) => deliveryAction(c, a.user.id, p.data)),
      { headers: noStore },
    );
  } catch (e) {
    return apiFailure(e);
  }
}
