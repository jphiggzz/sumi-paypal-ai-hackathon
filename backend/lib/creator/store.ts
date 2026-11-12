import { randomUUID, createHash } from "node:crypto";
import { authPool } from "../auth";
import { transaction } from "../agent-store";
import { WorkspaceError } from "../workspace-chat";
import { creators } from "./catalog";
import {
  initialCampaign,
  applyAnswer,
  briefSchema,
  validateCommit,
  type Answer,
  type Campaign,
  type Deal,
} from "./policy";
import { campaignPayoutReady } from "../paypal";
import { reconcileCreatorPayout, mergePaymentReceipt, reconcileInstallment } from "./payments";
import { installmentEligible, installmentTerms, type PaymentStructure } from "./installments";
export async function readCreatorCampaign(
  owner: string,
  conversationId: string,
) {
  const row = (
    await authPool.query(
      "SELECT cc.state FROM workspace_chats c LEFT JOIN creator_campaigns cc ON cc.conversation_id=c.id WHERE c.id=$1 AND c.owner_id=$2",
      [conversationId, owner],
    )
  ).rows[0];
  if (!row) throw new WorkspaceError("Chat not found.", 404);
  return (row.state || initialCampaign()) as Campaign;
}
export async function commitCreatorTurn(
  owner: string,
  cid: string,
  replyId: string,
  expected: number,
  answer: Answer,
  refinement = false,
  setup?: Campaign["setup"],
  draftDiscovery = false,
  explicitAudienceDetail = false,
  replacement = false,
) {
  return transaction(async (db) => {
    const chat = (
      await db.query(
        "SELECT id FROM workspace_chats WHERE id=$1 AND owner_id=$2 FOR UPDATE",
        [cid, owner],
      )
    ).rows[0];
    if (!chat) throw new WorkspaceError("Chat not found.", 404);
    const current = ((
      await db.query(
        "SELECT state FROM creator_campaigns WHERE conversation_id=$1 FOR UPDATE",
        [cid],
      )
    ).rows[0]?.state || initialCampaign()) as Campaign;
    if (current.lastReplyId === replyId) return current;
    if (current.revision !== expected)
      throw new WorkspaceError("Campaign changed. Try again.");
    const reply = await db.query(
      "UPDATE workspace_chat_messages SET content=$2,status='completed',interaction=$3 WHERE id=$1 AND conversation_id=$4 AND status='streaming' RETURNING id",
      [
        replyId,
        answer.reply,
        JSON.stringify({
          type: "creator_clarification",
          options: answer.options,
        }),
        cid,
      ],
    );
    if (!reply.rowCount) throw new WorkspaceError("Reply stopped.");
    const next = applyAnswer(current, answer, replyId);
    if (setup) next.setup = setup;
    const websiteValues = (value: Campaign["setup"]) => value?.website
      ? [value.website.url, value.website.title, value.website.excerpt]
      : null;
    const unchanged = JSON.stringify(briefSchema.parse(current.brief)) === JSON.stringify(briefSchema.parse(next.brief))
      && JSON.stringify(websiteValues(current.setup)) === JSON.stringify(websiteValues(next.setup));
    if (unchanged && next.outreach && JSON.stringify(current.candidates.map((candidate) => candidate.id)) === JSON.stringify(next.candidates.map((candidate) => candidate.id))) {
      next.outreach = { ...next.outreach, revision: next.revision };
    }
    if (JSON.stringify(websiteValues(current.setup)) !== JSON.stringify(websiteValues(next.setup))) {
      next.facts = next.facts?.filter((fact) => fact.origin !== "website" || answer.sources.some((source) =>
        source.field === fact.field && "origin" in source && source.origin === "website" &&
        "url" in source && source.url === next.setup?.website?.url,
      ));
    }
    if (answer.next !== "compare" && unchanged && !next.setup?.awaitingWebsite) {
      await db.query("UPDATE creator_runs SET revision=$2,updated_at=now() WHERE conversation_id=$1 AND status='draft'", [cid, next.revision]);
    } else {
      await db.query("UPDATE creator_runs SET status='stale',updated_at=now() WHERE conversation_id=$1 AND status='draft'", [cid]);
    }
    if (answer.next === "compare") {
      // Older conversations have one saved shortlist but no discovery-run history.
      // Preserve that known state without inventing an agent transcript.
      if (current.lastReplyId && current.candidates.length) {
        const oldMessage = await db.query(
          "SELECT id FROM workspace_chat_messages WHERE id::text=$1 AND conversation_id=$2 AND role='assistant' AND status='completed'",
          [current.lastReplyId, cid],
        );
        const existing = await db.query(
          "SELECT 1 FROM creator_runs WHERE conversation_id=$1 LIMIT 1",
          [cid],
        );
        if (oldMessage.rowCount && !existing.rowCount) {
          const profiles = creators.filter((c) =>
            [...current.candidates, ...(current.previous || [])].some((x) => x.id === c.id),
          );
          const legacy = {
            legacy: true,
            brief: current.brief,
            candidates: current.candidates,
            previous: current.previous || [],
            profiles,
          };
          await db.query(
            "INSERT INTO creator_runs(id,conversation_id,message_id,revision,status,input,result,attempt) VALUES($1,$2,$1,$3,'ready',$4,$5,$1) ON CONFLICT(id) DO NOTHING",
            [
              current.lastReplyId,
              cid,
              current.revision,
              JSON.stringify({ brief: current.brief }),
              JSON.stringify(legacy),
            ],
          );
        }
      }
      if (!refinement && !replacement) next.candidates = [];
      const result = refinement ? {
        refinement: true,
        brief: next.brief,
        candidates: next.candidates,
        profiles: creators.filter((creator) =>
          next.candidates.some((candidate) => candidate.id === creator.id),
        ),
      } : null;
      await db.query(
        "INSERT INTO creator_runs(id,conversation_id,message_id,revision,status,input,result,attempt) VALUES($1,$2,$1,$3,$4,$5,$6,$1) ON CONFLICT(id) DO NOTHING",
        [
          replyId,
          cid,
          next.revision,
          refinement ? "ready" : draftDiscovery ? "draft" : "queued",
          JSON.stringify({ ...answer, catalog: creators, website: next.setup?.website, audienceSuggestions: next.setup?.audienceSuggestions || [], explicitAudienceDetail, ...(replacement ? { replacement: true, retainedCandidates: next.candidates, seenIds: current.candidates.map(c => c.id) } : {}) }),
          result ? JSON.stringify(result) : null,
        ],
      );
    }
    await db.query(
      "INSERT INTO creator_campaigns(conversation_id,state) VALUES($1,$2) ON CONFLICT(conversation_id) DO UPDATE SET state=$2,updated_at=now()",
      [cid, JSON.stringify(next)],
    );
    return next;
  });
}
export type CreatorCommand =
  | { action: "approve_business"; revision: number; runId: string }
  | { action: "outreach_draft"; revision: number; creatorIds: string[]; message: string }
  | { action: "outreach_send"; revision: number }
  | { action: "outreach_responses"; revision: number; responses: { creatorId: string; status: "email" | "connected" | "none"; reply?: string }[] }
  | {
      action: "prepare";
      creatorId: string;
      revision: number;
      delivery: string;
      rightsDays: number;
      paymentStructure?: PaymentStructure;
    }
  | {
      action: "approve" | "delivery" | "complete" | "pay";
      dealId: string;
      digest: string;
      revision: number;
      installmentId?: "upfront" | "delivery";
    };
export async function creatorAction(
  owner: string,
  cid: string,
  command: CreatorCommand,
) {
  const result = await transaction(async (db) => {
    if (
      !(
        await db.query(
          "SELECT id FROM workspace_chats WHERE id=$1 AND owner_id=$2 FOR UPDATE",
          [cid, owner],
        )
      ).rowCount
    )
      throw new WorkspaceError("Chat not found.", 404);
    if (
      (
        await db.query(
          "SELECT 1 FROM workspace_chat_messages WHERE conversation_id=$1 AND status='streaming' AND lease_until>now()",
          [cid],
        )
      ).rowCount
    )
      throw new WorkspaceError("Wait for your reply to finish.");
    const c = (
      await db.query(
        "SELECT state FROM creator_campaigns WHERE conversation_id=$1 FOR UPDATE",
        [cid],
      )
    ).rows[0]?.state as Campaign | undefined;
    if (!c) throw new WorkspaceError("Find creators first.");
    if (c.revision !== command.revision)
      throw new WorkspaceError("Campaign changed. Refresh and review again.");
    let pay: Deal | undefined;
    let installmentId: "upfront" | "delivery" | undefined;
    if (command.action === "approve_business") {
      const approved = await db.query("UPDATE creator_runs SET input=jsonb_set(input, '{businessApproved}', 'true'::jsonb),updated_at=now() WHERE id=$1 AND conversation_id=$2 AND revision=$3 AND status='draft' RETURNING id", [command.runId, cid, c.revision]);
      if (!approved.rowCount) throw new WorkspaceError("Review the current business direction first.");
    } else if (command.action === "outreach_draft") {
      if (!command.creatorIds.length || new Set(command.creatorIds).size !== command.creatorIds.length || command.creatorIds.some((id) => !c.candidates.some((candidate) => candidate.id === id)))
        throw new WorkspaceError("Select current shortlisted creators.");
      if (c.outreach && c.outreach.status !== "draft" && c.outreach.revision === c.revision)
        throw new WorkspaceError("Outreach has already been simulated for this campaign revision.");
      c.outreach = { revision: c.revision, creatorIds: command.creatorIds, message: command.message, status: "draft" };
    } else if (command.action === "outreach_send" || command.action === "outreach_responses") {
      const outreach = c.outreach;
      if (!outreach || outreach.revision !== c.revision) throw new WorkspaceError("Prepare outreach for the current campaign first.");
      if (command.action === "outreach_send") {
        if (outreach.status === "draft") outreach.status = "sent";
      } else if (outreach.status === "sent") {
        if (command.responses.length !== outreach.creatorIds.length || new Set(command.responses.map((entry) => entry.creatorId)).size !== outreach.creatorIds.length || command.responses.some((entry) => !outreach.creatorIds.includes(entry.creatorId))) throw new WorkspaceError("Review the simulated response for each recipient.");
        outreach.responses = command.responses.map((entry) => ({ creatorId: entry.creatorId, status: entry.status, ...(entry.status !== "none" && entry.reply ? { reply: entry.reply } : {}) }));
        outreach.status = "responded";
      } else if (outreach.status !== "responded") throw new WorkspaceError("Send the sample invitations first.");
    } else if (command.action === "prepare") {
      if (!c.candidates.some((x) => x.id === command.creatorId))
        throw new WorkspaceError("Creator is no longer shortlisted.");
      if (c.deals.some((x) => x.creatorId === command.creatorId))
        throw new WorkspaceError(
          "An agreement already exists for this creator.",
        );
      const p = creators.find((x) => x.id === command.creatorId);
      if (!p) throw new WorkspaceError("Creator is no longer available.");
      // A fixed sample quote is never represented as a real creator response.
      const d: Deal = {
        id: randomUUID(),
        creatorId: p.id,
        revision: c.revision,
        stage: "negotiating",
        totalCents: p.cents,
        milestoneCents: Math.round(p.cents / 10),
        deliverable: `One ${p.format.toLowerCase()} for ${c.brief.brand}`,
        rightsDays: Math.min(command.rightsDays, 30),
        requestedRightsDays: command.rightsDays,
        counteroffer:
          command.rightsDays > 30
            ? "The sample creator offers a maximum of 30 days of usage. Review the revised terms before approving."
            : undefined,
        delivery: command.delivery,
        digest: "",
        approved: false,
        payment: "none",
        ...(command.paymentStructure ? {
          paymentStructure: command.paymentStructure,
          installments: installmentTerms(p.cents, command.paymentStructure).map((term) => ({ ...term, payment: "none" as const })),
        } : {}),
      };
      d.digest = createHash("sha256")
        .update(JSON.stringify({ campaign: cid, brief: c.brief, deal: d }))
        .digest("hex");
      c.deals.push(d);
    } else if ("dealId" in command) {
      const d = c.deals.find(
        (x) => x.id === command.dealId && x.digest === command.digest,
      );
      if (!d) throw new WorkspaceError("Agreement changed. Review it again.");
      if (command.action === "approve") {
        validateCommit(c, d);
        if (!d.approved) {
          d.approved = true;
          d.stage = "agreed";
        }
      }
      if (command.action === "delivery") {
        if (!d.approved)
          throw new WorkspaceError("Approve the agreement first.");
        if (d.stage === "agreed") d.stage = "delivering";
      }
      if (command.action === "complete") {
        if (!d.approved || !["delivering", "complete"].includes(d.stage))
          throw new WorkspaceError("Review the sample delivery first.");
        d.stage = "complete";
      }
      if (command.action === "pay") {
        if (d.installments) {
          const item = d.installments.find((entry) => entry.id === command.installmentId);
          if (!item) throw new WorkspaceError("Select an installment to pay.");
          if (!installmentEligible(item, { approved: d.approved, acceptedDelivery: d.stage === "complete", priorConfirmed: d.installments.find((entry) => entry.id === "upfront")?.payment === "confirmed" }))
            throw new WorkspaceError("This installment is not eligible for payment yet.");
          if (!campaignPayoutReady()) throw new WorkspaceError("Sandbox recipients are not configured.");
          if (item.payment === "confirmed") return { state: c };
          if ((item.paymentLease || 0) > Date.now()) throw new WorkspaceError("Payment is being checked. Try again shortly.");
          if (item.payment === "none") {
            const quota = await db.query("INSERT INTO demo_quota(day,runs) VALUES(current_date,1) ON CONFLICT(day) DO UPDATE SET runs=demo_quota.runs+1 WHERE demo_quota.runs<30 RETURNING day");
            if (!quota.rowCount) throw new WorkspaceError("Daily Sandbox demo limit reached.", 429);
          }
          item.payment = "pending";
          item.paymentLease = Date.now() + 60000;
          item.paymentAttempt = randomUUID();
          installmentId = item.id;
          pay = structuredClone(d);
        } else {
        if (!d.approved || d.stage !== "complete")
          throw new WorkspaceError(
            "Approve terms and review simulated delivery first.",
          );
        if (!campaignPayoutReady())
          throw new WorkspaceError("Sandbox recipients are not configured.");
        if (d.payment === "confirmed") return { state: c };
        if (d.payment === "none") {
          const quota = await db.query(
            "INSERT INTO demo_quota(day,runs) VALUES(current_date,1) ON CONFLICT(day) DO UPDATE SET runs=demo_quota.runs+1 WHERE demo_quota.runs<30 RETURNING day",
          );
          if (!quota.rowCount)
            throw new WorkspaceError("Daily Sandbox demo limit reached.", 429);
        }
        // Reserve the stable agreement ID before crossing the provider boundary.
        const lease = d.paymentLease || 0;
        if (lease > Date.now())
          throw new WorkspaceError(
            "Payment is being checked. Try again shortly.",
          );
        d.paymentLease = Date.now() + 60000;
        d.paymentAttempt = randomUUID();
        d.payment = "pending";
        pay = { ...d };
        }
      }
    }
    await db.query(
      "UPDATE creator_campaigns SET state=$2,updated_at=now() WHERE conversation_id=$1",
      [cid, JSON.stringify(c)],
    );
    return { state: c, pay, installmentId };
  });
  if (result.pay) {
    const d = result.pay;
    if (result.installmentId) {
      const installment = d.installments!.find((entry) => entry.id === result.installmentId)!;
      const receipt = await reconcileInstallment(d, installment);
      await transaction(async (db) => {
        const c = (await db.query("SELECT state FROM creator_campaigns WHERE conversation_id=$1 FOR UPDATE", [cid])).rows[0].state as Campaign;
        const target = c.deals.find((entry) => entry.id === d.id)?.installments?.find((entry) => entry.id === installment.id);
        if (!target) throw new WorkspaceError("Installment not found.");
        if (target.payment !== "confirmed" && (target.paymentAttempt === installment.paymentAttempt || receipt.payment === "confirmed")) {
          target.payment = receipt.payment;
          if (receipt.batchId) target.batchId = receipt.batchId;
          if (receipt.itemId) target.itemId = receipt.itemId;
          target.paymentLease = 0;
        }
        await db.query("UPDATE creator_campaigns SET state=$2,updated_at=now() WHERE conversation_id=$1", [cid, JSON.stringify(c)]);
      });
      return readCreatorCampaign(owner, cid);
    }
    const { payment, batchId, itemId } = await reconcileCreatorPayout(d);
    await transaction(async (db) => {
      const c = (
        await db.query(
          "SELECT state FROM creator_campaigns WHERE conversation_id=$1 FOR UPDATE",
          [cid],
        )
      ).rows[0].state as Campaign;
      const target = c.deals.find((x) => x.id === d.id)!;
      mergePaymentReceipt(
        target,
        { payment, batchId, itemId },
        d.paymentAttempt!,
      );
      await db.query(
        "UPDATE creator_campaigns SET state=$2,updated_at=now() WHERE conversation_id=$1",
        [cid, JSON.stringify(c)],
      );
    });
  }
  return readCreatorCampaign(owner, cid);
}
