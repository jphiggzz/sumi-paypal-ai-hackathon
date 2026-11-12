/** Disposable separate test accounts; real local HTTP and bounded agent discussion; no payment. */
import assert from "node:assert/strict";
import {randomUUID} from "node:crypto";
import {setTimeout as delay} from "node:timers/promises";
import {betterAuth} from "better-auth";
import {authPool} from "../lib/auth";
const base="http://localhost:3016";
const auth=betterAuth({secret:process.env.BETTER_AUTH_SECRET,baseURL:base,database:authPool,user:{modelName:"auth_users"},session:{modelName:"auth_sessions"},account:{modelName:"auth_accounts"},verification:{modelName:"auth_verifications"},emailAndPassword:{enabled:true}});
const users:{id:string;cookie:string;chat:string}[]=[];
async function call(n:number,path:string,body?:unknown,expected=200) {const r=await fetch(base+path,{method:body?"POST":"GET",headers:{origin:base,"content-type":"application/json",cookie:users[n].cookie,"x-demo-code":process.env.SUME_DEMO_CODE||""},...(body?{body:JSON.stringify(body)}:{})});const data=await r.json().catch(()=>({}));assert.equal(r.status,expected,`${path} ${r.status} ${data.error||""}`);return data;}
try {
 for(let i=0;i<3;i++){const r=await auth.api.signUpEmail({body:{email:`workspace-snack-${randomUUID()}@example.invalid`,name:`Test ${i}`,password:randomUUID()+randomUUID()},asResponse:true});assert.equal(r.status,200);const u=(await r.json()).user;users.push({id:u.id,cookie:r.headers.getSetCookie().filter(v=>v.split("=")[0].includes("session_token")).map(v=>v.split(";")[0]).join("; "),chat:randomUUID()});await call(i,"/api/workspace-chat",{action:"create",id:users[i].chat,mode:"shopping"});}
 const command=(n:number,c:object)=>call(n,"/api/workspace-chat/workflows",{conversationId:users[n].chat,command:c});
 const owner=await command(0,{action:"prepare_snacks"});const draft=owner.flows.find((f:any)=>f.kind==="snack");assert.ok(draft && !draft.team);
 const settings={name:"Test office",budgetCents:20000,reserveCents:1000,onsiteDays:2,servingsPerPersonDay:1,groups:[{id:"team",name:"Team",people:3,likes:[],dislikes:[],dietary:[],allergies:[]}]};
 const setup=await command(0,{action:"snack_setup",settings});const snackFlow=setup.flows.find((f:any)=>f.kind==="snack");assert.ok(snackFlow.team.me);const office=snackFlow.resourceId;await call(0,"/api/snacks",{action:"stock",officeId:office,revision:1,stock:[]});
 const inv=await call(0,"/api/snack-members",{action:"invite",officeId:office});await command(1,{action:"join_snacks",token:inv.token});await command(1,{action:"join_snacks",token:inv.token});await command(2,{action:"join_snacks",token:inv.token});
 const p1={likes:["pretzels"],dislikes:[],dietary:[],allergies:[]},p2={likes:["mango"],dislikes:[],dietary:[],allergies:[]};
 await call(1,"/api/snack-members",{action:"preferences",officeId:office,preferences:p1,shared:true});await call(2,"/api/snack-members",{action:"preferences",officeId:office,preferences:p2,shared:true});
 await call(1,"/api/snacks",{action:"plan_simulated",officeId:office,revision:4,cycleId:randomUUID()},404);
 const cycleId=randomUUID();await call(0,"/api/snacks",{action:"plan_simulated",officeId:office,revision:4,cycleId});
 let data:any,c:any;const deadline=Date.now()+150000;while(Date.now()<deadline){data=await call(0,`/api/workspace-chat/workflows?conversationId=${users[0].chat}`);c=data.flows.find((f:any)=>f.kind==="snack").state.cycles.find((r:any)=>r.id===cycleId);if(c?.status==="failed")throw Error(c.error_code);if(c?.status==="ready")break;await delay(2000);}
 assert.equal(c?.status,"ready");assert.equal(c.discussion.length,2);assert.ok(c.input.settings.groups.some((g:any)=>g.likes.includes("mango")));assert.equal(c.input.settings.groups.reduce((n:number,g:any)=>n+g.people,0),3);
 const friend=await call(1,`/api/workspace-chat/workflows?conversationId=${users[1].chat}`);assert.equal(friend.flows.find((f:any)=>f.kind==="snack").state,null);assert.equal(friend.flows.find((f:any)=>f.kind==="snack").team.discussion.length,2);
 await call(1,"/api/snack-members",{action:"preferences",officeId:office,preferences:p1,shared:false});data=await call(0,`/api/workspace-chat/workflows?conversationId=${users[0].chat}`);c=data.flows.find((f:any)=>f.kind==="snack").state.cycles.find((v:any)=>v.id===cycleId);assert.equal(c.status,"cancelled");assert.equal(c.basket,null);
 console.log("Workspace snack flow: draft, setup, two authenticated invitees, ownership denial, real agent round and withdrawal passed; synthetic identities and catalog, no payment.");
}finally{for(const u of users)await authPool.query("DELETE FROM auth_users WHERE id=$1",[u.id]);await authPool.end();}
