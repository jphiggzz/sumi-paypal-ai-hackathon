/** Disposable synthetic conversations and real budgeted model calls; no payments. */
import assert from "node:assert/strict";
import {randomUUID} from "node:crypto";
import {betterAuth} from "better-auth";
import {authPool} from "../lib/auth";
const base="http://localhost:3016";
const auth=betterAuth({secret:process.env.BETTER_AUTH_SECRET,baseURL:base,database:authPool,user:{modelName:"auth_users"},session:{modelName:"auth_sessions"},account:{modelName:"auth_accounts"},verification:{modelName:"auth_verifications"},emailAndPassword:{enabled:true}});
let user:string|undefined;
try {
 const r=await auth.api.signUpEmail({body:{email:`snack-talk-${randomUUID()}@example.invalid`,name:"Synthetic reviewer",password:randomUUID()+randomUUID()},asResponse:true});assert.equal(r.status,200);user=(await r.json()).user.id;
 const cookie=r.headers.getSetCookie().filter(v=>v.split("=")[0].includes("session_token")).map(v=>v.split(";")[0]).join("; ");
 async function call(path:string,body?:unknown){const res=await fetch(base+path,{method:body?"POST":"GET",headers:{origin:base,"content-type":"application/json",cookie,"x-demo-code":process.env.SUME_DEMO_CODE||""},...(body?{body:JSON.stringify(body)}:{})});const text=await res.text();assert.equal(res.status,200,`${path} ${res.status}`);return text;}
 async function create(){const id=randomUUID();await call("/api/workspace-chat",{action:"create",id,mode:"shopping"});return id;}
 async function send(id:string,text:string){const snap=JSON.parse(await call(`/api/workspace-chat?conversationId=${id}`));await call("/api/workspace-chat/stream",{conversationId:id,requestId:randomUUID(),messageId:randomUUID(),text,mode:"shopping",revision:snap.chat.revision});const after=JSON.parse(await call(`/api/workspace-chat?conversationId=${id}`));const reply=after.messages.at(-1);assert.equal(reply.status,"completed");return reply.content;}
 const a=await create(), first=await send(a,"Plan monthly office snacks");assert.match(first,/\?/);let flow=JSON.parse(await call(`/api/workspace-chat/workflows?conversationId=${a}`)).flows.find((f:any)=>f.kind==="snack");assert.equal(flow.team,null);assert.ok(!flow.draft.snackBrief.budget);
 const second=await send(a,"12 people, $180 a month. Some are vegan and please avoid peanuts.");flow=JSON.parse(await call(`/api/workspace-chat/workflows?conversationId=${a}`)).flows.find((f:any)=>f.kind==="snack");assert.equal(flow.draft.snackBrief.people.value,12);assert.equal(flow.draft.snackBrief.budget.value,180);assert.ok(flow.draft.snackBrief.dietary.some((v:string)=>/vegan/i.test(v)));assert.ok(flow.draft.snackBrief.avoid.some((v:string)=>/peanut/i.test(v)));assert.equal(flow.team,null);
 const b=await create(), rich=await send(b,"Plan office snacks for 8 people, budget $90 per month. No peanuts.");const f=JSON.parse(await call(`/api/workspace-chat/workflows?conversationId=${b}`)).flows.find((x:any)=>x.kind==="snack");assert.equal(f.draft.snackBrief.people.value,8);assert.equal(f.draft.snackBrief.budget.value,90);assert.ok(f.draft.snackBrief.avoid.some((v:string)=>/peanut/i.test(v)));assert.equal(f.team,null);
 console.log(JSON.stringify({first,second,rich,checks:"User-supplied facts proposed; no office, order or payment created."}));
} finally {if(user)await authPool.query("DELETE FROM auth_users WHERE id=$1",[user]);await authPool.end();}
