import { randomUUID } from "node:crypto";
import { transaction } from "./agent-store";
import {
  currentGiftOption,
  giftAccess,
  giftError,
  invalidate,
} from "./gift-store";

// These accounts have no authentication sessions or credentials. They can never
// impersonate an invited person or call checkout. Only the organizer can add them.
export async function simulateGiftFriends(user: string, groupId: string) {
  return transaction(async (c) => {
    const { g } = await giftAccess(c, user, groupId, true);
    if (g.owner_id !== user) giftError("GIFT_ORGANIZER_ONLY", 403);
    const existing = (
      await c.query("SELECT id,simulated FROM gift_members WHERE group_id=$1", [
        groupId,
      ])
    ).rows;
    if (existing.some((m) => m.simulated)) return;
    if (existing.length > 6) giftError("GIFT_GROUP_FULL");
    const samples = [
      [
        "Casey",
        "I prefer one thoughtful, useful gift over a bundle of filler. Please consider what the others know about the recipient and avoid duplicates.",
      ],
      [
        "Jordan",
        "I prefer something compact and easy to keep. Compare the actual products and prices with the others before recommending a gift.",
      ],
    ];
    for (const [name, note] of samples) {
      const actor = randomUUID(),
        member = randomUUID(),
        message = randomUUID();
      await c.query(
        'INSERT INTO auth_users(id,name,email,"emailVerified","createdAt","updatedAt") VALUES($1,$2,$3,false,now(),now())',
        [actor, name, `gift-simulated-${actor}@example.invalid`],
      );
      await c.query(
        "INSERT INTO gift_members(id,group_id,user_id,name,limit_cents,simulated) VALUES($1,$2,$3,$4,3000,true)",
        [member, groupId, actor, name],
      );
      await c.query(
        "INSERT INTO gift_messages(id,member_id,role,content) VALUES($1,$2,'user',$3)",
        [message, member, note],
      );
      await c.query(
        "INSERT INTO gift_facts(id,member_id,message_id,content) VALUES($1,$2,$3,$4)",
        [randomUUID(), member, message, note],
      );
    }
    await invalidate(c, groupId);
  });
}

export async function approveSimulatedFriends(
  user: string,
  groupId: string,
  digest: string,
) {
  return transaction(async (c) => {
    const { g } = await giftAccess(c, user, groupId, true);
    if (g.owner_id !== user) giftError("GIFT_ORGANIZER_ONLY", 403);
    const option = await currentGiftOption(c, g);
    if (
      !option ||
      option.digest !== digest ||
      option.lines.some(
        (p: any) => Date.now() - Date.parse(p.retrievedAt) > 86400000,
      )
    )
      giftError("GIFT_PLAN_STALE");
    // Explicit demo control: never approves a real member or creates fake funding.
    await c.query(
      "UPDATE gift_members SET approved_digest=$2 WHERE group_id=$1 AND simulated",
      [groupId, digest],
    );
  });
}
