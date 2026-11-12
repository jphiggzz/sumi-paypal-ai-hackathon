export const campaignBudgetCents: number;
export function runBudget(
  proposals: readonly { creator: string; cents: number }[],
  send: (creator: string, value: string) => Promise<{ status: string; itemId?: string }>,
  report: (event: { creator: string; cents: number; remaining: number; status: string; itemId?: string }) => void | Promise<void>,
): Promise<void>;
