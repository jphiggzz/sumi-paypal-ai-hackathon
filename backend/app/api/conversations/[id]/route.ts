import { changeEventSource } from "../../../../lib/event-store";
import { assertAdmissionWindow } from "../../../../lib/admission-window";
import { CapabilityError } from "../../../../lib/capability-contracts";
import { armRecovery } from "../../../../lib/recovery-workflow";
import { getRun } from "workflow/api";
import { z } from "zod";
import {
  admittedUser,
  canStartTask,
  noStore,
  sameOrigin,
} from "../../../../lib/agent-api";
import { authPool } from "../../../../lib/auth";
import { transaction } from "../../../../lib/agent-store";
import {
  followUpInput,
  revisionDecision,
} from "../../../../lib/conversation-policy";
import {
  conversationEvent,
  decideConversationRevision,
  enqueueFollowUp,
  ownedConversation,
  refreshConversationStatus,
} from "../../../../lib/conversation-store";
import {
  dispatchConversation,
  dispatchRevisionSave,
  recoverConversation,
} from "../../../../lib/conversation-dispatch";

type Context = { params: Promise<{ id: string }> };
async function accessConversation(request: Request, context: Context) {
  const access = await admittedUser(request);
  if (access.error) return { error: access.error };
  const { id } = await context.params;
  if (!z.uuid().safeParse(id).success)
    return { error: new Response(null, { status: 404 }) };
  const conversation = await ownedConversation(id, access.user.id);
  return conversation
    ? { conversation, user: access.user }
    : { error: new Response(null, { status: 404 }) };
}
export async function GET(request: Request, context: Context) {
  const access = await accessConversation(request, context);
  if (access.error) return access.error;
  const id = access.conversation.id;
  // One SQL statement gives the conversation and all related records the same
  // MVCC snapshot, without parallel queries on a transaction-bound pg client.
  const snapshot = (
    await authPool.query(
      `SELECT jsonb_build_object(
    'conversation',to_jsonb(c)||jsonb_build_object('agent_name',p.name),
    'messages',COALESCE((SELECT jsonb_agg(to_jsonb(m)-'conversation_id' ORDER BY m.sequence,m.id) FROM conversation_messages m WHERE m.conversation_id=c.id AND m.sequence>GREATEST(0,c.requested_sequence-100)),'[]'::jsonb),
    'turns',COALESCE((SELECT jsonb_agg(to_jsonb(t)-'conversation_id'-'context_snapshot' ORDER BY t.sequence) FROM conversation_turns t WHERE t.conversation_id=c.id AND t.sequence>GREATEST(0,c.requested_sequence-100)),'[]'::jsonb),
    'revisions',COALESCE((SELECT jsonb_agg(to_jsonb(r)-'conversation_id'-'markdown' ORDER BY r.revision DESC) FROM conversation_revisions r WHERE r.conversation_id=c.id AND r.revision>GREATEST(0,c.requested_sequence-100)),'[]'::jsonb),
    'artifact',(SELECT to_jsonb(r)-'conversation_id' FROM conversation_revisions r WHERE r.conversation_id=c.id ORDER BY r.revision DESC LIMIT 1),
    'approvals',COALESCE((SELECT jsonb_agg(to_jsonb(a)-'conversation_id' ORDER BY a.revision) FROM conversation_approvals a WHERE a.conversation_id=c.id AND a.revision>GREATEST(0,c.requested_sequence-100)),'[]'::jsonb),
    'events',COALESCE((SELECT jsonb_agg(to_jsonb(e)-'conversation_id' ORDER BY e.id) FROM conversation_events e WHERE e.conversation_id=c.id AND e.id IN (SELECT id FROM conversation_events WHERE conversation_id=c.id ORDER BY id DESC LIMIT 200)),'[]'::jsonb),
    'actions',COALESCE((SELECT jsonb_agg(to_jsonb(a)-'conversation_id' ORDER BY a.sequence,a.created_at) FROM conversation_actions a WHERE a.conversation_id=c.id AND a.sequence>GREATEST(0,c.requested_sequence-100)),'[]'::jsonb)
  ) AS snapshot FROM agent_conversations c JOIN agent_profiles p ON p.id=c.agent_id WHERE c.id=$1 AND c.owner_id=$2`,
      [id, access.user.id],
    )
  ).rows[0]?.snapshot;
  return snapshot
    ? Response.json(snapshot, { headers: noStore })
    : new Response(null, { status: 404 });
}

export async function POST(request: Request, context: Context) {
  if (!sameOrigin(request)) return new Response(null, { status: 403 });
  const access = await accessConversation(request, context);
  if (access.error) return access.error;
  const { conversation, user } = access;
  const id = conversation.id;
  const body = await request.json().catch(() => null);
  if (body?.action === "message") {
    if (!canStartTask(request, user))
      return Response.json(
        { error: "A valid preview access code is required." },
        { status: 403 },
      );
    const parsed = followUpInput.safeParse(body);
    if (!parsed.success) return new Response(null, { status: 400 });
    const admissionDeadline = await armRecovery(id, user.id, {
      messageId: parsed.data.messageId,
    });
    const result = await enqueueFollowUp(
      id,
      user.id,
      parsed.data,
      admissionDeadline,
    ).catch((error) => {
      if (error instanceof CapabilityError && error.status === 503)
        return { status: 503, sequence: undefined };
      throw error;
    });
    if (![200, 201].includes(result.status))
      return Response.json(
        {
          error:
            result.status === 429
              ? "Turn limit reached."
              : "Message conflicts with an existing request or the conversation is cancelled.",
        },
        { status: result.status },
      );
    try {
      if (!parsed.data.dispatchRecoveryTest) await dispatchConversation(id);
    } catch {
      return Response.json(
        {
          ...result,
          error: "Message saved. Retry the same request or resume processing.",
        },
        { status: 503 },
      );
    }
    return Response.json(
      { id, sequence: result.sequence },
      { status: result.status, headers: noStore },
    );
  }
  if (body?.action === "decision") {
    const parsed = revisionDecision.safeParse(body);
    if (!parsed.success) return new Response(null, { status: 400 });
    const admissionDeadline =
      parsed.data.decision === "approve"
        ? await armRecovery(id, user.id, { revision: parsed.data.revision })
        : undefined;
    const result = await decideConversationRevision(
      id,
      user.id,
      parsed.data,
      admissionDeadline,
    ).catch((error) => {
      if (error instanceof CapabilityError && error.status === 503)
        return { status: 503, dispatch: false };
      throw error;
    });
    if (result.status !== 200)
      return Response.json(
        { error: "This approval was superseded, expired, or is not ready." },
        { status: result.status },
      );
    try {
      if (result.dispatch && !parsed.data.dispatchRecoveryTest)
        await dispatchRevisionSave(id, parsed.data.revision);
    } catch {
      return Response.json(
        { error: "Decision saved. Retry approval to resume saving." },
        { status: 503 },
      );
    }
    return Response.json({ accepted: true }, { headers: noStore });
  }
  if (body?.action === "process") {
    try {
      const result = await recoverConversation(id, user.id);
      return Response.json(
        { accepted: result.status === 200 },
        { status: result.status },
      );
    } catch {
      return Response.json(
        { error: "Could not confirm worker state. Retry shortly." },
        { status: 503 },
      );
    }
  }
  if (body?.action === "read") {
    await authPool.query(
      "UPDATE agent_conversations SET read_sequence=processed_sequence WHERE id=$1 AND owner_id=$2",
      [id, user.id],
    );
    return Response.json({ accepted: true });
  }
  if (body?.action === "retry") {
    const latest = (
      await authPool.query(
        "SELECT message_id,attempt FROM conversation_turns WHERE conversation_id=$1 AND sequence=$2",
        [id, conversation.requested_sequence],
      )
    ).rows[0];
    const admissionDeadline = latest
      ? await armRecovery(id, user.id, {
          messageId: latest.message_id,
          attempt: latest.attempt + 1,
        })
      : undefined;
    const updated = await transaction(async (client) => {
      const c = (
        await client.query(
          "SELECT * FROM agent_conversations WHERE id=$1 AND owner_id=$2 FOR UPDATE",
          [id, user.id],
        )
      ).rows[0];
      if (!c.grants_active || c.worker_run_id) return false;
      const result = await client.query(
        "UPDATE conversation_turns SET status='queued',attempt=attempt+1,error_code=NULL WHERE conversation_id=$1 AND sequence=$2 AND status='failed' AND attempt<3 RETURNING sequence",
        [id, c.requested_sequence],
      );
      if (result.rowCount)
        await client.query(
          "UPDATE agent_dispatch_outbox SET state='pending' WHERE conversation_id=$1 AND sequence=$2 AND kind='turn'",
          [id, c.requested_sequence],
        );
      await assertAdmissionWindow(client, admissionDeadline);
      await refreshConversationStatus(client, id);
      return !!result.rowCount;
    });
    if (!updated) return new Response(null, { status: 409 });
    try {
      await dispatchConversation(id);
    } catch {
      return new Response(null, { status: 503 });
    }
    return Response.json({ accepted: true });
  }
  if (
    body?.action === "retry_save" &&
    z.number().int().positive().safeParse(body.revision).success
  ) {
    const approval = (
      await authPool.query(
        "SELECT * FROM conversation_approvals WHERE conversation_id=$1 AND revision=$2",
        [id, body.revision],
      )
    ).rows[0];
    if (!approval?.save_run_id) return new Response(null, { status: 409 });
    const state = await getRun(approval.save_run_id).status;
    if (!["failed", "cancelled"].includes(state))
      return new Response(null, { status: 409 });
    const admissionDeadline = await armRecovery(id, user.id, {
      revision: body.revision,
      dispatch: approval.save_dispatches + 1,
    });
    const updated = await transaction(async (client) => {
      const c = (
        await client.query(
          "SELECT * FROM agent_conversations WHERE id=$1 FOR UPDATE",
          [id],
        )
      ).rows[0];
      if (!c.grants_active || c.requested_sequence !== body.revision)
        return false;
      const result = await client.query(
        "UPDATE conversation_approvals SET save_run_id=NULL,save_dispatches=save_dispatches+1 WHERE conversation_id=$1 AND revision=$2 AND save_run_id=$3 AND state='approved' AND save_dispatches<3 RETURNING revision",
        [id, body.revision, approval.save_run_id],
      );
      if (result.rowCount)
        await client.query(
          "UPDATE agent_dispatch_outbox SET state='pending' WHERE conversation_id=$1 AND sequence=$2 AND kind='save'",
          [id, body.revision],
        );
      await assertAdmissionWindow(client, admissionDeadline);
      return !!result.rowCount;
    });
    if (!updated) return new Response(null, { status: 409 });
    await dispatchRevisionSave(id, body.revision);
    return Response.json({ accepted: true });
  }
  if (body?.action === "cancel") {
    await transaction(async (client) => {
      await client.query(
        "SELECT id FROM agent_conversations WHERE id=$1 FOR UPDATE",
        [id],
      );
      await client.query(
        "UPDATE agent_routines SET status='cancelled',version=version+1 WHERE conversation_id=$1 AND status IN ('active','paused')",
        [id],
      );

      const sources = await client.query(
        "SELECT id,version FROM agent_event_sources WHERE conversation_id=$1 AND owner_id=$2 AND status IN ('active','paused') ORDER BY id",
        [id, user.id],
      );
      for (const source of sources.rows)
        await changeEventSource(client, user.id, source.id, {
          action: "cancel",
          expectedVersion: source.version,
        });

      await client.query(
        "UPDATE agent_conversations SET grants_active=false,status='cancelled',worker_run_id=NULL,updated_at=now() WHERE id=$1",
        [id],
      );
      await client.query(
        "UPDATE conversation_turns SET status='cancelled' WHERE conversation_id=$1 AND status IN ('queued','running')",
        [id],
      );
      await client.query(
        "UPDATE conversation_approvals SET state='superseded' WHERE conversation_id=$1 AND state='pending'",
        [id],
      );
      await conversationEvent(
        client,
        id,
        "cancelled",
        "conversation_cancelled",
      );
    });
    if (conversation.worker_run_id)
      try {
        await getRun(conversation.worker_run_id).cancel();
      } catch {
        /* SQL revocation remains authoritative. */
      }
    return Response.json({ accepted: true });
  }
  return new Response(null, { status: 400 });
}
