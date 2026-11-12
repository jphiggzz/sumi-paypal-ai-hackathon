import { z } from "zod";
import { authPool } from "../../../lib/auth";
import { CapabilityError } from "../../../lib/capability-contracts";
import { start } from "workflow/api";
import {
  admittedUser,
  canStartTask,
  sameOrigin,
  noStore,
} from "../../../lib/agent-api";
import { boundedJson, apiFailure } from "../../../lib/foundation-api";
import { decidePayment } from "../../../lib/sandbox-payment-store";
import {
  sandboxPaymentWorkflow,
  sandboxPaymentRecoveryWorkflow,
} from "../../../lib/sandbox-payment-workflow";
const input = z
  .object({
    id: z.uuid(),
    digest: z.string().regex(/^[a-f0-9]{64}$/),
    decision: z.enum(["approve", "reject", "reconcile"]),
  })
  .strict();
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
    const current = (
      await authPool.query(
        "SELECT id,digest FROM sandbox_payment_proposals WHERE id=$1 AND owner_id=$2",
        [v.id, a.user.id],
      )
    ).rows[0];
    if (!current) throw new CapabilityError("PAYMENT_NOT_FOUND", 404);
    if (current.digest !== v.digest)
      throw new CapabilityError("PAYMENT_DIGEST_CONFLICT", 409);
    // Reject has no background effect. Prearm before approval to close admission/dispatch crash gap.
    const deadline = Date.now() + 30000,
      run =
        v.decision !== "reject"
          ? await start(sandboxPaymentWorkflow, [a.user.id, v.id])
          : null;
    const recovery =
      v.decision !== "reject"
        ? await start(sandboxPaymentRecoveryWorkflow, [a.user.id, v.id])
        : null;
    return Response.json(
      await decidePayment(
        a.user.id,
        v.id,
        v.digest,
        v.decision,
        run?.runId,
        deadline,
        recovery?.runId,
      ),
      { headers: noStore },
    );
  } catch (e) {
    return apiFailure(e);
  }
}

export async function GET(request: Request) {
  const a = await admittedUser(request);
  if (a.error) return a.error;
  const id = z
    .uuid()
    .safeParse(new URL(request.url).searchParams.get("workId"));
  if (!id.success) return new Response(null, { status: 400 });
  return Response.json(
    {
      payments: (
        await authPool.query(
          "SELECT id,state,payload,digest,item_id,error_code,result_id,result_revision FROM sandbox_payment_proposals WHERE work_id=$1 AND owner_id=$2",
          [id.data, a.user.id],
        )
      ).rows,
    },
    { headers: noStore },
  );
}
