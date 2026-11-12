import { admittedUser, noStore } from "../../../../lib/agent-api";
import { finishDriveOAuth } from "../../../../lib/drive-auth";
import { apiFailure } from "../../../../lib/foundation-api";
export async function GET(request: Request) {
  const a = await admittedUser(request);
  if (a.error) return a.error;
  const url = new URL(request.url),
    state = url.searchParams.get("state"),
    code = url.searchParams.get("code");
  if (!state || !code || state.length > 200 || code.length > 4096)
    return Response.json(
      { error: "OAUTH_CANCELLED_OR_INVALID" },
      { status: 400, headers: noStore },
    );
  try {
    await finishDriveOAuth(a.user.id, state, code);
    return new Response(null, {
      status: 303,
      headers: {
        ...noStore,
        Location: "/workspace",
        "Referrer-Policy": "no-referrer",
      },
    });
  } catch (e) {
    return apiFailure(e);
  }
}
