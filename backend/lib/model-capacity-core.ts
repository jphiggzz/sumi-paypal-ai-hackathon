import { authPool } from "./auth";
export async function reserveModelCapacityCore(model: string, maxWaitMs?: number) {
  // The existing Gateway team currently permits five RPM for the chosen model.
  // Leave headroom and share this schedule across all foundation conversations.
  const configured = Number(process.env.AGENT_MODEL_INTERVAL_MS ?? 16000);
  const interval = Number.isFinite(configured)
    ? Math.max(1000, Math.min(configured, 120000))
    : 16000;
  const row = (
    await authPool.query(
      `INSERT INTO agent_model_capacity(model,next_call_at)
    VALUES($1,now()+($2*interval '1 millisecond'))
    ON CONFLICT(model) DO UPDATE SET next_call_at=GREATEST(agent_model_capacity.next_call_at,now())+($2*interval '1 millisecond')
    WHERE $3::integer IS NULL OR agent_model_capacity.next_call_at <= now()+($3*interval '1 millisecond')
    RETURNING GREATEST(0,EXTRACT(epoch FROM (next_call_at-now()))*1000-$2)::integer AS wait_ms`,
      [model, interval, maxWaitMs ?? null],
    )
  ).rows[0];
  return row ? row.wait_ms as number : (maxWaitMs ?? 30000) + 1;
}
