import type { PoolClient } from "pg";
import { CapabilityError } from "./capability-contracts";
export function failureCategory(code: string | null) {
  if (!code) return null;
  if (/CONSENT|REAUTH|CONNECTION|REVOKED|SCOPE/.test(code.toUpperCase()))
    return "authorization";
  if (/BUDGET|QUOTA|LIMIT/.test(code.toUpperCase())) return "budget";
  if (/SOURCE_CHANGED|CONTEXT_CHANGED/.test(code.toUpperCase()))
    return "stale_context";
  if (/RATE|429/.test(code.toUpperCase())) return "provider_throttle";
  if (/MODEL/.test(code.toUpperCase())) return "model";
  return "execution";
}
export async function operations(
  client: PoolClient,
  owner: string,
  id: string,
) {
  const c = (
    await client.query(
      "SELECT id,status,requested_sequence,processed_sequence,worker_run_id,grants_active FROM agent_conversations WHERE id=$1 AND owner_id=$2",
      [id, owner],
    )
  ).rows[0];
  if (!c) throw new CapabilityError("CONVERSATION_NOT_FOUND", 404);
  const turns = (
    await client.query(
      `SELECT sequence,message_id,status,attempt,model,config_version,error_code,occurrence_id,event_id,context_snapshot->'sourceReferences' AS source_references FROM conversation_turns WHERE conversation_id=$1 ORDER BY sequence DESC LIMIT 100`,
      [id],
    )
  ).rows.map((t) => ({ ...t, category: failureCategory(t.error_code) }));
  const invocations = (
    await client.query(
      "SELECT id,sequence,tool_id,tool_version,state,attempts,connection_id,connection_version,error_code,retry_after_ms,duration_ms,output_bytes,workflow_run_id FROM agent_capability_invocations WHERE conversation_id=$1 ORDER BY started_at DESC LIMIT 100",
      [id],
    )
  ).rows;
  const proposals = (
    await client.query(
      `SELECT id,sequence,digest,state,payload->>'connectionId' AS connection_id,payload->>'connectionVersion' AS connection_version FROM agent_action_proposals WHERE conversation_id=$1 AND owner_id=$2 ORDER BY created_at DESC LIMIT 50`,
      [id, owner],
    )
  ).rows;
  const outbox = (
    await client.query(
      "SELECT id,sequence,kind,state FROM agent_dispatch_outbox WHERE conversation_id=$1 ORDER BY sequence DESC LIMIT 100",
      [id],
    )
  ).rows;
  const usage = (
    await client.query(
      "SELECT budget_key,requests,bytes FROM connector_usage WHERE day=(now() AT TIME ZONE 'UTC')::date AND (budget_key=$1 OR budget_key IN (SELECT 'connection:'||id::text FROM agent_connections WHERE owner_id=$2))",
      ["owner:" + owner, owner],
    )
  ).rows;
  const effects = (
    await client.query(
      "SELECT proposal_id,connection_id,resource_id,target_version,created_at FROM fixture_note_effects WHERE proposal_id IN (SELECT id FROM agent_action_proposals WHERE conversation_id=$1 AND owner_id=$2)",
      [id, owner],
    )
  ).rows;
  const triggers = (
    await client.query(
      "SELECT id,source_id,source_version,sequence FROM agent_event_inbox WHERE conversation_id=$1 AND owner_id=$2 ORDER BY sequence DESC LIMIT 100",
      [id, owner],
    )
  ).rows;
  const sourceImports = (
    await client.query(
      "SELECT id,source_id,connection_id,connection_version,resource_id,state,error_code,retry_after_ms,workflow_run_id,attempts FROM source_refreshes WHERE owner_id=$1 ORDER BY created_at DESC LIMIT 100",
      [owner],
    )
  ).rows;
  const sources = (
    await client.query(
      "SELECT id,connection_id,connection_version,resource_id,version,content_hash,fetched_at,expires_at FROM source_records WHERE owner_id=$1 ORDER BY fetched_at DESC LIMIT 100",
      [owner],
    )
  ).rows;
  return {
    sources,
    sourceImports,
    effects,
    triggers,
    correlationId: id,
    conversation: c,
    turns,
    invocations,
    proposals,
    outbox,
    usage,
    repair:
      "POST operation retry_turn, retry_exhausted (requestId required) or reconcile; completed writes are never reset.",
  };
}
