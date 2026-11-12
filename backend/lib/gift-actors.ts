type SharedFact = { member_id: string };
type GiftMember = { id: string; simulated?: boolean };
export function giftActors(facts: SharedFact[], members: GiftMember[], soloPerspectives: boolean) {
  const memberIds = [...new Set(facts.map((fact) => String(fact.member_id)))];
  memberIds.sort((a, b) => Number(Boolean(members.find((member) => member.id === a)?.simulated)) - Number(Boolean(members.find((member) => member.id === b)?.simulated)));
  if (soloPerspectives && memberIds.length === 1 && members.length === 1 && members[0]?.id === memberIds[0] && !members[0]?.simulated) return [
    { memberId: memberIds[0], name: "Scout", perspective: "practical and useful ideas" },
    { memberId: memberIds[0], name: "Muse", perspective: "personal and meaningful ideas" },
    { memberId: memberIds[0], name: "Dot", perspective: "unexpected but relevant ideas" },
  ];
  return memberIds.map((memberId) => ({ memberId, name: "", perspective: "" }));
}
