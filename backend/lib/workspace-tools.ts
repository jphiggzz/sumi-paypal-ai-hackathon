import { tool } from "ai";
import { z } from "zod";
import {
  prepareCampaign,
  startGiftDraft,
  startSnackDraft,
  collaborateWorkspaceSnacks,
  workspaceFlowSummary,
  workspaceGiftAction,
} from "./workspace-flows";
export function workspaceTools(
  user: { id: string; name: string },
  conversationId: string,
  requestId: string,
  origin: string,
  signal: AbortSignal,
  fullAdmission = true,
) {
  const active = () => signal.throwIfAborted();
  return {
    prepare_campaign: tool({
      description:
        "Only when explicitly asked for the fixed ChatEDU Sandbox demo, prepare its existing fixed-offer campaign review card. No campaign runs and no payout occurs until the human explicitly approves the exact Sandbox terms in the card. This does not execute a custom brief.",
      inputSchema: z.object({}).strict(),
      execute: async () => {
        active();
        if (!fullAdmission)
          throw new Error("Preview admission required for campaigns");
        return prepareCampaign(user.id, conversationId);
      },
    }),
    prepare_office_snacks: tool({
      description: "Prepare an office snack workflow when the user asks to plan or restock office snacks. Create an incomplete draft only; do not invent an office, budget, people or preferences. No invitation, order or payment occurs.",
      inputSchema: z.object({}).strict(),
      execute: async () => { active(); if (!fullAdmission) throw new Error("Preview admission required for a new office"); return startSnackDraft(user.id, conversationId); },
    }),
    prepare_group_gift: tool({
      description: "Start an incomplete group gift draft when the user wants to plan a group gift. Do not invent a recipient, occasion or title. This does not invite, share or pay.",
      inputSchema: z.object({}).strict(),
      execute: async () => {
        active();
        if (!fullAdmission) throw new Error("Preview admission required for new groups");
        return startGiftDraft(user.id, conversationId);
      },
    }),
    read_workflows: tool({
      description:
        "Read this conversation’s linked campaign, gift or snack status, shared facts and actual catalog options. Does not inspect other chats or unshared friend context.",
      inputSchema: z.object({}).strict(),
      execute: async () => {
        active();
        return workspaceFlowSummary(user.id, conversationId);
      },
    }),
    collaborate_office_snacks: tool({
      description: "When the office owner asks to build or compare a snack basket, start a bounded agent round using explicitly shared preferences and the simulated supplier catalog. Requires an already configured office. Does not pay or place an order.",
      inputSchema: z.object({}).strict(),
      execute: async () => { active(); if (!fullAdmission) throw new Error("Preview admission required for snack planning"); return collaborateWorkspaceSnacks(user.id, conversationId, requestId); },
    }),
    collaborate_gifts: tool({
      description:
        "Start real friend-agent collaboration and Channel3 search for the attached gift group when the user asks to find/compare gifts. Requires a positive group budget and explicitly shared facts. Runs durably; read status later. No payment or retailer order is executed.",
      inputSchema: z.object({}).strict(),
      execute: async () => {
        active();
        await workspaceGiftAction(
          user,
          conversationId,
          { action: "plan", id: requestId },
          origin,
        );
        return {
          status: "queued",
          message:
            "Agent collaboration and Channel3 search queued. Follow the gift card for persisted results.",
        };
      },
    }),
  };
}
