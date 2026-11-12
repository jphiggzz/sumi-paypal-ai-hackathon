import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { authPool } from "../lib/auth";
import { createGiftGroup } from "../lib/gift-store";

const user = { id: randomUUID(), name: "Capacity test" };
try {
  await authPool.query('INSERT INTO auth_users(id,name,email,"emailVerified","createdAt","updatedAt") VALUES($1,$2,$3,false,now(),now())', [user.id, user.name, `gift-capacity-${user.id}@example.invalid`]);
  for (let i = 0; i < 6; i++) {
    await createGiftGroup(user, { id: randomUUID(), recipient: null, occasion: null, title: `Gift ${i + 1}`, reserveCents: 1000 });
  }
  const count = await authPool.query("SELECT count(*)::int AS count FROM gift_groups WHERE owner_id=$1", [user.id]);
  assert.equal(count.rows[0].count, 6);
  console.log("Created six synthetic gifts for one account.");
} finally {
  await authPool.query("DELETE FROM auth_users WHERE id=$1", [user.id]);
  await authPool.end();
}
