import { z } from "zod";
import {
  admittedUser,
  canStartTask,
  sameOrigin,
  noStore,
} from "../../../lib/agent-api";
import { boundedJson, apiFailure } from "../../../lib/foundation-api";
import { transaction } from "../../../lib/agent-store";
import { listConnectionsWithClient } from "../../../lib/connection-store";
import { acceptWorkAnswer, assertWork } from "../../../lib/work-store";
import { workAnswer } from "../../../lib/work-policy";
import { armRecovery } from "../../../lib/recovery-workflow";
import { appendTurn, lockConversation } from "../../../lib/conversation-store";
import { dispatchConversation } from "../../../lib/conversation-dispatch";
import { CapabilityError } from "../../../lib/capability-contracts";
import { resultEvent } from "../../../lib/result-store";
const input = z.discriminatedUnion("action", [
  workAnswer.extend({ workId: z.uuid() }).strict(),
  z.object({ action: z.literal("cancel"), workId: z.uuid() }).strict(),
  z
    .object({
      action: z.literal("resume"),
      workId: z.uuid(),
      requestId: z.uuid(),
      expectedVersion: z.number().int().positive(),
    })
    .strict(),
]);
export async function GET(request: Request) {
  const a = await admittedUser(request);
  if (a.error) return a.error;
  try {
    const url = new URL(request.url),
      id = url.searchParams.get("workId");
    if (id && !z.uuid().safeParse(id).success)
      return new Response(null, { status: 400 });
    return Response.json(
      await transaction(async (c) => {
        if (url.searchParams.has("sources")) {
          const sources = (
            await c.query(
              "SELECT id,version,title,kind,expires_at FROM source_records WHERE owner_id=$1 AND deleted_at IS NULL AND expires_at>now() ORDER BY fetched_at DESC LIMIT 40",
              [a.user.id],
            )
          ).rows;
          const connections = (
            await listConnectionsWithClient(c, a.user.id)
          ).filter(
            (v) =>
              v.status === "connected" &&
              v.scopes.includes("documents:read") &&
              v.expiresAt &&
              new Date(v.expiresAt) > new Date(),
          );
          return { sources, connections };
        }
        const work = (
          await c.query(
            "SELECT * FROM agent_work WHERE owner_id=$1 AND ($2::uuid IS NULL OR id=$2) ORDER BY created_at DESC LIMIT 40",
            [a.user.id, id],
          )
        ).rows;
        for (const w of work) {
          w.question = w.question_id
            ? (
                await c.query(
                  "SELECT id,version,question,schema,state,expires_at,answer FROM agent_work_questions WHERE id=$1",
                  [w.question_id],
                )
              ).rows[0]
            : null;
          w.continuations = (
            await c.query(
              "SELECT job_id,job_version,sequence FROM agent_work_continuations WHERE work_id=$1",
              [w.id],
            )
          ).rows;
        }
        return { work };
      }),
      { headers: noStore },
    );
  } catch (e) {
    return apiFailure(e);
  }
}
export async function POST(request: Request) {
  if (!sameOrigin(request)) return new Response(null, { status: 403 });
  const a = await admittedUser(request);
  if (a.error) return a.error;
  if (!canStartTask(request, a.user))
    return new Response(null, { status: 403 });
  try {
    const p = input.safeParse(await boundedJson(request));
    if (!p.success) return new Response(null, { status: 400 });
    const v = p.data;
    const raw = await transaction(
      async (c) =>
        (
          await c.query(
            "SELECT conversation_id FROM agent_work WHERE id=$1 AND owner_id=$2",
            [v.workId, a.user.id],
          )
        ).rows[0],
    );
    if (!raw) throw new CapabilityError("WORK_NOT_FOUND", 404);
    if (v.action === "cancel") {
      await transaction(async (c) => {
        await c.query(
          "SELECT id FROM agent_conversations WHERE id=$1 FOR UPDATE",
          [raw.conversation_id],
        );
        await c.query(
          "UPDATE agent_work SET state='cancelled',updated_at=now() WHERE id=$1 AND owner_id=$2",
          [v.workId, a.user.id],
        );
        await c.query(
          "UPDATE conversation_turns SET status='cancelled' WHERE work_id=$1 AND status IN ('queued','running')",
          [v.workId],
        );
        await c.query(
          "UPDATE document_jobs SET state='cancelled',version=version+1 WHERE work_id=$1 AND state IN ('queued','running','paused','failed')",
          [v.workId],
        );
        await resultEvent(
          c,
          a.user.id,
          `work:${v.workId}:cancelled`,
          "work.cancelled",
          { workId: v.workId },
          raw.conversation_id,
        );
      });
      return Response.json({ state: "cancelled" }, { headers: noStore });
    }
    const messageId = v.action === "answer" ? v.answerId : v.requestId;
    const deadline = await armRecovery(raw.conversation_id, a.user.id, {
      messageId,
    });
    const result = await transaction(async (c) => {
      if (v.action === "answer")
        return acceptWorkAnswer(c, a.user.id, v.workId, v, deadline);
      await lockConversation(c, raw.conversation_id);
      const w = await assertWork(c, v.workId, a.user.id);
      if (
        w.input_version !== v.expectedVersion ||
        !["failed", "needs_reconnect", "budget_exhausted", "active"].includes(
          w.state,
        )
      )
        throw new CapabilityError("WORK_RESUME_CONFLICT", 409);
      if (
        w.model_calls >= w.request.maxModelCalls ||
        w.tool_calls >= w.request.maxTools
      )
        throw new CapabilityError("WORK_BUDGET_EXHAUSTED", 429);
      await c.query("UPDATE agent_work SET state='active' WHERE id=$1", [w.id]);
      const r = await appendTurn(
        c,
        w.conversation_id,
        w.owner_id,
        {
          messageId: v.requestId,
          text: "Owner requests resuming this same bounded work with the same remaining allowance. Do not create additional jobs.",
          recoveryTest: false,
          executionMode: "assistant",
          dispatchRecoveryTest: false,
        },
        { workId: w.id, internalKind: "owner_resume", mode: "assistant" },
        deadline,
      );
      if (![200, 201].includes(r.status))
        throw new CapabilityError("WORK_RESUME_FAILED", r.status);
      return r;
    });
    await dispatchConversation(raw.conversation_id);
    return Response.json(result, { headers: noStore });
  } catch (e) {
    return apiFailure(e);
  }
}
