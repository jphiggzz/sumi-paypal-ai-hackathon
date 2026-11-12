import { createHash, randomBytes, randomUUID } from "node:crypto";
import type { PoolClient } from "pg";
import { authPool } from "./auth";
import { canUsePriorRound } from "./gift-history";
import { canonicalJson } from "./canonical-json";
import { hasUnlimitedTestingAccess } from "./testing-access";
import { transaction } from "./agent-store";
import { CapabilityError } from "./capability-contracts";
import { giftDigest, verifyGiftOrder, type GiftProduct } from "./gift-policy";
import { contributionOrder, giftPayPal } from "./gift-paypal";
export const giftError = (code: string, status = 409): never => {
  throw new CapabilityError(code, status);
};
// Keep a bounded per-owner quota while allowing repeated prototype sessions.
export const GIFT_GROUP_LIMIT = 50;
const hash = (s: string) => createHash("sha256").update(s).digest("hex");
export async function giftAccess(
  c: Pick<PoolClient, "query">,
  user: string,
  id: string,
  lock = false,
) {
  const g = (
    await c.query(
      `SELECT * FROM gift_groups WHERE id=$1${lock ? " FOR UPDATE" : ""}`,
      [id],
    )
  ).rows[0];
  const m = (
    await c.query(
      "SELECT * FROM gift_members WHERE group_id=$1 AND user_id=$2",
      [id, user],
    )
  ).rows[0];
  if (!g || !m) giftError("GIFT_NOT_FOUND", 404);
  return { g, m };
}
export async function invalidate(c: PoolClient, id: string) {
  await c.query(
    "UPDATE gift_groups SET revision=revision+1,selected_job=null,selected_option=null WHERE id=$1",
    [id],
  );
  await c.query(
    "UPDATE gift_members SET approved_digest=null WHERE group_id=$1",
    [id],
  );
}
export async function createGiftGroup(
  user: { id: string; name: string },
  v: { id: string; recipient: string | null; occasion: string | null; reserveCents: number; title?: string | null },
) {
  return transaction(async (c) => {
    await c.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", [
      "gifts:" + user.id,
    ]);
    const prior = (
      await c.query("SELECT * FROM gift_groups WHERE id=$1", [v.id])
    ).rows[0];
    if (prior) {
      if (
        prior.owner_id !== user.id ||
        prior.recipient !== v.recipient ||
        prior.occasion !== v.occasion ||
        prior.reserve_cents !== v.reserveCents ||
        (v.title !== undefined && prior.title !== v.title)
      )
        giftError("GIFT_CREATE_CONFLICT");
      if (v.title !== undefined) return { id: v.id };
      const token = randomBytes(32).toString("base64url");
      await c.query("UPDATE gift_groups SET invite_hash=$2 WHERE id=$1", [
        v.id,
        hash(token),
      ]);
      return { id: v.id, inviteToken: token };
    }
    if (
      !hasUnlimitedTestingAccess(user.id) && +(
        await c.query("SELECT count(*) FROM gift_groups WHERE owner_id=$1", [
          user.id,
        ])
      ).rows[0].count >= GIFT_GROUP_LIMIT
    )
      giftError("GIFT_GROUP_LIMIT", 429);
    const token = randomBytes(32).toString("base64url");
    await c.query(
      "INSERT INTO gift_groups(id,owner_id,recipient,occasion,reserve_cents,invite_hash,title) VALUES($1,$2,$3,$4,$5,$6,$7)",
      [v.id, user.id, v.recipient, v.occasion, v.reserveCents, hash(token), v.title ?? null],
    );
    await c.query(
      "INSERT INTO gift_members(id,group_id,user_id,name) VALUES($1,$2,$3,$4)",
      [randomUUID(), v.id, user.id, user.name.slice(0, 80)],
    );
    return { id: v.id, inviteToken: token };
  });
}
export async function renameGiftGroup(user: string, id: string, title: string) {
  return transaction(async (c) => {
    const { g } = await giftAccess(c, user, id, true);
    if (g.owner_id !== user) giftError("GIFT_ORGANIZER_ONLY", 403);
    if (g.title === title) return;
    await c.query("UPDATE gift_groups SET title=$2 WHERE id=$1", [id, title]);
    await invalidate(c, id);
  });
}
export async function joinGiftGroup(
  user: { id: string; name: string },
  token: string,
) {
  return transaction(async (c) => {
    const g = (
      await c.query(
        "SELECT * FROM gift_groups WHERE invite_hash=$1 FOR UPDATE",
        [hash(token)],
      )
    ).rows[0];
    if (!g) giftError("GIFT_INVITE_INVALID", 404);
    const prior = (
      await c.query(
        "SELECT id FROM gift_members WHERE group_id=$1 AND user_id=$2",
        [g.id, user.id],
      )
    ).rows[0];
    if (prior) return { id: g.id };
    if (
      +(
        await c.query("SELECT count(*) FROM gift_members WHERE group_id=$1", [
          g.id,
        ])
      ).rows[0].count >= 8
    )
      giftError("GIFT_GROUP_FULL");
    await c.query(
      "INSERT INTO gift_members(id,group_id,user_id,name) VALUES($1,$2,$3,$4)",
      [randomUUID(), g.id, user.id, user.name.slice(0, 80)],
    );
    await invalidate(c, g.id);
    return { id: g.id };
  });
}
export async function rotateGiftInvite(user: string, id: string) {
  return transaction(async (c) => {
    const { g } = await giftAccess(c, user, id, true);
    if (g.owner_id !== user) giftError("GIFT_ORGANIZER_ONLY", 403);
    const token = randomBytes(32).toString("base64url");
    await c.query("UPDATE gift_groups SET invite_hash=$2 WHERE id=$1", [
      id,
      hash(token),
    ]);
    return token;
  });
}
export async function currentGiftOption(c: Pick<PoolClient, "query">, g: any) {
  if (!g.selected_job || !g.selected_option) return null;
  const j = (
    await c.query(
      "SELECT * FROM gift_jobs WHERE id=$1 AND group_id=$2 AND kind='plan' AND status='ready' AND revision=$3",
      [g.selected_job, g.id, g.revision],
    )
  ).rows[0];
  const option = j?.result?.options?.find(
    (o: any) => o.id === g.selected_option,
  );
  return option
    ? { ...option, digest: giftDigest(g.id, g.revision, j.id, option) }
    : null;
}
export async function readGiftState(user: string, id?: string) {
  if (!id)
    return {
      groups: (
        await authPool.query(
          "SELECT g.id,g.recipient,g.occasion FROM gift_groups g JOIN gift_members m ON m.group_id=g.id WHERE m.user_id=$1 ORDER BY g.created_at DESC",
          [user],
        )
      ).rows,
    };
  return transaction(async (c) => {
    const { g, m } = await giftAccess(c, user, id, true);
    const members = (
      await c.query(
        "SELECT id,name,approved_digest,simulated FROM gift_members WHERE group_id=$1 ORDER BY id",
        [id],
      )
    ).rows;
    const facts = (
      await c.query(
        "SELECT f.id,f.message_id,f.member_id,m.name,f.content FROM gift_facts f JOIN gift_members m ON m.id=f.member_id WHERE m.group_id=$1 AND f.active ORDER BY f.created_at",
        [id],
      )
    ).rows;
    const messages = (
      await c.query(
        "SELECT id,role,content,created_at FROM gift_messages WHERE member_id=$1 ORDER BY created_at,id",
        [m.id],
      )
    ).rows;
    const jobs = (
      await c.query(
        "SELECT id,kind,status,revision,result,error_code,input FROM gift_jobs WHERE group_id=$1 AND (kind='plan' OR member_id=$2) ORDER BY created_at DESC LIMIT 20",
        [id, m.id],
      )
    ).rows;
    const payments = (
      await c.query(
        "SELECT id,digest,amount_cents,status,order_id,approval_url,capture_id,error_code FROM gift_contributions WHERE member_id=$1 ORDER BY created_at DESC",
        [m.id],
      )
    ).rows;
    const funded = +(
      await c.query(
        "SELECT COALESCE(sum(amount_cents),0) AS cents FROM gift_contributions WHERE group_id=$1 AND status='completed'",
        [id],
      )
    ).rows[0].cents;
    const budget = +(
      await c.query(
        "SELECT sum(limit_cents) AS cents FROM gift_members WHERE group_id=$1",
        [id],
      )
    ).rows[0].cents;
    const option = await currentGiftOption(c, g);
    return {
      group: {
        id: g.id,
        recipient: g.recipient,
        occasion: g.occasion,
        title: g.title,
        revision: g.revision,
        reserveCents: g.reserve_cents,
        organizer: g.owner_id === user,
        orderReference: g.order_reference,
        budgetCents: budget,
        fundedCents: funded,
      },
      me: {
        id: m.id,
        name: m.name,
        limitCents: m.limit_cents,
        approvedDigest: m.approved_digest,
      },
      members: members.map((x) => ({
        id: x.id,
        name: x.name,
        simulated: x.simulated,
        approved: Boolean(option && x.approved_digest === option.digest),
      })),
      facts,
      messages,
      jobs: jobs.map(({ input, ...job }) => {
        if (job.kind !== "plan" || job.revision === g.revision) return job;
        const safe = canUsePriorRound(input, facts.map((fact: any) => fact.id), members.map((member: any) => member.id));
        return { ...job, result: safe ? job.result : null, historical: safe };
      }),
      payments,
      option,
      channel3Configured: Boolean(process.env.CHANNEL3_API_KEY),
      paypalConfigured: Boolean(
        process.env.PAYPAL_SANDBOX_CLIENT_ID &&
        process.env.PAYPAL_SANDBOX_CLIENT_SECRET,
      ),
    };
  });
}
export async function setGiftLimit(user: string, id: string, cents: number) {
  return transaction(async (c) => {
    const { m } = await giftAccess(c, user, id, true);
    const committed = +(
      await c.query(
        "SELECT COALESCE(sum(amount_cents),0) AS cents FROM gift_contributions WHERE member_id=$1 AND status NOT IN ('cancelled','failed')",
        [m.id],
      )
    ).rows[0].cents;
    if (cents < committed) giftError("GIFT_LIMIT_BELOW_COMMITTED");
    if (m.limit_cents === cents) return;
    await c.query("UPDATE gift_members SET limit_cents=$2 WHERE id=$1", [
      m.id,
      cents,
    ]);
    await invalidate(c, id);
  });
}
export async function shareGiftMessage(
  user: string,
  id: string,
  messageId: string,
  active: boolean,
) {
  return transaction(async (c) => {
    const { m } = await giftAccess(c, user, id, true);
    const message = (
      await c.query(
        "SELECT * FROM gift_messages WHERE id=$1 AND member_id=$2 AND role='user'",
        [messageId, m.id],
      )
    ).rows[0];
    if (!message) giftError("GIFT_PRIVATE_MESSAGE_NOT_FOUND", 404);
    const prior = (
      await c.query("SELECT * FROM gift_facts WHERE message_id=$1", [messageId])
    ).rows[0];
    if (prior?.active === active) return;
    if (prior)
      await c.query("UPDATE gift_facts SET active=$2 WHERE id=$1", [
        prior.id,
        active,
      ]);
    else if (active)
      await c.query(
        "INSERT INTO gift_facts(id,member_id,message_id,content) VALUES($1,$2,$3,$4)",
        [randomUUID(), m.id, messageId, message.content],
      );
    else return;
    await invalidate(c, id);
  });
}
export async function admitGiftJob(
  user: string,
  groupId: string,
  id: string,
  kind: "chat" | "plan",
  text: string | undefined,
  deadline: number,
  seed?: { jobId: string; productId: string; similar: boolean; chatMessageId?: string },
) {
  return transaction(async (c) => {
    const { g, m } = await giftAccess(c, user, groupId, true);
    const existing = (
      await c.query("SELECT * FROM gift_jobs WHERE id=$1", [id])
    ).rows[0];
    if (existing) {
      if (
        existing.member_id !== m.id ||
        existing.kind !== kind ||
        existing.input.text !== text ||
        canonicalJson(existing.input.seedRequest ?? null) !== canonicalJson(seed ?? null)
      )
        giftError("GIFT_REQUEST_CONFLICT");
      return;
    }
    if (
      kind === "plan" &&
      (
        await c.query(
          "SELECT id FROM gift_jobs WHERE group_id=$1 AND kind='plan' AND status IN ('queued','running') LIMIT 1",
          [groupId],
        )
      ).rowCount
    )
      giftError("GIFT_PLAN_ALREADY_RUNNING");
    if (
      !hasUnlimitedTestingAccess(user) && +(
        await c.query(
          "SELECT count(*) FROM gift_jobs WHERE member_id=$1 AND created_at>now()-interval '1 day'",
          [m.id],
        )
      ).rows[0].count >= 30
    )
      giftError("GIFT_DAILY_JOB_LIMIT", 429);
    let input: any;
    if (kind === "chat") {
      if (
        !hasUnlimitedTestingAccess(user) && +(
          await c.query(
            "SELECT count(*) FROM gift_messages WHERE member_id=$1",
            [m.id],
          )
        ).rows[0].count >= 100
      )
        giftError("GIFT_CHAT_LIMIT", 429);
      await c.query(
        "INSERT INTO gift_messages(id,member_id,role,content) VALUES($1,$2,'user',$3)",
        [id, m.id, text],
      );
      input = {
        text,
        recipient: g.recipient,
        occasion: g.occasion,
        title: g.title,
        messages: (
          await c.query(
            "SELECT role,content FROM gift_messages WHERE member_id=$1 ORDER BY created_at DESC LIMIT 12",
            [m.id],
          )
        ).rows.reverse(),
      };
    } else {
      const facts = (
        await c.query(
          "SELECT f.id,f.member_id,m.name,f.content FROM gift_facts f JOIN gift_members m ON m.id=f.member_id WHERE m.group_id=$1 AND f.active ORDER BY f.created_at",
          [groupId],
        )
      ).rows;
      const budget = +(
        await c.query(
          "SELECT sum(limit_cents) AS cents FROM gift_members WHERE group_id=$1",
          [groupId],
        )
      ).rows[0].cents;
      if (!facts.length || budget <= g.reserve_cents)
        giftError("GIFT_NEEDS_SHARED_CONTEXT_AND_BUDGET");
      if (facts.length > 40) giftError("GIFT_SHARED_CONTEXT_LIMIT", 429);
      const members = (await c.query("SELECT id,name,simulated FROM gift_members WHERE group_id=$1 ORDER BY id", [groupId])).rows;
      const soloDraft = (await c.query("SELECT 1 FROM workspace_workflow_links WHERE resource_id=$1 AND kind='gift' AND draft->>'participantChoice'='solo' LIMIT 1", [groupId])).rowCount;
      const prior = (await c.query("SELECT input,result FROM gift_jobs WHERE group_id=$1 AND kind='plan' AND status='ready' ORDER BY created_at DESC LIMIT 1", [groupId])).rows[0];
      const priorSafe = prior && canUsePriorRound(prior.input, facts.map((fact: any) => fact.id), members.map((member: any) => member.id));
      const previousOptions = priorSafe && Array.isArray(prior.result?.options) ? prior.result.options.slice(0, 3).map((option: any) => ({ title: String(option.title).slice(0, 100), products: Array.isArray(option.lines) ? option.lines.slice(0, 3).map((product: any) => ({ title: String(product.title).slice(0, 500), merchant: String(product.merchant).slice(0, 200) })) : [] })) : [];
      let seedProduct: any = undefined;
      if (seed) {
        if (seed.chatMessageId) {
          const message = await c.query("SELECT 1 FROM workspace_chat_messages m JOIN workspace_chats w ON w.id=m.conversation_id JOIN workspace_workflow_links l ON l.conversation_id=w.id AND l.kind='gift' WHERE m.id=$1 AND m.role='user' AND w.owner_id=$2 AND l.resource_id=$3", [seed.chatMessageId, user, groupId]);
          if (!message.rowCount) giftError("GIFT_MESSAGE_NOT_FOUND", 404);
        }
        const source = (await c.query("SELECT input,result FROM gift_jobs WHERE id=$1 AND group_id=$2 AND kind='plan' AND status='ready'", [seed.jobId, groupId])).rows[0];
        if (!source || !canUsePriorRound(source.input, facts.map((fact: any) => fact.id), members.map((member: any) => member.id))) giftError("GIFT_PLAN_STALE");
        seedProduct = source.result?.options?.flatMap((option: any) => option.lines || []).find((product: any) => product.id === seed.productId);
        if (!seedProduct) giftError("GIFT_PRODUCT_NOT_FOUND", 404);
      }
      input = {
        seedRequest: seed ?? null,
        seedProduct: seedProduct ? { id: seedProduct.id, title: seedProduct.title, merchant: seedProduct.merchant, similar: seed!.similar } : undefined,
        recipient: g.recipient,
        occasion: g.occasion,
        title: g.title,
        facts,
        members,
        soloPerspectives: Boolean(soloDraft && members.length === 1 && !members[0].simulated),
        previousOptions,
        budgetCents: budget,
        reserveCents: g.reserve_cents,
      };
    }
    await c.query(
      "INSERT INTO gift_jobs(id,group_id,member_id,kind,revision,input) VALUES($1,$2,$3,$4,$5,$6)",
      [id, groupId, m.id, kind, g.revision, JSON.stringify(input)],
    );
    if (Date.now() > deadline) giftError("GIFT_ADMISSION_EXPIRED");
  });
}
export async function claimGiftJob(id: string) {
  return transaction(async (c) => {
    const r = (
      await c.query("SELECT * FROM gift_jobs WHERE id=$1 FOR UPDATE", [id])
    ).rows[0];
    if (!r) return { missing: true as const };
    if (!["queued", "running"].includes(r.status)) return null;
    if (r.status === "running" && r.lease_until > new Date())
      return { busy: true as const };
    if (r.attempts >= 2) {
      await c.query(
        "UPDATE gift_jobs SET status='failed',error_code='GIFT_RETRIES_EXHAUSTED' WHERE id=$1",
        [id],
      );
      return null;
    }
    const g = (
      await c.query("SELECT revision FROM gift_groups WHERE id=$1", [
        r.group_id,
      ])
    ).rows[0];
    if (r.kind === "plan" && g.revision !== r.revision) {
      await c.query("UPDATE gift_jobs SET status='cancelled' WHERE id=$1", [
        id,
      ]);
      return null;
    }
    await c.query(
      "UPDATE gift_jobs SET status='running',attempts=attempts+1,lease_until=now()+interval '10 minutes' WHERE id=$1",
      [id],
    );
    return { ...r, attempt: r.attempts + 1 };
  });
}
export async function completeGiftJob(
  id: string,
  attempt: number,
  result: any,
) {
  // Consistent group → job lock order with API mutations.
  return transaction(async (c) => {
    const r0 = (
      await c.query("SELECT group_id FROM gift_jobs WHERE id=$1", [id])
    ).rows[0];
    if (!r0) return;
    const g = (
      await c.query("SELECT * FROM gift_groups WHERE id=$1 FOR UPDATE", [
        r0.group_id,
      ])
    ).rows[0];
    const r = (
      await c.query("SELECT * FROM gift_jobs WHERE id=$1 FOR UPDATE", [id])
    ).rows[0];
    if (r.status !== "running" || r.attempts !== attempt) return;
    if (r.kind === "plan" && g.revision !== r.revision) {
      await c.query("UPDATE gift_jobs SET status='cancelled' WHERE id=$1", [
        id,
      ]);
      return;
    }
    if (r.kind === "chat")
      await c.query(
        "INSERT INTO gift_messages(id,member_id,role,content) VALUES($1,$2,'assistant',$3)",
        [randomUUID(), r.member_id, result.reply],
      );
    await c.query(
      "UPDATE gift_jobs SET status='ready',result=$2,lease_until=null WHERE id=$1",
      [id, JSON.stringify(result)],
    );
  });
}
export async function failGiftJob(id: string, attempt: number) {
  await authPool.query(
    "UPDATE gift_jobs SET status='failed',error_code='GIFT_AGENT_FAILED',lease_until=null WHERE id=$1 AND attempts=$2 AND status='running'",
    [id, attempt],
  );
}
export async function selectGiftOption(
  user: string,
  groupId: string,
  jobId: string,
  optionId: string,
) {
  return transaction(async (c) => {
    const { g } = await giftAccess(c, user, groupId, true);
    if (g.owner_id !== user) giftError("GIFT_ORGANIZER_ONLY", 403);
    const j = (
      await c.query(
        "SELECT * FROM gift_jobs WHERE id=$1 AND group_id=$2 AND kind='plan' AND status='ready' AND revision=$3",
        [jobId, groupId, g.revision],
      )
    ).rows[0];
    if (!j?.result?.options?.some((o: any) => o.id === optionId))
      giftError("GIFT_PLAN_STALE");
    if (g.selected_job === jobId && g.selected_option === optionId) return;
    await c.query(
      "UPDATE gift_groups SET selected_job=$2,selected_option=$3 WHERE id=$1",
      [groupId, jobId, optionId],
    );
    await c.query(
      "UPDATE gift_members SET approved_digest=null WHERE group_id=$1",
      [groupId],
    );
  });
}
export async function approveGiftOption(
  user: string,
  groupId: string,
  digest: string,
) {
  return transaction(async (c) => {
    const { g, m } = await giftAccess(c, user, groupId, true);
    const o = await currentGiftOption(c, g);
    if (
      !o ||
      o.digest !== digest ||
      o.lines.some(
        (p: GiftProduct) => Date.now() - Date.parse(p.retrievedAt) > 86400000,
      )
    )
      giftError("GIFT_PLAN_STALE");
    await c.query("UPDATE gift_members SET approved_digest=$2 WHERE id=$1", [
      m.id,
      digest,
    ]);
  });
}
export async function fundGift(
  user: string,
  groupId: string,
  id: string,
  digest: string,
  cents: number,
  origin: string,
  returnPath = `/gifts?group=${groupId}`,
  approveOnCheckout = false,
) {
  // Keep the reservation durable before contacting PayPal; a failed network call
  // remains reserved and can only reuse this contribution's idempotency key.
  await transaction(async (c) => {
    const { g, m } = await giftAccess(c, user, groupId, true);
    if (m.simulated) giftError("SIMULATED_FRIEND_CANNOT_PAY", 403);
    const prior = (
      await c.query("SELECT * FROM gift_contributions WHERE id=$1", [id])
    ).rows[0];
    if (prior) {
      if (
        prior.member_id !== m.id ||
        prior.digest !== digest ||
        prior.amount_cents !== cents
      )
        giftError("GIFT_CONTRIBUTION_CONFLICT");
      if (approveOnCheckout) {
        const current = await currentGiftOption(c, g);
        if (!current || current.digest !== digest || m.approved_digest !== digest)
          giftError("GIFT_PLAN_CHANGED_BEFORE_PAYMENT");
      }
      return;
    }
    const option = await currentGiftOption(c, g);
    if (!option || option.digest !== digest || (!approveOnCheckout && m.approved_digest !== digest))
      giftError("GIFT_APPROVAL_REQUIRED");
    if (
      option.lines.some(
        (p: GiftProduct) => Date.now() - Date.parse(p.retrievedAt) > 86400000,
      )
    )
      giftError("GIFT_PLAN_STALE");
    const mine = +(
      await c.query(
        "SELECT COALESCE(sum(amount_cents),0) AS cents FROM gift_contributions WHERE member_id=$1 AND status NOT IN ('failed','cancelled')",
        [m.id],
      )
    ).rows[0].cents;
    const total = +(
      await c.query(
        "SELECT COALESCE(sum(amount_cents),0) AS cents FROM gift_contributions WHERE group_id=$1 AND status NOT IN ('failed','cancelled')",
        [groupId],
      )
    ).rows[0].cents;
    if (mine + cents > m.limit_cents || total + cents > option.goalCents)
      giftError("GIFT_CONTRIBUTION_LIMIT");
    if (approveOnCheckout) await c.query("UPDATE gift_members SET approved_digest=$2 WHERE id=$1", [m.id, digest]);
    await c.query(
      "INSERT INTO gift_contributions(id,group_id,member_id,digest,amount_cents) VALUES($1,$2,$3,$4,$5)",
      [id, groupId, m.id, digest, cents],
    );
  });
  return transaction(async (c) => {
    const { g, m } = await giftAccess(c, user, groupId, true);
    const p = (
      await c.query("SELECT * FROM gift_contributions WHERE id=$1 FOR UPDATE", [
        id,
      ])
    ).rows[0];
    if (p.order_id) return;
    const option = await currentGiftOption(c, g);
    if (!option || option.digest !== p.digest || m.approved_digest !== p.digest) giftError("GIFT_PLAN_CHANGED_BEFORE_PAYMENT");
    if (Date.now() - new Date(p.created_at).getTime() > 5 * 3600000)
      giftError("GIFT_ORDER_REQUIRES_REVIEW");
    try {
      const separator = returnPath.includes("?") ? "&" : "?";
      const result = await giftPayPal(
        "/v2/checkout/orders",
        "POST",
        contributionOrder(
          id,
          cents,
          `${origin}${returnPath}${separator}contribution=${id}`,
          `${origin}${returnPath}${separator}cancelled=${id}`,
        ),
        id,
      );
      const data = result.data;
      const link = data.links?.find((l: any) =>
        ["payer-action", "approve"].includes(l.rel),
      )?.href;
      if (
        !result.ok ||
        typeof data.id !== "string" ||
        !link ||
        ![
          "https://www.sandbox.paypal.com",
          "https://sandbox.paypal.com",
        ].includes(new URL(link).origin)
      )
        throw new Error("PAYPAL_CREATE_UNCERTAIN");
      const detail = await giftPayPal("/v2/checkout/orders/" + data.id);
      const merchant = detail.data.purchase_units?.[0]?.payee?.merchant_id;
      if (!detail.ok || typeof merchant !== "string")
        throw new Error("PAYPAL_CREATE_UNCERTAIN");
      verifyGiftOrder(detail.data, {
        ...p,
        order_id: data.id,
        merchant_id: merchant,
      });
      await c.query(
        "UPDATE gift_contributions SET status='created',order_id=$2,merchant_id=$3,approval_url=$4,error_code=null WHERE id=$1",
        [id, data.id, merchant, link],
      );
    } catch {
      await c.query(
        "UPDATE gift_contributions SET status='needs_review',error_code='PAYPAL_CREATE_UNCERTAIN' WHERE id=$1",
        [id],
      );
    }
  });
}
export async function captureGift(
  user: string,
  groupId: string,
  id: string,
  reconcileOnly = false,
) {
  return transaction(async (c) => {
    const { g, m } = await giftAccess(c, user, groupId, true);
    const p = (
      await c.query(
        "SELECT * FROM gift_contributions WHERE id=$1 AND group_id=$2 AND member_id=$3 FOR UPDATE",
        [id, groupId, m.id],
      )
    ).rows[0];
    if (!p?.order_id) giftError("GIFT_CONTRIBUTION_NOT_FOUND", 404);
    if (p.status === "completed") return;
    try {
      let read = await giftPayPal("/v2/checkout/orders/" + p.order_id);
      if (!read.ok) throw new Error();
      let captured = verifyGiftOrder(read.data, p);
      if (!captured && read.data.status === "APPROVED" && !reconcileOnly) {
        const option = await currentGiftOption(c, g);
        if (
          !option ||
          option.digest !== p.digest ||
          m.approved_digest !== p.digest
        )
          giftError("GIFT_PLAN_CHANGED_BEFORE_CAPTURE");
        await giftPayPal(
          `/v2/checkout/orders/${p.order_id}/capture`,
          "POST",
          {},
          "capture-" + id,
        );
        read = await giftPayPal("/v2/checkout/orders/" + p.order_id);
        if (!read.ok) throw new Error();
        captured = verifyGiftOrder(read.data, p);
      }
      if (!captured && read.data.status === "COMPLETED")
        throw new Error("PAYPAL_CAPTURE_MISSING");
      if (captured)
        await c.query(
          "UPDATE gift_contributions SET status='completed',capture_id=$2,error_code=null WHERE id=$1",
          [id, captured.id],
        );
      else
        await c.query(
          "UPDATE gift_contributions SET status=$2,error_code=null WHERE id=$1",
          [id, read.data.status === "VOIDED" ? "cancelled" : "created"],
        );
    } catch (e) {
      if (e instanceof CapabilityError) throw e;
      await c.query(
        "UPDATE gift_contributions SET status='needs_review',error_code='PAYPAL_RECONCILE_REQUIRED' WHERE id=$1",
        [id],
      );
    }
  });
}
export async function recordGiftPurchase(
  user: string,
  groupId: string,
  digest: string,
  reference: string,
) {
  return transaction(async (c) => {
    const { g } = await giftAccess(c, user, groupId, true);
    if (g.owner_id !== user) giftError("GIFT_ORGANIZER_ONLY", 403);
    const option = await currentGiftOption(c, g);
    if (!option || option.digest !== digest) giftError("GIFT_PLAN_STALE");
    const pending = +(
      await c.query(
        "SELECT count(*) FROM gift_members WHERE group_id=$1 AND approved_digest IS DISTINCT FROM $2",
        [groupId, digest],
      )
    ).rows[0].count;
    const funded = +(
      await c.query(
        "SELECT COALESCE(sum(amount_cents),0) AS cents FROM gift_contributions WHERE group_id=$1 AND status='completed'",
        [groupId],
      )
    ).rows[0].cents;
    if (pending || funded < option.goalCents)
      giftError("GIFT_NEEDS_APPROVALS_AND_FUNDING");
    await c.query("UPDATE gift_groups SET order_reference=$2 WHERE id=$1", [
      groupId,
      reference,
    ]);
  });
}
