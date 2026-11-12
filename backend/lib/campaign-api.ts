import { start } from "workflow/api";
import { db } from "./db";
import { approval, type Scenario } from "./policy";
import { campaignWorkflow } from "./campaign-workflow";
import { campaignPayoutReady } from "./paypal";
import { runToken } from "./access";

export async function startApprovedCampaign({
  id,
  scenario,
  recoveryTest = false,
}: {
  id: string;
  scenario: Scenario;
  recoveryTest?: boolean;
}) {
  const sql = db();
  const [existing] =
    await sql`SELECT scenario, status, recovery_test, workflow_run_id FROM campaigns WHERE id = ${id}`;
  if (!existing && scenario === "payout" && !campaignPayoutReady())
    return Response.json(
      { error: "CREATOR_SANDBOX_RECIPIENTS_NOT_CONFIGURED" },
      { status: 409 },
    );
  if (!existing) {
    await sql`WITH quota AS (
    INSERT INTO demo_quota(day, runs)
    SELECT current_date, 1 WHERE NOT EXISTS (SELECT 1 FROM campaigns WHERE id = ${id})
    ON CONFLICT (day) DO UPDATE SET runs = demo_quota.runs + 1 WHERE demo_quota.runs < 30
    RETURNING day
  )
  INSERT INTO campaigns(id, scenario, approval, recovery_test)
  SELECT ${id}, ${scenario}, ${JSON.stringify(approval)}::jsonb, ${recoveryTest} FROM quota
  ON CONFLICT (id) DO NOTHING`;
  }
  const [campaign] = existing
    ? [existing]
    : await sql`SELECT scenario, status, recovery_test, workflow_run_id FROM campaigns WHERE id = ${id}`;
  if (!campaign)
    return Response.json(
      { error: "Daily demo limit reached." },
      { status: 429 },
    );
  if (
    campaign.scenario !== scenario ||
    campaign.recovery_test !== recoveryTest
  ) {
    return Response.json(
      { error: "Campaign approval already used." },
      { status: 409 },
    );
  }

  try {
    if (campaign.status === "waiting" && !campaign.workflow_run_id) {
      await start(campaignWorkflow, [id, scenario]);
    }
  } catch (error) {
    console.error("Could not enqueue campaign", {
      name: error instanceof Error ? error.name : "Unknown",
      id,
    });
    return Response.json(
      { error: "Campaign could not start. Retry approval." },
      { status: 503 },
    );
  }
  return Response.json({ id, token: runToken(id) }, { status: 201 });
}
