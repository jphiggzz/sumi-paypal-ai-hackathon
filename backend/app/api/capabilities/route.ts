import { admittedUser, noStore } from "../../../lib/agent-api";
import { capabilityManifest } from "../../../lib/capability-policy";
export async function GET(request: Request) {
  const access = await admittedUser(request);
  if (access.error) return access.error;
  return Response.json(
    {
      capabilities: capabilityManifest(),
      externalWrites: false,
      credentialMode: "fixture_and_consent_gated_google_drive",
    },
    { headers: noStore },
  );
}
