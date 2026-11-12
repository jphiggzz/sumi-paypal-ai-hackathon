export const campaignBudgetCents = 80000;

export async function runBudget(proposals, send, report, limit = campaignBudgetCents) {
  let remaining = limit;
  const attempted = new Set();
  for (const { creator, cents } of proposals) {
    if (!Number.isSafeInteger(cents) || cents <= 0) throw new Error('Invalid payout amount');
    if (attempted.has(creator)) throw new Error('Duplicate payout proposal');
    if (cents > remaining) {
      await report({ creator, cents, remaining, status: 'BLOCKED_BUDGET' });
      continue;
    }

    attempted.add(creator);
    remaining -= cents;
    // Keep the reservation if the result is uncertain and stop the run.
    await report({ creator, cents, remaining, status: 'RESERVED' });
    const receipt = await send(creator, (cents / 100).toFixed(2));
    await report({ creator, cents, remaining, ...receipt });
    if (receipt.status !== 'SUCCESS') throw new Error('Payout needs reconciliation');
  }
}
