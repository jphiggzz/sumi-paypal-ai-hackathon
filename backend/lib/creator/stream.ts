import { createUIMessageStream, createUIMessageStreamResponse } from "ai";
import { readCreatorCampaign, commitCreatorTurn } from "./store";
import { generateCreatorAnswer } from "./agent";
import { suggestAudienceSegments } from "./audience-suggestions";
import { saveReply } from "../workspace-chat";
import { CreatorValidationError, shortlistExclusion, withoutWebsiteEvidence } from "./policy";
import { noStore } from "../agent-api";
import { isWebsiteOnly, readCampaignWebsite, websiteFromMessage } from "./website";
export function creatorStream(
  owner: string,
  cid: string,
  replyId: string,
  messages: { role: "user" | "assistant"; content: string }[],
  requestSignal: AbortSignal,
) {
  const stream = createUIMessageStream({
    execute: async ({ writer }) => {
      writer.write({ type: "start", messageId: replyId });
      writer.write({ type: "text-start", id: replyId });
      try {
        const signal = AbortSignal.any([
          requestSignal,
          AbortSignal.timeout(75000),
        ]);
        const current = await readCreatorCampaign(owner, cid);
        const latest = messages.findLast((message) => message.role === "user");
        const link = websiteFromMessage(latest?.content || "");
        const skipWebsite = current.setup?.awaitingWebsite &&
          /^(?:continue without (?:a |the )?website|skip|no website)[.!]?$/i.test((latest?.content || "").trim());
        const removeWebsite = skipWebsite ||
          /\b(?:remove|forget|stop using|don['’]?t use|do not use)\b[^.!?]{0,40}\b(?:website|site|link)\b/i.test(latest?.content || "") ||
          /\b(?:without|no)\s+(?:a\s+|the\s+|my\s+)?(?:website|site)\b/i.test(latest?.content || "");
        let website = removeWebsite ? undefined : current.setup?.website;
        let websiteError = false;
        if (link && !removeWebsite) {
          try {
            website = await readCampaignWebsite(link);
          } catch {
            websiteError = true;
          }
        }
        const previousWebsite = current.setup?.website;
        const websiteChanged = !!previousWebsite && (
          !website || previousWebsite.url !== website.url ||
          previousWebsite.title !== website.title || previousWebsite.excerpt !== website.excerpt
        );
        const planningCurrent = websiteChanged ? withoutWebsiteEvidence(current, messages) : current;
        const websiteOnly = isWebsiteOnly(latest?.content || "");
        const setupReady = current.setup?.awaitingWebsite && (skipWebsite || (link && !websiteError && websiteOnly));
        const wantsReplacement = /\band\s+(?:find|show me)\s+another creator\b/i.test(latest?.content || "");
        const refinement = shortlistExclusion(current, latest?.content || "", wantsReplacement);
        const another = /^(?:please\s+)?(?:find|show me)\s+another(?:\s+creator)?[.!]?$/i.test((latest?.content || "").trim());
        const replacement = (!!refinement && wantsReplacement) ||
          (another && !!current.brief.brand && !!current.brief.audience && !!current.candidates.length);
        const replacementAnswer = replacement && !refinement ? {
          brief: current.brief, reply: "", options: [], next: "compare" as const, sources: [], candidates: current.candidates,
        } : null;
        const missingAfterSkip = skipWebsite && websiteChanged && (!planningCurrent.brief.brand || !planningCurrent.brief.audience);
        let answer = refinement ?? replacementAnswer ?? (missingAfterSkip
          ? {
            brief: planningCurrent.brief,
            reply: planningCurrent.brief.brand ? "Who should this campaign reach?" : "What are you promoting?",
            options: planningCurrent.brief.brand ? ["Students", "Developers", "Businesses"] : [],
            next: "clarify" as const,
            sources: [],
            candidates: [],
          }
          : (setupReady || websiteError) && planningCurrent.brief.brand && planningCurrent.brief.audience
          ? { brief: planningCurrent.brief, reply: "", options: [], next: "compare" as const, sources: [], candidates: [] }
          : await generateCreatorAnswer(
            { ...planningCurrent, setup: { ...current.setup, website } },
            messages,
            signal,
            true,
          ));
        let setup = { ...current.setup, website, awaitingWebsite: false, websiteOffered: !!(current.setup?.websiteOffered || website || removeWebsite) };
        if (websiteError) {
          answer = { ...answer, reply: "I couldn’t read that website. Try another link or continue without it.", options: ["Continue without a website"], next: "clarify", candidates: [] };
          setup = { ...setup, awaitingWebsite: true, websiteOffered: true };
        } else if (!refinement && (answer.next === "compare" || (current.revision === 0 && answer.next === "clarify")) && !current.setup?.websiteOffered && !website && !removeWebsite && !current.candidates.length) {
          answer = { ...answer, reply: "What’s your website? I’ll use it to shape the creator search.", options: ["Continue without a website"], next: "clarify", candidates: [] };
          setup = { ...setup, awaitingWebsite: true, websiteOffered: true };
        }
        if (answer.next === "compare" && website?.excerpt && website.readable !== false && !refinement && !replacement) {
          try {
            setup.audienceSuggestions = await suggestAudienceSegments(answer.brief, website, messages, signal);
          } catch (error) {
            signal.throwIfAborted();
            console.warn("creator_audience_suggestions_unavailable", error instanceof Error ? error.name : "UnknownError");
            setup.audienceSuggestions = [];
          }
        } else if (removeWebsite || websiteChanged) {
          setup.audienceSuggestions = [];
        }
        signal.throwIfAborted();
        if (answer.next === "compare" && (!refinement || replacement)) {
          answer.reply = replacement ? "I’ll look for another creator. Run the agents when you’re ready." : website?.readable === false ? "I couldn’t read that website, so this direction is based on your message." : "Here’s a starting direction. You can change it before the agents run.";
          answer.options = [];
        }
        const detail = answer.brief.audienceDetail?.trim().toLowerCase();
        const explicitAudienceDetail = !!detail && messages.some((message) =>
          message.role === "user" && message.content.toLowerCase().includes(detail),
        );
        await commitCreatorTurn(owner, cid, replyId, current.revision, answer, !!refinement && !replacement, setup, !refinement || replacement, explicitAudienceDetail, replacement);
        writer.write({ type: "text-delta", id: replyId, delta: answer.reply });
      } catch (e) {
        console.warn(
          "creator_reply_failed",
          e instanceof CreatorValidationError
            ? e.message
            : e instanceof Error
              ? e.name
              : "UnknownError",
        );
        await saveReply(replyId, "", "failed");
        writer.write({
          type: "error",
          errorText:
            e instanceof Error && e.message === "Capacity busy"
              ? "The shared AI queue is busy. Your campaign is saved; retry shortly."
              : e instanceof Error &&
                  e.message === "MODEL_DAILY_BUDGET_EXHAUSTED"
                ? "Daily AI limit reached. Your campaign is saved."
                : `Campaign reply could not finish. Your saved campaign is unchanged; retry this reply.${process.env.NODE_ENV === "development" ? ` (${e instanceof CreatorValidationError ? e.message : e instanceof Error ? e.name : "UnknownError"})` : ""}`,
        });
      }
      writer.write({ type: "text-end", id: replyId });
      writer.write({ type: "finish" });
    },
    onError: () => "Campaign reply interrupted.",
  });
  return createUIMessageStreamResponse({ stream, headers: noStore });
}
