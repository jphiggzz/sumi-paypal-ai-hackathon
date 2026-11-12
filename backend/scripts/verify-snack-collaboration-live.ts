/** Synthetic members and sample catalog; real bounded agent discussion, no payments. */
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import { betterAuth } from "better-auth";
import { authPool } from "../lib/auth";
import { saveSnackOffice, saveSnackStock } from "../lib/snack-store";
import { joinSnackOffice, snackInvite, saveSnackPreferences } from "../lib/snack-members";
import { defaultSnackSettings } from "../lib/snack-policy";
const base="http://localhost:3016";
const auth=betterAuth({secret:process.env.BETTER_AUTH_SECRET,baseURL:base,database:authPool,user:{modelName:"auth_users"},session:{modelName:"auth_sessions"},account:{modelName:"auth_accounts"},verification:{modelName:"auth_verifications"},emailAndPassword:{enabled:true}});
const users:any[]=[]; let cookie="";
try {
 for(let i=0;i<3;i++) { const r=await auth.api.signUpEmail({body:{email:`snack-round-${randomUUID()}@example.invalid`,name:`Synthetic ${i}`,password:randomUUID()+randomUUID()},asResponse:true}); assert.equal(r.status,200); users.push((await r.json()).user); if(!i) cookie=r.headers.getSetCookie().filter(v=>v.split("=")[0].includes("session_token")).map(v=>v.split(";")[0]).join("; "); }
 const office=randomUUID(),cycle=randomUUID(); await saveSnackOffice(users[0].id,office,0,defaultSnackSettings); await saveSnackStock(users[0].id,office,1,[]);
 const token=await snackInvite(users[0].id,office); await joinSnackOffice(users[1],token); await joinSnackOffice(users[2],token);
 await saveSnackPreferences(users[1].id,office,{likes:["pretzels"],dislikes:[],dietary:[],allergies:[]},true);
 await saveSnackPreferences(users[2].id,office,{likes:["mango"],dislikes:[],dietary:[],allergies:[]},true);
 const post=await fetch(`${base}/api/snacks`,{method:"POST",headers:{origin:base,"content-type":"application/json",cookie,"x-demo-code":process.env.SUME_DEMO_CODE||""},body:JSON.stringify({action:"plan_simulated",officeId:office,revision:4,cycleId:cycle})}); assert.equal(post.status,200,await post.text());
 const deadline=Date.now()+180000;
 while(Date.now()<deadline) {
  const row=(await authPool.query("SELECT status,discussion,basket,error_code FROM snack_cycles WHERE id=$1",[cycle])).rows[0];
  if(row?.status==="failed") throw Error(`Snack workflow failed: ${row.error_code}`);
  if(row?.status==="ready") { assert.equal(row.discussion.length,2); assert.ok(row.discussion.every((d:any)=>d.summary && d.productIds.every((id:string)=>/^sample-/.test(id)))); assert.ok(row.basket.coverage.length===5); console.log("Live two-member agent round produced bounded sample recommendations and basket coverage; no payment."); break; }
  await delay(2000);
 }
 const row=(await authPool.query("SELECT status FROM snack_cycles WHERE id=$1",[cycle])).rows[0]; assert.equal(row?.status,"ready","workflow timed out");
} finally { for(const u of users) await authPool.query("DELETE FROM auth_users WHERE id=$1",[u.id]); await authPool.end(); }
