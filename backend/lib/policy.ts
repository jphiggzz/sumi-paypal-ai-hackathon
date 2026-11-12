export const scenarios = ['payout', 'review'] as const;
export type Scenario = (typeof scenarios)[number];
export type Creator = 'A' | 'B';
export type Offer = {
  creator: Creator;
  totalCents: number;
  milestoneCents: number;
  rightsDays: number;
  deliveryDay: string;
  visits: number;
};
export type Approval = { capCents: number; rightsDays: number; deliveryDay: string };

export const approval: Approval = { capCents: 800_000, rightsDays: 30, deliveryDay: 'Friday' };
export const brief = 'ChatEDU needs a creator for its Friday launch. Maximize forecast attributed visits with one accepted offer. Forecasts are simulated.';
export const labels = { A: 'Maya', B: 'Sam' };

export function offers(scenario: Scenario): Offer[] {
  return [
    { creator: 'A', totalCents: scenario === 'review' ? 840_000 : 680_000, milestoneCents: 30000, rightsDays: 30, deliveryDay: 'Friday', visits: 1050 },
    { creator: 'B', totalCents: 610_000, milestoneCents: 27000, rightsDays: scenario === 'review' ? 14 : 30, deliveryDay: 'Friday', visits: 1320 },
  ];
}

export function violations(offer: Offer, terms: Approval) {
  const problems: string[] = [];
  if (!Number.isSafeInteger(offer.totalCents) || offer.totalCents <= 0 || offer.totalCents > terms.capCents) problems.push('Offer exceeds the approved budget or has an invalid amount.');
  if (offer.rightsDays < terms.rightsDays) problems.push('Offer falls short of the required usage rights.');
  if (offer.deliveryDay !== terms.deliveryDay) problems.push('Offer misses the required delivery day.');
  if (!Number.isSafeInteger(offer.milestoneCents) || offer.milestoneCents <= 0 || offer.milestoneCents > offer.totalCents) problems.push('Milestone amount is invalid.');
  return problems;
}
