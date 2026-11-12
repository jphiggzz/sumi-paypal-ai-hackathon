import { neon } from '@neondatabase/serverless';
import type { Approval, Offer, Scenario } from './policy';

export type Campaign = {
  id: string;
  scenario: Scenario;
  approval: Approval;
  status: string;
  event_log: Record<string, unknown>;
  deal: Offer | null;
  batch_id: string | null;
  item_id: string | null;
  payout_request_id: string | null;
  payment_started_at: string | null;
  recovery_test: boolean;
};

export function db() {
  return neon(process.env.DATABASE_URL!);
}

export async function getCampaign(id: string) {
  const sql = db();
  const [row] = await sql`SELECT * FROM campaigns WHERE id = ${id}`;
  if (!row) throw new Error('Campaign missing');
  return row as Campaign;
}

export async function record(id: string, before: string, after: string, event: string, detail: unknown) {
  const sql = db();
  const rows = await sql`UPDATE campaigns SET status = ${after},
    event_log = event_log || jsonb_build_object(${event}::text, ${JSON.stringify(detail)}::jsonb)
    WHERE id = ${id} AND status = ${before} RETURNING id`;
  if (!rows.length) {
    const current = await getCampaign(id);
    if (!(event in current.event_log)) throw new Error('Unexpected campaign state');
  }
}
