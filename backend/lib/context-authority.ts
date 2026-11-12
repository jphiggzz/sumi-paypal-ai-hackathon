import { assertSourceReferences } from "./source-store";
import type { PoolClient } from "pg";
import { assertMemoryVersions } from "./memory-store";
import { authorizeConnectionUse } from "./connection-store";
import { CapabilityError, type MemoryReference } from "./capability-contracts";

export async function assertContextReferences(
  client: PoolClient,
  id: string,
  sequence: number,
  owner: string,
) {
  const snapshot = (
    await client.query(
      "SELECT context_snapshot FROM conversation_turns WHERE conversation_id=$1 AND sequence=$2",
      [id, sequence],
    )
  ).rows[0]?.context_snapshot;
  if (!snapshot) return;
  await assertResultReferences(client, owner, snapshot.resultReferences ?? []);
  await assertSourceReferences(client, owner, snapshot.sourceReferences ?? []);
  const refs: MemoryReference[] = snapshot.memoryReferences ?? [];
  await assertMemoryVersions(client, owner, id, refs);
  for (const ref of [...(snapshot.connectionReferences ?? [])].sort((a, b) =>
    a.id.localeCompare(b.id),
  )) {
    try {
      await authorizeConnectionUse(client, owner, ref.id, {
        expectedVersion: ref.version,
        requiredScopes: ["documents:read"],
        ...(ref.resourceId ? { resourceId: ref.resourceId } : {}),
      });
    } catch {
      throw new CapabilityError("CONNECTION_CONTEXT_CHANGED", 409);
    }
  }
}
export async function mergeContextReferences(
  client: PoolClient,
  id: string,
  sequence: number,
  memoryRefs: MemoryReference[] = [],
  connectionRefs: { id: string; version: number; resourceId?: string }[] = [],
) {
  const snapshot = (
    await client.query(
      "SELECT context_snapshot FROM conversation_turns WHERE conversation_id=$1 AND sequence=$2",
      [id, sequence],
    )
  ).rows[0]?.context_snapshot;
  if (!snapshot) throw new CapabilityError("CONTEXT_REQUIRED", 409);
  const memories = [...(snapshot.memoryReferences ?? []), ...memoryRefs];
  const connections = [
    ...(snapshot.connectionReferences ?? []),
    ...connectionRefs,
  ];
  if (
    new Set(memories.map((r) => `${r.id}:${r.version}`)).size > 5 ||
    connections.length > 30
  )
    throw new CapabilityError("CONTEXT_REFERENCE_LIMIT", 429);
  await assertMemoryVersions(
    client,
    (
      await client.query(
        "SELECT owner_id FROM agent_conversations WHERE id=$1",
        [id],
      )
    ).rows[0].owner_id,
    id,
    [...new Map(memories.map((r) => [`${r.id}:${r.version}`, r])).values()],
  );
  snapshot.memoryReferences = [
    ...new Map(memories.map((r) => [`${r.id}:${r.version}`, r])).values(),
  ];
  snapshot.connectionReferences = [
    ...new Map(
      connections.map((r) => [`${r.id}:${r.version}:${r.resourceId ?? ""}`, r]),
    ).values(),
  ];
  await client.query(
    "UPDATE conversation_turns SET context_snapshot=$3 WHERE conversation_id=$1 AND sequence=$2",
    [id, sequence, JSON.stringify(snapshot)],
  );
}
export async function mergeSourceReferences(
  client: PoolClient,
  id: string,
  sequence: number,
  owner: string,
  refs: { id: string; version: number }[],
) {
  await assertSourceReferences(client, owner, refs);
  const snapshot = (
    await client.query(
      "SELECT context_snapshot FROM conversation_turns WHERE conversation_id=$1 AND sequence=$2",
      [id, sequence],
    )
  ).rows[0]?.context_snapshot;
  if (!snapshot) throw new CapabilityError("CONTEXT_REQUIRED", 409);
  const merged = [
    ...new Map(
      [...(snapshot.sourceReferences ?? []), ...refs].map((r) => [
        r.id + ":" + r.version,
        r,
      ]),
    ).values(),
  ];
  if (merged.length > 10)
    throw new CapabilityError("SOURCE_REFERENCE_LIMIT", 429);
  snapshot.sourceReferences = merged;
  await client.query(
    "UPDATE conversation_turns SET context_snapshot=$3 WHERE conversation_id=$1 AND sequence=$2",
    [id, sequence, JSON.stringify(snapshot)],
  );
}

export async function assertResultReferences(
  c: PoolClient,
  owner: string,
  refs: { id: string; revision: number }[],
) {
  for (const ref of refs) {
    const r = (
      await c.query(
        "SELECT revision,source_id,source_version FROM structured_results WHERE id=$1 AND owner_id=$2",
        [ref.id, owner],
      )
    ).rows[0];
    if (!r || r.revision !== ref.revision)
      throw new CapabilityError("RESULT_CONTEXT_CHANGED", 409);
    await assertSourceReferences(c, owner, [
      { id: r.source_id, version: r.source_version },
    ]);
  }
}
export async function mergeResultReferences(
  c: PoolClient,
  id: string,
  sequence: number,
  owner: string,
  refs: { id: string; revision: number }[],
) {
  if (!refs.length) return;
  await assertResultReferences(c, owner, refs);
  const snapshot = (
    await c.query(
      "SELECT context_snapshot FROM conversation_turns WHERE conversation_id=$1 AND sequence=$2",
      [id, sequence],
    )
  ).rows[0]?.context_snapshot;
  if (!snapshot) throw new CapabilityError("CONTEXT_REQUIRED", 409);
  snapshot.resultReferences = [
    ...new Map(
      [...(snapshot.resultReferences ?? []), ...refs].map((r) => [
        r.id + ":" + r.revision,
        r,
      ]),
    ).values(),
  ];
  if (snapshot.resultReferences.length > 24)
    throw new CapabilityError("CONTEXT_REFERENCE_LIMIT", 429);
  await c.query(
    "UPDATE conversation_turns SET context_snapshot=$3 WHERE conversation_id=$1 AND sequence=$2",
    [id, sequence, JSON.stringify(snapshot)],
  );
}
