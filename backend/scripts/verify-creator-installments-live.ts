import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { betterAuth } from 'better-auth';
import { authPool } from '../lib/auth';
import { initialCampaign, applyAnswer } from '../lib/creator/policy';
const base = process.env.WORKSPACE_VERIFY_URL || 'http://localhost:3016';
if (!/^http:\/\/localhost:\d+$/.test(base)) throw Error('Local verification only');
if (process.env.CREATOR_INSTALLMENTS_LIVE !== '1') throw Error('Set CREATOR_INSTALLMENTS_LIVE=1 to authorize three Sandbox test payouts.');
const auth = betterAuth({ secret: process.env.BETTER_AUTH_SECRET, baseURL: base, database: authPool, user: { modelName: 'auth_users' }, session: { modelName: 'auth_sessions' }, account: { modelName: 'auth_accounts' }, verification: { modelName: 'auth_verifications' }, emailAndPassword: { enabled: true } });
let userId = '';
let verified = false;
try {
 const response = await auth.api.signUpEmail({ body: { email: `creator-installments-${randomUUID()}@example.invalid`, name: 'Sandbox verification', password: randomUUID()+randomUUID() }, asResponse: true });
 assert.equal(response.status, 200); userId=(await response.json()).user.id;
 const cookie=response.headers.getSetCookie().filter(c=>c.split('=')[0].includes('session_token')).map(c=>c.split(';')[0]).join('; ');
 const headers={Origin:base,'Content-Type':'application/json','x-demo-code':process.env.SUME_DEMO_CODE||'',Cookie:cookie};
 const cid=randomUUID();
 const create=await fetch(base+'/api/workspace-chat',{method:'POST',headers,body:JSON.stringify({action:'create',id:cid,mode:'creators'})}); assert.equal(create.status,200);
 const state=applyAnswer(initialCampaign(),{brief:{...initialCampaign().brief,brand:'Sample',audience:'students',budgetCents:100000},reply:'Sample',options:[],sources:[],next:'compare',candidates:[{id:'student-sample-08',reason:'Sample study content',evidenceIndexes:[0]},{id:'student-sample-04',reason:'Sample study content',evidenceIndexes:[0]}]},'fixture');
 await authPool.query('INSERT INTO creator_campaigns(conversation_id,state) VALUES($1,$2)',[cid,JSON.stringify(state)]);
 async function act(command:object) { const r=await fetch(base+'/api/creator-campaign',{method:'POST',headers,body:JSON.stringify({conversationId:cid,command})}); const b=await r.json(); if(!r.ok) throw Error(`${r.status}: ${b.error}`); return b.state; }
 async function pay(d:any,id:'upfront'|'delivery') { let s=await act({action:'pay',dealId:d.id,digest:d.digest,revision:1,installmentId:id}); let item=s.deals.find((x:any)=>x.id===d.id).installments.find((x:any)=>x.id===id); const limit=Date.now()+45000; while(item.payment!=='confirmed'&&Date.now()<limit){await new Promise(r=>setTimeout(r,3000));s=await act({action:'pay',dealId:d.id,digest:d.digest,revision:1,installmentId:id});item=s.deals.find((x:any)=>x.id===d.id).installments.find((x:any)=>x.id===id);} assert.equal(item.payment,'confirmed'); assert.ok(item.itemId&&item.batchId); const repeat=await act({action:'pay',dealId:d.id,digest:d.digest,revision:1,installmentId:id}); const again=repeat.deals.find((x:any)=>x.id===d.id).installments.find((x:any)=>x.id===id); assert.equal(again.itemId,item.itemId); return item; }
 let s=await act({action:'prepare',creatorId:'student-sample-08',revision:1,delivery:'Friday',rightsDays:30,paymentStructure:'upfront'}); let first=s.deals[0]; await act({action:'approve',dealId:first.id,digest:first.digest,revision:1}); const upfront=await pay(first,'upfront');
 s=await act({action:'prepare',creatorId:'student-sample-04',revision:1,delivery:'Friday',rightsDays:30,paymentStructure:'split'}); const split=s.deals.find((x:any)=>x.creatorId==='student-sample-04'); await act({action:'approve',dealId:split.id,digest:split.digest,revision:1}); const a=await pay(split,'upfront'); await act({action:'delivery',dealId:split.id,digest:split.digest,revision:1}); await act({action:'complete',dealId:split.id,digest:split.digest,revision:1}); const b=await pay(split,'delivery');
 assert.equal(upfront.amountCents,30000); assert.equal(a.amountCents,17500); assert.equal(b.amountCents,17500); assert.notEqual(a.batchId,b.batchId);
 verified = true;
 console.log(JSON.stringify({fixture:true,recipient:'configured test recipient',confirmed:[upfront.amountCents,a.amountCents,b.amountCents],distinctSplitBatches:true,duplicateRequestsStable:true}));
} finally { if(userId && verified) await authPool.query('DELETE FROM auth_users WHERE id=$1',[userId]); else if (userId) console.error('Retained test user for payout reconciliation:', userId); await authPool.end(); }
