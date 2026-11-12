import assert from 'node:assert/strict';
import { test } from 'node:test';
import { CapabilityError } from './capability-contracts';
import { actionInput,actionDecision,actionDigest,assertActionBinding,assertActionExpiry,type ActionPayload } from './action-policy';
import { connectionInput } from './connection-policy';
const now=Date.parse('2026-11-09T12:00:00Z');
const payload:ActionPayload={id:'b0fc9772-60ad-44c2-bcdb-c4c716f0f609',ownerId:'owner-a',conversationId:'f192945d-f9e4-467b-9580-7a8bec3f076a',sequence:1,kind:'fixture.record_note',connectionId:'3993cc20-91de-4007-92ae-afbaf05943e9',connectionVersion:1,resourceId:'doc-alpha',note:'Reviewed seven workers.',expectedTargetVersion:0,expiresAt:new Date(now+600000).toISOString(),recoveryTest:false};
function denied(run:()=>void,code:string){assert.throws(run,error=>error instanceof CapabilityError&&error.code===code);}
test('action digest binds exact approved content and every authority/target boundary',()=>{
 const hash=actionDigest(payload);
 assert.equal(actionDigest({...payload}),hash);
 for(const patch of [{ownerId:'owner-b'},{sequence:2},{connectionVersion:2},{resourceId:'doc-beta' as const},{note:'Different text'},{expectedTargetVersion:1},{expiresAt:new Date(now+700000).toISOString()},{conversationId:'different'},{recoveryTest:true}])assert.notEqual(actionDigest({...payload,...patch}),hash);
 assertActionBinding(payload,hash,'owner-a',1,now);
 denied(()=>assertActionBinding(payload,hash,'owner-b',1,now),'ACTION_NOT_FOUND');
 denied(()=>assertActionBinding(payload,'0'.repeat(64),'owner-a',1,now),'ACTION_DIGEST_CONFLICT');
 denied(()=>assertActionBinding(payload,hash,'owner-a',2,now),'ACTION_SUPERSEDED');
 denied(()=>assertActionBinding(payload,hash,'owner-a',1,now+600000),'ACTION_EXPIRED');
});
test('proposal and decision schemas cannot smuggle a provider, permission, args edit or credential',()=>{
 const {ownerId,sequence,kind,...input}=payload;void ownerId;void sequence;void kind;
 assert.equal(actionInput.safeParse(input).success,true);
 for(const patch of [{token:'secret'},{kind:'paypal.send'},{resourceId:'private'},{connectionVersion:0},{expectedTargetVersion:-1},{note:'x'.repeat(501)},{note:'bad\u0000note'},{note:'bad\u0007note'}])assert.equal(actionInput.safeParse({...input,...patch}).success,false);
 assert.equal(actionDecision.safeParse({decision:'approve',digest:actionDigest(payload),note:'Changed'}).success,false);
 assert.equal(actionDecision.safeParse({decision:'approve',digest:'not-a-digest'}).success,false);
 denied(()=>assertActionExpiry(new Date(now).toISOString(),now),'ACTION_EXPIRY_INVALID');
 denied(()=>assertActionExpiry(new Date(now+86400001).toISOString(),now),'ACTION_EXPIRY_INVALID');
 assertActionExpiry(new Date(now+86400000).toISOString(),now);
});
test('note write authority is fixture-only and read defaults are not widened',()=>{
 assert.equal(connectionInput.safeParse({provider:'fixture',scopes:['documents:read','notes:write']}).success,true);
 assert.equal(connectionInput.safeParse({provider:'google',scopes:['notes:write']}).success,false);
 assert.equal(connectionInput.safeParse({provider:'notion',scopes:['notes:write']}).success,false);
 assert.equal(connectionInput.parse({provider:'fixture'}).scopes,undefined);
});
