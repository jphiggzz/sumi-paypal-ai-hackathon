import { capabilityCheck } from "./capability-policy";
import { z } from "zod";
import { workInput } from './work-policy';

export const conversationPermissions = [
  "read_context",
  "read_revision",
  "reply",
  "create_draft",
  "save_approved_artifact",
];
const followUpFields = z.object({
  messageId: z.uuid(),
  text: z.string().trim().min(1).max(2000),
  recoveryTest: z.boolean().default(false),
  executionMode: z
    .enum(["assistant", "checkpoint", "capability_check"])
    .default("assistant"),
  dispatchRecoveryTest: z.boolean().default(false),
  capabilityRequest: capabilityCheck.optional(),
  work: workInput.optional(),
});
const validExecution = (value: {
  executionMode: string;
  capabilityRequest?: unknown;
}) =>
  (value.executionMode === "capability_check") === !!value.capabilityRequest;
export const followUpInput = followUpFields.refine(
  validExecution,
  "Capability checks require their exact tool request.",
);
export const conversationInput = followUpFields
  .extend({
    id: z.uuid(),
    source: z.string().trim().min(1).max(20000),
  })
  .refine(
    validExecution,
    "Capability checks require their exact tool request.",
  );
export const revisionDecision = z.object({
  action: z.literal("decision"),
  revision: z.number().int().positive(),
  digest: z.string().regex(/^[a-f0-9]{64}$/),
  decision: z.enum(["approve", "reject"]),
  dispatchRecoveryTest: z.boolean().default(false),
});
export function currentApproval(
  conversation: {
    requested_sequence: number;
    latest_revision: number | null;
    grants_active: boolean;
    approval_sequence?: number | null;
  },
  revision: number,
) {
  return (
    conversation.grants_active &&
    (conversation.approval_sequence === undefined ? conversation.requested_sequence : conversation.approval_sequence) === revision &&
    conversation.latest_revision === revision
  );
}
