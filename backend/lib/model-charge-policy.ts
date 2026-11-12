// Only a completed, server-looked-up generation can release a reservation.
// A missing cost is not a reported zero; BYOK accounting remains conservative.
export function confirmedModelCost(
  model: string,
  id: string,
  info: any,
): number | null {
  if (
    !info ||
    info.id !== id ||
    info.model !== model ||
    info.isByok !== false ||
    ![
      "stop",
      "length",
      "tool-calls",
      "content-filter",
      "error",
      "other",
    ].includes(info.finishReason) ||
    !Number.isFinite(info.totalCost) ||
    info.totalCost < 0 ||
    !Number.isInteger(info.promptTokens) ||
    info.promptTokens <= 0 ||
    !Number.isInteger(info.completionTokens) ||
    info.completionTokens < 0
  )
    return null;
  // Round up to the database's micro-dollar precision, never under-account.
  const values = [info.totalCost, info.gatewayCost];
  if (values.some((v) => v !== undefined && (!Number.isFinite(v) || v < 0)))
    return null;
  return (
    Math.ceil(Math.max(...values.filter((v) => v !== undefined)) * 1e6) / 1e6
  );
}
