/** Keep an in-flight PayPal return only while reopening its own conversation. */
export function workspaceConversationUrl(currentUrl: string, conversationId: string) {
  const current = new URL(currentUrl);
  const next = new URLSearchParams({ conversation: conversationId });
  if (current.searchParams.get("conversation") === conversationId && current.searchParams.has("snackInvite")) next.set("snackInvite", current.searchParams.get("snackInvite")!);
  if (current.searchParams.get("conversation") === conversationId && (current.searchParams.has("contribution") || current.searchParams.has("cancelled") || current.searchParams.has("snackPayment") || current.searchParams.has("snackCancelled"))) {
    for (const key of ["contribution", "cancelled", "snackPayment", "snackCancelled", "token", "PayerID"]) {
      const value = current.searchParams.get(key);
      if (value) next.set(key, value);
    }
  }
  return `/workspace?${next.toString()}`;
}
