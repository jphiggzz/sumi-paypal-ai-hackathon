import { spawnSync } from "node:child_process";
/** Hosted API/Workflow integration with explicit synthetic accounts/sources. No real payout unless --sandbox flag. */
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { writeFile } from "node:fs/promises";
import { setTimeout as delay } from "node:timers/promises";
import { Pool } from "pg";
import { betterAuth } from "better-auth";
import { authPool } from "../lib/auth";
import {
  proposeSandboxPayment,
  decidePayment,
  advancePayment,
} from "../lib/sandbox-payment-store";
import { correctResult } from "../lib/evidence-store";
const base = "https://sume-agent-foundation.vercel.app",
  sandbox = process.argv.includes("--sandbox");
const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 3 });
const auth = betterAuth({
  secret: process.env.BETTER_AUTH_SECRET,
  baseURL: base,
  database: pool,
  user: { modelName: "auth_users" },
  session: { modelName: "auth_sessions" },
  account: { modelName: "auth_accounts" },
  verification: { modelName: "auth_verifications" },
  emailAndPassword: { enabled: true },
});
async function account() {
  const r = await auth.api.signUpEmail({
    body: {
      email: `commerce-${randomUUID()}@example.invalid`,
      password: randomUUID() + randomUUID(),
      name: "Commerce verifier",
    },
    asResponse: true,
  });
  assert.equal(r.status, 200);
  return {
    id: (await r.json()).user.id,
    cookie: r.headers
      .getSetCookie()
      .filter((c) => c.split("=")[0].includes("session_token"))
      .map((c) => c.split(";")[0])
      .join("; "),
  };
}
async function call(path: string, user?: { cookie: string }, body?: unknown) {
  const r = await fetch(base + path, {
    method: body ? "POST" : "GET",
    headers: {
      Origin: base,
      "Content-Type": "application/json",
      "x-demo-code": process.env.SUME_DEMO_CODE!,
      ...(user ? { Cookie: user.cookie } : {}),
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  const text = await r.text();
  assert.doesNotMatch(
    text,
    /access_token|refresh_token|session_token|Bearer\s|"stack"\s*:/i,
  );
  return { status: r.status, data: text ? JSON.parse(text) : null };
}
async function json(path: string, user: any, body?: unknown) {
  const r = await call(path, user, body);
  assert.ok(
    r.status >= 200 && r.status < 300,
    `${r.status} ${JSON.stringify(r.data)}`,
  );
  return r.data;
}
async function wait(
  read: () => Promise<any>,
  ready: (v: any) => boolean,
  label: string,
  n = 180,
) {
  for (let i = 0; i < n; i++) {
    const r = await read();
    if (ready(r)) return r;
    await delay(1000);
  }
  throw new Error("Timeout " + label);
}
const checks: string[] = [],
  ids: any = {};
const pass = (s: string) => {
  checks.push(s);
  console.log("PASS", s);
};
async function source(u: any, title: string, content: string) {
  const id = randomUUID();
  await json("/api/documents", u, {
    requestId: randomUUID(),
    sourceId: id,
    expectedVersion: 0,
    filename: title + ".txt",
    content,
  });
  return { id, version: 1 };
}
async function task(
  u: any,
  options: {
    ai?: boolean;
    cap?: number;
    price?: string;
    maxModelCalls?: number;
  } = {},
) {
  const price = options.price ?? "1.25 USD",
    sources = [
      await source(
        u,
        "service-a",
        options.ai
          ? `I can deliver a test service for ${price}. The deliverables are three sample images. I will send them on November 12, 2026.`
          : `Price: ${price}\nDeliverables: three sample images\nDue date: November 12, 2026`,
      ),
      await source(
        u,
        "service-b",
        options.ai
          ? "My fee is 2.50 USD for two sample images, due November 13, 2026."
          : "Price: 2.50 USD\nDeliverables: two sample images\nDue date: November 13, 2026",
      ),
    ];
  const id = randomUUID(),
    workId = randomUUID();
  await json("/api/conversations", u, {
    id,
    messageId: workId,
    source: "Only owner-selected test documents.",
    text: "Compare the requested fields using the selected sources. Follow the bounded work manifest.",
    executionMode: options.ai ? "assistant" : "capability_check",
    ...(!options.ai
      ? { capabilityRequest: { tool: "start_document_job", input: {} } }
      : {}),
    work: {
      ...(options.maxModelCalls === undefined
        ? {}
        : { maxModelCalls: options.maxModelCalls }),
      sources: sources.map((s) => ({ kind: "source", ...s })),
      fields: ["Price", "Deliverables", "Due date"],
      extractionMode: options.ai ? "ai" : "literal",
      payment: {
        sourceIndex: 0,
        amountField: "Price",
        payee: "A",
        currency: "USD",
        maxCents: options.cap ?? 125,
      },
    },
  });
  const w = await wait(
    async () => (await json(`/api/agent-work?workId=${workId}`, u)).work[0],
    (w) => w.job_id,
    "job admission",
  );
  await wait(
    async () => (await json(`/api/jobs/${w.job_id}`, u)).job,
    (j) => ["completed", "failed"].includes(j.state),
    "job completion",
  );
  return { id, workId, jobId: w.job_id, sources };
}
try {
  assert.equal(
    (await call("/api/workspace?workId=" + randomUUID())).status,
    401,
  );
  assert.equal(
    (
      await call("/api/sandbox-payments", undefined, {
        id: randomUUID(),
        digest: "0".repeat(64),
        decision: "approve",
      })
    ).status,
    401,
  );
  pass("workspace and payment decisions require authenticated owner");
  const u = await account(),
    other = await account();
  ids.owner = u.id;
  const t = await task(u);
  ids.literal = t;
  const d = await json("/api/workspace?workId=" + t.workId, u);
  assert.equal(d.records.length, 2);
  assert.equal(d.records[0].facts[0].value, "1.25 USD");
  assert.equal(
    (await call("/api/workspace?workId=" + t.workId, other)).status,
    404,
  );
  pass(
    "hosted real finite job publishes owned versioned structured rows; foreign owner cannot read",
  );
  const proposal = await proposeSandboxPayment(u.id, t.workId);
  ids.payment = proposal.id;
  assert.equal(proposal.state, "pending");
  assert.equal(proposal.cents, 125);
  assert.equal((await proposeSandboxPayment(u.id, t.workId)).id, proposal.id);
  assert.equal(
    (
      await call("/api/sandbox-payments", other, {
        id: proposal.id,
        digest: proposal.digest,
        decision: "approve",
      })
    ).status,
    404,
  );
  assert.equal(
    (
      await call("/api/sandbox-payments", u, {
        id: proposal.id,
        digest: "f".repeat(64),
        decision: "approve",
      })
    ).status,
    409,
  );
  pass(
    "one exact payment proposal derived from owner-bound source/cap; foreign and wrong-digest approvals denied",
  );
  const runId = "fixture-payment-" + randomUUID();
  const decisions = await Promise.all([
    decidePayment(
      u.id,
      proposal.id,
      proposal.digest!,
      "approve",
      runId,
      Date.now() + 30000,
    ),
    decidePayment(
      u.id,
      proposal.id,
      proposal.digest!,
      "approve",
      runId,
      Date.now() + 30000,
    ),
  ]);
  assert.equal(decisions.filter((r) => r.replayed).length, 1);
  assert.equal(
    +(
      await pool.query(
        "SELECT count(*) FROM sandbox_payment_reservations WHERE payment_id=$1",
        [proposal.id],
      )
    ).rows[0].count,
    1,
  );
  let submissions = 0,
    statuses = 0,
    providerCommitted = false;
  const provider = {
    submit: async (_o: any, key: string) => {
      assert.equal(key, proposal.id);
      submissions++;
      if (!providerCommitted) {
        providerCommitted = true;
        throw new Error(
          "Synthetic lost response AFTER simulated provider commit",
        );
      }
      return "FIXTURE_BATCH";
    },
    status: async () => {
      statuses++;
      return { status: "SUCCESS", itemId: "FIXTURE_ITEM" };
    },
  };
  await advancePayment(u.id, proposal.id!, runId, provider);
  let reserved = (
    await pool.query(
      "SELECT state FROM sandbox_payment_reservations WHERE payment_id=$1",
      [proposal.id],
    )
  ).rows[0];
  assert.equal(reserved.state, "reserved");
  await Promise.all([
    advancePayment(u.id, proposal.id!, runId, provider),
    advancePayment(u.id, proposal.id!, runId, provider),
  ]);
  await advancePayment(u.id, proposal.id!, runId, provider);
  const paid = (
    await pool.query(
      "SELECT state,submissions FROM sandbox_payment_proposals WHERE id=$1",
      [proposal.id],
    )
  ).rows[0];
  assert.equal(paid.state, "succeeded");
  assert.equal(submissions, 2);
  assert.equal(statuses, 1);
  assert.equal(
    (
      await pool.query(
        "SELECT state FROM sandbox_payment_reservations WHERE payment_id=$1",
        [proposal.id],
      )
    ).rows[0].state,
    "spent",
  );
  pass(
    "explicit mocked uncertain-provider outcome keeps reservation; same identity reconciles concurrent retries into one simulated effect",
  );
  const second = await task(u);
  ids.correction = second;
  const dp = await json("/api/workspace?workId=" + second.workId, u),
    pp = await proposeSandboxPayment(u.id, second.workId),
    r = dp.records[0];
  await json("/api/workspace", u, {
    action: "correct",
    resultId: r.id,
    expectedRevision: 1,
    field: "Price",
    status: "absent",
    value: null,
    quote: "",
  });
  assert.equal(
    (
      await call("/api/sandbox-payments", u, {
        id: pp.id,
        digest: pp.digest,
        decision: "approve",
      })
    ).status,
    409,
  );
  assert.equal(
    (
      await call("/api/workspace", u, {
        action: "correct",
        resultId: r.id,
        expectedRevision: 1,
        field: "Price",
        status: "absent",
        value: null,
        quote: "",
      })
    ).status,
    409,
  );
  const oldArtifact = await json("/api/jobs/" + second.jobId, u);
  assert.equal(oldArtifact.blockedReason, "JOB_RESULT_SUPERSEDED");
  assert.equal(
    (
      await call("/api/jobs/" + second.jobId, u, {
        action: "approve",
        expectedVersion: oldArtifact.job.version,
        digest: "0".repeat(64),
      })
    ).status,
    409,
  );
  pass(
    "owner correction creates immutable new revision and invalidates old payment proposal; stale corrections rejected",
  );
  const capped = await task(u, { cap: 100 });
  const blocked = await proposeSandboxPayment(u.id, capped.workId);
  assert.equal(blocked.state, "blocked");
  assert.equal(blocked.providerCalled, false);
  pass("above-cap evidence produces no provider call or monetary reservation");
  const saved = await json("/api/workspace", u, {
    action: "save",
    workId: t.workId,
    expectedRevision: 0,
    state: d.state,
  });
  assert.equal(saved.revision, 1);
  assert.equal(
    (
      await call("/api/workspace", u, {
        action: "save",
        workId: t.workId,
        expectedRevision: 0,
        state: d.state,
      })
    ).status,
    409,
  );
  assert.equal(
    (await json("/api/workspace?workId=" + t.workId, u)).revision,
    1,
  );
  pass(
    "workspace is stored server-side with revision comparison and survives independent reads",
  );
  const revoked = await task(u);
  const pr = await proposeSandboxPayment(u.id, revoked.workId);
  await json("/api/agent-work", u, {
    action: "cancel",
    workId: revoked.workId,
  });
  assert.equal(
    (
      await call("/api/sandbox-payments", u, {
        id: pr.id,
        digest: pr.digest,
        decision: "approve",
      })
    ).status,
    409,
  );
  pass("task cancellation denies proposal approval before any sandbox request");
  const changed = await task(u);
  const sourceProposal = await proposeSandboxPayment(u.id, changed.workId);
  await json("/api/documents", u, {
    requestId: randomUUID(),
    sourceId: changed.sources[0].id,
    expectedVersion: 1,
    filename: "service-a.txt",
    content: "Price: 9.00 USD",
  });
  assert.equal(
    (
      await call("/api/sandbox-payments", u, {
        id: sourceProposal.id,
        digest: sourceProposal.digest,
        decision: "approve",
      })
    ).status,
    409,
  );
  pass(
    "changed source version rejects its old payment approval before provider submission",
  );
  const permissionOwner = await account();
  const permission = await task(permissionOwner);
  const permissionProposal = await proposeSandboxPayment(
    permissionOwner.id,
    permission.workId,
  );
  await pool.query(
    "UPDATE agent_profiles SET permissions=$2 WHERE id=(SELECT agent_id FROM agent_conversations WHERE id=$1)",
    [permission.id, JSON.stringify(["read_context"])],
  );
  const permissionDenied = await call(
    "/api/sandbox-payments",
    permissionOwner,
    {
      id: permissionProposal.id,
      digest: permissionProposal.digest,
      decision: "approve",
    },
  );
  assert.equal(permissionDenied.status, 403);
  assert.equal(permissionDenied.data.error, "PAYMENT_PERMISSION_DENIED");
  pass(
    "revoked current conversation capability denies financial approval (isolated synthetic owner fixture)",
  );
  const zero = await task(u, { maxModelCalls: 0 });
  const command = {
    action: "request",
    id: randomUUID(),
    workId: zero.workId,
    expectedRevision: 0,
    prompt: "Show missing facts",
  };
  const concurrent = await Promise.all([
    call("/api/workspace", u, command),
    call("/api/workspace", u, command),
  ]);
  assert.ok(concurrent.every((r) => r.status === 200));
  const denied = await wait(
    async () =>
      (await json("/api/workspace?workId=" + zero.workId, u)).requests.find(
        (r: any) => r.id === command.id,
      ),
    (r) => r?.status === "failed",
    "zero model allowance workspace request",
  );
  assert.equal(denied.error_code, "WORK_BUDGET_EXHAUSTED");
  assert.equal(
    (
      await pool.query("SELECT model_calls FROM agent_work WHERE id=$1", [
        zero.workId,
      ])
    ).rows[0].model_calls,
    0,
  );
  assert.equal(
    +(
      await pool.query(
        "SELECT count(*) FROM agent_work_charges WHERE work_id=$1 AND receipt=$2",
        [zero.workId, "workspace:" + command.id],
      )
    ).rows[0].count,
    1,
  );
  pass(
    "concurrent duplicate workspace commands admit once; exhausted shared model allowance gives durable failure without inference",
  );
  assert.equal(
    (
      await call("/api/workspace", u, {
        ...command,
        id: randomUUID(),
        expectedRevision: 999,
      })
    ).status,
    409,
  );
  pass("stale workspace revision rejected before model admission");
  await json("/api/agent-work", u, { action: "cancel", workId: t.workId });
  const receipts = await json("/api/sandbox-payments?workId=" + t.workId, u);
  assert.equal(receipts.payments[0].state, "succeeded");
  assert.equal(
    (await json("/api/sandbox-payments?workId=" + t.workId, other)).payments
      .length,
    0,
  );
  pass(
    "owned payment receipt remains readable after task cancellation; foreign owner receives no payment metadata",
  );
  if (sandbox) {
    const realOwner = await account();
    const real = await task(realOwner, { price: "0.01 USD", cap: 1 });
    ids.realSandbox = real;
    // Operator creates a signed synthetic owner session above; real hosted exact approval API below.
    const row = (
      await pool.query("SELECT owner_id FROM agent_work WHERE id=$1", [
        real.workId,
      ])
    ).rows[0];
    const p = await proposeSandboxPayment(row.owner_id, real.workId);
    if (process.argv.includes("--recover"))
      await pool.query(
        "UPDATE sandbox_payment_proposals SET lease_until=now()+interval '45 seconds' WHERE id=$1",
        [p.id],
      );
    const approved = await json("/api/sandbox-payments", realOwner, {
      id: p.id,
      digest: p.digest,
      decision: "approve",
    });
    assert.equal(approved.state, "approved");
    if (process.argv.includes("--recover")) {
      const original = (
        await pool.query(
          "SELECT workflow_run_id,recovery_run_id FROM sandbox_payment_proposals WHERE id=$1",
          [p.id],
        )
      ).rows[0];
      assert.ok(original.recovery_run_id);
      const cancelled = spawnSync(
        process.execPath,
        [
          "node_modules/workflow/bin/run.js",
          "cancel",
          original.workflow_run_id,
          "--backend",
          "vercel",
          "--env",
          "preview",
          "--json",
        ],
        { encoding: "utf8", timeout: 30000 },
      );
      assert.equal(cancelled.status, 0, "Cancel isolated payment worker");
      await wait(
        async () =>
          (
            await pool.query(
              "SELECT workflow_run_id,recovery_attempts FROM sandbox_payment_proposals WHERE id=$1",
              [p.id],
            )
          ).rows[0],
        (r) =>
          r.workflow_run_id !== original.workflow_run_id &&
          r.recovery_attempts === 1,
        "payment worker recovery",
        120,
      );
      ids.stoppedPaymentWorker = original.workflow_run_id;
    }
    const terminal = await wait(
      async () => {
        const d = await json("/api/workspace?workId=" + real.workId, realOwner);
        return d.payments[0];
      },
      (p) =>
        ["succeeded", "failed", "needs_review", "blocked"].includes(p.state),
      "real PayPal item confirmation",
      240,
    );
    assert.equal(terminal.state, "succeeded", JSON.stringify(terminal));
    assert.ok(terminal.item_id);
    await json("/api/sandbox-payments", realOwner, {
      id: p.id,
      digest: p.digest,
      decision: "approve",
    });
    const stored = (
      await pool.query(
        "SELECT state,submissions,followup_sequence,item_id,batch_id FROM sandbox_payment_proposals WHERE id=$1",
        [p.id],
      )
    ).rows[0];
    assert.equal(stored.submissions, 1);
    ids.realSandbox = {
      ...real,
      paymentId: p.id,
      state: stored.state,
      itemSuffix: stored.item_id.slice(-6),
      batchSuffix: stored.batch_id.slice(-6),
    };
    if (process.argv.includes("--recover"))
      pass(
        "actual cancelled sandbox-payment worker automatically recovers under the same approval/key without resetting submission counters (synthetic pre-submit lease)",
      );
    pass(
      "real hosted exact approval triggers 0.01 USD PayPal sandbox payout; recipient item SUCCESS and replay does not resubmit",
    );
  }
  const report = {
    status: "passed",
    target: base,
    recordedAt: new Date().toISOString(),
    checks,
    ids,
    fixtureBoundary:
      "Synthetic application sessions and uploaded sources. Payment reconciliation test uses injected mock provider with explicit lost-response-after-commit; no real PayPal call in these groups. Hosted document jobs and app APIs are real.",
    sandboxRequested: sandbox,
  };
  await writeFile(
    "../research/evidence-commerce-hosted-verification-2026-11-09.json",
    JSON.stringify(report, null, 2) + "\n",
  );
} catch (e) {
  await writeFile(
    "../research/evidence-commerce-hosted-failure-2026-11-09.json",
    JSON.stringify(
      { status: "failed", checks, ids, error: String(e) },
      null,
      2,
    ) + "\n",
  );
  throw e;
} finally {
  await pool.end();
  await authPool.end();
}
