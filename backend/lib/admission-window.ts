import type { PoolClient } from "pg";
import { CapabilityError } from "./capability-contracts";
/** A bounded watcher is prearmed before admission. Reject slow publication
 * while it still has headroom, instead of committing after its grace expires. */
export async function assertAdmissionWindow(
  client: PoolClient,
  deadline?: number,
) {
  if (deadline === undefined) return;
  await client.query("SET LOCAL statement_timeout='5s'");
  await client.query("SET LOCAL idle_in_transaction_session_timeout='5s'");
  const row = (
    await client.query(
      "SELECT clock_timestamp()<to_timestamp($1::double precision/1000) AS open",
      [deadline],
    )
  ).rows[0];
  if (!row?.open) throw new CapabilityError("ADMISSION_WINDOW_EXPIRED", 503);
}
