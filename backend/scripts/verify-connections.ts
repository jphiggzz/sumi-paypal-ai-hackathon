import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { writeFile } from 'node:fs/promises';
import { betterAuth } from 'better-auth';
import { Pool } from 'pg';
import { CapabilityError, type ConnectionHandle } from '../lib/capability-contracts';
import { authorizeConnectionUse, readConnectionForUse } from '../lib/connection-store';
import { authPool } from '../lib/auth';

// Run using matching target DATABASE_URL/BETTER_AUTH_SECRET. This privileged local
// harness issues synthetic-account sessions; deployed sign-in remains unchanged.
// No migrations, inference, OAuth, external providers or paid operations run here.
const base=new URL(process.argv[2] || 'http://localhost:3000');
if(!process.env.DATABASE_URL || !process.env.BETTER_AUTH_SECRET)
  throw new Error('Load the matching target database and auth secret.');
const pool=new Pool({connectionString:process.env.DATABASE_URL,max:2});
const fixtureAuth=betterAuth({secret:process.env.BETTER_AUTH_SECRET,baseURL:base.origin,database:pool,
  user:{modelName:'auth_users'},session:{modelName:'auth_sessions'},account:{modelName:'auth_accounts'},verification:{modelName:'auth_verifications'},emailAndPassword:{enabled:true}});
const headers={'Content-Type':'application/json',Origin:base.origin};
const evidence:{checkedAt:string;target:string;authentication:string;scope:string;checks:string[];fixtureConnectionIds:string[];status:string;failure?:string}={
  checkedAt:new Date().toISOString(),target:base.origin,
  authentication:'Privileged local harness issued ordinary signed Better Auth sessions to two synthetic example.invalid accounts. This does not verify Google OAuth.',
  scope:'Real target SQL and HTTP connection lifecycle only. Fixture connection expiry is fault-injected with privileged SQL. No real provider, OAuth credential, model or external document access.',
  checks:[],fixtureConnectionIds:[],status:'running'};
function passed(label:string){evidence.checks.push(label);console.log('PASS',label);}
async function account(){
  const email=`connection-verifier-${randomUUID()}@example.invalid`;
  const response=await fixtureAuth.api.signUpEmail({body:{email,password:randomUUID()+randomUUID(),name:'Connection verifier'},headers:new Headers(headers),asResponse:true});
  assert.equal(response.status,200);
  const cookie=response.headers.getSetCookie().filter(v=>v.split('=')[0].includes('session_token')).map(v=>v.split(';')[0]).join('; ');
  assert.ok(cookie);
  const owner=(await pool.query('SELECT id FROM auth_users WHERE email=$1',[email])).rows[0].id as string;
  return {cookie,owner};
}
async function call(path:string,session?:string,body?:unknown,method=body===undefined?'GET':'POST',extra:Record<string,string>={}){
  return fetch(new URL(path,base),{method,headers:{...headers,...(session?{Cookie:session}:{}),...extra},...(body===undefined?{}:{body:JSON.stringify(body)})});
}
async function json(path:string,session:string,body?:unknown,status=200,method=body===undefined?'GET':'POST'){
  const response=await call(path,session,body,method);
  assert.equal(response.status,status,`${path} returned unexpected status ${response.status}`);
  return await response.json();
}
function noSecrets(value:unknown){
  const forbidden=/^(?:token|accessToken|refreshToken|access_token|refresh_token|credential|credentialRef|credential_ref|secret|authorization)$/i;
  function walk(node:unknown){if(node&&typeof node==='object')for(const [key,item] of Object.entries(node)){assert.equal(forbidden.test(key),false,`Private field in DTO: ${key}`);walk(item);}}
  walk(value);
  assert.equal(JSON.stringify(value).includes('synthetic-fixture-only.'),false);
}
async function denied(owner:string,id:string,use:{expectedVersion?:number;requiredScopes:string[];resourceId?:string},code:string,status=409){
  await assert.rejects(readConnectionForUse(owner,id,use),error=>error instanceof CapabilityError&&error.code===code&&error.status===status);
}
async function create(session:string,patch:Record<string,unknown>={}){
  const result=await json('/api/connections',session,{provider:'fixture',...patch},201);
  noSecrets(result);evidence.fixtureConnectionIds.push(result.connection.id);
  return result.connection as ConnectionHandle;
}
try {
  const first=await account(),other=await account();
  assert.equal((await call('/api/connections')).status,401);
  assert.equal((await call('/api/connections',undefined,{provider:'fixture'})).status,401);
  assert.equal((await call('/api/connections',first.cookie,{provider:'fixture'},'POST',{Origin:'https://foreign.invalid'})).status,403);
  passed('unauthenticated reads/writes and foreign-origin creation denied');
  const fixture=await create(first.cookie);
  assert.equal(fixture.ownerId,first.owner);assert.equal(fixture.status,'connected');assert.equal(fixture.version,1);
  assert.deepEqual(fixture.scopes,['documents:read']);assert.deepEqual(fixture.resourceIds,['doc-alpha','doc-beta']);
  assert.ok(Date.parse(fixture.expiresAt!)>Date.now());
  assert.equal((await readConnectionForUse(first.owner,fixture.id,{expectedVersion:1,requiredScopes:['documents:read'],resourceId:'doc-alpha'})).id,fixture.id);
  const path='/api/connections/'+fixture.id;
  assert.equal((await call(path,other.cookie)).status,404);
  assert.equal((await call(path,other.cookie,{action:'disconnect',expectedVersion:1},'PATCH')).status,404);
  await denied(other.owner,fixture.id,{requiredScopes:[]},'connection_not_found',404);
  assert.equal((await json('/api/connections',other.cookie)).connections.some((c:ConnectionHandle)=>c.id===fixture.id),false);
  assert.equal((await call(path,first.cookie,{action:'disconnect',expectedVersion:1},'PATCH',{Origin:'https://foreign.invalid'})).status,403);
  passed('fixture defaults work; cross-owner list/detail/mutation/use and foreign-origin mutation denied');
  const reader=await pool.connect(),writer=await pool.connect();
  try{
    await reader.query('BEGIN');await writer.query('BEGIN');
    await writer.query("SET LOCAL lock_timeout='250ms'");
    await authorizeConnectionUse(reader,first.owner,fixture.id,{expectedVersion:1,requiredScopes:['documents:read']});
    await authorizeConnectionUse(writer,first.owner,fixture.id,{expectedVersion:1,requiredScopes:['documents:read']});
    await writer.query('ROLLBACK');await writer.query('BEGIN');
    await writer.query("SET LOCAL lock_timeout='250ms'");
    await assert.rejects(writer.query('UPDATE agent_connections SET version=version WHERE id=$1',[fixture.id]),error=>Boolean(error&&typeof error==='object'&&'code' in error&&error.code==='55P03'));
    await writer.query('ROLLBACK');await reader.query('COMMIT');
  }finally{
    await reader.query('ROLLBACK');await writer.query('ROLLBACK');reader.release();writer.release();
  }
  passed('concurrent SQL read-authority locks coexist and block generation mutation until commit');

  for(const provider of ['google','notion']){
    const real=await create(first.cookie,{provider,scopes:['documents:read'],resourceIds:['doc-alpha']});
    assert.equal(real.status,'requires_authorization');assert.deepEqual(real.scopes,[]);assert.deepEqual(real.resourceIds,[]);
    const reconnect=await json('/api/connections/'+real.id,first.cookie,{action:'reconnect',expectedVersion:1},409,'PATCH');
    assert.equal(reconnect.error,'consent_required');assert.equal(reconnect.consentRequired,true);
    await denied(first.owner,real.id,{requiredScopes:[]},'consent_required');
  }
  passed('Google and Notion metadata remain ungranted and require real consent');
  for(const injected of [{token:'synthetic-client-token'},{credentialRef:'client-reference'},{access_token:'synthetic-client-token'},{ownerId:other.owner}])
    assert.equal((await call('/api/connections',first.cookie,{provider:'fixture',...injected})).status,400);
  assert.equal((await call(path,first.cookie,{action:'reconnect',expectedVersion:1,credentialRef:'client-reference'},'PATCH')).status,400);
  assert.equal((await call(path,first.cookie,{action:'update',expectedVersion:1,resourceIds:['private-document']},'PATCH')).status,400);
  assert.equal((await call(path,first.cookie,{action:'update',expectedVersion:1,scopes:['documents:write']},'PATCH')).status,400);
  passed('client credential references, tokens, owner injection and out-of-catalog grants rejected');
  const raced=await Promise.all([
    call(path,first.cookie,{action:'update',expectedVersion:1,resourceIds:['doc-alpha']},'PATCH'),
    call(path,first.cookie,{action:'update',expectedVersion:1,resourceIds:['doc-alpha']},'PATCH')]);
  assert.deepEqual(raced.map(r=>r.status).sort(),[200,409]);
  const revised=(await json(path,first.cookie)).connection as ConnectionHandle;
  assert.equal(revised.version,2);assert.deepEqual(revised.resourceIds,['doc-alpha']);
  const revisions=(await pool.query('SELECT version,resource_ids FROM agent_connection_revisions WHERE connection_id=$1 ORDER BY version',[fixture.id])).rows;
  assert.deepEqual(revisions.map(r=>r.version),[1,2]);assert.deepEqual(revisions[0].resource_ids,['doc-alpha','doc-beta']);
  await denied(first.owner,fixture.id,{expectedVersion:1,requiredScopes:[]},'connection_version_conflict');
  await denied(first.owner,fixture.id,{expectedVersion:2,requiredScopes:['documents:write']},'connection_scope_denied',403);
  await denied(first.owner,fixture.id,{expectedVersion:2,requiredScopes:['documents:read'],resourceId:'doc-beta'},'connection_resource_denied',403);
  passed('concurrent generation CAS admits exactly one change; old generations and ungranted use fail');
  const client=await pool.connect();
  try{
    await client.query('BEGIN');
    await assert.rejects(client.query("UPDATE agent_connection_revisions SET status='disconnected' WHERE connection_id=$1 AND version=1",[fixture.id]),/Connection generations are immutable/);
    await client.query('ROLLBACK');
  }finally{client.release();}
  assert.equal((await pool.query('SELECT status FROM agent_connection_revisions WHERE connection_id=$1 AND version=1',[fixture.id])).rows[0].status,'connected');
  passed('SQL rejects revision mutation and rollback preserves prior generation');
  const expired=await create(first.cookie,{resourceIds:['doc-alpha']});
  await pool.query("UPDATE agent_connections SET expires_at=now()-interval '1 second' WHERE id=$1 AND owner_id=$2",[expired.id,first.owner]);
  await denied(first.owner,expired.id,{expectedVersion:1,requiredScopes:['documents:read'],resourceId:'doc-alpha'},'connection_expired');
  assert.equal((await json('/api/connections/'+expired.id,first.cookie)).connection.status,'expired');
  const expiry=new Date(Date.now()+7200_000).toISOString();
  const reconnected=(await json('/api/connections/'+expired.id,first.cookie,{action:'reconnect',expectedVersion:1,expiresAt:expiry,resourceIds:['doc-beta']},200,'PATCH')).connection;
  assert.equal(reconnected.version,2);assert.equal(reconnected.expiresAt,expiry);assert.equal(reconnected.status,'connected');
  await denied(first.owner,expired.id,{expectedVersion:1,requiredScopes:[]},'connection_version_conflict');
  await readConnectionForUse(first.owner,expired.id,{expectedVersion:2,requiredScopes:['documents:read'],resourceId:'doc-beta'});
  passed('actual-clock expired fixture use denied; explicit reconnect changes expiry and generation');
  const disconnected=(await json(path,first.cookie,{action:'disconnect',expectedVersion:2},200,'PATCH')).connection;
  assert.equal(disconnected.version,3);assert.equal(disconnected.status,'disconnected');
  await denied(first.owner,fixture.id,{expectedVersion:3,requiredScopes:['documents:read']},'connection_disconnected');
  const resumed=(await json(path,first.cookie,{action:'reconnect',expectedVersion:3},200,'PATCH')).connection;
  assert.equal(resumed.version,4);assert.equal(resumed.status,'connected');
  await denied(first.owner,fixture.id,{expectedVersion:2,requiredScopes:[]},'connection_version_conflict');
  const listing=await json('/api/connections',first.cookie);noSecrets(listing);noSecrets(await json(path,first.cookie));
  passed('disconnect and fixture reconnect fence revoked generations; all public DTOs omit secrets');
  evidence.status='passed';
}catch(error){
  evidence.status='failed';evidence.failure=error instanceof Error?error.message:'Unknown verifier failure';
  throw error;
}finally{
  if(process.env.AGENT_EVIDENCE_PATH)await writeFile(process.env.AGENT_EVIDENCE_PATH,JSON.stringify(evidence,null,2)+'\n');
  await Promise.allSettled([pool.end(),authPool.end()]);
}
console.log(`Verified ${evidence.checks.length} connection checks.`);
