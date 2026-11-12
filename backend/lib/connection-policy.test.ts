import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { PoolClient } from 'pg';
import { CapabilityError, type ConnectionHandle } from './capability-contracts.ts';
import { assertConnectionUse, changedConnection, connectionChange, connectionExpiry, connectionInput } from './connection-policy.ts';
import { acquireFixtureCredential, authorizeConnectionUse } from './connection-store.ts';
const now=Date.parse('2026-11-09T10:00:00Z');
const connected:ConnectionHandle={id:'c',ownerId:'owner-a',provider:'fixture',version:1,status:'connected',scopes:['documents:read'],resourceIds:['doc-alpha'],expiresAt:new Date(now+3600_000).toISOString()};
function fails(run:()=>unknown,code:string,status=409) {
  assert.throws(run,(error:unknown)=>error instanceof CapabilityError && error.code===code && error.status===status);
}
test('connection permissions bind owner, generation, scope, resource and expiry',()=>{
  assertConnectionUse(connected,'owner-a',{expectedVersion:1,requiredScopes:['documents:read'],resourceId:'doc-alpha'},now);
  fails(()=>assertConnectionUse(connected,'owner-b',{requiredScopes:[]},now),'connection_not_found',404);
  fails(()=>assertConnectionUse(undefined,'owner-a',{requiredScopes:[]},now),'connection_not_found',404);
  fails(()=>assertConnectionUse(connected,'owner-a',{expectedVersion:2,requiredScopes:[]},now),'connection_version_conflict');
  fails(()=>assertConnectionUse(connected,'owner-a',{requiredScopes:['documents:write']},now),'connection_scope_denied',403);
  fails(()=>assertConnectionUse(connected,'owner-a',{requiredScopes:[],resourceId:'doc-beta'},now),'connection_resource_denied',403);
  fails(()=>assertConnectionUse(connected,'owner-a',{requiredScopes:[]},now+3600_000),'connection_expired');
});
test('disconnect, narrowing and reconnect fence every previous generation',()=>{
  const disconnected=changedConnection(connected,{action:'disconnect',expectedVersion:1},now);
  assert.equal(disconnected.version,2);
  assert.equal(connected.status,'connected');
  fails(()=>assertConnectionUse(disconnected,'owner-a',{expectedVersion:1,requiredScopes:[]},now),'connection_version_conflict');
  fails(()=>assertConnectionUse(disconnected,'owner-a',{expectedVersion:2,requiredScopes:[]},now),'connection_disconnected');
  fails(()=>changedConnection(disconnected,{action:'reconnect',expectedVersion:1},now),'connection_version_conflict');
  const reconnected=changedConnection(disconnected,{action:'reconnect',expectedVersion:2,resourceIds:['doc-beta']},now);
  assert.equal(reconnected.version,3);
  fails(()=>assertConnectionUse(reconnected,'owner-a',{expectedVersion:2,requiredScopes:[]},now),'connection_version_conflict');
  fails(()=>assertConnectionUse(reconnected,'owner-a',{requiredScopes:[],resourceId:'doc-alpha'},now),'connection_resource_denied',403);
  fails(()=>changedConnection(disconnected,{action:'update',expectedVersion:2},now),'connection_reconnect_required');
  fails(()=>changedConnection(connected,{action:'update',expectedVersion:1},now+3600_000),'connection_reconnect_required');
});
test('real providers stay behind consent and cannot be reconnected or scope updated',()=>{
  for(const provider of ['google','notion'] as const) {
    const real={...connected,provider,status:'requires_authorization' as const};
    fails(()=>assertConnectionUse(real,'owner-a',{requiredScopes:[]},now),'consent_required');
    fails(()=>changedConnection(real,{action:'reconnect',expectedVersion:1},now),'consent_required');
    fails(()=>changedConnection(real,{action:'update',expectedVersion:1},now),'consent_required');
    assert.equal(changedConnection(real,{action:'disconnect',expectedVersion:1},now).status,'disconnected');
  }
});
test('client input cannot inject credentials, status, ownership or out-of-catalog grants',()=>{
  assert.equal(connectionInput.safeParse({provider:'fixture'}).success,true);
  for(const input of [{provider:'fixture',token:'secret'},{provider:'fixture',ownerId:'other'},{provider:'fixture',status:'connected'},{provider:'fixture',resourceIds:['private']},{provider:'fixture',scopes:['documents:write']}])
    assert.equal(connectionInput.safeParse(input).success,false);
  assert.equal(connectionChange.safeParse({action:'disconnect',expectedVersion:1,scopes:[]}).success,false);
  fails(()=>connectionExpiry(null,now),'invalid_connection_expiry',400);
  fails(()=>connectionExpiry(new Date(now).toISOString(),now),'invalid_connection_expiry',400);
  fails(()=>connectionExpiry(new Date(now+31*86400_000).toISOString(),now),'invalid_connection_expiry',400);
});
test('store authorization takes an owner-scoped shared lock and broker returns only a synthetic fixture secret',async()=>{
  const id='fe4c2930-b528-4816-8df1-f3d9baaa7dfb';
  const calls:Array<{sql:string;values:unknown[]}>=[];
  const row={id,owner_id:'owner-a',provider:'fixture',version:1,status:'connected',scopes:['documents:read'],resource_ids:['doc-alpha'],expires_at:new Date(Date.now()+3600_000)};
  const client={query:async(sql:string,values:unknown[])=>{calls.push({sql,values});return {rows:values[1]==='owner-a'?[row]:[]};}} as unknown as PoolClient;
  const credential=await acquireFixtureCredential(client,'owner-a',id,{expectedVersion:1,requiredScopes:['documents:read'],resourceId:'doc-alpha'});
  assert.ok(credential.token.startsWith(`synthetic-fixture-only.${id}.1.`));
  assert.equal('token' in credential.connection,false);
  assert.match(calls[0].sql,/owner_id=\$2 FOR SHARE$/);
  assert.deepEqual(calls[0].values,[id,'owner-a']);
  await assert.rejects(authorizeConnectionUse(client,'owner-b',id,{requiredScopes:[]}),error=>error instanceof CapabilityError&&error.code==='connection_not_found');
  row.version=2;row.status='disconnected';
  await assert.rejects(acquireFixtureCredential(client,'owner-a',id,{expectedVersion:1,requiredScopes:[]}),error=>error instanceof CapabilityError&&error.code==='connection_version_conflict');
});
