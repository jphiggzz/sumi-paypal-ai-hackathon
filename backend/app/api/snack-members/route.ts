import { z } from "zod";
import { admittedUser, sameOrigin, noStore } from "../../../lib/agent-api";
import { boundedJson, apiFailure } from "../../../lib/foundation-api";
import { joinSnackOffice, readSnackMembers, saveSnackPreferences, snackInvite, snackPreferences, snackPrivateChat } from "../../../lib/snack-members";
const input = z.discriminatedUnion("action", [
  z.object({ action: z.literal("join"), token: z.string().regex(/^[A-Za-z0-9_-]{43}$/) }).strict(),
  z.object({ action: z.literal("invite"), officeId: z.uuid() }).strict(),
  z.object({ action: z.literal("preferences"), officeId: z.uuid(), preferences: snackPreferences, shared: z.boolean() }).strict(),
  z.object({ action: z.literal("chat"), officeId: z.uuid(), text: z.string().trim().min(1).max(1500) }).strict(),
]);
export async function GET(request: Request) {
  const a = await admittedUser(request); if (a.error) return a.error;
  try { return Response.json(await readSnackMembers(a.user.id, z.uuid().parse(new URL(request.url).searchParams.get("officeId"))), { headers: noStore }); }
  catch (e) { return e instanceof z.ZodError ? Response.json({ error: "INVALID_INPUT" }, { status: 400, headers: noStore }) : apiFailure(e); }
}
export async function POST(request: Request) {
  if (!sameOrigin(request)) return new Response(null, { status: 403 });
  const a = await admittedUser(request); if (a.error) return a.error;
  try {
    const v = input.parse(await boundedJson(request));
    if (v.action === "join") return Response.json({ officeId: await joinSnackOffice(a.user, v.token) }, { headers: noStore });
    if (v.action === "invite") return Response.json({ token: await snackInvite(a.user.id, v.officeId) }, { headers: noStore });
    if (v.action === "preferences") await saveSnackPreferences(a.user.id, v.officeId, v.preferences, v.shared);
    if (v.action === "chat") await snackPrivateChat(a.user.id, v.officeId, v.text);
    return Response.json(await readSnackMembers(a.user.id, v.officeId), { headers: noStore });
  } catch (e) { return e instanceof z.ZodError ? Response.json({ error: "INVALID_INPUT" }, { status: 400, headers: noStore }) : apiFailure(e); }
}
