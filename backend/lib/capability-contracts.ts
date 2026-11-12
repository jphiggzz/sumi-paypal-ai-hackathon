import { z } from "zod";

export const connectorDocument = z.object({
  id: z.string().min(1).max(120),
  title: z.string().min(1).max(160),
  text: z.string().max(6000),
  sourceUrl: z.string().max(300),
  version: z.string().min(1).max(100),
  fixture: z.literal(true),
});
export type ConnectorDocument = z.infer<typeof connectorDocument>;
export type ConnectionHandle = {
  id: string;
  ownerId: string;
  provider: "fixture" | "google" | "notion";
  version: number;
  status: "connected" | "requires_authorization" | "expired" | "disconnected";
  scopes: string[];
  resourceIds: string[];
  expiresAt: string | null;
};
export type ConnectionUse = {
  expectedVersion?: number;
  requiredScopes: string[];
  resourceId?: string;
};
export type MemoryReference = { id: string; version: number };
export type MemoryFact = MemoryReference & {
  key: string;
  value: string;
  scope: "agent" | "conversation";
  conversationId: string | null;
  expiresAt: string | null;
  source: Record<string, unknown>;
};
export class CapabilityError extends Error {
  constructor(
    public code: string,
    public status = 409,
    public retryAfterMs?: number,
  ) {
    super(code);
    this.name = "CapabilityError";
  }
}
export type CapabilityContext = {
  ownerId: string;
  conversationId: string;
  sequence: number;
  workflowRunId: string;
  invocationId: string;
  signal: AbortSignal;
};
export type CapabilityDefinition<I = unknown, O = unknown> = {
  id: string;
  version: number;
  description: string;
  effect: "read" | "draft" | "reply" | "propose";
  permission: string;
  timeoutMs: number;
  maxInputBytes: number;
  maxOutputBytes: number;
  inputSchema: z.ZodType<I>;
  outputSchema: z.ZodType<O>;
  execute: (context: CapabilityContext, input: I) => Promise<O>;
};
