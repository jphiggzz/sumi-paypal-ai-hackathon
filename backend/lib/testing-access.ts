// Explicit server-side account IDs only; never trust a client-provided tier.
export function hasUnlimitedTestingAccess(ownerId: string, configured = process.env.SUME_UNLIMITED_TESTER_IDS ?? "") {
  return configured.split(",").map((id) => id.trim()).filter(Boolean).includes(ownerId);
}
