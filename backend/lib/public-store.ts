import { transaction } from "./agent-store";
import { authPool } from "./auth";
import { CapabilityError } from "./capability-contracts";
import { readPublicDocument } from "./public-document";
import { putOwnedSource } from "./document-store";
import { resultEvent } from "./result-store";
export async function performPublicImport(
  owner: string,
  id: string,
  runId: string,
) {
  const claim = await transaction(async (c) => {
    await c.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", [
      "sources:" + owner,
    ]);
    const r = (
      await c.query(
        "UPDATE document_requests SET execution_attempts=execution_attempts+1 WHERE id=$1 AND owner_id=$2 AND workflow_run_id=$3 RETURNING *",
        [id, owner, runId],
      )
    ).rows[0];
    if (!r) throw new CapabilityError("PUBLIC_WORKER_REVOKED", 409);
    if (r.state === "completed") return { done: true, request: r.request };
    if (r.provider_attempts >= 3)
      throw new CapabilityError("PUBLIC_ATTEMPTS_EXHAUSTED", 409);
    await c.query(
      "UPDATE document_requests SET state='running',provider_attempts=provider_attempts+1 WHERE id=$1",
      [id],
    );
    return { done: false, request: r.request };
  });
  if (claim.done) return { injectRecovery: false };
  try {
    const doc = await readPublicDocument(claim.request.url);
    return await transaction(async (c) => {
      await c.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", [
        "sources:" + owner,
      ]);
      const row = (
        await c.query(
          "SELECT * FROM document_requests WHERE id=$1 AND owner_id=$2 AND workflow_run_id=$3 FOR UPDATE",
          [id, owner, runId],
        )
      ).rows[0];
      if (!row) throw new CapabilityError("PUBLIC_WORKER_REVOKED", 409);
      if (row.state === "completed") return { injectRecovery: false };
      const result = await putOwnedSource(c, owner, {
        sourceId: row.source_id,
        expectedVersion: row.request.expectedVersion,
        kind: "public",
        ...doc,
      });
      await c.query(
        "UPDATE document_requests SET state='completed',result=$2,error_code=NULL WHERE id=$1",
        [id, JSON.stringify(result)],
      );
      await resultEvent(c, owner, "document:" + id, "document.updated", result);
      return { injectRecovery: row.request.recoveryTest === true };
    });
  } catch (error) {
    const e =
      error instanceof CapabilityError
        ? error
        : new CapabilityError("PUBLIC_FETCH_FAILED", 502);
    await authPool.query(
      "UPDATE document_requests SET state='failed',error_code=$2,retry_after_ms=$3 WHERE id=$1 AND owner_id=$4 AND state<>'completed'",
      [id, e.code, e.retryAfterMs ?? null, owner],
    );
    throw e;
  }
}
