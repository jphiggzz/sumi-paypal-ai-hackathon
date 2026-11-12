/** Model-free action approval conformance. Synthetic local accounts use ordinary
 * signed sessions. SQL injections below are explicit boundary/failure fixtures. */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { writeFile } from 'node:fs/promises';
import { setTimeout as delay } from 'node:timers/promises';
import { betterAuth } from 'better-auth';
import { Pool } from 'pg';
import { authPool } from '../lib/auth';
import { decideAction,executeAction,proposeAction } from '../lib/action-store';
import { actionInput,type ActionProposal } from '../lib/action-policy';
const base=new URL(process.argv[2]||'http://localhost:3000');
if(!process.env.DATABASE_URL||!process.env.BETTER_AUTH_SECRET||!process.env.SUME_DEMO_CODE)throw new Error('Load matching target database, auth secret and preview code.');
const pool=new Pool({connectionString:process.env.DATABASE_URL,max:2});
const fixtureAuth=betterAuth({secret:process.env.BETTER_AUTH_SECRET,baseURL:base.origin,database:pool,user:{modelName:'auth_users'},session:{modelName:'auth_sessions'},account:{modelName:'auth_accounts'},verification:{modelName:'auth_verifications'},emailAndPassword:{enabled:true}});
const headers={'Content-Type':'application/json',Origin:base.origin,'x-demo-code':process.env.SUME_DEMO_CODE};
const evidence={checkedAt:new Date().toISOString(),target:base.origin,authentication:'Ordinary signed Better Auth sessions issued by privileged local harness to synthetic example.invalid accounts; no Google OAuth checked.',scope:'Fixture-only local SQL note effects. No model inference, external-provider write or payment. Queued-execution cancellation cases deliberately use local decideAction without dispatch, then mutate authority, then call executor. Memory-reference and worker-fence checks use explicitly injected SQL fixture state.',checks:[] as string[],proposalIds:[] as string[],status:'running',failure:''};
function pass(label:string){evidence.checks.push(label);console.log('PASS',label);}
function noSecret(value:unknown){assert.doesNotMatch(JSON.stringify(value),/synthetic-fixture-only\.|fixture-access-v1|session_token|access_token|refresh_token|"stack"\s*:/i);}
async function account(){const email=`action-verifier-${randomUUID()}@example.invalid`;const r=await fixtureAuth.api.signUpEmail({body:{email,password:randomUUID()+randomUUID(),name:'Action verifier'},headers:new Headers(headers),asResponse:true});assert.equal(r.status,200);const cookie=r.headers.getSetCookie().filter(v=>v.split('=')[0].includes('session_token')).map(v=>v.split(';')[0]).join('; ');assert.ok(cookie);const owner=(await pool.query('SELECT id FROM auth_users WHERE email=$1',[email])).rows[0].id;return {cookie,owner};}
async function call(path:string,cookie?:string,body?:unknown,extra:Record<string,string>={}){const r=await fetch(new URL(path,base),{method:body===undefined?'GET':'POST',headers:{...headers,...(cookie?{Cookie:cookie}:{}),...extra},...(body===undefined?{}:{body:JSON.stringify(body)})});const text=await r.text();let data:any=null;if(text){try{data=JSON.parse(text);}catch{throw new Error('Non-JSON API response');}}noSecret(data);return {status:r.status,data};}
async function json(path:string,cookie:string,body?:unknown,status=200){const r=await call(path,cookie,body);assert.equal(r.status,status,`Unexpected HTTP status ${r.status} at ${path}`);return r.data;}
async function wait<T>(read:()=>Promise<T>,ready:(v:T)=>boolean,label:string){for(let i=0;i<120;i++){const v=await read();if(ready(v))return v;await delay(1000);}throw new Error('Timed out '+label);}
async function conversation(cookie:string){const id=randomUUID();await json('/api/conversations',cookie,{id,messageId:randomUUID(),text:'Record a fixture checkpoint.',source:'Local note approval verification. No external target.',executionMode:'checkpoint'},201);await wait(async()=>(await pool.query('SELECT status FROM conversation_turns WHERE conversation_id=$1 AND sequence=1',[id])).rows[0],v=>v?.status==='completed','checkpoint');return id;}
async function connection(cookie:string,patch={}){return (await json('/api/connections',cookie,{provider:'fixture',scopes:['notes:write'],resourceIds:['doc-alpha','doc-beta'],...patch},201)).connection;}
async function effects(id:string){return +(await pool.query('SELECT count(*) FROM fixture_note_effects WHERE proposal_id=$1',[id])).rows[0].count;}
try{
 const first=await account(),other=await account();
 const main=await conversation(first.cookie),separate=await conversation(first.cookie);
 const conn=await connection(first.cookie);
 const input=(patch={})=>({id:randomUUID(),conversationId:main,connectionId:conn.id,connectionVersion:conn.version,resourceId:'doc-alpha',note:'A human approved this synthetic local note.',expectedTargetVersion:0,...patch});
 const propose=async(patch={})=>{const p=(await json('/api/actions',first.cookie,input(patch),201)).proposal as ActionProposal;evidence.proposalIds.push(p.id);return p;};
 const decision=(p:ActionProposal,decision='approve')=>({decision,digest:p.digest});
 const approveWithoutDispatch=async(p:ActionProposal)=>{assert.equal((await decideAction(first.owner,p.id,{decision:'approve',digest:p.digest},{admissionDeadline:Date.now()+30_000})).status,200);};
 assert.equal((await call('/api/actions')).status,401);
 assert.equal((await call('/api/actions',undefined,input())).status,401);
 assert.equal((await call('/api/actions',first.cookie,input(),{Origin:'https://foreign.invalid'})).status,403);
 const proposal=await propose({recoveryTest:true});
 assert.equal((await call('/api/actions/'+proposal.id,other.cookie)).status,404);
 assert.equal((await call('/api/actions/'+proposal.id,other.cookie,decision(proposal))).status,404);
 assert.equal((await call('/api/actions/'+proposal.id,first.cookie,decision(proposal),{Origin:'https://foreign.invalid'})).status,403);
 assert.equal((await json('/api/actions',other.cookie)).proposals.length,0);
 pass('auth, origin and owner isolation apply to proposal list/detail/create/decision');
 const original={...proposal.payload};delete (original as any).ownerId;delete (original as any).sequence;delete (original as any).kind;
 delete (original as any).expiresAt;
 const retry=await json('/api/actions',first.cookie,original,200);assert.equal(retry.proposal.digest,proposal.digest);
 assert.equal((await call('/api/actions',first.cookie,{...original,note:'Changed arguments'})).status,409);
 assert.equal((await call('/api/actions/'+proposal.id,first.cookie,{...decision(proposal),note:'Edited at approval'})).status,400);
 assert.equal((await call('/api/actions/'+proposal.id,first.cookie,{decision:'approve',digest:'0'.repeat(64)})).status,409);
 assert.equal((await call('/api/actions',first.cookie,input({token:'client-secret'}))).status,400);
 assert.equal((await call('/api/actions',first.cookie,input({kind:'paypal.send'}))).status,400);
 assert.equal((await call('/api/actions',first.cookie,input({note:'bad\u0000note'}))).status,400);
 pass('proposal retry preserves server-default expiry; changed arguments, edited approvals and digest/token injection fail');
 const immutable=await pool.connect();try{await immutable.query('BEGIN');await assert.rejects(immutable.query("UPDATE agent_action_proposals SET payload=jsonb_set(payload,'{note}','\"tampered\"') WHERE id=$1",[proposal.id]),/Action payloads are immutable/);await immutable.query('ROLLBACK');}finally{immutable.release();}
 pass('database rejects immutable proposal payload mutation');
 const expiredAdmission=await decideAction(first.owner,proposal.id,{decision:'approve',digest:proposal.digest},{admissionDeadline:Date.now()-1});
 assert.equal(expiredAdmission.status,503);assert.equal((await json('/api/actions/'+proposal.id,first.cookie)).proposal.state,'pending');
 pass('an expired executor admission window cannot commit approval');
 await json('/api/actions/'+proposal.id,first.cookie,decision(proposal));
 // Stop making app calls: real Workflow must execute and retry from durable state.
 const saved=await wait(async()=>(await pool.query('SELECT state,attempts FROM agent_action_proposals WHERE id=$1',[proposal.id])).rows[0],v=>v?.state==='executed'&&v.attempts===2,'postcommit recovery');
 assert.equal(saved.attempts,2);assert.equal(await effects(proposal.id),1);
 const detail=(await json('/api/actions/'+proposal.id,first.cookie)).proposal;
 assert.equal(detail.receipt.fixture,true);assert.equal(detail.receipt.note,proposal.payload.note);assert.equal(detail.receipt.targetVersion,1);
 await json('/api/actions/'+proposal.id,first.cookie,decision(proposal));
 assert.equal(await effects(proposal.id),1);
 pass('armed real Workflow executes without app polling; injected postcommit retry reconciles two attempts and one effect');
 const rejected=await propose({resourceId:'doc-beta'});await json('/api/actions/'+rejected.id,first.cookie,decision(rejected,'reject'));
 assert.equal((await call('/api/actions/'+rejected.id,first.cookie,decision(rejected))).status,409);
 assert.equal((await executeAction(rejected.id,first.owner)).state,'rejected');assert.equal(await effects(rejected.id),0);
 pass('rejection is final and cannot authorize an effect');
 const missingScope=await connection(first.cookie,{scopes:['documents:read']});
 assert.equal((await call('/api/actions',first.cookie,input({connectionId:missingScope.id}))).status,403);
 const unshared=await connection(first.cookie,{resourceIds:['doc-beta']});
 assert.equal((await call('/api/actions',first.cookie,input({connectionId:unshared.id}))).status,403);
 const foreign=await connection(other.cookie);
 assert.equal((await call('/api/actions',first.cookie,input({connectionId:foreign.id}))).status,404);
 pass('fixture writes require notes scope, granted resource and an owner connection');
 const stale=await propose({resourceId:'doc-beta'});await approveWithoutDispatch(stale);
 const follow=await json('/api/conversations/'+main,first.cookie,{action:'message',messageId:randomUUID(),text:'Supersede all previous pending fixture actions.',executionMode:'checkpoint'},201);
 assert.equal(follow.sequence,2);assert.equal((await executeAction(stale.id,first.owner)).state,'blocked');assert.equal(await effects(stale.id),0);
 pass('new accepted instruction fences an approved but queued write');
 const revokedConn=await connection(first.cookie);
 const revoked=await propose({conversationId:separate,connectionId:revokedConn.id});await approveWithoutDispatch(revoked);
 const patch=await fetch(new URL('/api/connections/'+revokedConn.id,base),{method:'PATCH',headers:{...headers,Cookie:first.cookie},body:JSON.stringify({action:'disconnect',expectedVersion:1})});assert.equal(patch.status,200);
 assert.equal((await executeAction(revoked.id,first.owner)).state,'blocked');assert.equal(await effects(revoked.id),0);
 pass('connection revocation prevents approved queued execution');
 const expires=await propose({conversationId:separate,connectionId:conn.id,resourceId:'doc-beta',expiresAt:new Date(Date.now()+5000).toISOString()});await approveWithoutDispatch(expires);await delay(5200);
 assert.equal((await executeAction(expires.id,first.owner)).state,'expired');assert.equal(await effects(expires.id),0);
 pass('expired exact approval cannot execute');
 const memoryId=randomUUID();await pool.query("INSERT INTO agent_memories(id,owner_id,scope,key,normalized_key,value) VALUES($1,$2,'agent','Action context','action context','first version')",[memoryId,first.owner]);
 await pool.query("UPDATE conversation_turns SET context_snapshot=jsonb_set(COALESCE(context_snapshot,'{}'::jsonb),'{memoryReferences}',$2::jsonb) WHERE conversation_id=$1 AND sequence=1",[separate,JSON.stringify([{id:memoryId,version:1}])]);
 const memoryProposal=await propose({conversationId:separate,connectionId:conn.id,resourceId:'doc-beta'});await approveWithoutDispatch(memoryProposal);
 await pool.query('UPDATE agent_memories SET version=version+1 WHERE id=$1',[memoryId]);
 assert.equal((await executeAction(memoryProposal.id,first.owner)).state,'blocked');assert.equal(await effects(memoryProposal.id),0);
 // Restore only this explicit fixture's current reference for subsequent tests.
 await pool.query("UPDATE conversation_turns SET context_snapshot=context_snapshot-'memoryReferences' WHERE conversation_id=$1 AND sequence=1",[separate]);
 pass('changed factual-memory generation prevents approved queued execution');
 const raceConn=await connection(first.cookie);
 const left=await propose({conversationId:separate,connectionId:raceConn.id}),right=await propose({conversationId:separate,connectionId:raceConn.id});
 await approveWithoutDispatch(left);await approveWithoutDispatch(right);
 const race=await Promise.all([executeAction(left.id,first.owner),executeAction(right.id,first.owner)]);
 assert.deepEqual(race.map(r=>r.state).sort(),['blocked','executed']);assert.equal((await effects(left.id))+(await effects(right.id)),1);
 assert.equal((await pool.query('SELECT version FROM fixture_note_targets WHERE owner_id=$1 AND connection_id=$2 AND resource_id=$3',[first.owner,raceConn.id,'doc-alpha'])).rows[0].version,1);
 pass('concurrent proposals for the same expected target revision commit exactly one note');
 const badWorker=await proposeAction(first.owner,actionInput.parse(input({conversationId:separate,connectionId:raceConn.id,resourceId:'doc-beta'})),{sequence:1,workflowRunId:'not-the-current-worker'});
 assert.equal(badWorker.status,409);
 const profile=(await pool.query('SELECT worker_run_id FROM agent_conversations WHERE id=$1',[separate])).rows[0];
 await pool.query("UPDATE agent_conversations SET worker_run_id='fixture-worker' WHERE id=$1",[separate]);
 const badSequence=await proposeAction(first.owner,actionInput.parse(input({conversationId:separate,connectionId:raceConn.id,resourceId:'doc-beta'})),{sequence:2,workflowRunId:'fixture-worker'});
 assert.equal(badSequence.status,409);
 await pool.query('UPDATE agent_conversations SET worker_run_id=$2 WHERE id=$1',[separate,profile.worker_run_id]);
 pass('worker proposals reject superseded run IDs and noncurrent sequences');
 noSecret(await json('/api/actions',first.cookie));noSecret(await json('/api/actions/'+proposal.id,first.cookie));
 evidence.status='passed';
}catch(error){evidence.status='failed';evidence.failure=error instanceof Error?error.message:'Unknown failure';throw error;}
finally{if(process.env.AGENT_EVIDENCE_PATH)await writeFile(process.env.AGENT_EVIDENCE_PATH,JSON.stringify(evidence,null,2)+'\n');await Promise.allSettled([pool.end(),authPool.end()]);}
console.log(`Verified ${evidence.checks.length} fixture action checks.`);
