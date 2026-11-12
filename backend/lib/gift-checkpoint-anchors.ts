export type GiftAnchorMessage = { id: string; role: string; content: string };

export function giftSetupMessageId(messages: GiftAnchorMessage[]) {
  return messages.find((m) => m.role === "assistant" && /Let’s set up your gift\.|Gift created\.|Workflow updated\. Review the card below for status and the next action\./.test(m.content))?.id;
}

export function giftFollowupAnchor(messages: GiftAnchorMessage[], initialTitle: string | null | undefined) {
  if (!initialTitle) return { answered: false, assistantId: undefined };
  const setupId = giftSetupMessageId(messages);
  const setupIndex = setupId ? messages.findIndex((m) => m.id === setupId) : -1;
  const titleIndex = messages.findIndex((m, i) => i > setupIndex && m.role === "user" && m.content === initialTitle);
  if (titleIndex < 0) return { answered: false, assistantId: undefined };
  const answerIndex = messages.findIndex((m, i) => i > titleIndex && m.role === "user");
  if (answerIndex < 0) return { answered: false, assistantId: undefined };
  return { answered: true, assistantId: messages.find((m, i) => i > answerIndex && m.role === "assistant")?.id };
}
