import type { PoolClient } from "pg";
import { CapabilityError } from "./capability-contracts";
export async function reserveConnectorBudget(
  client: PoolClient,
  owner: string,
  connectionId: string,
  operation: 'refresh' | 'selection' = 'refresh',
) {
  const reservedRequests=operation==='selection'?4:12;
  const reservedBytes=operation==='selection'?49152:196608;
  // Reservation never refunded: uncertain/failed requests still consume allowance.
  for (const [key, requests, bytes] of [
    [`owner:${owner}`, 300, 3 * 1024 * 1024],
    [`connection:${connectionId}`, 60, 1024 * 1024],
  ] as const) {
    const r = await client.query(
      `INSERT INTO connector_usage(day,budget_key,requests,bytes) VALUES((now() AT TIME ZONE 'UTC')::date,$1,$4,$5) ON CONFLICT(day,budget_key) DO UPDATE SET requests=connector_usage.requests+$4,bytes=connector_usage.bytes+$5 WHERE connector_usage.requests+$4<=$2 AND connector_usage.bytes+$5<=$3 RETURNING requests`,
      [key, requests, bytes,reservedRequests,reservedBytes],
    );
    if (!r.rowCount)
      throw new CapabilityError("CONNECTOR_BUDGET_EXHAUSTED", 429);
  }
}
