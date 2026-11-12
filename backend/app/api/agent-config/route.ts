import {
  admittedUser,
  sameOrigin,
  noStore,
  canStartTask,
} from "../../../lib/agent-api";
import { transaction } from "../../../lib/agent-store";
import { currentConfig, changeConfig } from "../../../lib/agent-config";
import { configInput } from "../../../lib/knowledge-policy";
import { apiFailure, boundedJson } from "../../../lib/foundation-api";
export async function GET(request: Request) {
  const a = await admittedUser(request);
  if (a.error) return a.error;
  try {
    return Response.json(
      await transaction(async (c) => {
        const p = (
          await c.query("SELECT id FROM agent_profiles WHERE owner_id=$1", [
            a.user.id,
          ])
        ).rows[0];
        return p ? await currentConfig(c, p.id, a.user.id) : null;
      }),
      { headers: noStore },
    );
  } catch (e) {
    return apiFailure(e);
  }
}
export async function PUT(request: Request) {
  if (!sameOrigin(request)) return new Response(null, { status: 403 });
  const a = await admittedUser(request);
  if (a.error) return a.error;
  if (!canStartTask(request, a.user))
    return new Response(null, { status: 403 });
  try {
    const p = configInput.safeParse(await boundedJson(request));
    if (!p.success) return new Response(null, { status: 400 });
    return Response.json(
      await transaction((c) => changeConfig(c, a.user.id, p.data)),
      { headers: noStore },
    );
  } catch (e) {
    return apiFailure(e);
  }
}
