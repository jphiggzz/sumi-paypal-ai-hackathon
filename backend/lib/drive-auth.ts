import { createHash, randomBytes } from "node:crypto";
import { transaction } from "./agent-store";
import { authorizeConnectionUse } from "./connection-store";
import { CapabilityError } from "./capability-contracts";
import {
  DRIVE_SCOPE,
  sealCredential,
  openCredential,
  limitedResponse,
} from "./drive-provider";
const hash = (v: string) => createHash("sha256").update(v).digest("hex");
function settings() {
  if (
    !process.env.GOOGLE_CLIENT_ID ||
    !process.env.GOOGLE_CLIENT_SECRET ||
    !process.env.BETTER_AUTH_URL
  )
    throw new CapabilityError("GOOGLE_SETUP_REQUIRED", 503);
  return {
    clientId: process.env.GOOGLE_CLIENT_ID,
    clientSecret: process.env.GOOGLE_CLIENT_SECRET,
    callback: process.env.BETTER_AUTH_URL + "/api/drive/callback",
  };
}
export async function beginDriveOAuth(
  owner: string,
  id: string,
  version: number,
) {
  const cfg = settings(),
    state = randomBytes(32).toString("base64url"),
    verifier = randomBytes(32).toString("base64url");
  await transaction(async (client) => {
    const c = (
      await client.query(
        "SELECT * FROM agent_connections WHERE id=$1 AND owner_id=$2 FOR UPDATE",
        [id, owner],
      )
    ).rows[0];
    if (!c || c.provider !== "google")
      throw new CapabilityError("CONNECTION_NOT_FOUND", 404);
    if (c.version !== version)
      throw new CapabilityError("connection_version_conflict", 409);
    await client.query(
      "DELETE FROM drive_oauth_states WHERE expires_at<now() OR connection_id=$1",
      [id],
    );
    await client.query(
      "INSERT INTO drive_oauth_states VALUES($1,$2,$3,$4,$5,now()+interval '5 minutes')",
      [hash(state), owner, id, version, verifier],
    );
  });
  const u = new URL("https://accounts.google.com/o/oauth2/v2/auth");
  for (const [k, v] of Object.entries({
    client_id: cfg.clientId,
    redirect_uri: cfg.callback,
    response_type: "code",
    scope: DRIVE_SCOPE,
    access_type: "offline",
    prompt: "consent",
    state,
    code_challenge: createHash("sha256").update(verifier).digest("base64url"),
    code_challenge_method: "S256",
  }))
    u.searchParams.set(k, v);
  return {
    authorizationUrl: u.toString(),
    callback: cfg.callback,
    scope: DRIVE_SCOPE,
  };
}
async function tokens(body: Record<string, string>) {
  const c = settings();
  const r = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      ...body,
      client_id: c.clientId,
      client_secret: c.clientSecret,
    }),
    signal: AbortSignal.timeout(2500),
    redirect: "error",
  });
  let value: any;
  try {
    value = JSON.parse(await limitedResponse(r, 8192));
  } catch {
    throw new CapabilityError("PROVIDER_REAUTH_REQUIRED", 409);
  }
  if (
    typeof value.access_token !== "string" ||
    value.access_token.length > 4096 ||
    !Number.isFinite(value.expires_in)
  )
    throw new CapabilityError("PROVIDER_TOKEN_INVALID", 502);
  return value;
}
export async function finishDriveOAuth(
  owner: string,
  state: string,
  code: string,
) {
  const cfg = settings();
  const row = await transaction(
    async (client) =>
      (
        await client.query(
          "DELETE FROM drive_oauth_states WHERE state_hash=$1 AND owner_id=$2 AND expires_at>now() RETURNING *",
          [hash(state), owner],
        )
      ).rows[0],
  );
  if (!row) throw new CapabilityError("OAUTH_STATE_INVALID", 400);
  const token = await tokens({
    grant_type: "authorization_code",
    code,
    code_verifier: row.verifier,
    redirect_uri: cfg.callback,
  });
  if (
    !token.refresh_token ||
    !String(token.scope).split(" ").includes(DRIVE_SCOPE)
  )
    throw new CapabilityError("PROVIDER_CONSENT_INCOMPLETE", 409);
  await transaction(async (client) => {
    const c = (
      await client.query(
        "SELECT * FROM agent_connections WHERE id=$1 AND owner_id=$2 FOR UPDATE",
        [row.connection_id, owner],
      )
    ).rows[0];
    if (!c || c.version !== row.connection_version)
      throw new CapabilityError("connection_version_conflict", 409);
    await client.query(
      "INSERT INTO drive_credentials(connection_id,owner_id,sealed) VALUES($1,$2,$3) ON CONFLICT(connection_id) DO UPDATE SET sealed=EXCLUDED.sealed,updated_at=now()",
      [
        c.id,
        owner,
        sealCredential(
          {
            ...token,
            expiresAt: Date.now() + Math.min(token.expires_in, 3600) * 1000,
          },
          owner + ":" + c.id,
        ),
      ],
    );
    const next = c.version + 1;
    await client.query(
      "UPDATE agent_connections SET version=$2,status='connected',scopes=ARRAY['documents:read'],resource_ids='{}',expires_at=now()+interval '7 days',updated_at=now() WHERE id=$1",
      [c.id, next],
    );
    await client.query(
      "INSERT INTO agent_connection_revisions SELECT id,version,owner_id,provider,status,scopes,resource_ids,expires_at,now() FROM agent_connections WHERE id=$1",
      [c.id],
    );
  });
  return { connected: true, resourceSelectionRequired: true };
}
export async function driveAccessToken(
  owner: string,
  id: string,
  version: number,
) {
  return transaction(async (client) => {
    const c = await authorizeConnectionUse(client, owner, id, {
      expectedVersion: version,
      requiredScopes: ["documents:read"],
    });
    if (c.provider !== "google")
      throw new CapabilityError("PROVIDER_MISMATCH", 400);
    const row = (
      await client.query(
        "SELECT sealed FROM drive_credentials WHERE connection_id=$1 AND owner_id=$2 FOR UPDATE",
        [id, owner],
      )
    ).rows[0];
    if (!row) throw new CapabilityError("consent_required", 409);
    const t = openCredential(row.sealed, owner + ":" + id);
    if (t.expiresAt > Date.now() + 30000) return t.access_token as string;
    const refreshed = await tokens({
      grant_type: "refresh_token",
      refresh_token: t.refresh_token,
    });
    const next = {
      ...t,
      ...refreshed,
      refresh_token: refreshed.refresh_token || t.refresh_token,
      expiresAt: Date.now() + Math.min(refreshed.expires_in, 3600) * 1000,
    };
    await client.query(
      "UPDATE drive_credentials SET sealed=$2,updated_at=now() WHERE connection_id=$1",
      [id, sealCredential(next, owner + ":" + id)],
    );
    return next.access_token as string;
  });
}
