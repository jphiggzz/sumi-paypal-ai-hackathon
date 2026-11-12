import { proposeSandboxPayment } from "./sandbox-payment-store";
import { readJobForAgent } from "./job-store";
import { assertWorkTurn, chargeWork } from './work-store';
import { runWorkTool } from './work-tools';
import {workPhaseTools} from './work-policy';
import { pinnedConfig } from "./agent-config";
import { readHistory } from "./history-store";
import { searchSources, assertSourceReferences } from "./source-store";
import type { z } from "zod";
import { historyInput, sourceSearchInput } from "./knowledge-policy";
import { actionInput } from "./action-policy";
import { proposeAction } from "./action-store";
import { createHash } from "node:crypto";
import type { PoolClient } from "pg";
import { transaction } from "./agent-store";
import { capabilitySpecs, type CapabilityId } from "./capability-policy";
import {
  CapabilityError,
  type CapabilityContext,
  type MemoryFact,
} from "./capability-contracts";
import {
  lockConversation,
  readConversationContext,
  storeConversationDraft,
  storeConversationReply,
  conversationEvent,
} from "./conversation-store";
import { assertTurnAuthority } from "./routine-store";
import {
  assertContextReferences,
  mergeResultReferences,
  mergeSourceReferences,
  mergeContextReferences,
} from "./context-authority";
import {
  acquireFixtureCredential,
  authorizeConnectionUse,
} from "./connection-store";
import { readFixtureDocument, listFixtureDocuments } from "./connector-http";
import type { FixtureScenario } from "./connector-fixture";
import { retrieveMemories } from "./memory-store";

import { canonicalJson } from "./canonical-json";
const digest = (value: unknown) =>
  createHash("sha256").update(canonicalJson(value)).digest("hex");
const bytes = (value: unknown) =>
  Buffer.byteLength(JSON.stringify(value), "utf8");
const safeCode = (error: unknown) =>
  error instanceof CapabilityError ? error.code : "TOOL_EXECUTION_FAILED";

async function authority(
  client: PoolClient,
  id: string,
  sequence: number,
  runId: string,
  permission: string,
) {
  const conversation = await lockConversation(client, id, runId, permission);
  await assertTurnAuthority(client, id, sequence);
  await assertContextReferences(client, id, sequence, conversation.owner_id);
  return conversation;
}
/** Registry is server-owned and closed. Unknown tools and invalid schemas never
 * reach an adapter. Provider credentials remain only in this Node step's scope. */
export async function executeCapability(
  id: string,
  sequence: number,
  runId: string,
  name: string,
  rawInput: unknown,
  invocationKey: string,
  scenario: FixtureScenario = "normal",
) {
  if (!Object.prototype.hasOwnProperty.call(capabilitySpecs, name))
    throw new CapabilityError("UNKNOWN_CAPABILITY", 400);
  const toolId = name as CapabilityId,
    spec = capabilitySpecs[toolId];
  const parsed = spec.inputSchema.safeParse(rawInput);
  if (!parsed.success) throw new CapabilityError("INVALID_TOOL_INPUT", 400);
  const input = parsed.data;
  if (
    bytes(input) > spec.maxInputBytes ||
    !invocationKey ||
    invocationKey.length > 200
  )
    throw new CapabilityError("TOOL_INPUT_LIMIT", 400);
  const identity = `${id}:${sequence}:${invocationKey}`;
  const inputDigest = digest({
    toolId,
    version: spec.version,
    input,
    scenario,
  });
  const abort = new AbortController();
  let credential: string | undefined;
  let connection:
    | { id: string; version: number; resourceId?: string }
    | undefined;
  const started = Date.now();
  let claim: { ownerId: string; cached: boolean; result: unknown };
  try {
    claim = await transaction(async (client) => {
      const c = await authority(client, id, sequence, runId, spec.permission);
      const configuration = await pinnedConfig(client, id, sequence);
      if (!configuration.tools.includes(toolId))
        throw new CapabilityError("CONFIG_TOOL_DENIED", 403);
      if (
        toolId !== "read_context" &&
        !(
          await client.query(
            "SELECT 1 FROM conversation_actions WHERE conversation_id=$1 AND sequence=$2 AND kind='read_context'",
            [id, sequence],
          )
        ).rowCount
      )
        throw new CapabilityError("CONTEXT_REQUIRED", 409);
      if (
        toolId === "read_fixture_document" ||
        toolId === "list_fixture_documents"
      ) {
        const p = input as {
          connectionId: string;
          expectedVersion: number;
          resourceId?: string;
        };
        const acquired = await acquireFixtureCredential(
          client,
          c.owner_id,
          p.connectionId,
          {
            expectedVersion: p.expectedVersion,
            requiredScopes: ["documents:read"],
            ...(p.resourceId ? { resourceId: p.resourceId } : {}),
          },
        );
        credential = acquired.token;
        connection = {
          id: acquired.connection.id,
          version: acquired.connection.version,
          ...(p.resourceId ? { resourceId: p.resourceId } : {}),
        };
      }
      const prior = (
        await client.query(
          "SELECT i.*,r.result FROM agent_capability_invocations i LEFT JOIN agent_capability_results r ON r.invocation_id=i.id WHERE i.id=$1",
          [identity],
        )
      ).rows[0];
      if (
        prior &&
        (prior.input_digest !== inputDigest ||
          prior.owner_id !== c.owner_id ||
          prior.tool_id !== toolId)
      )
        throw new CapabilityError("TOOL_INVOCATION_CONFLICT", 409);
      if (prior?.state === "completed")
        return { ownerId: c.owner_id, cached: true, result: prior.result };
      if (prior?.state === "failed")
        throw new CapabilityError(
          prior.error_code ?? "TOOL_EXECUTION_FAILED",
          409,
          prior.retry_after_ms ?? undefined,
        );
      const work=await assertWorkTurn(client,id,sequence);
      if(work) {
        const mode=(await client.query('SELECT execution_mode FROM conversation_turns WHERE conversation_id=$1 AND sequence=$2',[id,sequence])).rows[0]?.execution_mode;
        if(mode==='assistant' && toolId!=='read_context') {
          const done=(await client.query("SELECT tool_id FROM agent_capability_invocations WHERE conversation_id=$1 AND sequence=$2 AND state='completed'",[id,sequence])).rows.map(r=>r.tool_id);
          const job=work.job_id?(await client.query('SELECT state FROM document_jobs WHERE id=$1',[work.job_id])).rows[0]:null;
          if(!workPhaseTools(work,job?.state??null,done).includes(toolId))throw new CapabilityError('WORK_PHASE_TOOL_DENIED',403);
        }
        if(['read_fixture_document','list_fixture_documents','propose_fixture_note','read_history','read_revision','search_memory'].includes(toolId))throw new CapabilityError('WORK_TOOL_NOT_ALLOWED',403);
        if(toolId==='read_job_result' && (input as {jobId:string}).jobId!==work.job_id)throw new CapabilityError('WORK_JOB_NOT_AUTHORIZED',403);
        if(work.internal_kind==='job_result' && ['start_document_job','control_document_job','refresh_connected_source','request_clarification','propose_fixture_note'].includes(toolId))throw new CapabilityError('CONTINUATION_TOOL_DENIED',403);
        await chargeWork(client,work,'tool',1,`tool:${identity}`);
      }
      await client.query(
        `INSERT INTO agent_capability_invocations(id,conversation_id,sequence,owner_id,workflow_run_id,tool_id,tool_version,input_digest,state,connection_id,connection_version)
    VALUES($1,$2,$3,$4,$5,$6,$7,$8,'running',$9,$10)
    ON CONFLICT(id) DO UPDATE SET attempts=agent_capability_invocations.attempts+1,workflow_run_id=$5`,
        [
          identity,
          id,
          sequence,
          c.owner_id,
          runId,
          toolId,
          spec.version,
          inputDigest,
          connection?.id ?? null,
          connection?.version ?? null,
        ],
      );
      return { ownerId: c.owner_id, cached: false, result: undefined };
    });
  } catch (error) {
    // Failed authorization is recorded without credentials or provider execution.
    await transaction(async (client) => {
      const c = (
        await client.query(
          "SELECT owner_id FROM agent_conversations WHERE id=$1 AND worker_run_id=$2",
          [id, runId],
        )
      ).rows[0];
      if (!c) return;
      await client.query(
        "INSERT INTO agent_capability_invocations(id,conversation_id,sequence,owner_id,workflow_run_id,tool_id,tool_version,input_digest,state,error_code,completed_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8,'failed',$9,now()) ON CONFLICT DO NOTHING",
        [
          identity,
          id,
          sequence,
          c.owner_id,
          runId,
          toolId,
          spec.version,
          inputDigest,
          safeCode(error),
        ],
      );
    });
    throw error;
  }
  if (claim.cached) return spec.outputSchema.parse(claim.result);
  const context: CapabilityContext = {
    ownerId: claim.ownerId,
    conversationId: id,
    sequence,
    workflowRunId: runId,
    invocationId: identity,
    signal: abort.signal,
  };
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    // Local write transactions are awaited to their authoritative commit; a
    // Promise.race must never report failure while a non-cancellable write commits.
    const execution = runTool(toolId, context, input, credential, scenario);
    const result =
      spec.effect === "read"
        ? await Promise.race([
            execution,
            new Promise<never>((_, reject) => {
              timer = setTimeout(() => {
                abort.abort();
                reject(new CapabilityError("TOOL_TIMEOUT", 504));
              }, spec.timeoutMs);
            }),
          ])
        : await execution;
    const output = spec.outputSchema.safeParse(result);
    if (!output.success) throw new CapabilityError("INVALID_TOOL_OUTPUT", 502);
    if (bytes(output.data) > spec.maxOutputBytes)
      throw new CapabilityError("TOOL_OUTPUT_LIMIT", 502);
    // Never persist a provider reflecting a credential into a tool response.
    if (credential && JSON.stringify(output.data).includes(credential))
      throw new CapabilityError("CREDENTIAL_IN_OUTPUT", 502);
    await transaction(async (client) => {
      await authority(client, id, sequence, runId, spec.permission);
      if (connection) {
        await authorizeConnectionUse(client, claim.ownerId, connection.id, {
          expectedVersion: connection.version,
          requiredScopes: ["documents:read"],
          ...(connection.resourceId
            ? { resourceId: connection.resourceId }
            : {}),
        });
        await mergeContextReferences(client, id, sequence, [], [connection]);
      }
      if (toolId === "search_sources" || toolId === 'refresh_connected_source')
        await mergeSourceReferences(
          client,
          id,
          sequence,
          claim.ownerId,
          ((
            output.data as { sources: { id: string; version: number }[] }
          ).sources??[]).map((r) => ({ id: r.id, version: r.version })),
        );
      if (
        toolId === "read_history" ||
        toolId === "read_revision" ||
        toolId === "read_job_result"
      ) {
        const bundles =
          (
            output.data as {
              contextReferences?: {
                memoryReferences?: any[];
                connectionReferences?: any[];
                sourceReferences?: any[];
                resultReferences?: any[];
              }[];
            }
          ).contextReferences ?? [];
        for (const bundle of bundles) {
          await mergeResultReferences(client,id,sequence,claim.ownerId,bundle.resultReferences??[]);
          await mergeContextReferences(
            client,
            id,
            sequence,
            bundle.memoryReferences ?? [],
            bundle.connectionReferences ?? [],
          );
          await mergeSourceReferences(
            client,
            id,
            sequence,
            claim.ownerId,
            bundle.sourceReferences ?? [],
          );
        }
        await assertContextReferences(client, id, sequence, claim.ownerId);
      }
      if (toolId === "search_memory")
        await mergeContextReferences(
          client,
          id,
          sequence,
          (output.data as { memories: MemoryFact[] }).memories.map((m) => ({
            id: m.id,
            version: m.version,
          })),
        );
      await client.query(
        "INSERT INTO agent_capability_results(invocation_id,result) VALUES($1,$2) ON CONFLICT DO NOTHING",
        [identity, JSON.stringify(output.data)],
      );
      await client.query(
        "UPDATE agent_capability_invocations SET state='completed',duration_ms=$2,output_bytes=$3,completed_at=now() WHERE id=$1",
        [identity, Date.now() - started, bytes(output.data)],
      );
      await conversationEvent(
        client,
        id,
        `capability:${identity}`,
        "capability_completed",
        {
          sequence,
          tool: toolId,
          version: spec.version,
          fixture: toolId.includes("fixture"),
          ...(connection
            ? {
                connectionId: connection.id,
                connectionVersion: connection.version,
              }
            : {}),
        },
      );
    });
    return output.data;
  } catch (error) {
    const code = safeCode(error);
    await transaction(async (client) => {
      await client.query(
        "UPDATE agent_capability_invocations SET state='failed',error_code=$2,retry_after_ms=$3,duration_ms=$4,completed_at=now() WHERE id=$1 AND state<>'completed'",
        [
          identity,
          code,
          error instanceof CapabilityError
            ? (error.retryAfterMs ?? null)
            : null,
          Date.now() - started,
        ],
      );
      await conversationEvent(
        client,
        id,
        `capability_failed:${identity}`,
        "capability_failed",
        { sequence, tool: toolId, code },
      );
    });
    throw new CapabilityError(
      code,
      error instanceof CapabilityError ? error.status : 502,
      error instanceof CapabilityError ? error.retryAfterMs : undefined,
    );
  } finally {
    if (timer) clearTimeout(timer);
    abort.abort();
    credential = undefined;
  }
}
async function runTool(
  name: CapabilityId,
  c: CapabilityContext,
  input: unknown,
  credential: string | undefined,
  scenario: FixtureScenario,
): Promise<unknown> {
  switch (name) {
    case "propose_sandbox_payment":
      return transaction(async client=>{const work=await assertWorkTurn(client,c.conversationId,c.sequence);if(!work)throw new CapabilityError("WORK_AUTHORIZATION_REQUIRED",403);return work.id;}).then(id=>proposeSandboxPayment(c.ownerId,id));
    case 'list_connected_sources': case 'refresh_connected_source': case 'start_document_job': case 'inspect_document_job': case 'control_document_job': case 'request_clarification':
      return runWorkTool(name,c,input);
    case "read_job_result":
      return transaction((client) =>
        readJobForAgent(
          client,
          c.ownerId,
          c.conversationId,
          (input as { jobId: string }).jobId,
        ),
      );
    case "read_history":
      return transaction((client) =>
        readHistory(
          client,
          c.ownerId,
          c.conversationId,
          c.sequence,
          input as z.infer<typeof historyInput>,
        ),
      );
    case "search_sources":
      return transaction(async client=>{
        const work=await assertWorkTurn(client,c.conversationId,c.sequence),p=input as z.infer<typeof sourceSearchInput>;
        if(!work)return searchSources(client,c.ownerId,p);
        if(p.sourceId && !work.resolved_sources.some((r:any)=>r.id===p.sourceId))throw new CapabilityError('WORK_SOURCE_NOT_ALLOWED',403);
        const refs=p.sourceId?work.resolved_sources.filter((r:any)=>r.id===p.sourceId):work.resolved_sources;
        const sources=[];for(const ref of refs){const found=await searchSources(client,c.ownerId,{...p,sourceId:ref.id});sources.push(...found.sources);}
        return {sources:sources.slice(0,p.limit)};
      });
    case "read_context":
      return readConversationContext(
        c.conversationId,
        c.sequence,
        c.workflowRunId,
      );
    case "read_revision":
      return transaction(async (client) => {
        await authority(
          client,
          c.conversationId,
          c.sequence,
          c.workflowRunId,
          "read_revision",
        );
        const revision = (input as { revision: number }).revision;
        if (revision >= c.sequence)
          throw new CapabilityError("INVALID_REVISION", 400);
        const row = (
          await client.query(
            "SELECT revision,title,markdown,digest,state FROM conversation_revisions WHERE conversation_id=$1 AND revision=$2",
            [c.conversationId, revision],
          )
        ).rows[0];
        if (!row) throw new CapabilityError("REVISION_NOT_FOUND", 404);
        await assertContextReferences(
          client,
          c.conversationId,
          revision,
          c.ownerId,
        );
        const snapshot = (
          await client.query(
            "SELECT context_snapshot FROM conversation_turns WHERE conversation_id=$1 AND sequence=$2",
            [c.conversationId, revision],
          )
        ).rows[0]?.context_snapshot;
        return {
          ...row,
          contextReferences: snapshot
            ? [
                {
                  memoryReferences: snapshot.memoryReferences ?? [],
                  connectionReferences: snapshot.connectionReferences ?? [],
                  sourceReferences: snapshot.sourceReferences ?? [],
                  resultReferences:snapshot.resultReferences??[],
                },
              ]
            : [],
        };
      });
    case "create_draft":
      return storeConversationDraft(
        c.conversationId,
        c.sequence,
        c.workflowRunId,
        input,
      );
    case "reply":
      return storeConversationReply(
        c.conversationId,
        c.sequence,
        c.workflowRunId,
        (input as { text: string }).text,
      );
    case "propose_fixture_note": {
      const hash = createHash("sha256").update(c.invocationId).digest();
      hash[6] = (hash[6] & 15) | 128;
      hash[8] = (hash[8] & 63) | 128;
      const hex = hash.subarray(0, 16).toString("hex");
      const id = `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
      const payload = actionInput.parse({
        ...(input as object),
        id,
        conversationId: c.conversationId,
      });
      const result = await proposeAction(c.ownerId, payload, {
        sequence: c.sequence,
        workflowRunId: c.workflowRunId,
      });
      if (!result.proposal)
        throw new CapabilityError(
          result.error ?? "ACTION_PROPOSAL_FAILED",
          result.status,
        );
      return {
        proposalId: result.proposal.id,
        digest: result.proposal.digest,
        state: result.proposal.state,
        fixture: true,
      };
    }
    case "search_memory":
      return transaction(async (client) => ({
        memories: await retrieveMemories(
          client,
          c.ownerId,
          c.conversationId,
          (input as { query: string }).query,
          (input as { limit: number }).limit,
        ),
      }));
    case "read_fixture_document":
      return readFixtureDocument(
        (input as { resourceId: string }).resourceId,
        credential!,
        { signal: c.signal, scenario },
      );
    case "list_fixture_documents": {
      const listing = await listFixtureDocuments(credential!, {
        cursor: (input as { cursor?: string }).cursor,
        signal: c.signal,
        scenario,
      });
      const p = input as { connectionId: string; expectedVersion: number };
      const grant = await transaction((client) =>
        authorizeConnectionUse(client, c.ownerId, p.connectionId, {
          expectedVersion: p.expectedVersion,
          requiredScopes: ["documents:read"],
        }),
      );
      return {
        ...listing,
        documents: listing.documents.filter((d) =>
          grant.resourceIds.includes(d.id),
        ),
      };
    }
  }
}
