import { start } from "workflow/api";
import { setTimeout as delay } from "node:timers/promises";
import type { PoolClient } from "pg";
import { transaction } from "./agent-store";
import {
  assertWorkTurn,
  askWorkQuestion,
  chargeWork,
  workUuid,
} from "./work-store";
import { lockConversation, storeConversationReply } from "./conversation-store";
import {
  CapabilityError,
  type CapabilityContext,
} from "./capability-contracts";
import {
  listConnectionsWithClient,
  authorizeConnectionUse,
} from "./connection-store";
import {
  assertSourceReferences,
  admitSourceRefresh,
  refreshSource,
} from "./source-store";
import { admitJob, inspectJob, controlJob } from "./job-store";
import { documentJobWorkflow, workJobRecoveryWorkflow } from "./job-workflow";
import { jobInput } from "./document-policy";

async function locked(c: PoolClient, context: CapabilityContext) {
  await lockConversation(
    c,
    context.conversationId,
    context.workflowRunId,
    "read_context",
  );
  const w = await assertWorkTurn(c, context.conversationId, context.sequence);
  if (!w) throw new CapabilityError("WORK_AUTHORIZATION_REQUIRED", 403);
  return w;
}
async function resolve(
  c: PoolClient,
  w: any,
  index: number,
  row: { id: string; version: number },
) {
  await assertSourceReferences(c, w.owner_id, [row]);
  const refs = [
    ...w.resolved_sources.filter((r: any) => r.index !== index),
    { index, id: row.id, version: row.version },
  ];
  await c.query("UPDATE agent_work SET resolved_sources=$2 WHERE id=$1", [
    w.id,
    JSON.stringify(refs),
  ]);
  return {
    state: "ready",
    sourceIndex: index,
    sources: [{ id: row.id, version: row.version }],
    remainingSourceIndexes: w.request.sources
      .map((_: unknown, i: number) => i)
      .filter((i: number) => !refs.some((r: any) => r.index === i)),
    citation: `[source:${row.id}@${row.version}]`,
  };
}
export async function runWorkTool(
  name: string,
  context: CapabilityContext,
  input: any,
): Promise<any> {
  if (name === "list_connected_sources")
    return transaction(async (c) => {
      await lockConversation(
        c,
        context.conversationId,
        context.workflowRunId,
        "read_context",
      );
      const w = await assertWorkTurn(
        c,
        context.conversationId,
        context.sequence,
      );
      return {
        connections: (await listConnectionsWithClient(c, context.ownerId))
          .filter(
            (v) =>
              v.status === "connected" &&
              (!w ||
                w.request.sources.some(
                  (s: any) =>
                    s.kind === "connection" && s.connectionId === v.id,
                )),
          )
          .map((v) => ({
            id: v.id,
            provider: v.provider,
            version: v.version,
            resourceIds: w
              ? v.resourceIds.filter((r) =>
                  w.request.sources.some(
                    (s: any) =>
                      s.kind === "connection" &&
                      s.connectionId === v.id &&
                      s.resourceId === r,
                  ),
                )
              : v.resourceIds,
            expiresAt: v.expiresAt,
          })),
        workSources: w?.request.sources ?? null,
      };
    });
  if (name === "request_clarification")
    return transaction(async (c) => {
      await locked(c, context);
      return askWorkQuestion(
        c,
        context.conversationId,
        context.sequence,
        input.question,
      );
    });
  if (name === "refresh_connected_source")
    return refreshWorkSource(context, input.sourceIndex);
  if (name === "inspect_document_job")
    return transaction(async (c) => {
      const w = await locked(c, context);
      if (!w.job_id) return { state: w.state, jobId: null };
      const r = await inspectJob(c, context.ownerId, w.job_id);
      return {
        jobId: w.job_id,
        state: r.job.state,
        version: r.job.version,
        artifact: r.artifact,
        blockedReason: r.blockedReason,
        stages: r.stages,
      };
    });
  if (name === "start_document_job") {
    const prepared = await transaction(async (c) => {
      const w = await locked(c, context);
      if (w.job_id) return { existing: w.job_id };
      if (w.internal_kind === "job_result" || w.state !== "active")
        throw new CapabilityError("WORK_NOT_ACTIVE", 409);
      if (!w.request.fields)
        throw new CapabilityError("WORK_NEEDS_FIELDS", 409);
      if (w.resolved_sources.length !== w.request.sources.length)
        throw new CapabilityError("WORK_SOURCES_NOT_READY", 409);
      await assertSourceReferences(c, w.owner_id, w.resolved_sources);
      return {
        workId: w.id,
        input: jobInput.parse({
          id: workUuid(`job:${w.id}`),
          conversationId: context.conversationId,
          sources: w.resolved_sources.map((r: any) => ({
            id: r.id,
            version: r.version,
          })),
          fields: w.request.fields,
          extractionMode: w.request.extractionMode,
          recoveryTest: w.request.recoveryTest ?? false,
          holdAfterStage: w.request.holdAfterStage ?? 0,
        }),
      };
    });
    if (prepared.existing) {
      await storeConversationReply(
        context.conversationId,
        context.sequence,
        context.workflowRunId,
        `Started document comparison job ${prepared.existing}. Its result will follow automatically.`,
      );
      return { jobId: prepared.existing, state: "admitted", replayed: true };
    }
    const deadline = Date.now() + 30000,
      run = await start(documentJobWorkflow, [
        context.ownerId,
        prepared.input!.id,
        1,
      ]);
    const recovery = await start(workJobRecoveryWorkflow, [
      context.ownerId,
      prepared.input!.id,
    ]);
    const row = await admitJob(
      context.ownerId,
      prepared.input!,
      run.runId,
      deadline,
      {
        workId: prepared.workId!,
        sequence: context.sequence,
        workerRunId: context.workflowRunId,
        recoveryRunId: recovery.runId,
      },
    );
    await storeConversationReply(
      context.conversationId,
      context.sequence,
      context.workflowRunId,
      `Started document comparison job ${row.id}. Its result will follow automatically.`,
    );
    return { jobId: row.id, state: row.state, version: row.version };
  }
  if (name === "control_document_job") {
    const w = await transaction((c) => locked(c, context));
    if (!w.job_id) throw new CapabilityError("JOB_NOT_FOUND", 404);
    let resumption;
    if (input.action === "resume") {
      const deadline = Date.now() + 30000,
        run = await start(documentJobWorkflow, [
          context.ownerId,
          w.job_id,
          input.expectedVersion + 1,
        ]);
      const recovery = await start(workJobRecoveryWorkflow, [
        context.ownerId,
        w.job_id,
      ]);
      resumption = {
        runId: run.runId,
        deadline,
        recoveryRunId: recovery.runId,
      };
    }
    return controlJob(context.ownerId, w.job_id, input, resumption, {
      conversationId: context.conversationId,
      sequence: context.sequence,
      workerRunId: context.workflowRunId,
    });
  }
  throw new CapabilityError("UNKNOWN_CAPABILITY", 400);
}
async function refreshWorkSource(context: CapabilityContext, index: number) {
  const prepared = await transaction(async (c) => {
    const w = await locked(c, context);
    if (
      w.internal_kind === "job_result" ||
      !["active", "waiting_source"].includes(w.state)
    )
      throw new CapabilityError("WORK_NOT_ACTIVE", 409);
    const s = w.request.sources[index];
    if (!s) throw new CapabilityError("WORK_SOURCE_NOT_ALLOWED", 403);
    if (s.kind === "source")
      return {
        ready: await resolve(c, w, index, { id: s.id, version: s.version }),
      };
    await authorizeConnectionUse(c, w.owner_id, s.connectionId, {
      expectedVersion: s.expectedVersion,
      resourceId: s.resourceId,
      requiredScopes: ["documents:read"],
    });
    await c.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", [
      `source:${w.owner_id}:${s.connectionId}:${s.expectedVersion}:${s.resourceId}`,
    ]);
    const fresh = (
      await c.query(
        "SELECT id,version FROM source_records WHERE owner_id=$1 AND connection_id=$2 AND connection_version=$3 AND resource_id=$4 AND expires_at>now() AND deleted_at IS NULL",
        [w.owner_id, s.connectionId, s.expectedVersion, s.resourceId],
      )
    ).rows[0];
    if (fresh)
      return {
        ready: { ...(await resolve(c, w, index, fresh)), cached: true },
      };
    const lease = (
      await c.query(
        "SELECT * FROM agent_source_leases WHERE owner_id=$1 AND connection_id=$2 AND connection_version=$3 AND resource_id=$4 AND expires_at>now()",
        [w.owner_id, s.connectionId, s.expectedVersion, s.resourceId],
      )
    ).rows[0];
    const refreshId = workUuid(`source:${context.invocationId}`);
    if (lease && lease.refresh_id !== refreshId)
      return { pending: lease.refresh_id, workId: w.id };
    await chargeWork(c, w, "provider", 12, `refresh:${refreshId}:calls`);
    await chargeWork(c, w, "bytes", 196608, `refresh:${refreshId}:bytes`);
    await c.query(
      `INSERT INTO agent_source_leases VALUES($1,$2,$3,$4,$5,now()+interval '30 seconds') ON CONFLICT(owner_id,connection_id,connection_version,resource_id) DO UPDATE SET refresh_id=$5,expires_at=EXCLUDED.expires_at`,
      [w.owner_id, s.connectionId, s.expectedVersion, s.resourceId, refreshId],
    );
    return {
      workId: w.id,
      input: {
        id: refreshId,
        connectionId: s.connectionId,
        expectedVersion: s.expectedVersion,
        resourceId: s.resourceId,
        fixtureRevision: 1,
      },
    };
  });
  if (prepared.ready) return prepared.ready;
  if (prepared.pending) {
    const { scheduleSourceWait } = await import("./work-dispatch");
    await scheduleSourceWait(context, prepared.workId!, prepared.pending);
    return {
      state: "pending",
      refreshId: prepared.pending,
      automaticFollowUp: true,
    };
  }
  let admitted = false;
  try {
    const input = prepared.input!;
    const admission = await admitSourceRefresh(
      context.ownerId,
      input,
      context.workflowRunId,
      Date.now() + 30000,
    );
    admitted = true;
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        await refreshSource(context.ownerId, input, admission.workflow_run_id);
        break;
      } catch (error) {
        if (
          !(error instanceof CapabilityError) ||
          !["PROVIDER_UNAVAILABLE", "PROVIDER_RATE_LIMITED"].includes(
            error.code,
          ) ||
          attempt === 2 ||
          (error.retryAfterMs ?? 0) > 1000
        )
          throw error;
        await delay(Math.max(1000, error.retryAfterMs ?? 0));
      }
    }
    return transaction(async (c) => {
      const w = await locked(c, context);
      const row = (
        await c.query(
          "SELECT id,version FROM source_records WHERE owner_id=$1 AND connection_id=$2 AND connection_version=$3 AND resource_id=$4 AND expires_at>now() AND deleted_at IS NULL",
          [
            context.ownerId,
            input.connectionId,
            input.expectedVersion,
            input.resourceId,
          ],
        )
      ).rows[0];
      if (!row) throw new CapabilityError("SOURCE_NOT_READY", 409);
      await c.query("UPDATE agent_work SET state='active' WHERE id=$1", [w.id]);
      return resolve(c, w, index, row);
    });
  } catch (error) {
    if (!(error instanceof CapabilityError)) throw error;
    const state = [
      "PROVIDER_REAUTH_REQUIRED",
      "consent_required",
      "PROVIDER_RESOURCE_DENIED",
    ].includes(error.code)
      ? "needs_reconnect"
      : /BUDGET/.test(error.code)
        ? "budget_exhausted"
        : "failed";
    await transaction(async (c) => {
      const w = await locked(c, context);
      await c.query(
        "UPDATE agent_work SET state=$2,error_code=$3 WHERE id=$1",
        [w.id, state, error.code],
      );
      if (!admitted)
        await c.query(
          "DELETE FROM agent_source_leases WHERE owner_id=$1 AND refresh_id=$2",
          [context.ownerId, prepared.input!.id],
        );
    });
    return { state, error: error.code, sourceIndex: index };
  }
}
