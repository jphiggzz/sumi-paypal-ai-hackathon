export function giftBudgetAvailability(input: {
  newDraft: boolean;
  limitCents: number;
  hasSharedFacts: boolean;
  readyForBudget: boolean;
  answered: boolean;
  interactive: boolean;
  responseFinished: boolean;
}) {
  const show = !input.newDraft || input.limitCents > 0 || input.hasSharedFacts || input.readyForBudget || (input.answered && !input.interactive);
  return { show, offer: input.interactive && input.answered && !show && input.responseFinished };
}

export function giftBudgetResponse(messages: { id: string; role: string; content: string; status?: string; interaction?: { type: string; next?: "explore" | "ready" } | null }[], legacyAnchor?: string) {
  const latestClarification = [...messages].reverse().find((m) => m.role === "assistant" && m.status === "completed" && m.interaction?.type === "gift_clarification");
  const latestAssistant = [...messages].reverse().find((m) => m.role === "assistant");
  const next = latestClarification?.interaction?.next;
  return {
    anchorId: next === "ready" ? latestClarification?.id : legacyAnchor,
    eligible: latestAssistant?.status === "completed" && !latestAssistant.content.startsWith("A workflow action could not complete.") && (next === undefined || next === "ready"),
  };
}
