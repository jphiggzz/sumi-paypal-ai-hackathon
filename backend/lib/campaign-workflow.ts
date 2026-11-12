import { createHook, getWorkflowMetadata, sleep } from "workflow";
import { resumeHook } from "workflow/api";
import { HookNotFoundError } from "workflow/errors";
import { Output } from "ai";
import { budgetedGenerateText as generateText } from "./model-charges";
import { waitForModelCapacity } from "./model-capacity";
import { z } from "zod";
import { brief, offers, violations, type Scenario } from "./policy";
import { db, getCampaign, record } from "./db";
import { submit, status } from "./paypal";
import { eventKey, type Fixture } from "./fixtures";

export async function campaignWorkflow(id: string, scenario: Scenario) {
  "use workflow";

  if (!(await claim(id, getWorkflowMetadata().workflowRunId))) return;
  let phase = "counteroffer";
  try {
    await waitForFixture(id, "counteroffer", "10s");
    phase = "model";
    const model = await configuredCampaignModel();
    await waitForModelCapacity(model);
    if (!(await decide(id, scenario, model))) return;
    phase = "acceptance";
    await waitForFixture(id, "acceptance", "2s");
    await recordFixture(id, "acceptance", "offered", "accepted");
    phase = "delivery";
    await waitForFixture(id, "delivery", "2s");
    await recordFixture(id, "delivery", "accepted", "delivered");

    phase = "payout submission";
    await sendPayout(id);
    phase = "payout confirmation";
    for (let attempt = 0; attempt < 12; attempt++) {
      if (await confirmPayout(id)) return;
      await sleep("5s");
    }
    await markPending(id);
  } catch {
    await markFailed(id, phase);
  }
}

async function claim(id: string, runId: string) {
  "use step";
  const sql = db();
  const rows = await sql`UPDATE campaigns SET workflow_run_id = ${runId}
    WHERE id = ${id} AND status = 'waiting' AND (workflow_run_id IS NULL OR workflow_run_id = ${runId})
    RETURNING id`;
  return rows.length === 1;
}

async function waitForFixture(id: string, event: Fixture, delay: "10s" | "2s") {
  using hook = createHook<{ source: "fixture" }>({
    token: eventKey(id, event),
  });
  await Promise.all([
    (async () => {
      await hook;
    })(),
    (async () => {
      await sleep(delay);
      await emitFixture(id, event);
    })(),
  ]);
}

async function emitFixture(id: string, event: Fixture) {
  "use step";
  try {
    await resumeHook(eventKey(id, event), { source: "fixture" });
  } catch (error) {
    if (!HookNotFoundError.is(error)) throw error;
  }
}

async function configuredCampaignModel() {
  "use step";
  return process.env.SUME_MODEL || "amazon/nova-micro";
}

async function decide(id: string, scenario: Scenario, model: string) {
  "use step";
  const campaign = await getCampaign(id);
  if ("counteroffer" in campaign.event_log) return campaign.deal !== null;
  const candidates = offers(scenario);
  const { output } = await generateText({
    model,
    maxRetries: 0,
    maxOutputTokens: 1000,
    output: Output.object({
      schema: z.object({
        creator: z.enum(["A", "B"]),
        reason: z.string().max(600),
      }),
    }),
    prompt: `${brief}
Choose one offer. Prefer eligible offers, then higher forecast visits.
If none is eligible, choose which offer to escalate for review.
Approval: ${JSON.stringify(campaign.approval)}
Counteroffer and alternatives: ${JSON.stringify(candidates)}`,
    abortSignal: AbortSignal.timeout(40_000),
  });
  const chosen = candidates.find((offer) => offer.creator === output.creator)!;
  const problems = violations(chosen, campaign.approval);
  const detail = {
    source: "fixture",
    candidates,
    recommendation: output,
    model,
    problems,
  };
  const sql = db();
  await sql`UPDATE campaigns SET status = ${problems.length ? "review" : "offered"},
    deal = ${JSON.stringify(problems.length ? null : chosen)}::jsonb,
    event_log = event_log || jsonb_build_object('counteroffer', ${JSON.stringify(detail)}::jsonb)
    WHERE id = ${id} AND status = 'waiting'`;
  return !problems.length;
}

async function recordFixture(
  id: string,
  event: Fixture,
  before: string,
  after: string,
) {
  "use step";
  await record(id, before, after, event, { source: "fixture" });
}

async function sendPayout(id: string) {
  "use step";
  const sql = db();
  await sql`UPDATE campaigns SET status = 'submitting', payout_request_id = ${id},
    payment_started_at = now()
    WHERE id = ${id} AND status = 'delivered' AND event_log ? 'acceptance' AND event_log ? 'delivery'`;
  const campaign = await getCampaign(id);
  if (campaign.batch_id) return;
  if (
    campaign.status !== "submitting" ||
    !campaign.deal ||
    !campaign.payout_request_id ||
    !campaign.payment_started_at ||
    violations(campaign.deal, campaign.approval).length
  ) {
    throw new Error("Payout not authorized");
  }
  if (
    Date.now() - Date.parse(campaign.payment_started_at) >=
    24 * 60 * 60 * 1000
  ) {
    throw new Error("Payout retry window expired");
  }
  const batchId = await submit(campaign.deal, campaign.payout_request_id);
  if (campaign.recovery_test && !("interruption" in campaign.event_log)) {
    await record(id, "submitting", "submitting", "interruption", {
      source: "test",
      after: "PayPal accepted submission",
    });
    throw new Error("Injected failure after payout submission");
  }
  await sql`UPDATE campaigns SET status = 'confirming', batch_id = ${batchId}
    WHERE id = ${id} AND status = 'submitting'`;
}

async function confirmPayout(id: string) {
  "use step";
  const campaign = await getCampaign(id);
  if (campaign.status === "paid" || campaign.status === "payment_review")
    return true;
  if (!campaign.deal || !campaign.batch_id || !campaign.payout_request_id)
    throw new Error("Payout submission missing");
  const result = await status(
    campaign.deal,
    campaign.payout_request_id,
    campaign.batch_id,
  );
  const sql = db();
  if (result.itemId) {
    await sql`UPDATE campaigns SET status = 'paid', item_id = ${result.itemId}
      WHERE id = ${id} AND status = 'confirming'`;
    return true;
  }
  if (["PENDING", "PROCESSING", "NEW"].includes(result.status)) return false;
  await record(
    id,
    "confirming",
    "payment_review",
    "paypalStatus",
    result.status,
  );
  return true;
}

async function markPending(id: string) {
  "use step";
  await record(
    id,
    "confirming",
    "payment_review",
    "paypalStatus",
    "Confirmation window elapsed",
  );
}

async function markFailed(id: string, phase: string) {
  "use step";
  console.error("Campaign workflow failed during " + phase, { id });
  const sql = db();
  await sql`UPDATE campaigns SET event_log = event_log || jsonb_build_object('failure', ${phase}::text),
    status = CASE WHEN payout_request_id IS NULL THEN 'failed' ELSE 'payment_review' END
    WHERE id = ${id} AND status NOT IN ('review', 'paid', 'payment_review')`;
}
