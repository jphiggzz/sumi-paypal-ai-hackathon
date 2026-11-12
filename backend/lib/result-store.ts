import type { PoolClient } from "pg";
import { createHash } from "node:crypto";
import type { z } from "zod";
import { canonicalJson } from "./canonical-json";
import { CapabilityError } from "./capability-contracts";
import { feedRead, feedAction } from "./document-policy";
export const inputHash = (v: unknown) =>
  createHash("sha256").update(canonicalJson(v)).digest("hex");
export async function workQuota(
  c: PoolClient,
  owner: string,
  kind: string,
  max: number,
) {
  const row = await c.query(
    "INSERT INTO foundation_work_quota VALUES((now() AT TIME ZONE 'UTC')::date,$1,$2,1) ON CONFLICT(day,owner_id,kind) DO UPDATE SET count=foundation_work_quota.count+1 WHERE foundation_work_quota.count<$3 RETURNING count",
    [owner, kind, max],
  );
  if (!row.rowCount) throw new CapabilityError("WORK_QUOTA_EXHAUSTED", 429);
}
// Serialize allocation AND reads per owner: sequence allocation alone is not commit order.
export async function feedLock(c: PoolClient, owner: string) {
  await c.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", [
    "results:" + owner,
  ]);
}
export async function resultEvent(
  c: PoolClient,
  owner: string,
  key: string,
  kind: string,
  detail: unknown,
  conversationId: string | null = null,
  jobId: string | null = null,
) {
  await feedLock(c, owner);
  await c.query(
    "INSERT INTO result_events(owner_id,conversation_id,job_id,event_key,kind,detail) VALUES($1,$2,$3,$4,$5,$6) ON CONFLICT(owner_id,event_key) DO NOTHING",
    [owner, conversationId, jobId, key, kind, JSON.stringify(detail)],
  );
}
export async function readResults(
  c: PoolClient,
  owner: string,
  input: z.infer<typeof feedRead>,
) {
  await feedLock(c, owner);
  if (
    input.conversationId &&
    !(
      await c.query(
        "SELECT 1 FROM agent_conversations WHERE id=$1 AND owner_id=$2",
        [input.conversationId, owner],
      )
    ).rowCount
  )
    throw new CapabilityError("CONVERSATION_NOT_FOUND", 404);
  const rows = (
    await c.query(
      "SELECT id::text,conversation_id,job_id,kind,detail,created_at FROM result_events WHERE owner_id=$1 AND id>$2::bigint AND ($3::uuid IS NULL OR conversation_id=$3) ORDER BY result_events.id LIMIT $4",
      [owner, input.after, input.conversationId ?? null, input.limit + 1],
    )
  ).rows;
  const events = rows.slice(0, input.limit);
  return {
    events,
    nextCursor: events.at(-1)?.id ?? input.after,
    hasMore: rows.length > input.limit,
  };
}
export async function deliveryAction(
  c: PoolClient,
  owner: string,
  input: z.infer<typeof feedAction>,
) {
  await feedLock(c, owner);
  if (input.action === "ack") {
    const d = (
      await c.query(
        "SELECT * FROM result_deliveries WHERE id=$1 AND owner_id=$2 AND consumer_id=$3 FOR UPDATE",
        [input.deliveryId, owner, input.consumerId],
      )
    ).rows[0];
    if (!d) throw new CapabilityError("DELIVERY_NOT_FOUND", 404);
    await c.query(
      "INSERT INTO result_consumers(owner_id,consumer_id,ack_cursor) VALUES($1,$2,$3) ON CONFLICT(owner_id,consumer_id) DO UPDATE SET ack_cursor=GREATEST(result_consumers.ack_cursor,EXCLUDED.ack_cursor)",
      [owner, input.consumerId, d.next_cursor],
    );
    await c.query(
      "UPDATE result_deliveries SET acknowledged_at=COALESCE(acknowledged_at,now()) WHERE id=$1",
      [d.id],
    );
    return {
      acknowledged: true,
      cursor: (
        await c.query(
          "SELECT ack_cursor::text FROM result_consumers WHERE owner_id=$1 AND consumer_id=$2",
          [owner, input.consumerId],
        )
      ).rows[0].ack_cursor,
    };
  }
  const scope = input.conversationId ?? "*";
  await c.query(
    "INSERT INTO result_consumers(owner_id,consumer_id,scope) VALUES($1,$2,$3) ON CONFLICT DO NOTHING",
    [owner, input.consumerId, scope],
  );
  const consumer = (
    await c.query(
      "SELECT scope FROM result_consumers WHERE owner_id=$1 AND consumer_id=$2",
      [owner, input.consumerId],
    )
  ).rows[0];
  if (consumer.scope !== scope)
    throw new CapabilityError("CONSUMER_SCOPE_CONFLICT", 409);
  const digest = inputHash(input);
  const prior = (
    await c.query("SELECT * FROM result_deliveries WHERE id=$1", [
      input.requestId,
    ])
  ).rows[0];
  if (prior) {
    if (
      prior.owner_id !== owner ||
      prior.consumer_id !== input.consumerId ||
      prior.input_digest !== digest
    )
      throw new CapabilityError("DELIVERY_CONFLICT", 409);
    const events = (
      await c.query(
        "SELECT id::text,conversation_id,job_id,kind,detail,created_at FROM result_events WHERE owner_id=$1 AND id=ANY($2::bigint[]) ORDER BY result_events.id",
        [owner, prior.event_ids],
      )
    ).rows;
    return {
      deliveryId: prior.id,
      events,
      nextCursor: String(prior.next_cursor),
      hasMore: prior.has_more,
      replayed: true,
    };
  }
  await workQuota(c, owner, "deliveries", 200);
  const r = await readResults(c, owner, input);
  await c.query(
    "INSERT INTO result_deliveries(id,owner_id,consumer_id,input_digest,after_cursor,next_cursor,event_ids,has_more) VALUES($1,$2,$3,$4,$5,$6,$7,$8)",
    [
      input.requestId,
      owner,
      input.consumerId,
      digest,
      input.after,
      r.nextCursor,
      JSON.stringify(r.events.map((e) => e.id)),
      r.hasMore,
    ],
  );
  return { deliveryId: input.requestId, ...r, replayed: false };
}
