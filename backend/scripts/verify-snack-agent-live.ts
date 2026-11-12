/** Synthetic user and brief; one real budgeted model call. No payment or supplier calls. */
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { betterAuth } from "better-auth";
import { authPool } from "../lib/auth";
import { saveSnackOffice } from "../lib/snack-store";
import { joinSnackOffice, snackInvite, snackPrivateChat, readSnackMembers } from "../lib/snack-members";
import { defaultSnackSettings } from "../lib/snack-policy";
const auth = betterAuth({ secret: process.env.BETTER_AUTH_SECRET, baseURL:"http://localhost:3016", database:authPool,user:{modelName:"auth_users"},session:{modelName:"auth_sessions"},account:{modelName:"auth_accounts"},verification:{modelName:"auth_verifications"},emailAndPassword:{enabled:true} });
const users: any[]=[];
try {
 for (let i=0;i<2;i++) {const r=await auth.api.signUpEmail({body:{email:`snack-agent-${randomUUID()}@example.invalid`,name:`Synthetic ${i}`,password:randomUUID()+randomUUID()},asResponse:true}); assert.equal(r.status,200); users.push((await r.json()).user);}
 const office=randomUUID(); await saveSnackOffice(users[0].id,office,0,defaultSnackSettings); const token=await snackInvite(users[0].id,office); await joinSnackOffice(users[1],token);
 await snackPrivateChat(users[1].id,office,"I enjoy pretzels and dislike raisins.");
 const mine=await readSnackMembers(users[1].id,office), owner=await readSnackMembers(users[0].id,office);
 assert.equal(mine.messages.length,2); assert.equal(mine.messages[1].role,"assistant"); assert.ok(mine.messages[1].content.length); assert.equal(owner.messages.length,0); assert.equal(owner.members.length,0);
 console.log("Live budgeted private snack agent replied; owner saw neither private messages nor unshared preferences.");
} finally { for(const u of users) await authPool.query("DELETE FROM auth_users WHERE id=$1",[u.id]); await authPool.end(); }
