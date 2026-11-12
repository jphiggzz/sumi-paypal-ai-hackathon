import { z } from "zod";
import { admittedUser, canStartTask, sameOrigin, noStore } from "../../../lib/agent-api";
import { boundedJson, apiFailure } from "../../../lib/foundation-api";
import { giftActionInput, executeGiftAction } from "../../../lib/gift-api";
import { readGiftState } from "../../../lib/gift-store";
export async function GET(request: Request) {
  const a = await admittedUser(request); if (a.error) return a.error;
  try { const raw = new URL(request.url).searchParams.get("groupId"); return Response.json(await readGiftState(a.user.id, raw ? z.uuid().parse(raw) : undefined), { headers: noStore }); }
  catch (e) { return e instanceof z.ZodError ? Response.json({ error: "INVALID_INPUT" }, { status: 400 }) : apiFailure(e); }
}
export async function POST(request: Request) {
  if (!sameOrigin(request)) return new Response(null, { status: 403 });
  const a = await admittedUser(request); if (a.error) return a.error;
  try {
    const v = giftActionInput.parse(await boundedJson(request));
    if (v.action === "create" && !canStartTask(request, a.user)) return new Response(null, { status: 403 });
    return Response.json(await executeGiftAction(a.user, v, new URL(request.url).origin), { headers: noStore });
  } catch (e) { return e instanceof z.ZodError ? Response.json({ error: "INVALID_INPUT" }, { status: 400, headers: noStore }) : apiFailure(e); }
}
