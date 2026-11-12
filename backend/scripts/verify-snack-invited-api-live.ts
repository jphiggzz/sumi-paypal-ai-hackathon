/** Disposable authenticated test users, live agent calls, sample catalog; no payments. */
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import { betterAuth } from "better-auth";
import { authPool } from "../lib/auth";
import { defaultSnackSettings } from "../lib/snack-policy";
const base = "http://localhost:3016";
const auth=betterAuth({secret:process.env.BETTER_AUTH_SECRET,baseURL:base,database:authPool,user:{modelName:"auth_users"},session:{modelName:"auth_sessions"},account:{modelName:"auth_accounts"},verification:{modelName:"auth_verifications"},emailAndPassword:{enabled:true}});
const users: {id:string;cookie:string}[]=[];
async function call(which:number, path:string, body?:unknown, expected=200) {
 const r=await fetch(base+path,{method:body?"POST":"GET",headers:{origin:base,"content-type":"application/json",cookie:users[which].cookie,"x-demo-code":process.env.SUME_DEMO_CODE||""},...(body?{body:JSON.stringify(body)}:{})});
 const result=await r.json().catch(()=>({})); assert.equal(r.status,expected,`${path}: ${r.status} ${result.error??""}`); return result;
}
try {
 for(let i=0;i<3;i++) {const r=await auth.api.signUpEmail({body:{email:`snack-api-${randomUUID()}@example.invalid`,name:`Test member ${i}`,password:randomUUID()+randomUUID()},asResponse:true});assert.equal(r.status,200);const u=(await r.json()).user;users.push({id:u.id,cookie:r.headers.getSetCookie().filter(v=>v.split("=")[0].includes("session_token")).map(v=>v.split(";")[0]).join("; ")});}
 const officeId=randomUUID(),cycleId=randomUUID();
 await call(0,"/api/snacks",{action:"save",officeId,revision:0,settings:defaultSnackSettings});
 await call(0,"/api/snacks",{action:"stock",officeId,revision:1,stock:[]});
 const {token}=await call(0,"/api/snack-members",{action:"invite",officeId});
 for(const n of [1,2]) {const joined=await call(n,"/api/snack-members",{action:"join",token});assert.equal(joined.officeId,officeId);}
 const secret=`Private ${randomUUID()} I like pretzels.`;
 await call(1,"/api/snack-members",{action:"chat",officeId,text:secret});
 const one=await call(1,`/api/snack-members?officeId=${officeId}`), other=await call(2,`/api/snack-members?officeId=${officeId}`), owner=await call(0,`/api/snack-members?officeId=${officeId}`);
 assert.equal(one.messages.length,2);assert.equal(other.messages.length,0);assert.equal(owner.messages.length,0);assert.equal(owner.members.length,0);assert.ok(!JSON.stringify(other).includes(secret));
 await call(1,"/api/snack-members",{action:"preferences",officeId,preferences:{likes:["pretzels"],dislikes:[],dietary:[],allergies:[]},shared:true});
 await call(2,"/api/snack-members",{action:"preferences",officeId,preferences:{likes:["mango"],dislikes:[],dietary:[],allergies:[]},shared:true});
 const shared=await call(0,`/api/snack-members?officeId=${officeId}`); assert.equal(shared.members.length,2);assert.ok(!JSON.stringify(shared).includes(secret));
 await call(0,"/api/snacks",{action:"plan_simulated",officeId,revision:4,cycleId});
 let state:any;const deadline=Date.now()+150000;
 while(Date.now()<deadline){state=await call(0,`/api/snacks?officeId=${officeId}`); const c=state.cycles.find((v:any)=>v.id===cycleId); if(c?.status==="failed")throw Error(c.error_code);if(c?.status==="ready")break;await delay(2000);}
 const cycle=state.cycles.find((v:any)=>v.id===cycleId);assert.equal(cycle?.status,"ready");assert.equal(cycle.discussion.length,2);assert.ok(cycle.discussion.every((v:any)=>v.productIds.every((id:string)=>/^sample-/.test(id))));assert.ok(cycle.input.settings.groups.some((v:any)=>v.likes.includes("mango")));
 await call(1,"/api/snack-members",{action:"preferences",officeId,preferences:{likes:["pretzels"],dislikes:[],dietary:[],allergies:[]},shared:false});
 const after=await call(0,`/api/snacks?officeId=${officeId}`), participant=await call(2,`/api/snack-members?officeId=${officeId}`);const stale=after.cycles.find((v:any)=>v.id===cycleId);assert.equal(stale.status,"cancelled");assert.equal(stale.input,null);assert.equal(stale.basket,null);assert.deepEqual(stale.discussion,[]);assert.equal(participant.members.length,1);assert.deepEqual(participant.discussion,[]);
 console.log("PASS: three separate synthetic signed-in sessions, invitation, private live agent, explicit sharing, live two-agent sample basket, and withdrawal/redaction. No real coworkers or payment.");
} finally {for(const u of users)await authPool.query("DELETE FROM auth_users WHERE id=$1",[u.id]);await authPool.end();}
