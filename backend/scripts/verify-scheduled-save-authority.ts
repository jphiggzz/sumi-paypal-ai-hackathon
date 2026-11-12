/** Model-free regression using explicitly privileged SQL fixtures for completed
 * scheduled drafts. Only normal owner APIs start hosted save Workflows; no local
 * Workflow world, inference, real provider or payment operation is used. */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { writeFile } from 'node:fs/promises';
import { Pool } from 'pg';
import { betterAuth } from 'better-auth';
import { artifactDigest } from '../lib/agent-hash';

const base=new URL(process.argv[2]||'http://localhost:3000');
if(!process.env.DATABASE_URL||!process.env.BETTER_AUTH_SECRET||!process.env.SUME_DEMO_CODE)throw new Error('Load matching target database, auth secret and preview code.');
const pool=new Pool({connectionString:process.env.DATABASE_URL,max:2});
const headers={Origin:base.origin,'Content-Type':'application/json','x-demo-code':process.env.SUME_DEMO_CODE};
const auth=betterAuth({secret:process.env.BETTER_AUTH_SECRET,baseURL:base.origin,database:pool,user:{modelName:'auth_users'},session:{modelName:'auth_sessions'},account:{modelName:'auth_accounts'},verification:{modelName:'auth_verifications'},emailAndPassword:{enabled:true}});
let stage='synthetic authentication';
const checks:string[]=[];
function passed(label:string){checks.push(label);console.log('PASS',label);}
async function waitSql(read:()=>Promise<any>,ready:(value:any)=>boolean,label:string,pollMs=200){for(let elapsed=0;elapsed<180000;elapsed+=pollMs){const value=await read();if(ready(value))return value;await delay(pollMs);}throw new Error(`timeout_${label}`);}
async function budget(){return(await pool.query("SELECT day::text,reserved_usd::text,calls FROM agent_model_budget WHERE day=(now() AT TIME ZONE 'UTC')::date")).rows;}
async function main(){
  const before=await budget();
  const response=await auth.api.signUpEmail({body:{email:`scheduled-save-authority-${randomUUID()}@example.invalid`,password:randomUUID()+randomUUID(),name:'Scheduled save authority verifier'},headers:new Headers(headers),asResponse:true});assert.equal(response.status,200);
  const ownerId=(await response.json()).user.id,cookie=response.headers.getSetCookie().filter(v=>v.split('=')[0].includes('session_token')).map(v=>v.split(';')[0]).join('; ');assert.ok(cookie);
  async function post(path:string,body:unknown,status=200){const r=await fetch(new URL(path,base),{method:'POST',headers:{...headers,Cookie:cookie},body:JSON.stringify(body)});const text=await r.text();assert.doesNotMatch(text,/synthetic-fixture-only\.|Bearer\s|access_token|refresh_token|"stack"\s*:/i);assert.equal(r.status,status,`HTTP ${path}`);return text?JSON.parse(text):null;}
  const permissions=['read_context','read_revision','reply','create_draft','save_approved_artifact'];
  const agentId=randomUUID();await pool.query('INSERT INTO agent_profiles(id,owner_id,name,permissions) VALUES($1,$2,$3,$4)',[agentId,ownerId,'SQL scheduled-save fixture',JSON.stringify(permissions)]);
  type Fixture={id:string;routineId:string;digest:string;title:string;markdown:string};
  async function fixture(label:string,recovery=false):Promise<Fixture>{
    const id=randomUUID(),routineId=randomUUID(),occurrenceId=randomUUID(),title=`Scheduled fixture ${label}`,markdown=`# ${label}\n\nSCHEDULED FIXTURE61. Explicit synthetic SQL draft; no model generated this content.`,digest=artifactDigest(title,markdown);
    const client=await pool.connect();
    try{await client.query('BEGIN');
      await client.query("INSERT INTO agent_conversations(id,owner_id,agent_id,title,source,requested_sequence,processed_sequence,latest_revision,status) VALUES($1,$2,$3,$4,'Explicit completed scheduled-draft SQL fixture',1,1,1,'awaiting_approval')",[id,ownerId,agentId,title]);
      await client.query("INSERT INTO agent_routines(id,conversation_id,owner_id,instruction,execution_mode,timezone,next_due_at,interval_seconds,max_runs,run_count,expires_at) VALUES($1,$2,$3,'SQL fixture completed scheduled artifact','assistant','UTC',now()+interval '1 day',86400,2,1,now()+interval '2 days')",[routineId,id,ownerId]);
      await client.query("INSERT INTO routine_occurrences(id,routine_id,version,due_at,conversation_id,sequence,status) VALUES($1,$2,1,now()-interval '1 minute',$3,1,'completed')",[occurrenceId,routineId,id]);
      await client.query("INSERT INTO conversation_turns(conversation_id,sequence,message_id,text,status,model,recovery_test,context_snapshot,execution_mode,occurrence_id) VALUES($1,1,$2,'SQL fixture completed scheduled artifact','completed','amazon/nova-micro',$3,$4,'assistant',$5)",[id,randomUUID(),recovery,JSON.stringify({memoryReferences:[],connectionReferences:[],event:null}),occurrenceId]);
      await client.query('INSERT INTO conversation_revisions(conversation_id,revision,title,markdown,digest) VALUES($1,1,$2,$3,$4)',[id,title,markdown,digest]);
      await client.query("INSERT INTO conversation_approvals(conversation_id,revision,digest,state) VALUES($1,1,$2,'pending')",[id,digest]);
      await client.query('COMMIT');
    }catch(error){await client.query('ROLLBACK');throw error;}finally{client.release();}
    return{id,routineId,digest,title,markdown};
  }
  async function pause(f:Fixture){return post(`/api/conversations/${f.id}/routines`,{action:'pause',id:f.routineId,version:1});}
  async function approve(f:Fixture,status=200){return post(`/api/conversations/${f.id}`,{action:'decision',decision:'approve',revision:1,digest:f.digest},status);}
  async function snapshot(f:Fixture){return(await pool.query("SELECT r.state,r.markdown,r.digest,a.state AS approval_state,a.save_run_id,COALESCE(x.attempts,0) AS attempts,(SELECT count(*) FROM conversation_events WHERE conversation_id=$1 AND kind='artifact_saved') AS saved_count,(SELECT count(*) FROM conversation_events WHERE conversation_id=$1 AND kind='save_completed') AS completed_count FROM conversation_revisions r JOIN conversation_approvals a USING(conversation_id,revision) LEFT JOIN conversation_actions x ON x.conversation_id=r.conversation_id AND x.sequence=r.revision AND x.kind='save_approved_artifact' WHERE r.conversation_id=$1 AND r.revision=1",[f.id])).rows[0];}

  stage='pending scheduled approval after pause';
  const pending=await fixture('pending authority');await pause(pending);await approve(pending,409);
  const pendingState=await snapshot(pending);assert.equal(pendingState.approval_state,'superseded');assert.equal(pendingState.state,'draft');assert.equal(pendingState.saved_count,'0');
  passed('pausing the routine invalidates pending exact-digest scheduled approval before any save');

  stage='claimed save paused before side effect';
  const queued=await fixture('queued authority',true);await approve(queued);
  // recovery_test is an explicitly labelled fixture hold: the real hosted save
  // Workflow claims SQL ownership and then waits five seconds before its write.
  const claim=await waitSql(()=>snapshot(queued),v=>!!v.save_run_id,'hosted_save_claim',50);assert.equal(claim.state,'draft');assert.equal(claim.attempts,0);
  await pause(queued);
  await waitSql(async()=>(await pool.query("SELECT kind,detail FROM conversation_events WHERE conversation_id=$1 AND kind='stale_save_blocked'",[queued.id])).rows[0],v=>!!v,'paused_save_blocked');
  const blocked=await snapshot(queued);assert.equal(blocked.state,'draft');assert.equal(blocked.approval_state,'superseded');assert.equal(blocked.saved_count,'0');assert.equal(blocked.attempts,0);
  passed('a real claimed hosted save rechecks routine authority after its hold and writes nothing after pause');

  stage='fresh authorized save then post-commit receipt reconciliation';
  const fresh=await fixture('authorized history',true);await approve(fresh);
  const committed=await waitSql(()=>snapshot(fresh),v=>v.state==='saved','fresh_save_commit',20);assert.equal(committed.attempts,1,'Missed post-commit retry window');assert.equal(committed.saved_count,'1');
  await pause(fresh);
  const pausedBeforeRetry=await snapshot(fresh);assert.equal(pausedBeforeRetry.attempts,1,'Missed pause-before-retry window');
  const reconciled=await waitSql(()=>snapshot(fresh),v=>v.completed_count==='1'&&v.attempts>=2,'receipt_first_reconciliation',100);
  assert.equal(reconciled.attempts,2);assert.equal(reconciled.saved_count,'1');assert.equal(reconciled.state,'saved');assert.equal(reconciled.markdown,fresh.markdown);assert.equal(reconciled.digest,fresh.digest);
  passed('current exact owner approval saves successfully and later routine revocation preserves one committed artifact across retry reconciliation');

  stage='zero inference and unchanged reservation ledger';
  const ids=[pending.id,queued.id,fresh.id];
  assert.equal((await pool.query("SELECT count(*) FROM conversation_events WHERE conversation_id=ANY($1::uuid[]) AND kind='model_usage'",[ids])).rows[0].count,'0');
  const after=await budget();assert.deepEqual(after,before,'Unrelated concurrent inference changed the shared budget ledger');
  passed('all authority fixtures and real hosted save workflows use zero model calls and leave inference reservations unchanged');
  const record={completedAt:new Date().toISOString(),target:base.origin,checks,fixtures:[{conversationId:pending.id,routineId:pending.routineId,case:'paused pending approval',state:pendingState},{conversationId:queued.id,routineId:queued.routineId,case:'pause after real hosted save claim',state:blocked},{conversationId:fresh.id,routineId:fresh.routineId,case:'save then revoke before receipt reconciliation',state:reconciled}],budget:{before,after},authentication:'Ordinary signed Better Auth session for an isolated synthetic owner; no deployed test-login endpoint.',fixtureDisclosure:'Privileged SQL inserts completed scheduled turns, draft content, pending approvals and occurrence links. No model generated these drafts and no scheduled generation timer was simulated as real. Normal owner APIs start actual hosted save Workflows and pause real SQL routine authority.',failureInjection:'recovery_test adds five-second pre-save hold and one post-commit interruption; the final case pauses before the actual two-second retry.',coverage:'Pending decision fence, execution-time save fence, authorized save and receipt-first reconciliation. Does not independently force the separate claimSave denial branch.',noModelCalls:true,noPayments:true};
  if(process.env.AGENT_EVIDENCE_PATH)await writeFile(process.env.AGENT_EVIDENCE_PATH,JSON.stringify(record,null,2)+'\n');console.log(JSON.stringify(record,null,2));
}
try{await main();}catch(error){console.error(JSON.stringify({error:'scheduled_save_authority_verification_failed',stage,type:error instanceof Error?error.name:'unknown'}));process.exitCode=1;}finally{await pool.end();}
