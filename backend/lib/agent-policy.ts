import { z } from 'zod';

export const taskInput = z.object({
  id: z.uuid(),
  instruction: z.string().trim().min(3).max(2000),
  source: z.string().trim().min(1).max(20_000),
  recoveryTest: z.boolean().default(false),
});
export const draftInput = z.object({ title: z.string().trim().min(1).max(120), markdown: z.string().trim().min(1).max(20_000) });
export const decisionInput = z.object({ decision: z.enum(['approve', 'reject']), digest: z.string().regex(/^[a-f0-9]{64}$/) });
export const permissions = ['read_source', 'create_draft', 'save_approved_artifact'] as const;
export const terminalStatuses = ['completed', 'rejected', 'cancelled', 'failed'];
export function sourceStats(source: string) {
  return { characters: source.length, words: source.trim().split(/\s+/u).filter(Boolean).length, lines: source.split('\n').length };
}
export function sameDecision(saved: { decision: string; digest: string }, incoming: { decision: string; digest: string }) {
  return saved.decision === incoming.decision && saved.digest === incoming.digest;
}
