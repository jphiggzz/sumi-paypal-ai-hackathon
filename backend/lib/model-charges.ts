import { setTimeout as delay } from "node:timers/promises";
import { createGateway, generateText } from "ai";
import { authPool } from "./auth";
import { transaction } from "./agent-store";
import { reserveModelBudgetCore } from "./model-budget-core";
import { confirmedModelCost } from "./model-charge-policy";
const lookup = createGateway({
  fetch: (url, init) =>
    fetch(url, { ...init, signal: AbortSignal.timeout(5000) }),
});

export async function reconcileModelCharge(id: string) {
  const row = (
    await authPool.query(
      "SELECT * FROM agent_model_charges WHERE id=$1 AND confirmed_usd IS NULL AND generation_id IS NOT NULL",
      [id],
    )
  ).rows[0];
  if (!row) return;
  await authPool.query(
    "UPDATE agent_model_charges SET checked_at=now() WHERE id=$1",
    [id],
  );
  let info;
  try {
    info = await lookup.getGenerationInfo({ id: row.generation_id });
  } catch {
    return;
  }
  const cost = confirmedModelCost(row.model, row.generation_id, info);
  if (cost === null) return;
  await transaction(async (c) => {
    const locked = (
      await c.query(
        "SELECT * FROM agent_model_charges WHERE id=$1 FOR UPDATE",
        [id],
      )
    ).rows[0];
    if (
      !locked ||
      locked.confirmed_usd !== null ||
      locked.generation_id !== row.generation_id
    )
      return;
    // Settle against the reservation's original UTC day, even after midnight.
    await c.query(
      "UPDATE agent_model_budget SET reserved_usd=reserved_usd-$2+$3 WHERE day=$1",
      [locked.day, locked.held_usd, cost],
    );
    await c.query(
      "UPDATE agent_model_charges SET confirmed_usd=$2,settled_at=now(),usage=$3 WHERE id=$1",
      [
        id,
        cost,
        JSON.stringify({
          promptTokens: info.promptTokens,
          completionTokens: info.completionTokens,
          provider: info.providerName,
        }),
      ],
    );
  });
}
export async function captureModelGeneration(id: string, metadata: any) {
  const generationId = metadata?.gateway?.generationId;
  if (
    typeof generationId !== "string" ||
    !/^gen_[A-Za-z0-9_-]{10,100}$/.test(generationId)
  )
    return;
  // Bind exactly once. Never let a caller reuse a generation to refund two calls.
  await authPool.query(
    "UPDATE agent_model_charges SET generation_id=$2 WHERE id=$1 AND (generation_id IS NULL OR generation_id=$2)",
    [id, generationId],
  );
  await reconcileModelCharge(id);
}
export async function reserveTrackedModel(model: string, signal?: AbortSignal) {
  for (let attempt = 0; attempt < 5; attempt++) {
    signal?.throwIfAborted();
    const pending = (
      await authPool.query(
        "SELECT id FROM agent_model_charges WHERE generation_id IS NOT NULL AND confirmed_usd IS NULL AND day=(now() AT TIME ZONE 'UTC')::date ORDER BY checked_at NULLS FIRST,created_at LIMIT 4",
      )
    ).rows;
    for (const row of pending) await reconcileModelCharge(row.id);
    signal?.throwIfAborted();
    try {
      return await reserveModelBudgetCore(model);
    } catch (e) {
      // Gateway usage can take ~90 seconds to ingest. Wait for known receipts,
      // never bypass the ceiling or issue another inference to recover a cost.
      if (
        !(e instanceof Error) ||
        e.message !== "MODEL_DAILY_BUDGET_EXHAUSTED" ||
        !pending.length ||
        attempt === 4
      )
        throw e;
      await delay(10000, undefined, { signal });
    }
  }
  throw new Error("MODEL_DAILY_BUDGET_EXHAUSTED");
}

// Same SDK contract and models. Each invocation reserves separately before the
// provider call; failed/ambiguous usage never receives an estimated refund.
export const budgetedGenerateText = (async (
  options: Parameters<typeof generateText>[0],
) => {
  if (
    typeof options.model !== "string" ||
    options.tools ||
    options.stopWhen ||
    !options.maxOutputTokens ||
    options.maxOutputTokens > 3000
  )
    throw new Error("UNBOUNDED_TRACKED_MODEL_REQUEST");
  options.abortSignal?.throwIfAborted();
  const id = await reserveTrackedModel(options.model, options.abortSignal);
  return generateText({
    ...options,
    maxRetries: 0,
    abortSignal: options.abortSignal || AbortSignal.timeout(30000),
    onLanguageModelCallEnd: async (event) => {
      await captureModelGeneration(id, event.providerMetadata).catch(() => {});
      await options.onLanguageModelCallEnd?.(event);
    },
  });
}) as typeof generateText;
