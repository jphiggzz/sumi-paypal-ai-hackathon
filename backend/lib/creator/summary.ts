export function compactAgentSummary(value: string): string {
  const text = value.trim().replace(/\s+/g, " ");
  if (!text) return "Review complete.";
  const sentence = text.match(/^.{1,240}?[.!?](?:\s|$)/)?.[0]?.trim();
  if (sentence) return sentence;
  if (text.length <= 240) return text;
  return text.slice(0, 237).replace(/\s+\S*$/, "") + "…";
}

export function checkedAgentSummary(value: string, brief: { exclusions: string[]; budgetCents?: number | null }): string {
  const summary = compactAgentSummary(value);
  if ((brief.exclusions.length && /\b(?:no|without|neither)\b[^.!?]{0,50}\bexclusions?\b/i.test(summary)) ||
      (brief.budgetCents != null && /\b(?:no|without|neither)\b[^.!?]{0,50}\bbudget\b/i.test(summary))) {
    return "Agent summary conflicted with the saved brief.";
  }
  return summary;
}
