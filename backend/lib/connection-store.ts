// Server module: PostgreSQL and node:crypto never enter client components or model context.
import { randomUUID, randomBytes } from "node:crypto";
import type { PoolClient } from "pg";
import { z } from "zod";
import {
  CapabilityError,
  type ConnectionHandle,
  type ConnectionUse,
} from "./capability-contracts";
import {
  assertConnectionUse,
  changedConnection,
  connectionChange,
  connectionExpiry,
  connectionInput,
  fixtureResourceIds,
  type ConnectionChange,
  type ConnectionInput,
} from "./connection-policy";

type Row = {
  id: string;
  owner_id: string;
  provider: ConnectionHandle["provider"];
  version: number;
  status: ConnectionHandle["status"];
  scopes: string[];
  resource_ids: string[];
  expires_at: Date | string | null;
};
function handle(row: Row): ConnectionHandle {
  return {
    id: row.id,
    ownerId: row.owner_id,
    provider: row.provider,
    version: row.version,
    status: row.status,
    scopes: row.scopes,
    resourceIds: row.resource_ids,
    expiresAt:
      row.expires_at === null ? null : new Date(row.expires_at).toISOString(),
  };
}
async function transaction<T>(execute: (client: PoolClient) => Promise<T>) {
  const { transaction: run } = await import("./agent-store");
  return run(execute);
}
async function snapshot(client: PoolClient, connection: ConnectionHandle) {
  await client.query(
    `INSERT INTO agent_connection_revisions(connection_id,version,owner_id,provider,status,scopes,resource_ids,expires_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8)`,
    [
      connection.id,
      connection.version,
      connection.ownerId,
      connection.provider,
      connection.status,
      connection.scopes,
      connection.resourceIds,
      connection.expiresAt,
    ],
  );
}
function failure(error: unknown) {
  if (error instanceof CapabilityError)
    return { status: error.status, error: error.code };
  throw error;
}
export async function listConnectionsWithClient(
  client: PoolClient,
  ownerId: string,
): Promise<ConnectionHandle[]> {
  return (
    await client.query(
      "SELECT * FROM agent_connections WHERE owner_id=$1 ORDER BY updated_at DESC LIMIT 100",
      [ownerId],
    )
  ).rows.map((row) => {
    const connection = handle(row);
    return connection.status === "connected" &&
      connection.expiresAt !== null &&
      Date.parse(connection.expiresAt) <= Date.now()
      ? { ...connection, status: "expired" as const }
      : connection;
  });
}
export async function listConnections(
  ownerId: string,
): Promise<ConnectionHandle[]> {
  return transaction((client) => listConnectionsWithClient(client, ownerId));
}
export async function createConnection(
  ownerId: string,
  input: ConnectionInput,
): Promise<{ status: number; connection?: ConnectionHandle; error?: string }> {
  const parsed = connectionInput.safeParse(input);
  if (!parsed.success) return { status: 400, error: "invalid_connection" };
  input = parsed.data;
  try {
    const connection: ConnectionHandle = {
      id: input.id ?? randomUUID(),
      ownerId,
      provider: input.provider,
      version: 1,
      status:
        input.provider === "fixture" ? "connected" : "requires_authorization",
      scopes:
        input.provider === "fixture"
          ? (input.scopes ?? ["documents:read"])
          : [],
      resourceIds:
        input.provider === "fixture"
          ? (input.resourceIds ?? [...fixtureResourceIds])
          : [],
      expiresAt:
        input.provider === "fixture" ? connectionExpiry(input.expiresAt) : null,
    };
    return await transaction(async (client) => {
      await client.query(
        "SELECT pg_advisory_xact_lock(hashtextextended($1,0))",
        [`connections:${ownerId}`],
      );
      const count = +(
        await client.query(
          "SELECT count(*) FROM agent_connections WHERE owner_id=$1",
          [ownerId],
        )
      ).rows[0].count;
      if (count >= 20) return { status: 429, error: "connection_limit" };
      const inserted = await client.query(
        `INSERT INTO agent_connections(id,owner_id,provider,version,status,scopes,resource_ids,expires_at) VALUES($1,$2,$3,1,$4,$5,$6,$7) ON CONFLICT(id) DO NOTHING RETURNING id`,
        [
          connection.id,
          ownerId,
          connection.provider,
          connection.status,
          connection.scopes,
          connection.resourceIds,
          connection.expiresAt,
        ],
      );
      if (!inserted.rowCount)
        return { status: 409, error: "connection_id_conflict" };
      await snapshot(client, connection);
      return { status: 201, connection };
    });
  } catch (error) {
    return failure(error);
  }
}
export async function changeConnection(
  ownerId: string,
  id: string,
  input: ConnectionChange,
): Promise<{ status: number; connection?: ConnectionHandle; error?: string }> {
  if (!z.uuid().safeParse(id).success)
    return { status: 404, error: "connection_not_found" };
  const parsed = connectionChange.safeParse(input);
  if (!parsed.success)
    return { status: 400, error: "invalid_connection_change" };
  try {
    return await transaction(async (client) => {
      const row = (
        await client.query(
          "SELECT * FROM agent_connections WHERE id=$1 AND owner_id=$2 FOR UPDATE",
          [id, ownerId],
        )
      ).rows[0];
      if (!row) return { status: 404, error: "connection_not_found" };
      const connection = changedConnection(handle(row), parsed.data);
      const update = await client.query(
        `UPDATE agent_connections SET version=$3,status=$4,scopes=$5,resource_ids=$6,expires_at=$7,updated_at=now() WHERE id=$1 AND owner_id=$2 AND version=$8 RETURNING id`,
        [
          id,
          ownerId,
          connection.version,
          connection.status,
          connection.scopes,
          connection.resourceIds,
          connection.expiresAt,
          parsed.data.expectedVersion,
        ],
      );
      if (!update.rowCount)
        throw new CapabilityError("connection_version_conflict");
      await snapshot(client, connection);
      if (connection.status === "disconnected")
        await client.query(
          "DELETE FROM drive_credentials WHERE connection_id=$1 AND owner_id=$2",
          [id, ownerId],
        );
      return { status: 200, connection };
    });
  } catch (error) {
    return failure(error);
  }
}
// SHARE permits concurrent readers while serializing authorization with connection
// generation mutations (FOR UPDATE), through the caller's final result commit.
export async function authorizeConnectionUse(
  client: PoolClient,
  ownerId: string,
  id: string,
  use: ConnectionUse,
): Promise<ConnectionHandle> {
  if (!z.uuid().safeParse(id).success)
    throw new CapabilityError("connection_not_found", 404);
  const row = (
    await client.query(
      "SELECT * FROM agent_connections WHERE id=$1 AND owner_id=$2 FOR SHARE",
      [id, ownerId],
    )
  ).rows[0];
  const connection = row ? handle(row) : undefined;
  assertConnectionUse(connection, ownerId, use);
  return connection;
}
export async function readConnectionForUse(
  ownerId: string,
  id: string,
  use: ConnectionUse,
): Promise<ConnectionHandle> {
  return transaction((client) =>
    authorizeConnectionUse(client, ownerId, id, use),
  );
}
// Clearly synthetic, ephemeral fixture credentials. Never returned by a route, persisted,
// logged, or included in prompts. This is not storage or refresh of real OAuth secrets.
export async function acquireFixtureCredential(
  client: PoolClient,
  ownerId: string,
  id: string,
  use: ConnectionUse,
): Promise<{ connection: ConnectionHandle; token: string }> {
  const connection = await authorizeConnectionUse(client, ownerId, id, use);
  if (connection.provider !== "fixture")
    throw new CapabilityError("consent_required");
  return {
    connection,
    token: `synthetic-fixture-only.${connection.id}.${connection.version}.${randomBytes(16).toString("hex")}`,
  };
}
