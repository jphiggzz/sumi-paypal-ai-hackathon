import type { PoolClient } from "pg";
import { CapabilityError } from "./capability-contracts";
import { configInput, configurableTools } from "./knowledge-policy";
import type { z } from "zod";
export async function currentConfig(
  client: PoolClient,
  agentId: string,
  owner: string,
) {
  const profile = (
    await client.query(
      "SELECT config_version FROM agent_profiles WHERE id=$1 AND owner_id=$2 FOR SHARE",
      [agentId, owner],
    )
  ).rows[0];
  if (!profile) throw new CapabilityError("AGENT_NOT_FOUND", 404);
  await client.query(
    `INSERT INTO agent_config_versions(agent_id,version,owner_id,instructions,tools,model,context_bytes) VALUES($1,1,$2,'',$3,'amazon/nova-micro',16000) ON CONFLICT DO NOTHING`,
    [agentId, owner, JSON.stringify(configurableTools)],
  );
  return (
    await client.query(
      "SELECT * FROM agent_config_versions WHERE agent_id=$1 AND version=$2",
      [agentId, profile.config_version],
    )
  ).rows[0];
}
export async function changeConfig(
  client: PoolClient,
  owner: string,
  input: z.infer<typeof configInput>,
) {
  const p = (
    await client.query(
      "SELECT * FROM agent_profiles WHERE owner_id=$1 FOR UPDATE",
      [owner],
    )
  ).rows[0];
  if (!p) throw new CapabilityError("AGENT_NOT_FOUND", 404);
  await currentConfig(client, p.id, owner);
  if (p.config_version !== input.expectedVersion)
    throw new CapabilityError("CONFIG_VERSION_CONFLICT", 409);
  const version = p.config_version + 1;
  if (version > 100) throw new CapabilityError("CONFIG_VERSION_LIMIT", 429);
  await client.query(
    "INSERT INTO agent_config_versions(agent_id,version,owner_id,instructions,tools,model,context_bytes,max_output_tokens) VALUES($1,$2,$3,$4,$5,$6,$7,$8)",
    [
      p.id,
      version,
      owner,
      input.instructions,
      JSON.stringify(input.tools),
      input.model,
      input.contextBytes,
      input.maxOutputTokens,
    ],
  );
  await client.query(
    "UPDATE agent_profiles SET config_version=$2 WHERE id=$1",
    [p.id, version],
  );
  return { version };
}
export async function pinnedConfig(
  client: PoolClient,
  id: string,
  sequence: number,
) {
  const c = (
    await client.query(
      "SELECT v.* FROM conversation_turns t JOIN agent_conversations c ON c.id=t.conversation_id JOIN agent_config_versions v ON v.agent_id=c.agent_id AND v.version=COALESCE(t.config_version,1) WHERE t.conversation_id=$1 AND t.sequence=$2",
      [id, sequence],
    )
  ).rows[0];
  if (!c) throw new CapabilityError("CONFIG_NOT_FOUND", 409);
  return c;
}
