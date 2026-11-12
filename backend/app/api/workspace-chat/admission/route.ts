import { admittedUser, canStartTask, noStore, sameOrigin } from "../../../../lib/agent-api";
import { hasWorkspaceGiftMembership, hasWorkspaceSnackMembership } from "../../../../lib/workspace-flows";

export async function POST(request: Request) {
  if (!sameOrigin(request)) return new Response(null, { status: 403 });
  const auth = await admittedUser(request);
  if (auth.error) return auth.error;
  const body = await request.json().catch(() => ({}));
  const id = typeof body.conversationId === "string" && /^[a-f0-9-]{36}$/i.test(body.conversationId) ? body.conversationId : null;
  const admitted = canStartTask(request, auth.user) || Boolean(id && (
    await hasWorkspaceGiftMembership(auth.user.id, id) || await hasWorkspaceSnackMembership(auth.user.id, id)
  ));
  return Response.json({ admitted }, { headers: noStore });
}
