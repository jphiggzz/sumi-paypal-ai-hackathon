import { z } from "zod";
import { noStore, sameOrigin } from "../../../../lib/agent-api";
import { boundedJson, apiFailure } from "../../../../lib/foundation-api";
import { giftActionInput, executeGiftAction } from "../../../../lib/gift-api";
import { createGiftDemo, getGiftDemo, giftDemoActor, giftDemoFriends, giftDemoReturnPath } from "../../../../lib/gift-demo";
import { giftError, readGiftState } from "../../../../lib/gift-store";
const actorFor = (r: Request) => giftDemoActor.parse(new URL(r.url).searchParams.get("actor") ?? "alex");
async function view(session: Awaited<ReturnType<typeof getGiftDemo>>, actor: z.infer<typeof giftDemoActor>) {
  return { ...await readGiftState(session.actors[actor].id, session.group_id), demo: true, actor, friends: giftDemoFriends };
}
function failure(e: unknown) { return e instanceof z.ZodError ? Response.json({ error: "INVALID_DEMO_INPUT" }, { status: 400, headers: noStore }) : apiFailure(e); }
export async function GET(request: Request) {
  try { return Response.json(await view(await getGiftDemo(request), actorFor(request)), { headers: noStore }); } catch (e) { return failure(e); }
}
export async function POST(request: Request) {
  if (!sameOrigin(request)) return new Response(null, { status: 403 });
  try {
    const actor = actorFor(request), body = await boundedJson(request);
    if (body.action === "start" || body.action === "reset") {
      z.object({ action: z.enum(["start", "reset"]) }).strict().parse(body);
      const created = await createGiftDemo(request, body.action === "reset");
      return Response.json(await view(created.session, actor), { headers: { ...noStore, ...(created.cookie ? { "Set-Cookie": `gift_demo=${created.cookie}; HttpOnly; SameSite=Lax; Path=/api/gifts/demo; Max-Age=28800` } : {}) } });
    }
    const session = await getGiftDemo(request);
    const v = giftActionInput.parse(body);
    if (["create", "join", "invite"].includes(v.action) || !("groupId" in v) || v.groupId !== session.group_id) giftError("GIFT_DEMO_SCOPE_DENIED", 403);
    await executeGiftAction(session.actors[actor], v, new URL(request.url).origin, giftDemoReturnPath(actor));
    return Response.json(await view(session, actor), { headers: noStore });
  } catch (e) { return failure(e); }
}
