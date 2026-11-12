/** Persisted setup progress; payment and sharing authority live elsewhere. */
export type GiftSetupState = { version: 1; phase: "brief" | "ready"; questions: number; lastReplyId: string };

export function readGiftSetupState(value: unknown, legacy: string[]): GiftSetupState {
  const state = value as Partial<GiftSetupState> | null;
  if (state?.version === 1 && (state.phase === "brief" || state.phase === "ready") && Number.isInteger(state.questions) && typeof state.lastReplyId === "string") return state as GiftSetupState;
  return { version: 1, phase: legacy.includes("gift_mock_handoff") ? "ready" : "brief", questions: Math.min(2, legacy.filter((type) => type === "gift_clarification").length), lastReplyId: "" };
}

export function nextGiftSetupState(previous: GiftSetupState, replyId: string, outcome: "question" | "ready"): GiftSetupState {
  if (previous.lastReplyId === replyId) return previous;
  return { version: 1, phase: outcome === "ready" ? "ready" : "brief", questions: Math.min(2, previous.questions + Number(outcome === "question")), lastReplyId: replyId };
}
