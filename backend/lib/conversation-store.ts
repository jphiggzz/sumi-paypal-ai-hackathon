import {appendSourceCitations} from "./source-citations";
import { createWorkForTurn, workContext, assertWorkTurn, chargeWork } from './work-store';
import {workInput} from './work-policy';
import { currentConfig, pinnedConfig } from "./agent-config";
import { boundedHistory } from "./knowledge-policy";
import { getEventContext } from "./event-authority";
import { assertAdmissionWindow } from "./admission-window";
import { assertMemoryVersions } from "./memory-store";
import { retrieveMemories } from "./memory-store";
import { listConnectionsWithClient } from "./connection-store";
import { assertContextReferences } from "./context-authority";
import { canonicalJson } from "./canonical-json";
import { capabilityCheck } from "./capability-policy";
import { assertTurnAuthority } from "./routine-store";
import { randomUUID } from "node:crypto";
import { FatalError } from "workflow";
import type { PoolClient } from "pg";
import { authPool } from "./auth";
import { transaction } from "./agent-store";
import { artifactDigest } from "./agent-hash";
import { draftInput, sourceStats } from "./agent-policy";
import {
  conversationPermissions,
  currentApproval,
  type followUpInput,
} from "./conversation-policy";
import type { z } from "zod";

export class ConversationLimitError extends Error {}

export async function conversationEvent(
  client: PoolClient,
  id: string,
  key: string,
  kind: string,
  detail = {},
) {
  return client.query(
    "INSERT INTO conversation_events(conversation_id,event_key,kind,detail) VALUES($1,$2,$3,$4) ON CONFLICT DO NOTHING RETURNING id",
    [id, key, kind, JSON.stringify(detail)],
  );
}
export async function conversationMessage(
  client: PoolClient,
  id: string,
  sequence: number,
  key: string,
  role: string,
  content: string,
) {
  await client.query(
    "INSERT INTO conversation_messages(conversation_id,sequence,message_key,role,content) VALUES($1,$2,$3,$4,$5) ON CONFLICT DO NOTHING",
    [id, sequence, key, role, content],
  );
}
export async function ownedConversation(id: string, owner: string) {
  return (
    await authPool.query(
      "SELECT c.*,p.name AS agent_name FROM agent_conversations c JOIN agent_profiles p ON p.id=c.agent_id WHERE c.id=$1 AND c.owner_id=$2",
      [id, owner],
    )
  ).rows[0];
}
export async function lockConversation(
  client: PoolClient,
  id: string,
  runId?: string,
  permission?: string,
) {
  const row = (
    await client.query(
      "SELECT c.*,p.permissions,p.enabled FROM agent_conversations c JOIN agent_profiles p ON p.id=c.agent_id WHERE c.id=$1 FOR UPDATE OF c FOR SHARE OF p",
      [id],
    )
  ).rows[0];
  if (!row || !row.grants_active || !row.enabled)
    throw new FatalError("Conversation permission revoked");
  if (runId && row.worker_run_id !== runId)
    throw new FatalError("Conversation worker superseded");
  if (permission && !row.permissions.includes(permission))
    throw new FatalError("Tool permission denied");
  return row;
}
export async function refreshConversationStatus(
  client: PoolClient,
  id: string,
) {
  await client.query(
    `UPDATE agent_conversations c SET updated_at=now(),status=CASE
    WHEN NOT grants_active THEN 'cancelled'
    WHEN EXISTS(SELECT 1 FROM conversation_turns t WHERE t.conversation_id=c.id AND t.status='running') THEN 'running'
    WHEN EXISTS(SELECT 1 FROM conversation_turns t WHERE t.conversation_id=c.id AND t.status='queued') THEN 'queued'
    WHEN EXISTS(SELECT 1 FROM conversation_approvals a WHERE a.conversation_id=c.id AND a.revision=c.requested_sequence AND a.state='approved' AND NOT EXISTS(SELECT 1 FROM conversation_revisions r WHERE r.conversation_id=c.id AND r.revision=a.revision AND r.state='saved')) THEN 'saving'
    WHEN EXISTS(SELECT 1 FROM conversation_approvals a WHERE a.conversation_id=c.id AND a.revision=c.requested_sequence AND a.state='pending' AND a.expires_at>now()) THEN 'awaiting_approval'
    WHEN EXISTS(SELECT 1 FROM conversation_turns t WHERE t.conversation_id=c.id AND t.sequence=c.requested_sequence AND t.status='failed') THEN 'failed'
    ELSE 'idle' END WHERE id=$1`,
    [id],
  );
}
export async function createConversation(
  owner: string,
  input: {
    id: string;
    source: string;
    messageId: string;
    text: string;
    recoveryTest: boolean;
    executionMode?: "assistant" | "checkpoint" | "capability_check";
    capabilityRequest?: z.infer<typeof capabilityCheck>;
    dispatchRecoveryTest?: boolean;
    work?: z.infer<typeof import('./work-policy').workInput>;
  },
  admissionDeadline?: number,
) {
  return transaction(async (client) => {
    await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", [
      input.id,
    ]);
    const existing = (
      await client.query(
        "SELECT * FROM agent_conversations WHERE id=$1 FOR UPDATE",
        [input.id],
      )
    ).rows[0];
    if (existing) {
      if (existing.owner_id !== owner || existing.source !== input.source)
        return { status: 409 };
      const first = (
        await client.query(
          "SELECT * FROM conversation_turns WHERE conversation_id=$1 AND sequence=1",
          [input.id],
        )
      ).rows[0];
      const existingWork=first?.work_id?(await client.query('SELECT initial_request FROM agent_work WHERE id=$1',[first.work_id])).rows[0]?.initial_request:null;
      return first?.message_id === input.messageId &&
        canonicalJson(existingWork?workInput.parse(existingWork):null)===canonicalJson(input.work??null) &&
        first.text === input.text &&
        first.recovery_test === input.recoveryTest &&
        first.execution_mode === (input.executionMode ?? "assistant") &&
        canonicalJson(first.capability_request ?? null) ===
          canonicalJson(input.capabilityRequest ?? null)
        ? { status: 200, id: input.id, sequence: 1 }
        : { status: 409 };
    }
    const agent = (
      await client.query(
        "INSERT INTO agent_profiles(id,owner_id,permissions) VALUES($1,$2,$3) ON CONFLICT(owner_id) DO UPDATE SET owner_id=EXCLUDED.owner_id RETURNING id",
        [randomUUID(), owner, JSON.stringify(conversationPermissions)],
      )
    ).rows[0];
    await client.query(
      "INSERT INTO agent_conversations(id,owner_id,agent_id,title,source) VALUES($1,$2,$3,$4,$5)",
      [input.id, owner, agent.id, input.text.slice(0, 100), input.source],
    );
    const result = await appendTurn(
      client,
      input.id,
      owner,
      {
        ...input,
        executionMode: input.executionMode ?? "assistant",
        dispatchRecoveryTest: input.dispatchRecoveryTest ?? false,
      },
      undefined,
      admissionDeadline,
    );
    if (result.status !== 201)
      throw new ConversationLimitError("Conversation quota exceeded");
    return { ...result, id: input.id };
  });
}
export async function appendTurn(
  client: PoolClient,
  id: string,
  owner: string,
  input: z.infer<typeof followUpInput>,
  trigger?: { occurrenceId?: string; eventId?: string; mode: string; workId?: string; internalKind?: string; jobVersion?:number },
  admissionDeadline?: number,
) {
  await assertAdmissionWindow(client, admissionDeadline);
  const conversation = (
    await client.query(
      "SELECT * FROM agent_conversations WHERE id=$1 AND owner_id=$2 FOR UPDATE",
      [id, owner],
    )
  ).rows[0];
  if (!conversation) return { status: 404 };
  const prior = (
    await client.query(
      "SELECT * FROM conversation_turns WHERE conversation_id=$1 AND message_id=$2",
      [id, input.messageId],
    )
  ).rows[0];
  if (prior)
    return prior.text === input.text &&
      prior.recovery_test === input.recoveryTest &&
      prior.execution_mode === (trigger?.mode ?? input.executionMode) &&
      canonicalJson(prior.capability_request ?? null) ===
        canonicalJson(input.capabilityRequest ?? null) &&
      (trigger?.workId ? prior.work_id===trigger.workId : canonicalJson(prior.work_id?workInput.parse((await client.query('SELECT initial_request FROM agent_work WHERE id=$1',[prior.work_id])).rows[0]?.initial_request):null)===canonicalJson(input.work??null))
      ? { status: 200, sequence: prior.sequence }
      : { status: 409 };
  if (!conversation.grants_active) return { status: 409 };
  if (conversation.requested_sequence >= 10000) return { status: 429 };
  const quota = await client.query(
    "INSERT INTO agent_daily_quota(day,owner_id,tasks) VALUES(current_date,$1,1) ON CONFLICT(day,owner_id) DO UPDATE SET tasks=agent_daily_quota.tasks+1 WHERE agent_daily_quota.tasks<20 RETURNING tasks",
    [owner],
  );
  if (!quota.rowCount) return { status: 429 };
  const config = await currentConfig(client, conversation.agent_id, owner);
  const sequence = conversation.requested_sequence + 1;
  if(trigger?.workId) {
    const { assertWork }=await import('./work-store');
    const work=await assertWork(client,trigger.workId,owner);
    if(work.conversation_id!==id)throw new FatalError('Work conversation mismatch');
    await chargeWork(client,work,'dispatch',1,`turn:${input.messageId}`);
  } else {
    await client.query("UPDATE agent_work SET state='cancelled',updated_at=now() WHERE conversation_id=$1 AND state<>'cancelled'",[id]);
    await client.query('UPDATE agent_conversations SET human_sequence=$2,approval_sequence=NULL WHERE id=$1',[id,sequence]);
  }
  await client.query(
    "INSERT INTO conversation_turns(conversation_id,sequence,message_id,text,model,recovery_test) VALUES($1,$2,$3,$4,$5,$6)",
    [
      id,
      sequence,
      input.messageId,
      input.text,
      config.model,
      input.recoveryTest,
    ],
  );
  await client.query(
    "UPDATE conversation_turns SET config_version=$3 WHERE conversation_id=$1 AND sequence=$2",
    [id, sequence, config.version],
  );
  if(trigger?.workId) await client.query('UPDATE conversation_turns SET work_id=$3,internal_kind=$4,work_job_version=$5 WHERE conversation_id=$1 AND sequence=$2',[id,sequence,trigger.workId,trigger.internalKind,trigger.jobVersion??null]);
  else if(input.work) {
    if(config.model!=='amazon/nova-micro')throw new FatalError('Work model must be Nova Micro');
    await createWorkForTurn(client,owner,id,sequence,input.messageId,input.work);
  }
  await client.query(
    "UPDATE conversation_turns SET occurrence_id=$3,execution_mode=$4,capability_request=$5,event_id=$6 WHERE conversation_id=$1 AND sequence=$2",
    [
      id,
      sequence,
      trigger?.occurrenceId ?? null,
      trigger?.mode ?? input.executionMode,
      input.capabilityRequest ? JSON.stringify(input.capabilityRequest) : null,
      trigger?.eventId ?? null,
    ],
  );
  await client.query(
    "INSERT INTO agent_dispatch_outbox(id,conversation_id,sequence,kind) VALUES($1,$2,$3,'turn') ON CONFLICT DO NOTHING",
    [`turn:${id}:${sequence}`, id, sequence],
  );
  const invalidated = trigger?.workId ? {rowCount:0,rows:[]} : await client.query(
    "UPDATE conversation_approvals a SET state='superseded' WHERE a.conversation_id=$1 AND a.state IN ('pending','approved') AND NOT EXISTS(SELECT 1 FROM conversation_revisions r WHERE r.conversation_id=a.conversation_id AND r.revision=a.revision AND r.state='saved') RETURNING revision",
    [id],
  );
  await client.query(
    "UPDATE agent_conversations SET requested_sequence=$2,status=CASE WHEN worker_run_id IS NULL THEN 'queued' ELSE 'running' END,updated_at=now() WHERE id=$1",
    [id, sequence],
  );
  await conversationMessage(
    client,
    id,
    sequence,
    `user:${sequence}`,
    trigger?.internalKind==='clarification_answer' ? 'user' : trigger ? "system" : "user",
    input.text,
  );
  await conversationEvent(client, id, `queued:${sequence}`, "message_queued", {
    sequence,
    messageId: input.messageId,
  });
  if (invalidated.rowCount)
    await conversationEvent(
      client,
      id,
      `superseded:${sequence}`,
      "approvals_superseded",
      {
        bySequence: sequence,
        revisions: invalidated.rows.map((row) => row.revision),
      },
    );
  await assertAdmissionWindow(client, admissionDeadline);
  return { status: 201, sequence };
}
export async function enqueueFollowUp(
  id: string,
  owner: string,
  input: z.infer<typeof followUpInput>,
  admissionDeadline?: number,
) {
  return transaction((client) =>
    appendTurn(client, id, owner, input, undefined, admissionDeadline),
  );
}
export async function appendEventTurn(
  client: import("pg").PoolClient,
  id: string,
  owner: string,
  input: z.infer<typeof followUpInput>,
  eventId: string,
  admissionDeadline?: number,
) {
  return appendTurn(
    client,
    id,
    owner,
    input,
    { eventId, mode: input.executionMode },
    admissionDeadline,
  );
}
export async function claimConversation(id: string, runId: string) {
  return transaction(async (client) => {
    const conversation = await lockConversation(client, id);
    if (conversation.worker_run_id && conversation.worker_run_id !== runId)
      return false;
    const pending = await client.query(
      "SELECT 1 FROM conversation_turns WHERE conversation_id=$1 AND status IN ('queued','running')",
      [id],
    );
    if (!pending.rowCount) return false;
    await client.query(
      "UPDATE agent_conversations SET worker_run_id=$2,updated_at=now() WHERE id=$1",
      [id, runId],
    );
    return true;
  });
}
export async function nextConversationTurn(id: string, runId: string) {
  return transaction(async (client) => {
    await lockConversation(client, id, runId);
    const turn = (
      await client.query(
        "SELECT * FROM conversation_turns WHERE conversation_id=$1 AND status='queued' ORDER BY sequence LIMIT 1 FOR UPDATE",
        [id],
      )
    ).rows[0];
    if (!turn) {
      await client.query(
        "UPDATE agent_conversations SET worker_run_id=NULL WHERE id=$1 AND worker_run_id=$2",
        [id, runId],
      );
      await refreshConversationStatus(client, id);
      return null;
    }
    await client.query(
      "UPDATE conversation_turns SET status='running' WHERE conversation_id=$1 AND sequence=$2",
      [id, turn.sequence],
    );
    await refreshConversationStatus(client, id);
    await conversationEvent(
      client,
      id,
      `started:${turn.sequence}:${turn.attempt}`,
      "turn_started",
      { sequence: turn.sequence, attempt: turn.attempt, model: turn.model },
    );
    return {
      configuration: await pinnedConfig(client, id, turn.sequence),
      sequence: turn.sequence,
      text: turn.text,
      model: turn.model,
      executionMode: turn.execution_mode,
      capabilityRequest: turn.capability_request,
      internalKind: turn.internal_kind,
    };
  });
}
export async function readConversationContext(
  id: string,
  sequence: number,
  runId: string,
) {
  return transaction(async (client) => {
    const conversation = await lockConversation(
      client,
      id,
      runId,
      "read_context",
    );
    await assertTurnAuthority(client, id, sequence);
    const turn = (
      await client.query(
        "SELECT context_snapshot,text FROM conversation_turns WHERE conversation_id=$1 AND sequence=$2",
        [id, sequence],
      )
    ).rows[0];
    if (turn.context_snapshot) {
      await assertContextReferences(
        client,
        id,
        sequence,
        conversation.owner_id,
      );
      return turn.context_snapshot;
    }
    const configuration = await pinnedConfig(client, id, sequence);
    const users = (
      await client.query(
        "SELECT sequence,role,content FROM conversation_messages WHERE conversation_id=$1 AND sequence<=$2 AND role IN ('user','system') ORDER BY sequence DESC,id DESC LIMIT 40",
        [id, sequence],
      )
    ).rows.reverse();
    const replies = (
      await client.query(
        "SELECT sequence,role,content FROM conversation_messages WHERE conversation_id=$1 AND sequence<$2 AND role='assistant' ORDER BY sequence DESC,id DESC LIMIT 6",
        [id, sequence],
      )
    ).rows.reverse();
    for (const row of replies) {
      const old = (
        await client.query(
          "SELECT context_snapshot FROM conversation_turns WHERE conversation_id=$1 AND sequence=$2",
          [id, row.sequence],
        )
      ).rows[0]?.context_snapshot;
      if (
        old &&
        (old.sourceReferences?.length ||
          old.memoryReferences?.length ||
          old.connectionReferences?.length || old.resultReferences?.length)
      )
        row.content =
          "[Referenced historical answer omitted from automatic context. Use read_history to retrieve it under current authority.]";
    }
    const artifact =
      (
        await client.query(
          "SELECT revision,title,markdown,digest,state FROM conversation_revisions WHERE conversation_id=$1 AND revision<$2 ORDER BY revision DESC LIMIT 1",
          [id, sequence],
        )
      ).rows[0] ?? null;
    if (artifact) {
      const old = (
        await client.query(
          "SELECT context_snapshot FROM conversation_turns WHERE conversation_id=$1 AND sequence=$2",
          [id, artifact.revision],
        )
      ).rows[0]?.context_snapshot;
      if (
        old &&
        (old.sourceReferences?.length ||
          old.memoryReferences?.length ||
          old.connectionReferences?.length || old.resultReferences?.length)
      )
        artifact.markdown =
          "[Referenced historical artifact omitted from automatic context. Use read_revision to retrieve it under current authority.]";
    }
    const revisions = (
      await client.query(
        "SELECT revision,title,digest,state FROM conversation_revisions WHERE conversation_id=$1 AND revision<$2 ORDER BY revision DESC LIMIT 20",
        [id, sequence],
      )
    ).rows;
    const memories = await retrieveMemories(
      client,
      conversation.owner_id,
      id,
      turn.text,
      5,
    );
    await assertMemoryVersions(
      client,
      conversation.owner_id,
      id,
      memories.map((m) => ({ id: m.id, version: m.version })),
    );
    const connections = await listConnectionsWithClient(
      client,
      conversation.owner_id,
    );
    const fixtureTargets = (
      await client.query(
        "SELECT t.connection_id AS \"connectionId\",t.resource_id AS \"resourceId\",t.version FROM fixture_note_targets t JOIN agent_connections c ON c.id=t.connection_id WHERE t.owner_id=$1 AND c.owner_id=$1 AND c.status='connected' AND c.provider='fixture' AND t.resource_id=ANY(c.resource_ids) AND 'notes:write'=ANY(c.scopes) ORDER BY t.connection_id,t.resource_id LIMIT 40",
        [conversation.owner_id],
      )
    ).rows;
    const actionProposals = (
      await client.query(
        "SELECT id,digest,state FROM agent_action_proposals WHERE owner_id=$1 AND conversation_id=$2 ORDER BY created_at DESC LIMIT 5",
        [conversation.owner_id, id],
      )
    ).rows;
    const snapshot = {
      configuration: {
        version: configuration.version,
        contextBytes: configuration.context_bytes,
      },
      history: {
        totalThroughSequence: sequence,
        omittedOlderMessages:
          users.length >= 40 ||
          boundedHistory(users, configuration.context_bytes).length <
            users.length,
        tool: "read_history",
      },
      fixtureTargets,
      actionProposals,
      work: await workContext(client,id,sequence),
      event: await getEventContext(client, id, sequence),
      memories,
      memoryReferences: memories.map((m) => ({ id: m.id, version: m.version })),
      connectionReferences: [],
      connections,
      source: conversation.source,
      sourceStats: sourceStats(conversation.source),
      userInstructions: boundedHistory(users, configuration.context_bytes),
      recentReplies: replies,
      latestArtifact: artifact,
      revisions,
    };
    await client.query(
      "UPDATE conversation_turns SET context_snapshot=$3 WHERE conversation_id=$1 AND sequence=$2",
      [id, sequence, JSON.stringify(snapshot)],
    );
    await client.query(
      "INSERT INTO conversation_actions(conversation_id,sequence,kind,result) VALUES($1,$2,'read_context',$3) ON CONFLICT DO NOTHING",
      [
        id,
        sequence,
        JSON.stringify({
          sourceStats: snapshot.sourceStats,
          throughSequence: sequence,
          userMessages: users.length,
        }),
      ],
    );
    await conversationEvent(
      client,
      id,
      `context:${sequence}`,
      "context_loaded",
      { sequence, throughSequence: sequence, userMessages: users.length },
    );
    return snapshot;
  });
}
export async function storeConversationDraft(
  id: string,
  sequence: number,
  runId: string,
  input: unknown,
) {
  const draft = draftInput.parse(input);
  return transaction(async (client) => {
    await client.query("SET LOCAL statement_timeout='5s'");
    await client.query("SET LOCAL lock_timeout='5s'");
    const conversation = await lockConversation(
      client,
      id,
      runId,
      "create_draft",
    );
    await assertTurnAuthority(client, id, sequence);
    await assertContextReferences(client, id, sequence, conversation.owner_id);
    const read = await client.query(
      "SELECT 1 FROM conversation_actions WHERE conversation_id=$1 AND sequence=$2 AND kind='read_context'",
      [id, sequence],
    );
    if (!read.rowCount)
      throw new FatalError("Read the conversation context first");
    const existing = (
      await client.query(
        "SELECT title,digest,revision FROM conversation_revisions WHERE conversation_id=$1 AND revision=$2",
        [id, sequence],
      )
    ).rows[0];
    if (existing) return existing;
    const reply = await client.query(
      "SELECT 1 FROM conversation_messages WHERE conversation_id=$1 AND message_key=$2",
      [id, `reply:${sequence}`],
    );
    if (reply.rowCount) throw new FatalError("This turn already has a reply");
    const sourceRefs=(await client.query('SELECT context_snapshot FROM conversation_turns WHERE conversation_id=$1 AND sequence=$2',[id,sequence])).rows[0]?.context_snapshot?.sourceReferences??[];
    draft.markdown=appendSourceCitations(draft.markdown,sourceRefs,20000);
    const digest = artifactDigest(draft.title, draft.markdown);
    await client.query(
      "INSERT INTO conversation_revisions(conversation_id,revision,title,markdown,digest) VALUES($1,$2,$3,$4,$5)",
      [id, sequence, draft.title, draft.markdown, digest],
    );
    const state =
      conversation.requested_sequence === sequence ? "pending" : "superseded";
    if(state==='pending') {
      await client.query("UPDATE conversation_approvals SET state='superseded' WHERE conversation_id=$1 AND revision<>$2 AND state IN ('pending','approved') AND NOT EXISTS(SELECT 1 FROM conversation_revisions r WHERE r.conversation_id=$1 AND r.revision=conversation_approvals.revision AND r.state='saved')",[id,sequence]);
      await client.query('UPDATE agent_conversations SET approval_sequence=$2 WHERE id=$1',[id,sequence]);
    }
    await client.query(
      "INSERT INTO conversation_approvals(conversation_id,revision,digest,state) VALUES($1,$2,$3,$4)",
      [id, sequence, digest, state],
    );
    await client.query(
      "UPDATE agent_conversations SET latest_revision=$2,updated_at=now() WHERE id=$1",
      [id, sequence],
    );
    await conversationMessage(
      client,
      id,
      sequence,
      `reply:${sequence}`,
      "assistant",
      `Created ${draft.title} (version ${sequence}).`,
    );
    await conversationEvent(
      client,
      id,
      `draft:${sequence}`,
      "revision_created",
      { revision: sequence, digest, approval: state },
    );
    return { revision: sequence, title: draft.title, digest };
  });
}
export async function storeConversationReply(
  id: string,
  sequence: number,
  runId: string,
  text: string,
) {
  if (!text.trim() || text.length > 4000) throw new FatalError("Invalid reply");
  return transaction(async (client) => {
    await client.query("SET LOCAL statement_timeout='5s'");
    await client.query("SET LOCAL lock_timeout='5s'");
    const conversation = await lockConversation(client, id, runId, "reply");
    await assertTurnAuthority(client, id, sequence);
    await assertContextReferences(client, id, sequence, conversation.owner_id);
    const sourceRefs=(await client.query('SELECT context_snapshot FROM conversation_turns WHERE conversation_id=$1 AND sequence=$2',[id,sequence])).rows[0]?.context_snapshot?.sourceReferences??[];
    text=appendSourceCitations(text,sourceRefs,4000);

    const read = await client.query(
      "SELECT 1 FROM conversation_actions WHERE conversation_id=$1 AND sequence=$2 AND kind='read_context'",
      [id, sequence],
    );
    if (!read.rowCount)
      throw new FatalError("Read the conversation context first");
    await conversationMessage(
      client,
      id,
      sequence,
      `reply:${sequence}`,
      "assistant",
      text,
    );
    await conversationEvent(client, id, `reply:${sequence}`, "reply_created", {
      sequence,
    });
    return { replied: true };
  });
}
export async function finishConversationTurn(
  id: string,
  sequence: number,
  runId: string,
  failed = false,
  errorCode = "TURN_FAILED",
) {
  await transaction(async (client) => {
    await lockConversation(client, id, runId);
    const state = (
      await client.query(
        "SELECT status FROM conversation_turns WHERE conversation_id=$1 AND sequence=$2",
        [id, sequence],
      )
    ).rows[0];
    if (state?.status === "cancelled") return;
    const reply = await client.query(
      "SELECT 1 FROM conversation_messages WHERE conversation_id=$1 AND message_key=$2",
      [id, `reply:${sequence}`],
    );
    const success = !failed && !!reply.rowCount;
    const workTurn=(await client.query('SELECT work_id,internal_kind,work_job_version FROM conversation_turns WHERE conversation_id=$1 AND sequence=$2',[id,sequence])).rows[0];
    let outcome=failed?(/BUDGET/.test(errorCode)?'budget_exhausted':'failed'):'completed',workError=failed?errorCode:null;
    if(!failed&&workTurn?.internal_kind==='job_result') {
      const job=(await client.query('SELECT j.state,j.error_code FROM document_jobs j JOIN agent_work w ON w.job_id=j.id WHERE w.id=$1',[workTurn.work_id])).rows[0];
      if(job?.state==='failed'){outcome=/BUDGET/.test(job.error_code??'')?'budget_exhausted':'failed';workError=job.error_code;}
      if(job?.state==='cancelled')outcome='cancelled';
    }
    if(workTurn?.work_id && (failed || workTurn.internal_kind==='job_result')) await client.query("UPDATE agent_work w SET state=$2,error_code=$3,updated_at=now() WHERE id=$1 AND state<>'cancelled' AND ($4::integer IS NULL OR EXISTS(SELECT 1 FROM document_jobs j WHERE j.id=w.job_id AND j.version=$4))",[workTurn.work_id,outcome,workError,workTurn.work_job_version]);
    await client.query(
      "UPDATE conversation_turns SET status=$3,error_code=$4 WHERE conversation_id=$1 AND sequence=$2",
      [
        id,
        sequence,
        success ? "completed" : "failed",
        success ? null : errorCode,
      ],
    );
    await client.query(
      "UPDATE agent_conversations SET processed_sequence=GREATEST(processed_sequence,$2),updated_at=now() WHERE id=$1",
      [id, sequence],
    );
    await conversationEvent(
      client,
      id,
      `finished:${sequence}`,
      success ? "turn_completed" : "turn_failed",
      { sequence },
    );
    await client.query(
      "UPDATE routine_occurrences SET status=$3 WHERE conversation_id=$1 AND sequence=$2",
      [id, sequence, success ? "completed" : "failed"],
    );
    await refreshConversationStatus(client, id);
  });
}
export async function decideConversationRevision(
  id: string,
  owner: string,
  input: { revision: number; digest: string; decision: string },
  admissionDeadline?: number,
) {
  return transaction(async (client) => {
    await assertAdmissionWindow(client, admissionDeadline);
    const conversation = (
      await client.query(
        "SELECT * FROM agent_conversations WHERE id=$1 AND owner_id=$2 FOR UPDATE",
        [id, owner],
      )
    ).rows[0];
    if (!conversation) return { status: 404 };
    if (!currentApproval(conversation, input.revision)) return { status: 409 };
    try {
      await assertTurnAuthority(client, id, input.revision);
      await assertContextReferences(client, id, input.revision, owner);
    } catch {
      await client.query(
        "UPDATE conversation_approvals SET state='superseded' WHERE conversation_id=$1 AND revision=$2 AND state IN ('pending','approved') AND NOT EXISTS(SELECT 1 FROM conversation_revisions WHERE conversation_id=$1 AND revision=$2 AND state='saved')",
        [id, input.revision],
      );
      await refreshConversationStatus(client, id);
      return { status: 409 };
    }
    const turn = (
      await client.query(
        "SELECT status FROM conversation_turns WHERE conversation_id=$1 AND sequence=$2",
        [id, input.revision],
      )
    ).rows[0];
    if (turn?.status !== "completed") return { status: 409 };
    const approval = (
      await client.query(
        "SELECT * FROM conversation_approvals WHERE conversation_id=$1 AND revision=$2",
        [id, input.revision],
      )
    ).rows[0];
    if (
      !approval ||
      approval.digest !== input.digest ||
      new Date(approval.expires_at) <= new Date()
    )
      return { status: 409 };
    const requested = input.decision === "approve" ? "approved" : "rejected";
    if (approval.state !== "pending")
      return {
        status: approval.state === requested ? 200 : 409,
        dispatch: approval.state === "approved" && !approval.save_run_id,
      };
    await client.query(
      "UPDATE conversation_approvals SET state=$3,decided_by=$4,decided_at=now(),save_dispatches=CASE WHEN $3='approved' THEN 1 ELSE 0 END WHERE conversation_id=$1 AND revision=$2",
      [id, input.revision, requested, owner],
    );
    await conversationEvent(
      client,
      id,
      `decision:${input.revision}`,
      "approval_decided",
      { revision: input.revision, decision: input.decision },
    );
    if (input.decision === "approve")
      await client.query(
        "INSERT INTO agent_dispatch_outbox(id,conversation_id,sequence,kind) VALUES($1,$2,$3,'save') ON CONFLICT DO NOTHING",
        [`save:${id}:${input.revision}`, id, input.revision],
      );
    await refreshConversationStatus(client, id);
    await assertAdmissionWindow(client, admissionDeadline);
    return { status: 200, dispatch: input.decision === "approve" };
  });
}
