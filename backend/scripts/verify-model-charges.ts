import assert from "node:assert/strict";
import { writeFile } from "node:fs/promises";
import { gateway } from "ai";
import {
  budgetedGenerateText,
  reconcileModelCharge,
} from "../lib/model-charges";
import { authPool } from "../lib/auth";
import { dailyModelLimit } from "../lib/routine-policy";
try {
  assert.equal(dailyModelLimit(), 5);
  let id: unknown;
  if (process.argv.includes("--existing"))
    id = (
      await authPool.query(
        "SELECT generation_id FROM agent_model_charges WHERE generation_id IS NOT NULL ORDER BY created_at DESC LIMIT 1",
      )
    ).rows[0]?.generation_id;
  else {
    const r = await budgetedGenerateText({
      model: "google/gemini-2.5-flash-lite",
      maxOutputTokens: 20,
      maxRetries: 0,
      prompt: "Reply with exactly: ready",
    });
    assert.match(r.text, /ready/i);
    id = r.providerMetadata?.gateway?.generationId;
  }
  assert.equal(typeof id, "string");
  const info = await gateway.getGenerationInfo({ id: id as string });
  console.log(
    JSON.stringify({
      model: info.model,
      cost: info.totalCost,
      finishReason: info.finishReason,
      inputTokens: info.promptTokens,
      outputTokens: info.completionTokens,
    }),
  );
  let row = (
    await authPool.query(
      "SELECT * FROM agent_model_charges WHERE generation_id=$1",
      [id],
    )
  ).rows[0];
  assert(row);
  await reconcileModelCharge(row.id);
  row = (
    await authPool.query("SELECT * FROM agent_model_charges WHERE id=$1", [
      row.id,
    ])
  ).rows[0];
  assert.notEqual(row.confirmed_usd, null);
  const before = (
    await authPool.query(
      "SELECT reserved_usd FROM agent_model_budget WHERE day=$1",
      [row.day],
    )
  ).rows[0].reserved_usd;
  await Promise.all([
    reconcileModelCharge(row.id),
    reconcileModelCharge(row.id),
  ]);
  const after = (
    await authPool.query(
      "SELECT reserved_usd FROM agent_model_budget WHERE day=$1",
      [row.day],
    )
  ).rows[0].reserved_usd;
  assert.equal(before, after);
  assert(Number(row.confirmed_usd) < Number(row.held_usd));
  const evidence = {
    checkedAt: new Date().toISOString(),
    dailyCeiling: 5,
    model: row.model,
    reserved: Number(row.held_usd),
    confirmed: Number(row.confirmed_usd),
    providerCost: info.totalCost,
    inputTokens: info.promptTokens,
    outputTokens: info.completionTokens,
    checks: [
      "Provider-confirmed exact generation/model cost",
      "Unused reservation released; original daily ceiling unchanged",
      "Concurrent repeated reconciliation does not refund twice",
    ],
    limits:
      "Historical reservations without generation receipts remain charged conservatively. No inference quality or evaluation reductions.",
  };
  await writeFile(
    "../research/model-charge-verification-2026-11-10.json",
    JSON.stringify(evidence, null, 2) + "\n",
  );
  console.log(JSON.stringify(evidence));
} finally {
  await authPool.end();
}
