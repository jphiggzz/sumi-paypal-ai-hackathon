type Proposal = { creator: string; cents: number };
type Event = { creator: string; status: string; cents?: number; remaining?: number; itemId?: string };
export function sandboxTest(proposals: Proposal[], source: 'agent' | 'fixture' | 'campaign', options?: {
  config?: Record<string, string | undefined>;
  journal?: URL;
  limit?: number;
  details?: unknown;
  onEvent?: (event: Event) => void;
}): Promise<void>;
