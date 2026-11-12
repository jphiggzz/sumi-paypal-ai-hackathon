import { z } from "zod";
import {
  admittedUser,
  canStartTask,
  noStore,
  sameOrigin,
} from "../../../../../lib/agent-api";
import { authPool } from "../../../../../lib/auth";
import { ownedConversation } from "../../../../../lib/conversation-store";
import { routineInput } from "../../../../../lib/routine-policy";
import { controlRoutine, putRoutine } from "../../../../../lib/routine-store";
import { armRoutine } from "../../../../../lib/routine-workflow";
type Context = { params: Promise<{ id: string }> };
async function access(request: Request, context: Context) {
  const a = await admittedUser(request);
  if (a.error) return { error: a.error };
  const { id } = await context.params;
  if (
    !z.uuid().safeParse(id).success ||
    !(await ownedConversation(id, a.user.id))
  )
    return { error: new Response(null, { status: 404 }) };
  return { user: a.user, id, error: undefined };
}
export async function GET(request: Request, context: Context) {
  const a = await access(request, context);
  if (a.error) return a.error;
  const routines = (
    await authPool.query(
      "SELECT * FROM agent_routines WHERE conversation_id=$1 AND owner_id=$2 ORDER BY created_at DESC",
      [a.id, a.user.id],
    )
  ).rows;
  const occurrences = (
    await authPool.query(
      "SELECT o.*,t.status AS turn_status,t.error_code FROM routine_occurrences o JOIN agent_routines r ON r.id=o.routine_id LEFT JOIN conversation_turns t ON t.conversation_id=o.conversation_id AND t.sequence=o.sequence WHERE o.conversation_id=$1 AND r.owner_id=$2 ORDER BY o.created_at DESC LIMIT 100",
      [a.id, a.user.id],
    )
  ).rows;
  return Response.json({ routines, occurrences }, { headers: noStore });
}
export async function POST(request: Request, context: Context) {
  if (!sameOrigin(request)) return new Response(null, { status: 403 });
  const a = await access(request, context);
  if (a.error) return a.error;
  const body = await request.json().catch(() => null);
  if (body?.action === "pause" || body?.action === "cancel") {
    if (
      !z.uuid().safeParse(body.id).success ||
      !z.number().int().positive().safeParse(body.version).success
    )
      return new Response(null, { status: 400 });
    const status = await controlRoutine(
      a.user.id,
      a.id,
      body.id,
      body.version,
      body.action,
    );
    return Response.json({ accepted: status === 200 }, { status });
  }
  if (!canStartTask(request, a.user))
    return new Response(null, { status: 403 });
  if (body?.action !== "create" && body?.action !== "edit")
    return new Response(null, { status: 400 });
  const p = routineInput.safeParse(body);
  if (!p.success)
    return Response.json(
      { error: "Invalid routine, run cap, timezone or expiry." },
      { status: 400 },
    );
  const version =
    body.action === "edit"
      ? z.number().int().positive().safeParse(body.version)
      : null;
  if (version && !version.success) return new Response(null, { status: 400 });
  const expected = version?.success ? version.data : undefined;
  // A durable timer exists before its configuration commits. Rejected or
  // interrupted admissions leave a bounded, harmless watcher with no authority.
  const admissionDeadline = await armRoutine(
    p.data.id,
    expected === undefined ? 1 : expected + 1,
  );
  const result = await putRoutine(
    a.user.id,
    a.id,
    p.data,
    expected,
    admissionDeadline,
  );
  return Response.json(result, { status: result.status, headers: noStore });
}
