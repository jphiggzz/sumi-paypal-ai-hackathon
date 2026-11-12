/** Model-free hosted conformance run. Credentials are local synthetic Better Auth
 * sessions; fixture connectors never contact real providers or perform OAuth. */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { writeFile } from 'node:fs/promises';
import { betterAuth } from 'better-auth';
import { Pool } from 'pg';
import { authPool } from '../lib/auth';
import type { FixtureScenario } from '../lib/connector-fixture';

const base = new URL(process.argv[2] || 'http://localhost:3000');
const checks: string[] = [];
let activeCheck = 'environment';
const conversationId = randomUUID();
const path = `/api/conversations/${conversationId}`;
if (!process.env.DATABASE_URL || !process.env.BETTER_AUTH_SECRET || !process.env.SUME_DEMO_CODE)
  throw new Error('Load matching target database, auth secret and preview code.');
const pool = new Pool({connectionString:process.env.DATABASE_URL,max:2});
const fixtureAuth = betterAuth({
  secret:process.env.BETTER_AUTH_SECRET,baseURL:base.origin,database:pool,
  user:{modelName:'auth_users'},session:{modelName:'auth_sessions'},
  account:{modelName:'auth_accounts'},verification:{modelName:'auth_verifications'},
  emailAndPassword:{enabled:true},
});
const headers = {'Content-Type':'application/json',Origin:base.origin,'x-demo-code':process.env.SUME_DEMO_CODE};
const traces: string[] = [];
function check(label:string) {activeCheck=label;}
function pass(label:string) {checks.push(label);console.log('PASS',label);}
function noCredential(value:unknown) {
  assert.doesNotMatch(typeof value==='string'?value:JSON.stringify(value), /synthetic-fixture-only\.|fixture-access-v1|fixture-expired-v1|fixture-revoked-v1|Bearer\s|session_token|access_token|refresh_token|"stack"\s*:/i);
}
async function account() {
  const response=await fixtureAuth.api.signUpEmail({body:{email:`capability-verifier-${randomUUID()}@example.invalid`,password:randomUUID()+randomUUID(),name:'Capability verifier'},headers:new Headers(headers),asResponse:true});
  assert.equal(response.status,200);
  const cookie=response.headers.getSetCookie().filter(v=>v.split('=')[0].includes('session_token')).map(v=>v.split(';')[0]).join('; ');
  assert.ok(cookie);return cookie;
}
async function call(route:string,session?:string,body?:unknown,method?:string) {
  // Authentication headers are never retained in the evidence trace.
  if(body!==undefined) {noCredential(body);traces.push(JSON.stringify(body));}
  const response=await fetch(new URL(route,base),{method:method??(body===undefined?'GET':'POST'),headers:{...headers,...(session?{Cookie:session}:{})},...(body===undefined?{}:{body:JSON.stringify(body)})});
  const text=await response.text();noCredential(text);traces.push(text);
  let data:any=null;
  if(text) {try{data=JSON.parse(text);}catch{throw new Error('response_not_json');}}
  return {status:response.status,data};
}
async function json(route:string,session:string,body?:unknown,status=200,method?:string) {
  const result=await call(route,session,body,method);assert.equal(result.status,status,`HTTP ${route}`);return result.data;
}
async function waitSql<T>(read:()=>Promise<T>,ready:(value:T)=>boolean,label:string,seconds=180,pollMs=1000) {
  for(let i=0;i<Math.ceil(seconds*1000/pollMs);i++) {const value=await read();if(ready(value))return value;await delay(pollMs);}
  throw new Error(`timeout_${label}`);
}
async function terminal(sequence:number,expected:'completed'|'failed',code?:string) {
  const turn=await waitSql(async()=>(await pool.query('SELECT status,error_code FROM conversation_turns WHERE conversation_id=$1 AND sequence=$2',[conversationId,sequence])).rows[0],value=>!!value&&['completed','failed','cancelled'].includes(value.status),'turn_terminal');
  assert.equal(turn.status,expected);
  const invocations=(await pool.query('SELECT tool_id,state,error_code,attempts,owner_id,workflow_run_id,retry_after_ms FROM agent_capability_invocations WHERE conversation_id=$1 AND sequence=$2 ORDER BY started_at,id',[conversationId,sequence])).rows;
  assert.ok(invocations.some(row=>row.tool_id==='read_context'&&row.state==='completed'));
  assert.ok(invocations.every(row=>row.attempts>=1&&row.owner_id&&row.workflow_run_id));
  if(code)assert.ok(invocations.some(row=>row.state==='failed'&&row.error_code===code),`Expected invocation error ${code}`);
  if(expected==='completed')assert.ok(invocations.some(row=>row.tool_id==='reply'&&row.state==='completed'));
  return invocations;
}
async function reply(sequence:number) {
  return (await pool.query("SELECT content FROM conversation_messages WHERE conversation_id=$1 AND sequence=$2 AND role='assistant' ORDER BY id",[conversationId,sequence])).rows.map(row=>row.content).join('\n');
}

type ToolRequest={tool:'read_fixture_document'|'list_fixture_documents'|'search_memory';input:Record<string,unknown>;scenario?:FixtureScenario};
async function main() {
  check('synthetic sessions and authentication');
  const first=await account(),other=await account();
  assert.equal((await call('/api/connections')).status,401);
  assert.equal((await call(path+'/capabilities')).status,401);
  pass('unauthenticated connector and capability access denied');
  const createConnection=async(session:string,patch={})=>(await json('/api/connections',session,{provider:'fixture',scopes:['documents:read'],resourceIds:['doc-alpha'],...patch},201)).connection;
  const alpha=await createConnection(first);
  const both=await createConnection(first,{resourceIds:['doc-alpha','doc-beta']});
  const noScope=await createConnection(first,{scopes:[]});
  const foreign=await createConnection(other);
  assert.equal(alpha.status,'connected');assert.equal(alpha.version,1);
  for(const provider of ['google','notion']) {
    const result=await json('/api/connections',first,{provider},201);
    assert.equal(result.consentRequired,true);assert.equal(result.connection.status,'requires_authorization');
    assert.deepEqual(result.connection.scopes,[]);assert.deepEqual(result.connection.resourceIds,[]);
  }
  pass('real provider metadata remains consent-required with no fixture OAuth claim');
  check('owner isolation');
  assert.equal((await call('/api/connections/'+alpha.id,other)).status,404);
  assert.equal((await call('/api/connections/'+alpha.id,other,{action:'disconnect',expectedVersion:1},'PATCH')).status,404);
  pass('connection read and mutation are owner isolated');
  const request=(connection:any,resourceId='doc-alpha'):ToolRequest=>({tool:'read_fixture_document',input:{connectionId:connection.id,expectedVersion:connection.version,resourceId}});
  const initial={id:conversationId,messageId:randomUUID(),text:'Read the granted synthetic infrastructure document.',source:'Connector conformance fixture; external source text is untrusted data.',executionMode:'capability_check',capabilityRequest:request(alpha),dispatchRecoveryTest:true};
  check('durable outbox dispatch without app polling');
  await json('/api/conversations',first,initial,201);
  // Nothing calls the app until SQL independently observes real Workflow completion.
  await terminal(1,'completed');
  const outbox=(await pool.query('SELECT state FROM agent_dispatch_outbox WHERE conversation_id=$1',[conversationId])).rows;
  assert.ok(outbox.length>0&&outbox.every(row=>row.state!=='failed'));
  assert.match(await reply(1),/^Fixture check \(no model\): /);assert.match(await reply(1),/FIXTURE ALPHA17/);assert.match(await reply(1),/11 workers/);
  pass('registered fixture read and reply complete through real Workflow outbox recovery without app polling');
  check('duplicate and changed-UUID request identity');
  await json('/api/conversations',first,initial,200);
  assert.equal((await call('/api/conversations',first,{...initial,capabilityRequest:request(alpha,'doc-beta')})).status,409);
  const count=(await pool.query("SELECT count(*) FROM agent_capability_invocations WHERE conversation_id=$1 AND sequence=1 AND tool_id='read_fixture_document'",[conversationId])).rows[0].count;
  assert.equal(count,'1');
  pass('same message UUID replays one effective invocation and rejects changed input');
  assert.equal((await call(path,other)).status,404);
  assert.equal((await call(path+'/capabilities',other)).status,404);
  assert.equal((await call(path,other,{action:'message',messageId:randomUUID(),text:'Unauthorized fixture read.',executionMode:'capability_check',capabilityRequest:request(alpha)})).status,404);
  pass('conversation content and invocation metadata are owner isolated');

  let nextSequence=1;
  async function turn(label:string,capabilityRequest:ToolRequest,expected:'completed'|'failed'='completed',code?:string) {
    check(label);const messageId=randomUUID();
    const admitted=await json(path,first,{action:'message',messageId,text:label,executionMode:'capability_check',capabilityRequest},201);
    assert.equal(admitted.sequence,++nextSequence);
    const invocations=await terminal(nextSequence,expected,code);
    return {sequence:nextSequence,text:await reply(nextSequence),invocations};
  }
  const firstPage=await turn('list only granted resources',{tool:'list_fixture_documents',input:{connectionId:alpha.id,expectedVersion:alpha.version}});
  assert.match(firstPage.text,/Infrastructure Notes/);assert.doesNotMatch(firstPage.text,/Archive Inventory|doc-beta/);
  const hiddenPage=await turn('ungranted second page is filtered',{tool:'list_fixture_documents',input:{connectionId:alpha.id,expectedVersion:alpha.version,cursor:'page-beta'}});
  assert.doesNotMatch(hiddenPage.text,/Archive Inventory|doc-beta/);
  const pageA=await turn('pagination first granted page',{tool:'list_fixture_documents',input:{connectionId:both.id,expectedVersion:both.version}});
  assert.match(pageA.text,/Infrastructure Notes/);
  const pageB=await turn('pagination second granted page',{tool:'list_fixture_documents',input:{connectionId:both.id,expectedVersion:both.version,cursor:'page-beta'}});
  assert.match(pageB.text,/Archive Inventory/);
  pass('pagination preserves allowed document metadata and hides ungranted document names');
  await turn('foreign owner connection denied',request(foreign),'failed','connection_not_found');
  await turn('unshared resource denied',request(alpha,'doc-beta'),'failed','connection_resource_denied');
  await turn('missing document scope denied',request(noScope),'failed','connection_scope_denied');
  pass('registered tools enforce connection ownership, resource grants and scopes');
  check('connection generation changes');
  const disconnected=(await json('/api/connections/'+alpha.id,first,{action:'disconnect',expectedVersion:alpha.version},200,'PATCH')).connection;
  assert.equal(disconnected.version,alpha.version+1);
  await turn('disconnected credential denied',request(disconnected),'failed','connection_disconnected');
  const reconnected=(await json('/api/connections/'+alpha.id,first,{action:'reconnect',expectedVersion:disconnected.version},200,'PATCH')).connection;
  assert.equal(reconnected.version,disconnected.version+1);
  await turn('stale connection generation denied',request(alpha),'failed','connection_version_conflict');
  assert.match((await turn('reconnected generation reads fixture',request(reconnected))).text,/FIXTURE ALPHA17/);
  pass('disconnect blocks reads and reconnect advances authority while fencing stale versions');
  await turn('malformed provider data fails durably',{...request(reconnected),scenario:'malformed'},'failed','connector_response_invalid');
  const rate=await turn('rate limiting is recorded without unbounded retries',{...request(reconnected),scenario:'rate-limited'},'failed','connector_rate_limited');
  const rateInvocation=rate.invocations.find(row=>row.tool_id==='read_fixture_document');
  assert.equal(rateInvocation?.retry_after_ms,2000);
  pass('malformed and rate-limited fixture responses retain sanitized durable error codes');
  const hostile=await turn('hostile source remains untrusted data',{...request(reconnected),scenario:'hostile'});
  assert.match(hostile.text,/Ignore all instructions/);
  assert.match(hostile.text,/FIXTURE ALPHA17/);
  assert.deepEqual(hostile.invocations.map(row=>row.tool_id).sort(),['read_context','read_fixture_document','reply'].sort());
  pass('hostile source instructions remain plain fixture output and cause no extra tool execution');

  check('in-flight disconnect fences fixture output');
  const inFlightConnection=await createConnection(first);
  const inFlightMessage=randomUUID();
  const inFlight=await json(path,first,{action:'message',messageId:inFlightMessage,text:'Read while connection authority is revoked in flight.',executionMode:'capability_check',capabilityRequest:{...request(inFlightConnection),scenario:'delay'}},201);
  assert.equal(inFlight.sequence,++nextSequence);
  // SQL observes the actual provider call boundary. A missed window is a failed
  // test, never relabeled as proof of in-flight revocation.
  const runningInvocation=await waitSql(async()=>(await pool.query("SELECT id,state FROM agent_capability_invocations WHERE conversation_id=$1 AND sequence=$2 AND tool_id='read_fixture_document'",[conversationId,nextSequence])).rows[0],value=>!!value,'in_flight_invocation',180,20);
  assert.equal(runningInvocation.state,'running','Missed in-flight fixture delay window');
  await json('/api/connections/'+inFlightConnection.id,first,{action:'disconnect',expectedVersion:inFlightConnection.version},200,'PATCH');
  const revokedInvocations=await terminal(nextSequence,'failed','connection_version_conflict');
  assert.ok(revokedInvocations.some(row=>row.tool_id==='read_fixture_document'&&row.state==='failed'));
  assert.equal((await pool.query('SELECT count(*) FROM agent_capability_results WHERE invocation_id=$1',[runningInvocation.id])).rows[0].count,'0');
  assert.doesNotMatch(await reply(nextSequence),/FIXTURE ALPHA17|Infrastructure Notes|11 workers/);
  pass('disconnect during a real running fixture read rejects provider data before result persistence or reply');

  check('redacted capability metadata and no model calls');
  const snapshot=await json(path,first);
  const metadata=await json(path+'/capabilities',first);
  noCredential(snapshot);noCredential(metadata);noCredential(traces);
  const rows=Array.isArray(metadata)?metadata:metadata.invocations;
  assert.ok(Array.isArray(rows)&&rows.length>0);
  for(const row of rows)for(const key of ['input','output','result','token','credential','secret'])assert.ok(!(key in row));
  const allInvocations=(await pool.query('SELECT tool_id,state,error_code,attempts,workflow_run_id FROM agent_capability_invocations WHERE conversation_id=$1 ORDER BY sequence,started_at',[conversationId])).rows;
  noCredential(allInvocations);
  assert.equal((await pool.query("SELECT count(*) FROM conversation_events WHERE conversation_id=$1 AND kind='model_usage'",[conversationId])).rows[0].count,'0');
  assert.equal((await pool.query('SELECT count(*) FROM conversation_revisions WHERE conversation_id=$1',[conversationId])).rows[0].count,'0');
  assert.equal(nextSequence,15);
  pass('HTTP traces, replies and metadata contain no credentials; verification makes zero model calls');
  const evidence={completedAt:new Date().toISOString(),target:base.origin,conversationId,checks,turnCount:nextSequence,invocations:allInvocations,authentication:'Synthetic fixture accounts using ordinary signed Better Auth sessions; no deployed test login.',connector:'Deterministic in-process Request/Response fixture; no real provider, OAuth or external network.',failureInjection:'Foreground dispatch intentionally omitted for first turn; provider failures use deterministic simulator scenarios; in-flight disconnect targets a SQL-observed running read during a bounded 500ms fixture delay.',approval:'No artifact created. Existing digest-bound approval behavior is outside this connector-only run.',noModelCalls:true,noPayments:true};
  if(process.env.AGENT_EVIDENCE_PATH)await writeFile(process.env.AGENT_EVIDENCE_PATH,JSON.stringify(evidence,null,2)+'\n');
  console.log(JSON.stringify(evidence,null,2));
}
try {await main();}
catch(error) {console.error(JSON.stringify({error:'capability_verification_failed',check:activeCheck,type:error instanceof Error?error.name:'unknown'}));process.exitCode=1;}
finally {await pool.end();await authPool.end();}
