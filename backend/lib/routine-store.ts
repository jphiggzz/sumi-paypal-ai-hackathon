import { assertEventTurnAuthority } from "./event-authority";
import { assertWorkTurn } from './work-store';
import { assertAdmissionWindow } from "./admission-window";
import { canonicalJson } from "./canonical-json";
import { randomUUID } from "node:crypto";
import type { PoolClient } from "pg";
import { FatalError } from "workflow";
import { z } from "zod";
import { authPool } from "./auth";
import { transaction } from "./agent-store";
import {
  appendTurn,
  conversationEvent,
  refreshConversationStatus,
} from "./conversation-store";
import { nextDue, routineInput } from "./routine-policy";

export async function putRoutine(
  owner: string,
  conversationId: string,
  input: z.infer<typeof routineInput>,
  expectedVersion?: number,
  admissionDeadline?: number,
) {
  return transaction(async (client) => {
    await assertAdmissionWindow(client, admissionDeadline);
    await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", [
      `routines:${owner}`,
    ]);
    const c = (
      await client.query(
        "SELECT * FROM agent_conversations WHERE id=$1 AND owner_id=$2 FOR UPDATE",
        [conversationId, owner],
      )
    ).rows[0];
    if (!c) return { status: 404 };
    if (!c.grants_active) return { status: 409 };
    const prior = (
      await client.query(
        "SELECT * FROM agent_routines WHERE id=$1 FOR UPDATE",
        [input.id],
      )
    ).rows[0];
    if (
      prior &&
      (prior.owner_id !== owner || prior.conversation_id !== conversationId)
    )
      return { status: 404 };
    if (prior && expectedVersion === undefined) {
      const same =
        prior.instruction === input.instruction &&
        prior.execution_mode === input.executionMode &&
        canonicalJson(prior.capability_request ?? null) ===
          canonicalJson(input.capabilityRequest ?? null) &&
        new Date(prior.next_due_at).toISOString() ===
          new Date(input.dueAt).toISOString() &&
        prior.timezone === input.timezone &&
        prior.interval_seconds === input.intervalSeconds &&
        prior.max_runs === input.maxRuns &&
        new Date(prior.expires_at).toISOString() ===
          new Date(input.expiresAt).toISOString();
      return { status: same ? 200 : 409, version: prior.version };
    }
    if (expectedVersion !== undefined && prior?.version !== expectedVersion)
      return { status: 409 };
    const count = +(
      await client.query(
        "SELECT count(*) FROM agent_routines WHERE owner_id=$1 AND status IN ('active','paused') AND id<>$2",
        [owner, input.id],
      )
    ).rows[0].count;
    // Serialize account-wide admission as well as conversation ownership.
    if (count >= 5) return { status: 429 };
    if (
      Date.parse(input.dueAt) < Date.now() - 5000 ||
      Date.parse(input.expiresAt) <= Date.now() ||
      input.maxRuns <= (prior?.run_count ?? 0)
    )
      return { status: 400 };
    const version = prior ? prior.version + 1 : 1;
    if (prior) await revokeRoutineTurns(client, input.id, conversationId);
    await client.query(
      `INSERT INTO agent_routines(id,conversation_id,owner_id,instruction,execution_mode,timezone,next_due_at,interval_seconds,max_runs,expires_at,version)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
      ON CONFLICT(id) DO UPDATE SET instruction=$4,execution_mode=$5,timezone=$6,next_due_at=$7,interval_seconds=$8,max_runs=$9,expires_at=$10,version=$11,status='active',updated_at=now()`,
      [
        input.id,
        conversationId,
        owner,
        input.instruction,
        input.executionMode,
        input.timezone,
        input.dueAt,
        input.intervalSeconds,
        input.maxRuns,
        input.expiresAt,
        version,
      ],
    );
    await client.query(
      "UPDATE agent_routines SET capability_request=$2 WHERE id=$1",
      [
        input.id,
        input.capabilityRequest
          ? JSON.stringify(input.capabilityRequest)
          : null,
      ],
    );
    await conversationEvent(
      client,
      conversationId,
      `routine:${input.id}:${version}`,
      "routine_scheduled",
      {
        routineId: input.id,
        version,
        dueAt: input.dueAt,
        executionMode: input.executionMode,
        configuration: input,
      },
    );
    await assertAdmissionWindow(client, admissionDeadline);
    return { status: prior ? 200 : 201, version };
  });
}
async function revokeRoutineTurns(
  client: PoolClient,
  id: string,
  conversationId: string,
) {
  await client.query(
    "UPDATE conversation_turns t SET status='cancelled',error_code='ROUTINE_REVOKED' FROM routine_occurrences o WHERE t.occurrence_id=o.id AND o.routine_id=$1 AND t.status IN ('queued','running')",
    [id],
  );
  await client.query(
    "UPDATE routine_occurrences SET status='cancelled' WHERE routine_id=$1 AND status='queued'",
    [id],
  );
  await refreshConversationStatus(client, conversationId);
}
export async function controlRoutine(
  owner: string,
  conversationId: string,
  id: string,
  version: number,
  action: "pause" | "cancel",
) {
  return transaction(async (client) => {
    const c = (
      await client.query(
        "SELECT * FROM agent_conversations WHERE id=$1 AND owner_id=$2 FOR UPDATE",
        [conversationId, owner],
      )
    ).rows[0];
    if (!c) return 404;
    const r = (
      await client.query(
        "SELECT * FROM agent_routines WHERE id=$1 AND conversation_id=$2 FOR UPDATE",
        [id, conversationId],
      )
    ).rows[0];
    if (!r) return 404;
    if (r.version !== version) return 409;
    if (r.status === "cancelled") return action === "cancel" ? 200 : 409;
    await client.query(
      "UPDATE agent_routines SET version=version+1,status=$2,updated_at=now() WHERE id=$1",
      [id, action === "pause" ? "paused" : "cancelled"],
    );
    await revokeRoutineTurns(client, id, conversationId);
    await conversationEvent(
      client,
      conversationId,
      `routine_control:${id}:${version + 1}`,
      "routine_" + action,
      { routineId: id, version: version + 1 },
    );
    return 200;
  });
}
export async function routineState(id: string, version: number) {
  const row = (
    await authPool.query(
      "SELECT r.*,c.grants_active,p.enabled FROM agent_routines r JOIN agent_conversations c ON c.id=r.conversation_id JOIN agent_profiles p ON p.id=c.agent_id WHERE r.id=$1",
      [id],
    )
  ).rows[0];
  if (!row) return { missing: true };
  if (row.version < version) return { missing: true };
  if (
    row.version !== version ||
    row.status !== "active" ||
    !row.grants_active ||
    !row.enabled
  )
    return null;
  if (new Date(row.expires_at) <= new Date()) {
    await authPool.query(
      "UPDATE agent_routines SET status='expired' WHERE id=$1 AND version=$2 AND status='active'",
      [id, version],
    );
    return null;
  }
  return {
    dueAt: new Date(row.next_due_at).toISOString(),
    conversationId: row.conversation_id,
    ownerId: row.owner_id,
    expiresAt: new Date(row.expires_at).toISOString(),
  };
}
export async function fireRoutine(
  id: string,
  version: number,
  dueAt: string,
  admissionDeadline?: number,
) {
  return transaction(async (client) => {
    // Always lock conversation before routine, matching user edit/cancel paths.
    const identity = (
      await client.query(
        "SELECT conversation_id FROM agent_routines WHERE id=$1",
        [id],
      )
    ).rows[0];
    if (!identity) return null;
    const c = (
      await client.query(
        "SELECT c.*,p.enabled FROM agent_conversations c JOIN agent_profiles p ON p.id=c.agent_id WHERE c.id=$1 FOR UPDATE OF c",
        [identity.conversation_id],
      )
    ).rows[0];
    const r = (
      await client.query(
        "SELECT * FROM agent_routines WHERE id=$1 FOR UPDATE",
        [id],
      )
    ).rows[0];
    const prior = (
      await client.query(
        "SELECT * FROM routine_occurrences WHERE routine_id=$1 AND version=$2 AND due_at=$3",
        [id, version, dueAt],
      )
    ).rows[0];
    if (prior)
      return {
        conversationId: c.id,
        sequence: prior.sequence,
        duplicate: true,
      };
    const now = new Date();
    if (
      !c.grants_active ||
      !c.enabled ||
      r.version !== version ||
      r.status !== "active" ||
      new Date(r.next_due_at).toISOString() !== dueAt ||
      new Date(dueAt) > now ||
      new Date(r.expires_at) <= now ||
      r.run_count >= r.max_runs
    )
      return null;
    const occurrenceId = randomUUID();
    await client.query(
      "INSERT INTO routine_occurrences(id,routine_id,version,due_at,conversation_id) VALUES($1,$2,$3,$4,$5)",
      [occurrenceId, id, version, dueAt, c.id],
    );
    const result = await appendTurn(
      client,
      c.id,
      r.owner_id,
      {
        messageId: occurrenceId,
        text: r.instruction,
        recoveryTest: false,
        executionMode: r.execution_mode,
        dispatchRecoveryTest: false,
        capabilityRequest: r.capability_request ?? undefined,
      },
      { occurrenceId, mode: r.execution_mode },
      admissionDeadline,
    );
    if (result.status !== 201) {
      await client.query(
        "UPDATE routine_occurrences SET status='blocked' WHERE id=$1",
        [occurrenceId],
      );
      await client.query(
        "UPDATE agent_routines SET status='blocked' WHERE id=$1",
        [id],
      );
      await conversationEvent(
        client,
        c.id,
        `routine_blocked:${occurrenceId}`,
        "routine_blocked",
        { routineId: id, status: result.status },
      );
      return null;
    }
    await client.query(
      "UPDATE routine_occurrences SET sequence=$2 WHERE id=$1",
      [occurrenceId, result.sequence],
    );
    const next = nextDue(new Date(dueAt), r.interval_seconds, now);
    await client.query(
      "UPDATE agent_routines SET run_count=run_count+1,next_due_at=COALESCE($2,next_due_at),status=CASE WHEN run_count+1>=max_runs OR $2::timestamptz IS NULL THEN 'completed' WHEN $2::timestamptz>=expires_at THEN 'expired' ELSE 'active' END,updated_at=now() WHERE id=$1",
      [id, next],
    );
    await conversationEvent(
      client,
      c.id,
      `routine_fired:${occurrenceId}`,
      "routine_fired",
      {
        routineId: id,
        version,
        dueAt,
        sequence: result.sequence,
        executionMode: r.execution_mode,
      },
    );
    await assertAdmissionWindow(client, admissionDeadline);
    return {
      conversationId: c.id,
      sequence: result.sequence,
      duplicate: false,
    };
  });
}
export async function assertTurnAuthority(
  client: PoolClient,
  id: string,
  sequence: number,
) {
  await assertEventTurnAuthority(client, id, sequence);
  await assertWorkTurn(client,id,sequence);
  const turn = (
    await client.query(
      "SELECT t.status,t.occurrence_id,r.version,o.version AS occurrence_version,r.status AS routine_status,r.expires_at FROM conversation_turns t LEFT JOIN routine_occurrences o ON o.id=t.occurrence_id LEFT JOIN agent_routines r ON r.id=o.routine_id WHERE t.conversation_id=$1 AND t.sequence=$2",
      [id, sequence],
    )
  ).rows[0];
  if (!turn || turn.status === "cancelled")
    throw new FatalError("TURN_REVOKED");
  // Completed/expired schedules can still finish their last admitted occurrence;
  // pause/cancel/edit revoke it. Expiry is rechecked before every output write.
  if (
    turn.occurrence_id &&
    (turn.version !== turn.occurrence_version ||
      ["paused", "cancelled", "blocked"].includes(turn.routine_status) ||
      new Date(turn.expires_at) <= new Date())
  )
    throw new FatalError("ROUTINE_REVOKED");
}
