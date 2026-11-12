import { hasUnlimitedTestingAccess } from "./testing-access";
import {
  simulateGiftFriends,
  approveSimulatedFriends,
} from "./gift-simulation";
import { campaignPayoutReady } from "./paypal";
import { createHash, randomUUID } from "node:crypto";
import { canonicalJson } from "./canonical-json";
import { authPool } from "./auth";
import { CapabilityError } from "./capability-contracts";
import { approval, offers } from "./policy";
import { startApprovedCampaign } from "./campaign-api";
import {
  createGiftGroup,
  giftAccess,
  readGiftState,
  joinGiftGroup,
  shareGiftMessage,
  renameGiftGroup,
} from "./gift-store";
import { executeGiftAction, giftActionInput } from "./gift-api";
import { saveSnackOffice, snackOfficeState } from "./snack-store";
import { joinSnackOffice, readSnackMembers } from "./snack-members";
import type { SnackSettings } from "./snack-policy";
const fail = (message: string, status = 409): never => {
  throw new CapabilityError(message, status);
};
export async function ownedWorkspace(owner: string, conversationId: string) {
  const row = (
    await authPool.query(
      "SELECT id FROM workspace_chats WHERE id=$1 AND owner_id=$2",
      [conversationId, owner],
    )
  ).rows[0];
  if (!row) fail("WORKSPACE_NOT_FOUND", 404);
}
async function link(
  owner: string,
  conversationId: string,
  kind: "campaign" | "gift" | "snack",
  draft: unknown = {},
  resourceId: string = randomUUID(),
) {
  await ownedWorkspace(owner, conversationId);
  return (
    await authPool.query(
      "INSERT INTO workspace_workflow_links(id,conversation_id,kind,resource_id,draft) VALUES($1,$2,$3,$4,$5) ON CONFLICT(conversation_id,kind) DO UPDATE SET kind=EXCLUDED.kind RETURNING *",
      [randomUUID(), conversationId, kind, resourceId, JSON.stringify(draft)],
    )
  ).rows[0];
}
export async function startSnackDraft(owner: string, conversationId: string) {
  await link(owner, conversationId, "snack", { version: 1 });
  return { status: "draft", message: "Office snack setup is ready." };
}
export async function setupWorkspaceSnack(user: { id: string; name: string }, conversationId: string, settings: SnackSettings) {
  const owner = user.id;
  await ownedWorkspace(owner, conversationId);
  const l = (await authPool.query("SELECT resource_id FROM workspace_workflow_links WHERE conversation_id=$1 AND kind='snack'", [conversationId])).rows[0];
  if (!l) fail("PREPARE_SNACKS_FIRST");
  const prior = (await authPool.query("SELECT owner_id,settings FROM snack_offices WHERE id=$1", [l.resource_id])).rows[0];
  if (prior) {
    if (prior.owner_id !== owner || canonicalJson(prior.settings) !== canonicalJson(settings)) fail("SNACK_SETUP_CONFLICT");
  } else await saveSnackOffice(owner, l.resource_id, 0, settings);
  await authPool.query("UPDATE snack_offices SET headcount_mode='total' WHERE id=$1 AND owner_id=$2 AND revision=1", [l.resource_id,owner]);
  await authPool.query("INSERT INTO snack_members(id,office_id,user_id,name) VALUES($1,$2,$3,$4) ON CONFLICT(office_id,user_id) DO NOTHING", [randomUUID(),l.resource_id,owner,user.name.slice(0,80)]);
}
export async function joinWorkspaceSnack(user: {id:string;name:string}, conversationId: string, token: string) {
  await ownedWorkspace(user.id, conversationId);
  const prior = (await authPool.query("SELECT l.resource_id,o.invite_hash FROM workspace_workflow_links l JOIN snack_offices o ON o.id=l.resource_id WHERE l.conversation_id=$1 AND l.kind='snack'", [conversationId])).rows[0];
  if (prior) {
    if (prior.invite_hash !== createHash("sha256").update(token).digest("hex")) fail("THIS_CHAT_ALREADY_HAS_AN_OFFICE");
    await joinSnackOffice(user, token);
    return;
  }
  const id = await joinSnackOffice(user, token);
  await link(user.id, conversationId, "snack", {}, id);
}
export async function hasWorkspaceSnackMembership(user: string, conversationId: string) {
  return Boolean((await authPool.query(`SELECT 1 FROM workspace_chats c JOIN workspace_workflow_links l ON l.conversation_id=c.id AND l.kind='snack' JOIN snack_members m ON m.office_id=l.resource_id AND m.user_id=c.owner_id WHERE c.id=$1 AND c.owner_id=$2`, [conversationId,user])).rowCount);
}
export async function collaborateWorkspaceSnacks(owner: string, conversationId: string, cycleId: string) {
  await ownedWorkspace(owner, conversationId);
  const l = (await authPool.query("SELECT resource_id FROM workspace_workflow_links WHERE conversation_id=$1 AND kind='snack'", [conversationId])).rows[0];
  if (!l) fail("PREPARE_SNACKS_FIRST");
  const { ownedSnackOffice, admitSnackCycle } = await import("./snack-store");
  const office = await ownedSnackOffice(authPool, owner, l.resource_id);
  const { start } = await import("workflow/api");
  const { snackCycleWorkflow } = await import("./snack-workflow");
  const deadline = Date.now() + 30000;
  await start(snackCycleWorkflow, [owner, l.resource_id, cycleId, true]);
  await admitSnackCycle(owner, l.resource_id, office.revision, cycleId, deadline, "simulated");
  return { status: "queued", message: "Simulated snack basket queued; no payment or order." };
}
export async function prepareCampaign(owner: string, conversationId: string) {
  await link(owner, conversationId, "campaign");
  return {
    status: "prepared",
    message:
      "Campaign review card is available. The fixed Sandbox scenario needs explicit approval before it runs.",
  };
}
export async function startGiftDraft(owner: string, conversationId: string) {
  const l = await link(owner, conversationId, "gift", { version: 2 });
  return { status: "draft", message: "Choose who is contributing." };
}

export async function updateGiftDraft(user: { id: string; name: string }, conversationId: string, patch: { participantChoice?: "solo" | "invite"; title?: string; inviteComplete?: boolean; readyForBudget?: boolean }) {
  await ownedWorkspace(user.id, conversationId);
  const result = await authPool.query(
    `UPDATE workspace_workflow_links SET draft = draft || $3::jsonb || CASE WHEN NOT (draft ? 'initialTitle') AND ($3::jsonb ? 'title') THEN jsonb_build_object('initialTitle', $3::jsonb->'title') ELSE '{}'::jsonb END || CASE WHEN $3::jsonb @> '{"readyForBudget":true}'::jsonb THEN jsonb_build_object('setup', COALESCE(draft->'setup', '{"version":1,"questions":0,"lastReplyId":""}'::jsonb) || '{"phase":"ready"}'::jsonb) ELSE '{}'::jsonb END WHERE conversation_id=$1 AND kind='gift' AND draft->>'version'='2' AND EXISTS (SELECT 1 FROM workspace_chats WHERE id=$1 AND owner_id=$2) RETURNING resource_id,draft`,
    [conversationId, user.id, JSON.stringify(patch)],
  );
  const l = result.rows[0];
  if (!l) fail("GIFT_DRAFT_NOT_FOUND", 404);
  if (l.draft.title && l.draft.participantChoice) {
    const existing = (await authPool.query("SELECT id FROM gift_groups WHERE id=$1", [l.resource_id])).rows[0];
    if (!existing) await createGiftGroup(user, { id: l.resource_id, recipient: null, occasion: null, title: l.draft.title, reserveCents: 1000 });
    else if (patch.title !== undefined) await renameGiftGroup(user.id, l.resource_id, l.draft.title);
  }
  return { status: "saved" };
}
export async function prepareGift(
  user: { id: string; name: string },
  conversationId: string,
  draft: { recipient: string; occasion: string; reserveCents: number },
) {
  const l = await link(user.id, conversationId, "gift", draft);
  const prior = (
    await authPool.query("SELECT id,recipient FROM gift_groups WHERE id=$1", [
      l.resource_id,
    ])
  ).rows[0];
  if (
    (prior?.recipient || l.draft.recipient)?.toLowerCase() !==
    draft.recipient.toLowerCase()
  )
    fail("GIFT_ALREADY_LINKED_START_A_NEW_CHAT");
  if (!prior) await createGiftGroup(user, { id: l.resource_id, ...l.draft });
  await giftAccess(authPool, user.id, l.resource_id);
  return {
    status: "prepared",
    recipient: prior?.recipient || l.draft.recipient,
    message:
      "Gift group ready. Set your private contribution limit, invite friends and explicitly share the context you want their agents to use.",
  };
}
export async function readWorkspaceFlows(
  owner: string,
  conversationId: string,
) {
  await ownedWorkspace(owner, conversationId);
  const links = (
    await authPool.query(
      "SELECT * FROM workspace_workflow_links WHERE conversation_id=$1 ORDER BY created_at",
      [conversationId],
    )
  ).rows;
  return Promise.all(
    links.map(async (l) => {
      if (l.kind === "gift") {
        const exists = (
          await authPool.query("SELECT id FROM gift_groups WHERE id=$1", [
            l.resource_id,
          ])
        ).rows[0];
        return {
          kind: "gift" as const,
          id: l.id,
          resourceId: l.resource_id,
          draft: l.draft,
          state: exists
            ? ((await readGiftState(owner, l.resource_id)) as Extract<
                Awaited<ReturnType<typeof readGiftState>>,
                { group: unknown }
              >)
            : null,
        };
      }
      if (l.kind === "snack") {
        const office = (await authPool.query("SELECT owner_id FROM snack_offices WHERE id=$1", [l.resource_id])).rows[0];
        const team = office ? await readSnackMembers(owner, l.resource_id) : null;
        return { kind: "snack" as const, id: l.id, resourceId: l.resource_id, draft: l.draft, team, state: office?.owner_id === owner ? await snackOfficeState(owner, l.resource_id) : null };
      }
      const campaign =
        (
          await authPool.query(
            "SELECT id,scenario,approval,status,event_log,deal,batch_id,item_id FROM campaigns WHERE id=$1",
            [l.resource_id],
          )
        ).rows[0] ?? null;
      return {
        kind: "campaign" as const,
        id: l.id,
        resourceId: l.resource_id,
        approval,
        payoutReady: campaignPayoutReady(),
        offers: { payout: offers("payout"), review: offers("review") },
        state: campaign,
      };
    }),
  );
}
export async function workspaceFlowSummary(
  owner: string,
  conversationId: string,
) {
  const flows = await readWorkspaceFlows(owner, conversationId);
  return flows.map((f) =>
    f.kind === "snack" ? { kind: f.kind, office: f.team?.office, sharedPreferences: f.team?.members, status: (f.state as any)?.cycles?.[0]?.status ?? (f.team ? "joined" : "draft") } : f.kind === "campaign"
      ? {
          kind: f.kind,
          approval: f.approval,
          payoutReady: f.payoutReady,
          state: f.state,
        }
      : {
          kind: f.kind,
          group: f.state?.group,
          draft: f.draft,
          members: f.state?.members,
          me: f.state?.me,
          sharedContext: f.state?.facts,
          myContributions: f.state?.payments?.slice(0, 5).map((p: any) => ({
            id: p.id,
            status: p.status,
            cents: p.amount_cents,
            captureId: p.capture_id,
            currentPlan: p.digest === f.state?.option?.digest,
            error: p.error_code,
          })),
          latestJobs: f.state?.jobs?.slice(0, 2).map((j: any) => ({
            id: j.id,
            revision: j.revision,
            status:
              j.revision === f.state?.group.revision ? j.status : "outdated",
            summary:
              j.revision === f.state?.group.revision
                ? j.result?.summary
                : undefined,
            options: (j.revision === f.state?.group.revision
              ? j.result?.options
              : undefined
            )?.map((o: any) => ({
              id: o.id,
              title: o.title,
              totalCents: o.goalCents,
              products: o.lines?.map((p: any) => ({
                title: p.title,
                merchant: p.merchant,
                cents: p.cents,
                url: p.url,
              })),
            })),
          })),
          selected: f.state?.option,
        },
  );
}
export async function workspaceGiftAction(
  user: { id: string; name: string },
  conversationId: string,
  payload: unknown,
  origin: string,
) {
  await ownedWorkspace(user.id, conversationId);
  const l = (
    await authPool.query(
      "SELECT resource_id FROM workspace_workflow_links WHERE conversation_id=$1 AND kind='gift'",
      [conversationId],
    )
  ).rows[0];
  if (!l) fail("PREPARE_A_GIFT_GROUP_FIRST");
  if ((payload as any)?.action === "simulate_friends")
    return simulateGiftFriends(user.id, l.resource_id);
  if ((payload as any)?.action === "approve_simulated") {
    const { z } = await import("zod");
    return approveSimulatedFriends(
      user.id,
      l.resource_id,
      z
        .string()
        .regex(/^[a-f0-9]{64}$/)
        .parse((payload as any).digest),
    );
  }
  const parsed = giftActionInput.parse({
    ...(payload as object),
    groupId: l.resource_id,
  });
  if (["create", "join", "chat"].includes(parsed.action))
    fail("UNSUPPORTED_WORKSPACE_ACTION", 400);
  return executeGiftAction(
    user,
    parsed,
    origin,
    `/workspace?conversation=${conversationId}`,
  );
}
export async function shareWorkspaceContext(
  owner: string,
  conversationId: string,
  messageId: string,
  active: boolean,
) {
  await ownedWorkspace(owner, conversationId);
  const l = (
    await authPool.query(
      "SELECT resource_id FROM workspace_workflow_links WHERE conversation_id=$1 AND kind='gift'",
      [conversationId],
    )
  ).rows[0];
  if (!l) fail("PREPARE_A_GIFT_GROUP_FIRST");
  const { m } = await giftAccess(authPool, owner, l.resource_id);
  const msg = (
    await authPool.query(
      "SELECT content FROM workspace_chat_messages WHERE id=$1 AND conversation_id=$2 AND role='user' AND status='completed'",
      [messageId, conversationId],
    )
  ).rows[0];
  if (!msg) fail("MESSAGE_NOT_FOUND", 404);
  if (msg.content.length > 1500)
    fail("SHARE_A_MESSAGE_OF_AT_MOST_1500_CHARACTERS", 400);
  await authPool.query(
    "INSERT INTO gift_messages(id,member_id,role,content) VALUES($1,$2,'user',$3) ON CONFLICT DO NOTHING",
    [messageId, m.id, msg.content],
  );
  await shareGiftMessage(owner, l.resource_id, messageId, active);
}
export async function joinWorkspaceGift(
  user: { id: string; name: string },
  conversationId: string,
  token: string,
) {
  await ownedWorkspace(user.id, conversationId);
  const existing = (
    await authPool.query(
      "SELECT id FROM workspace_workflow_links WHERE conversation_id=$1 AND kind='gift'",
      [conversationId],
    )
  ).rows[0];
  if (existing) fail("THIS_CHAT_ALREADY_HAS_A_GIFT_GROUP");
  const joined = await joinGiftGroup(user, token);
  await link(user.id, conversationId, "gift", {}, joined.id);
}
export async function approveWorkspaceCampaign(
  owner: string,
  conversationId: string,
  scenario: "payout" | "review",
) {
  await ownedWorkspace(owner, conversationId);
  const l = (
    await authPool.query(
      "SELECT resource_id FROM workspace_workflow_links WHERE conversation_id=$1 AND kind='campaign'",
      [conversationId],
    )
  ).rows[0];
  if (!l) fail("PREPARE_A_CAMPAIGN_FIRST");
  const response = await startApprovedCampaign({ id: l.resource_id, scenario });
  if (!response.ok) {
    const body = await response.json();
    fail(body.error, response.status);
  }
}

export async function shareGroupFeedback(
  owner: string,
  conversationId: string,
  id: string,
  text: string,
) {
  await ownedWorkspace(owner, conversationId);
  const l = (
    await authPool.query(
      "SELECT resource_id FROM workspace_workflow_links WHERE conversation_id=$1 AND kind='gift'",
      [conversationId],
    )
  ).rows[0];
  if (!l) fail("PREPARE_A_GIFT_GROUP_FIRST");
  const { transaction } = await import("./agent-store");
  await transaction(async (c) => {
    const { m } = await giftAccess(c, owner, l.resource_id, true);
    const prior = (
      await c.query("SELECT member_id,content FROM gift_messages WHERE id=$1", [
        id,
      ])
    ).rows[0];
    if (prior) {
      if (prior.member_id !== m.id || prior.content !== text)
        fail("GIFT_REQUEST_CONFLICT");
      return;
    }
    if (
      !hasUnlimitedTestingAccess(owner) && +(
        await c.query("SELECT count(*) FROM gift_messages WHERE member_id=$1", [
          m.id,
        ])
      ).rows[0].count >= 100
    )
      fail("GIFT_CHAT_LIMIT", 429);
    await c.query(
      "INSERT INTO gift_messages(id,member_id,role,content) VALUES($1,$2,'user',$3)",
      [id, m.id, text],
    );
  });
  await shareGiftMessage(owner, l.resource_id, id, true);
}

// A signed-in invitee may work only inside a gift group they actually joined.
// Invitations do not grant admission to unrelated campaigns or new groups.
export async function hasWorkspaceGiftMembership(
  owner: string,
  conversationId: string,
) {
  return Boolean(
    (
      await authPool.query(
        `SELECT 1 FROM workspace_chats c
    JOIN workspace_workflow_links l ON l.conversation_id=c.id AND l.kind='gift'
    JOIN gift_members m ON m.group_id=l.resource_id AND m.user_id=c.owner_id
    WHERE c.id=$1 AND c.owner_id=$2 AND NOT m.simulated`,
        [conversationId, owner],
      )
    ).rowCount,
  );
}
