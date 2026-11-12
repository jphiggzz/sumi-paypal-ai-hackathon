import { snackClarificationSchema, snackClarificationSystem, groundedSnackBrief, avoidRepeatedSnackQuestion } from "../../../../lib/snack-clarification";
import { startSnackDraft } from "../../../../lib/workspace-flows";
import { creatorStream } from "../../../../lib/creator/stream";
import { z } from "zod";
import { readGiftSetupState, nextGiftSetupState, type GiftSetupState } from "../../../../lib/gift-setup-state";
import { giftClarificationSystem, giftClarificationSchema, safeGiftClarification, withoutRepeatedGiftOptions, giftClarificationReply, giftSearchAvailable } from "../../../../lib/gift-clarification";
import { authPool } from "../../../../lib/auth";
import {
  streamText,
  generateText,
  Output,
  createUIMessageStream,
  createUIMessageStreamResponse,
} from "ai";
import {
  admittedUser,
  canStartTask,
  noStore,
  sameOrigin,
} from "../../../../lib/agent-api";
import {
  acceptTurn,
  saveReply,
  workspaceSystem,
  WorkspaceError,
} from "../../../../lib/workspace-chat";
import {
  reserveTrackedModel,
  captureModelGeneration,
} from "../../../../lib/model-charges";
import { reserveModelCapacityCore } from "../../../../lib/model-capacity-core";
import { workspaceTools } from "../../../../lib/workspace-tools";
import {
  workspaceFlowSummary,
  hasWorkspaceGiftMembership,
  hasWorkspaceSnackMembership,
} from "../../../../lib/workspace-flows";
export const maxDuration = 90;
const schema = z
  .object({
    conversationId: z.uuid(),
    requestId: z.uuid(),
    messageId: z.uuid(),
    text: z.string().trim().min(1).max(6000),
    mode: z.enum(["creators", "shopping"]),
    revision: z.number().int().nonnegative(),
    retryOf: z.uuid().optional(),
    productRefinement: z.boolean().optional(),
  })
  .strict();
export async function POST(req: Request) {
  if (!sameOrigin(req)) return new Response(null, { status: 403 });
  const a = await admittedUser(req);
  if (a.error) return a.error;
  const fullAdmission = canStartTask(req, a.user);
  let b: z.infer<typeof schema>;
  let messages: Awaited<ReturnType<typeof acceptTurn>>;
  try {
    b = schema.parse(await req.json());
    if (
      !fullAdmission &&
      (b.mode === "creators" || !(await hasWorkspaceGiftMembership(a.user.id, b.conversationId)) && !(await hasWorkspaceSnackMembership(a.user.id, b.conversationId)))
    )
      return Response.json(
        {
          error:
            "Enter your preview access code in the account menu, or join a gift invitation.",
        },
        { status: 403, headers: noStore },
      );
    messages = await acceptTurn(a.user.id, b);
  } catch (e) {
    return Response.json(
      { error: e instanceof WorkspaceError ? e.message : "Invalid message." },
      {
        status: e instanceof WorkspaceError ? e.status : 400,
        headers: noStore,
      },
    );
  }
  if (b.mode === "creators") return creatorStream(a.user.id, b.conversationId, b.requestId, messages, req.signal);
  const cancel = new AbortController();
  const signal = AbortSignal.any([
    req.signal,
    cancel.signal,
    AbortSignal.timeout(80000),
  ]);
  const stream = createUIMessageStream({
    execute: async ({ writer }) => {
      let text = "";
      let completed = false;
      let lastSave = 0;
      let providerError = false;
      let setupUpdate: GiftSetupState | undefined;
      let snackBriefUpdate: unknown;
      let snackClarifying = false;
      let failureMessage = "Reply interrupted. Review the saved response before retrying.";
      writer.write({ type: "start", messageId: b.requestId });
      writer.write({ type: "text-start", id: b.requestId });
      try {
        const verified = await workspaceFlowSummary(a.user.id, b.conversationId);
        const soloDraft = verified.find((f) => f.kind === "gift" && f.draft?.version === 2 && ["solo", "invite"].includes(f.draft?.participantChoice) && f.group?.title);
        const priorSteps = soloDraft && (await authPool.query("SELECT interaction->>'type' AS type FROM workspace_chat_messages WHERE conversation_id=$1 AND status='completed' AND interaction->>'type' IN ('gift_clarification','gift_mock_handoff') ORDER BY sequence", [b.conversationId])).rows;
        const setup = soloDraft ? readGiftSetupState(soloDraft.draft?.setup, (priorSteps || []).map((step: {type: string}) => step.type)) : undefined;
        const boundedHandoff = setup?.phase === "brief" && setup.questions >= 2 && !soloDraft?.draft?.readyForBudget && !(soloDraft?.me?.limitCents > 0);
        if (b.productRefinement) {
          text = "I’ll look for options.";
          if (!(await saveReply(b.requestId, text, "streaming"))) throw new Error("Stopped");
          writer.write({ type: "text-delta", id: b.requestId, delta: text });
          completed = true;
        } else if (boundedHandoff) {
          text = "Let’s find some ideas.";
          setupUpdate = nextGiftSetupState(setup!, b.requestId, "ready");
          if (!(await saveReply(b.requestId, text, "streaming"))) throw new Error("Stopped");
          const saved = await authPool.query("UPDATE workspace_chat_messages SET interaction=$2::jsonb WHERE id=$1 AND status='streaming' RETURNING id", [b.requestId, JSON.stringify({ type: "gift_mock_handoff" })]);
          if (!saved.rowCount) throw new Error("Stopped");
          writer.write({ type: "text-delta", id: b.requestId, delta: text });
          completed = true;
        } else {
        const model =
          process.env.WORKSPACE_CHAT_MODEL || "google/gemini-2.5-flash-lite";
        const wait = await reserveModelCapacityCore(model, 30000);
        if (wait > 30000) throw new Error("Capacity busy");
        if (wait > 0)
          await new Promise<void>((resolve, reject) => {
            const t = setTimeout(resolve, wait);
            signal.addEventListener(
              "abort",
              () => {
                clearTimeout(t);
                reject(new Error("Stopped"));
              },
              { once: true },
            );
          });
        signal.throwIfAborted();
        if (!(await saveReply(b.requestId, text, "streaming")))
          throw new Error("Stopped");
        const chargeId = await reserveTrackedModel(model, signal);
        const explicitAction =
          /\b(create|start|prepare|open|set up)\b/i.test(b.text) &&
          !/\b(don't|do not|never)\b.{0,40}\b(create|start|prepare|open)\b/i.test(
            b.text,
          );
        const giftSetup = fullAdmission && !verified.some((f) => f.kind === "gift") &&
          /\bgift\b/i.test(b.text) && /\b(group|friends)\b/i.test(b.text) &&
          !/\b(don't|do not|never)\b/i.test(b.text);
        const campaignSetup =
          fullAdmission &&
          explicitAction &&
          /\b(?:fixed|sandbox|demo)\b/i.test(b.text) &&
          /\bcampaign\b/i.test(b.text) &&
          !verified.some((f) => f.kind === "campaign");
        const availableTools = workspaceTools(a.user, b.conversationId, b.requestId, new URL(req.url).origin, signal, fullAdmission);
        const { prepare_group_gift: _prepareGift, ...existingGiftTools } = availableTools;
        const { collaborate_gifts: _collaborateGift, ...giftToolsWithoutSearch } = existingGiftTools;
        const giftForSearch = verified.find((f) => f.kind === "gift");
        const giftNameFollowup = verified.some((f) => f.kind === "gift" && f.draft?.version === 2 && f.group?.title === b.text);
        const planningGift = verified.find((f) => f.kind === "gift" && f.draft?.version === 2 && f.group?.title && !f.draft?.readyForBudget && !(f.me?.limitCents > 0));
        const titleIntroduced = planningGift && messages.some((message) => message.role === "user" && message.content === (planningGift.draft?.initialTitle || planningGift.group?.title));
        const priorClarification = planningGift && (await authPool.query("SELECT 1 FROM workspace_chat_messages WHERE conversation_id=$1 AND status='completed' AND interaction->>'type'='gift_clarification' LIMIT 1", [b.conversationId])).rowCount;
        const hasSnackDraft = verified.some(f => f.kind === "snack" && !f.office);
        const startsSnacks = fullAdmission && !giftSetup && !verified.some(f => f.kind === "snack") && /\b(snacks?|pantry)\b/i.test(b.text) && /\b(office|team|workplace|coworkers?|co-workers?|employees?|staff|company|monthly|restock)\b/i.test(b.text) && !/\b(?:don't|do not|never)\s+(?:plan|create|start|prepare|set up|order|buy|restock)\b/i.test(b.text);
        if (hasSnackDraft || startsSnacks) {
          snackClarifying = true;
          if (startsSnacks) await startSnackDraft(a.user.id, b.conversationId);
          const result = await generateText({ model, system: snackClarificationSystem, messages, output: Output.object({ schema: snackClarificationSchema }), maxOutputTokens: 700, maxRetries: 0, abortSignal: signal, onLanguageModelCallEnd: async event => { await captureModelGeneration(chargeId, event.providerMetadata).catch(() => {}); } });
          signal.throwIfAborted();
          const output = snackClarificationSchema.parse(result.output);
          const row = (await authPool.query("SELECT draft FROM workspace_workflow_links WHERE conversation_id=$1 AND kind='snack'", [b.conversationId])).rows[0];
          const prior = row?.draft?.snackBrief || {};
          const userMessages = messages.filter(m => m.role === "user").map(m => String(m.content));
          const previousQuestion = [...messages].reverse().find(m => m.role === "assistant");
          const brief = groundedSnackBrief(output, userMessages, prior, previousQuestion ? String(previousQuestion.content) : "");
          snackBriefUpdate = brief;
          text = avoidRepeatedSnackQuestion(output.question, previousQuestion ? String(previousQuestion.content) : "");
          if (!(await saveReply(b.requestId, text, "streaming"))) throw new Error("Stopped");
          writer.write({ type: "text-delta", id: b.requestId, delta: text });
          completed = true;
        } else if (setup?.phase !== "ready" && (giftNameFollowup || (planningGift && (titleIntroduced || priorClarification)))) {
          const result = await generateText({
            model,
            system: giftClarificationSystem,
            messages,
            output: Output.object({ schema: giftClarificationSchema }),
            maxOutputTokens: 700,
            maxRetries: 0,
            abortSignal: signal,
            onLanguageModelCallEnd: async (event) => {
              await captureModelGeneration(chargeId, event.providerMetadata).catch(() => {});
            },
          });
          signal.throwIfAborted();
          const userText = messages.filter((m) => m.role === "user").map((m) => m.content).join("\n");
          let value = safeGiftClarification(giftClarificationSchema.parse(result.output), userText);
          if (!giftNameFollowup && value.options.length) {
            const prior = await authPool.query("SELECT interaction FROM workspace_chat_messages WHERE conversation_id=$1 AND status='completed' AND interaction->>'type'='gift_clarification' ORDER BY sequence DESC LIMIT 1", [b.conversationId]);
            const previous: unknown = prior.rows[0]?.interaction?.options;
            const previousOptions = Array.isArray(previous) ? previous.filter((item): item is string => typeof item === "string") : [];
            let fresh = withoutRepeatedGiftOptions(value.options, previousOptions);
            if (previousOptions.length && fresh.length < 2 && value.options.length >= 2) {
              try {
                const retryWait = await reserveModelCapacityCore(model, 30000);
                if (retryWait > 30000) throw new Error("Capacity busy");
                if (retryWait > 0) await new Promise<void>((resolve, reject) => {
                  const timer = setTimeout(resolve, retryWait);
                  signal.addEventListener("abort", () => { clearTimeout(timer); reject(new Error("Stopped")); }, { once: true });
                });
                const retryCharge = await reserveTrackedModel(model, signal);
                const retry = await generateText({ model, system: giftClarificationSystem + "\nYour prior attempt repeated the previous suggestions. Offer different ideas grounded in this conversation, or return no options and ask an open question if you cannot.", messages, output: Output.object({ schema: giftClarificationSchema }), maxOutputTokens: 700, maxRetries: 0, abortSignal: signal, onLanguageModelCallEnd: async (event) => { await captureModelGeneration(retryCharge, event.providerMetadata).catch(() => {}); } });
                value = safeGiftClarification(giftClarificationSchema.parse(retry.output), userText);
                fresh = withoutRepeatedGiftOptions(value.options, previousOptions);
              } catch { signal.throwIfAborted(); }
            }
            if (value.options.length && fresh.length < 2) value = { question: "What other direction would you like to explore?", options: [], selection: "single", next: "explore" };
            else if (value.options.length) value = { ...value, options: fresh };
          }
          const ready = value.next === "ready";
          setupUpdate = setup ? nextGiftSetupState(setup, b.requestId, ready ? "ready" : "question") : undefined;
          text = giftClarificationReply(value);
          if (!(await saveReply(b.requestId, text, "streaming"))) throw new Error("Stopped");
          const options = value.options;
          const saved = await authPool.query("UPDATE workspace_chat_messages SET interaction=$2::jsonb WHERE id=$1 AND status='streaming' RETURNING id", [b.requestId, JSON.stringify(ready ? { type: "gift_mock_handoff" } : { type: "gift_clarification", options, selection: value.selection ?? "single", next: "explore" })]);
          if (!saved.rowCount) throw new Error("Stopped");
          writer.write({ type: "text-delta", id: b.requestId, delta: text });
          completed = true;
        } else {
          const result = streamText({
            model,
            system:
              workspaceSystem(b.mode) +
              "\nVerified workflow state: " +
              JSON.stringify(verified) + (b.productRefinement ? "\nThe user is refining a gift product; acknowledge briefly that a new search is starting. Do not claim results or purchases." : ""),
            toolChoice: b.productRefinement ? "none" : giftSetup
              ? { type: "tool", toolName: "prepare_group_gift" }
              : campaignSetup
                ? { type: "tool", toolName: "prepare_campaign" }
                : giftForSearch && !giftSearchAvailable(giftForSearch)
                ? "none"
                : "auto",
            tools: giftForSearch ? (giftSearchAvailable(giftForSearch) ? existingGiftTools : giftToolsWithoutSearch) as typeof availableTools : availableTools,
            messages,
            onLanguageModelCallEnd: async (event) => {
              await captureModelGeneration(
                chargeId,
                event.providerMetadata,
              ).catch(() => {});
            },
            maxOutputTokens: 1500,
            maxRetries: 0,
            abortSignal: signal,
            onError: () => {
              providerError = true;
            },
          });
          for await (const delta of result.textStream) {
            text += delta;
            writer.write({ type: "text-delta", id: b.requestId, delta });
            if (Date.now() - lastSave > 500) {
              if (!(await saveReply(b.requestId, text, "streaming")))
                throw new Error("Stopped");
              lastSave = Date.now();
            }
          }
          const reason = await result.finishReason;
          if (reason === "tool-calls" && !providerError && !signal.aborted) {
            const results = await result.toolResults;
            const errors = (await result.steps)
              .flatMap((step) => step.content)
              .filter((part: any) => part.type === "tool-error");
            const note = errors.length
              ? "A workflow action could not complete. Review the current card and try again."
              : results.length
                ? ({ prepare_group_gift: "Let’s set up your gift.", prepare_office_snacks: "What does your team need from its snack setup?", collaborate_office_snacks: "Building the simulated basket…", prepare_campaign: "Campaign ready.", collaborate_gifts: "Finding gifts…", read_workflows: "Here’s the current status." } as Record<string, string>)[results[results.length - 1].toolName] || "Ready."
                : "No workflow action completed.";
            text += (text ? "\n\n" : "") + note;
            writer.write({
              type: "text-delta",
              id: b.requestId,
              delta: (text === note ? "" : "\n\n") + note,
            });
          }
          completed =
            !signal.aborted &&
            !providerError &&
            ["stop", "tool-calls"].includes(reason) &&
            text.length > 0;
        }
        }
      } catch (error) {
        if (snackClarifying && !signal.aborted) console.error("SNACK_CLARIFICATION_FAILED", error instanceof Error ? error.name : "UnknownError");
        if (error instanceof Error && error.message === "MODEL_DAILY_BUDGET_EXHAUSTED") {
          failureMessage = "The daily AI limit has been reached. Try again after the limit resets at midnight UTC.";
        }
        completed = false;
      } finally {
        const interrupted = signal.aborted;
        cancel.abort();
        if (completed && snackBriefUpdate) {
          await authPool.query(`WITH reply AS (
            UPDATE workspace_chat_messages SET content=$2,status='completed' WHERE id=$1 AND status='streaming' RETURNING id
          ) UPDATE workspace_workflow_links SET draft=jsonb_set(draft,'{snackBrief}',$5::jsonb,true)
            WHERE conversation_id=$3 AND kind='snack' AND EXISTS (SELECT 1 FROM reply)
              AND EXISTS (SELECT 1 FROM workspace_chats WHERE id=$3 AND owner_id=$4)
              AND NOT EXISTS (SELECT 1 FROM snack_offices o WHERE o.id=workspace_workflow_links.resource_id)`,
            [b.requestId,text,b.conversationId,a.user.id,JSON.stringify(snackBriefUpdate)]);
        } else if (completed && setupUpdate) {
          // Commit the reply and its setup transition together. An interrupted or
          // already-finished turn cannot advance the draft on a late response.
          await authPool.query(`WITH reply AS (
            UPDATE workspace_chat_messages SET content=$2,status='completed'
            WHERE id=$1 AND status='streaming' RETURNING id
          ) UPDATE workspace_workflow_links
            SET draft=jsonb_set(draft, '{setup}', $5::jsonb, true)
            WHERE conversation_id=$3 AND kind='gift' AND EXISTS (SELECT 1 FROM reply)
              AND EXISTS (SELECT 1 FROM workspace_chats WHERE id=$3 AND owner_id=$4)`,
          [b.requestId, text, b.conversationId, a.user.id, JSON.stringify(setupUpdate)]);
        } else {
          await saveReply(b.requestId, text, completed ? "completed" : interrupted ? "interrupted" : "failed");
        }
      }
      writer.write({ type: "text-end", id: b.requestId });
      if (!completed)
        writer.write({
          type: "error",
          errorText: failureMessage,
        });
      writer.write({ type: "finish" });
    },
    onError: () => "Reply interrupted. Reopen the saved chat.",
  });
  return createUIMessageStreamResponse({ stream, headers: noStore });
}
