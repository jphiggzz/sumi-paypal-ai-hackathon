import { randomUUID } from "node:crypto";
import { transaction } from "./agent-store";
import { FatalError } from "workflow";
import {
  cheapModels,
  dailyModelLimit,
  modelBudgetReservation,
  fullRequestPrice,
} from "./routine-policy";

export async function reserveModelBudgetCore(model: string) {
  if (!cheapModels.includes(model)) throw new FatalError("MODEL_NOT_ALLOWED");
  const response = await fetch("https://ai-gateway.vercel.sh/v1/models", {
    signal: AbortSignal.timeout(10000),
  });
  if (!response.ok) throw new FatalError("MODEL_PRICE_UNVERIFIED");
  const catalog = await response.json();
  const entry = catalog.data?.find((item: { id: string }) => item.id === model);
  if (
    !entry ||
    !Number.isFinite(+entry.pricing?.input) ||
    !Number.isFinite(+entry.pricing?.output) ||
    entry.pricing.varies_by_provider ||
    entry.context_window > 1048576 ||
    +entry.pricing.input > 0.0000001 ||
    +entry.pricing.output > 0.0000004 ||
    fullRequestPrice(entry) > modelBudgetReservation(model)
  )
    throw new FatalError("MODEL_PRICE_LIMIT");
  const reservation = modelBudgetReservation(model);
  // Untracked callers retain the full conservative reservation, even on failure. No
  // refunds based on uncertain usage. Shared across foundation accounts/runs.
  // Each model reserves above a full-context + 3K-output request at the
  // highest listed regional rate. Unexpected pricing fails closed.
  return transaction(async (c) => {
    const result = await c.query(
      `INSERT INTO agent_model_budget(day,reserved_usd,calls)
      SELECT (now() AT TIME ZONE 'UTC')::date,$1,1 WHERE $1::numeric<=$2::numeric
      ON CONFLICT(day) DO UPDATE SET reserved_usd=agent_model_budget.reserved_usd+$1,calls=agent_model_budget.calls+1
      WHERE agent_model_budget.reserved_usd+$1<=$2 RETURNING day`,
      [reservation, dailyModelLimit()],
    );
    if (!result.rowCount) throw new FatalError("MODEL_DAILY_BUDGET_EXHAUSTED");
    const id = randomUUID();
    await c.query(
      "INSERT INTO agent_model_charges(id,day,model,held_usd) VALUES($1,$2,$3,$4)",
      [id, result.rows[0].day, model, reservation],
    );
    return id;
  });
}
