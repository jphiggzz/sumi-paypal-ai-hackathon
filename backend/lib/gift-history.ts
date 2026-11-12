// Earlier shared results are usable only while every source fact and participant remains.
// Historical results are read-only and cannot authorize selection or payment.
export function canUsePriorRound(input: any, currentFactIds: string[], currentMemberIds: string[]) {
  if (!Array.isArray(input?.facts) || !Array.isArray(input?.members) || input.facts.length === 0 || input.members.length !== currentMemberIds.length) return false;
  const facts = new Set(currentFactIds), members = new Set(currentMemberIds);
  return input.facts.every((fact: any) => typeof fact?.id === "string" && facts.has(fact.id)) && input.members.every((member: any) => typeof member?.id === "string" && members.has(member.id));
}
