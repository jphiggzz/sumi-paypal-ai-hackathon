import { assertSourceReferences } from "./source-store";
import { createHash, randomUUID } from "node:crypto";
import { transaction } from "./agent-store";
import { assertWork, chargeWork, workUuid } from "./work-store";
import { CapabilityError } from "./capability-contracts";
import { canonicalDigestInput, usdCents } from "./evidence-policy";
import { resultEvent } from "./result-store";
import { authPool } from "./auth";
import { submit, status } from "./paypal";
import type { Offer } from "./policy";
export function paymentDigest(payload: unknown) {
  return createHash("sha256")
    .update(canonicalDigestInput(payload))
    .digest("hex");
}
export function payeeBinding(alias: "A" | "B") {
  const email = process.env["PAYPAL_SANDBOX_CREATOR_" + alias]?.trim();
  if (
    !email ||
    !/^sb-[^@\s]+@(?:personal|business)\.example\.com$/i.test(email)
  )
    throw new CapabilityError("SANDBOX_PAYEE_UNAVAILABLE", 503);
  return createHash("sha256").update(email.toLowerCase()).digest("hex");
}
export async function paymentAuthority(c: any, p: any) {
  const w = await assertWork(c, p.work_id, p.owner_id);
  const conv = (
    await c.query(
      "SELECT p.permissions FROM agent_conversations c JOIN agent_profiles p ON p.id=c.agent_id WHERE c.id=$1 AND c.owner_id=$2 FOR SHARE OF p",
      [w.conversation_id, p.owner_id],
    )
  ).rows[0];
  if (
    !conv?.permissions.includes("read_context") ||
    !conv.permissions.includes("create_draft")
  )
    throw new CapabilityError("PAYMENT_PERMISSION_DENIED", 403);
  const r = (
    await c.query(
      "SELECT * FROM structured_results WHERE id=$1 AND owner_id=$2",
      [p.result_id, p.owner_id],
    )
  ).rows[0];
  if (!r || r.revision !== p.result_revision || r.work_id !== w.id)
    throw new CapabilityError("RESULT_REVISION_CHANGED", 409);
  await assertSourceReferences(c, p.owner_id, [
    { id: r.source_id, version: r.source_version },
  ]);
  const job = (
    await c.query("SELECT state FROM document_jobs WHERE id=$1", [r.job_id])
  ).rows[0];
  if (job?.state !== "completed")
    throw new CapabilityError("PAYMENT_JOB_NOT_COMPLETED", 409);
  if (
    new Date(p.expires_at) <= new Date() ||
    payeeBinding(p.payload.payee) !== p.payload.payeeBinding
  )
    throw new CapabilityError("PAYMENT_AUTHORITY_CHANGED", 409);
  if (paymentDigest(p.payload) !== p.digest)
    throw new CapabilityError("PAYMENT_DIGEST_CONFLICT", 409);
  const field = r.facts.find(
    (f: any) => f.field === w.request.payment?.amountField,
  );
  const cents = field?.status === "found" ? usdCents(field.value) : null;
  if (!cents || cents !== p.payload.cents || cents > w.request.payment.maxCents)
    throw new CapabilityError("PAYMENT_AMOUNT_INVALID", 409);
  return w;
}
export async function proposeSandboxPayment(owner: string, workId: string) {
  return transaction(async (c) => {
    const raw = (
      await c.query(
        "SELECT conversation_id FROM agent_work WHERE id=$1 AND owner_id=$2",
        [workId, owner],
      )
    ).rows[0];
    if (!raw) throw new CapabilityError("WORK_NOT_FOUND", 404);
    await c.query("SELECT id FROM agent_conversations WHERE id=$1 FOR UPDATE", [
      raw.conversation_id,
    ]);
    const w = await assertWork(c, workId, owner);
    const scope = w.request.payment;
    if (!scope || !w.job_id)
      throw new CapabilityError("PAYMENT_SCOPE_REQUIRED", 403);
    const existing = (
      await c.query(
        "SELECT * FROM sandbox_payment_proposals WHERE work_id=$1",
        [workId],
      )
    ).rows[0];
    if (existing)
      return {
        id: existing.id,
        state: existing.state,
        digest: existing.digest,
        replayed: true,
      };
    const r = (
      await c.query(
        "SELECT r.* FROM structured_results r JOIN document_jobs j ON j.id=r.job_id WHERE r.work_id=$1 AND r.source_index=$2 AND j.state='completed'",
        [w.id, scope.sourceIndex],
      )
    ).rows[0];
    if (!r) throw new CapabilityError("PAYMENT_RESULT_NOT_READY", 409);
    await assertSourceReferences(c, owner, [
      { id: r.source_id, version: r.source_version },
    ]);
    const f = r.facts.find((f: any) => f.field === scope.amountField),
      cents = f?.status === "found" ? usdCents(f.value) : null;
    if (!cents || cents > scope.maxCents)
      return {
        state: "blocked",
        reason: "PAYMENT_AMOUNT_INVALID",
        providerCalled: false,
      };
    const id = workUuid("payment:" + w.id),
      payload = {
        kind: "paypal.sandbox.payout",
        workId: w.id,
        resultId: r.id,
        resultRevision: r.revision,
        sourceId: r.source_id,
        sourceVersion: r.source_version,
        amountField: scope.amountField,
        cents,
        currency: "USD",
        payee: scope.payee,
        payeeBinding: payeeBinding(scope.payee),
        maxCents: scope.maxCents,
      };
    const digest = paymentDigest(payload);
    await c.query(
      "INSERT INTO sandbox_payment_proposals(id,owner_id,work_id,result_id,result_revision,payload,digest,expires_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8)",
      [
        id,
        owner,
        w.id,
        r.id,
        r.revision,
        JSON.stringify(payload),
        digest,
        w.expires_at,
      ],
    );
    await resultEvent(
      c,
      owner,
      "payment:" + id + ":proposed",
      "payment.proposed",
      {
        paymentId: id,
        digest,
        cents,
        currency: "USD",
        payee: scope.payee,
        sandbox: true,
      },
      w.conversation_id,
      w.job_id,
    );
    return {
      id,
      state: "pending",
      digest,
      cents,
      currency: "USD",
      payee: scope.payee,
      sandbox: true,
    };
  });
}
export async function decidePayment(
  owner: string,
  id: string,
  digest: string,
  decision: "approve" | "reject" | "reconcile",
  runId?: string,
  deadline?: number,
  recoveryRunId?: string,
) {
  return transaction(async (c) => {
    const raw = (
      await c.query(
        "SELECT p.*,w.conversation_id FROM sandbox_payment_proposals p JOIN agent_work w ON w.id=p.work_id WHERE p.id=$1 AND p.owner_id=$2",
        [id, owner],
      )
    ).rows[0];
    if (!raw) throw new CapabilityError("PAYMENT_NOT_FOUND", 404);
    await c.query("SELECT id FROM agent_conversations WHERE id=$1 FOR UPDATE", [
      raw.conversation_id,
    ]);
    const p = (
      await c.query(
        "SELECT * FROM sandbox_payment_proposals WHERE id=$1 FOR UPDATE",
        [id],
      )
    ).rows[0];
    if (p.digest !== digest)
      throw new CapabilityError("PAYMENT_DIGEST_CONFLICT", 409);
    if (decision === "reconcile") {
      if (
        ![
          "approved",
          "submitting",
          "pending_provider",
          "needs_review",
        ].includes(p.state)
      )
        throw new CapabilityError("PAYMENT_STATE_CONFLICT", 409);
      if (!runId || !deadline || Date.now() > deadline)
        throw new CapabilityError("PAYMENT_ADMISSION_EXPIRED", 409);
      if (p.lease_until && new Date(p.lease_until) > new Date())
        throw new CapabilityError("PAYMENT_IN_FLIGHT", 409);
      if (!p.batch_id && p.submission_started_at)
        throw new CapabilityError(
          "PAYMENT_MANUAL_RECONCILIATION_REQUIRED",
          409,
        );
      if (!p.batch_id) await paymentAuthority(c, p);
      if (p.check_limit >= 48)
        throw new CapabilityError("PAYMENT_RECONCILIATION_LIMIT", 429);
      await c.query(
        "UPDATE sandbox_payment_proposals SET state=$2,workflow_run_id=$3,recovery_run_id=$4,check_limit=check_limit+16 WHERE id=$1",
        [
          id,
          p.batch_id ? "pending_provider" : "approved",
          runId,
          recoveryRunId ?? null,
        ],
      );
      return {
        id,
        state: p.batch_id ? "pending_provider" : "approved",
        replayed: false,
      };
    }
    if (
      decision === "approve" &&
      [
        "approved",
        "submitting",
        "pending_provider",
        "succeeded",
        "needs_review",
      ].includes(p.state)
    )
      return { id, state: p.state, replayed: true };
    if (p.state !== "pending")
      throw new CapabilityError("PAYMENT_STATE_CONFLICT", 409);
    if (decision === "reject") {
      await c.query(
        "UPDATE sandbox_payment_proposals SET state='rejected' WHERE id=$1",
        [id],
      );
      return { id, state: "rejected" };
    }
    const w = await paymentAuthority(c, p);
    if (!runId || !deadline || Date.now() > deadline)
      throw new CapabilityError("PAYMENT_ADMISSION_EXPIRED", 409);
    await c.query(
      "SELECT pg_advisory_xact_lock(hashtext('sandbox-global-money-limit'))",
    );
    const usage = +(
      await c.query(
        "SELECT COALESCE(sum(cents),0)::int AS cents FROM sandbox_payment_reservations WHERE created_at >= (now() AT TIME ZONE 'UTC')::date AND state<>'released'",
      )
    ).rows[0].cents;
    if (usage + p.payload.cents > 10000)
      throw new CapabilityError("SANDBOX_DAILY_MONEY_LIMIT", 429);
    await chargeWork(c, w, "dispatch", 1, "payment:" + id);
    await c.query(
      "INSERT INTO sandbox_payment_reservations(payment_id,owner_id,work_id,cents,state) VALUES($1,$2,$3,$4,'reserved')",
      [id, owner, w.id, p.payload.cents],
    );
    await c.query(
      "UPDATE sandbox_payment_proposals SET state='approved',workflow_run_id=$2,recovery_run_id=$3 WHERE id=$1",
      [id, runId, recoveryRunId ?? null],
    );
    await c.query(
      "INSERT INTO sandbox_payment_events(payment_id,event_key,detail) VALUES($1,'approved',$2)",
      [id, JSON.stringify({ digest, ownerApproved: true })],
    );
    return { id, state: "approved", replayed: false };
  });
}
/** Provider network work is outside transactions. Unknown outcomes keep funds reserved. */
export async function advancePayment(
  owner: string,
  id: string,
  runId: string,
  provider: { submit: typeof submit; status: typeof status } = {
    submit,
    status,
  },
) {
  const claim = randomUUID();
  const p = await transaction(async (c) => {
    const raw = (
      await c.query(
        "SELECT p.*,w.conversation_id FROM sandbox_payment_proposals p JOIN agent_work w ON w.id=p.work_id WHERE p.id=$1 AND p.owner_id=$2",
        [id, owner],
      )
    ).rows[0];
    if (!raw) return { mode: "missing" };
    await c.query("SELECT id FROM agent_conversations WHERE id=$1 FOR UPDATE", [
      raw.conversation_id,
    ]);
    const p = (
      await c.query(
        "SELECT * FROM sandbox_payment_proposals WHERE id=$1 FOR UPDATE",
        [id],
      )
    ).rows[0];
    if (p.state === "pending") return { mode: "missing" };
    if (p.workflow_run_id !== runId) return { mode: "other" };
    if (
      ["succeeded", "failed", "rejected", "blocked", "needs_review"].includes(
        p.state,
      )
    )
      return { mode: "done" };
    if (p.state === "pending") return { mode: "missing" };
    if (p.lease_until && new Date(p.lease_until) > new Date())
      return { mode: "waiting" };
    if (p.batch_id) {
      if (p.checks >= p.check_limit) {
        await c.query(
          "UPDATE sandbox_payment_proposals SET state='needs_review',error_code='PROVIDER_PENDING' WHERE id=$1",
          [id],
        );
        return { mode: "done" };
      }
      await c.query(
        "UPDATE sandbox_payment_proposals SET claim_id=$2,lease_until=now()+interval '45 seconds',checks=checks+1 WHERE id=$1",
        [id, claim],
      );
      return { ...p, mode: "status" };
    }
    try {
      await paymentAuthority(c, p);
    } catch (e) {
      if (!(e instanceof CapabilityError)) throw e;
      await c.query(
        "UPDATE sandbox_payment_proposals SET state=$2,error_code=$3 WHERE id=$1",
        [id, p.submission_started_at ? "needs_review" : "blocked", e.code],
      );
      if (!p.submission_started_at)
        await c.query(
          "UPDATE sandbox_payment_reservations SET state='released' WHERE payment_id=$1",
          [id],
        );
      return { mode: "done" };
    }
    if (p.submissions >= 3) {
      await c.query(
        "UPDATE sandbox_payment_proposals SET state='needs_review',error_code='SUBMISSION_UNCERTAIN' WHERE id=$1",
        [id],
      );
      return { mode: "done" };
    }
    await c.query(
      "UPDATE sandbox_payment_proposals SET state='submitting',claim_id=$2,lease_until=now()+interval '45 seconds',submissions=submissions+1,submission_started_at=COALESCE(submission_started_at,now()) WHERE id=$1",
      [id, claim],
    );
    return { ...p, mode: "submit" };
  });
  if (!["status", "submit"].includes(p.mode)) return p.mode;
  const offer: Offer = {
    creator: p.payload.payee,
    totalCents: p.payload.cents,
    milestoneCents: p.payload.cents,
    rightsDays: 0,
    deliveryDay: "",
    visits: 0,
  };
  try {
    if (payeeBinding(p.payload.payee) !== p.payload.payeeBinding)
      throw new Error("Payee changed");
    const result =
      p.mode === "submit"
        ? { batchId: await provider.submit(offer, id) }
        : await provider.status(offer, id, p.batch_id);
    await transaction(async (c) => {
      const current = (
        await c.query(
          "SELECT * FROM sandbox_payment_proposals WHERE id=$1 FOR UPDATE",
          [id],
        )
      ).rows[0];
      if (current.claim_id !== claim) return;
      if ("batchId" in result)
        await c.query(
          "UPDATE sandbox_payment_proposals SET batch_id=$2,state='pending_provider',lease_until=NULL,error_code=NULL WHERE id=$1",
          [id, result.batchId],
        );
      else if (result.status === "SUCCESS") {
        await c.query(
          "UPDATE sandbox_payment_proposals SET state='succeeded',item_id=$2,lease_until=NULL,error_code=NULL WHERE id=$1",
          [id, result.itemId],
        );
        await c.query(
          "UPDATE sandbox_payment_reservations SET state='spent' WHERE payment_id=$1",
          [id],
        );
        await c.query(
          "INSERT INTO sandbox_payment_events(payment_id,event_key,detail) VALUES($1,'succeeded',$2) ON CONFLICT DO NOTHING",
          [
            id,
            JSON.stringify({
              itemId: result.itemId,
              cents: p.payload.cents,
              currency: "USD",
              sandbox: true,
            }),
          ],
        );
      } else if (
        [
          "DENIED",
          "FAILED",
          "BLOCKED",
          "RETURNED",
          "REFUNDED",
          "REVERSED",
        ].includes(result.status)
      ) {
        await c.query(
          "UPDATE sandbox_payment_proposals SET state='failed',error_code=$2,lease_until=NULL WHERE id=$1",
          [id, "PROVIDER_" + result.status],
        );
        await c.query(
          "UPDATE sandbox_payment_reservations SET state='released' WHERE payment_id=$1",
          [id],
        );
      } else
        await c.query(
          "UPDATE sandbox_payment_proposals SET state='pending_provider',lease_until=NULL WHERE id=$1",
          [id],
        );
    });
  } catch {
    // A missing HTTP response is never evidence that the provider did not pay.
    await authPool.query(
      "UPDATE sandbox_payment_proposals SET lease_until=NULL,error_code='PROVIDER_UNCERTAIN' WHERE id=$1 AND claim_id=$2",
      [id, claim],
    );
  }
  return "waiting";
}
