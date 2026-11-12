import type { PoolClient } from 'pg';
import { z } from 'zod';
import { authPool } from './auth';
import { transaction } from './agent-store';
import { CapabilityError } from './capability-contracts';
import { authorizeConnectionUse } from './connection-store';
import { assertContextReferences } from './context-authority';
import { lockConversation } from './conversation-store';
import { assertTurnAuthority } from './routine-store';
import { actionInput,actionDecision,actionDigest,assertActionBinding,assertActionExpiry,type ActionInput,type ActionDecision,type ActionPayload,type ActionProposal,type ActionReceipt } from './action-policy';

type Result={status:number;proposal?:ActionProposal;error?:string};
function dto(row:Record<string,any>):ActionProposal {
 return {id:row.id,payload:row.payload,digest:row.digest,state:row.state,attempts:row.attempts,decidedAt:row.decided_at?new Date(row.decided_at).toISOString():null,error:row.error_code??null,receipt:row.receipt??null};
}
const select=`SELECT p.*,e.receipt FROM agent_action_proposals p LEFT JOIN fixture_note_effects e ON e.proposal_id=p.id`;
function failure(error:unknown):Result {
 if(error&&typeof error==='object'&&'code' in error&&['57014','25P03','55P03'].includes(String(error.code)))return {status:503,error:'ACTION_ADMISSION_UNAVAILABLE'};
 if(error instanceof CapabilityError)return {status:error.status,error:error.code};
 if(error instanceof Error&&error.name==='FatalError')return {status:409,error:'ACTION_AUTHORITY_REVOKED'};
 throw error;
}
async function connection(client:PoolClient,payload:ActionPayload) {
 const handle=await authorizeConnectionUse(client,payload.ownerId,payload.connectionId,{expectedVersion:payload.connectionVersion,requiredScopes:['notes:write'],resourceId:payload.resourceId});
 if(handle.provider!=='fixture')throw new CapabilityError('ACTION_FIXTURE_ONLY',403);
}
async function ownedConversationLock(client:PoolClient,owner:string,id:string,runId?:string) {
 // Lock owner-filtered row before lockConversation to avoid revealing other accounts.
 const owned=(await client.query('SELECT id FROM agent_conversations WHERE id=$1 AND owner_id=$2 FOR UPDATE',[id,owner])).rows[0];
 if(!owned)throw new CapabilityError('ACTION_NOT_FOUND',404);
 return lockConversation(client,id,runId,'read_context');
}
export async function listActions(ownerId:string,conversationId?:string):Promise<ActionProposal[]> {
 if(conversationId&&!z.uuid().safeParse(conversationId).success)return [];
 return (await authPool.query(select+' WHERE p.owner_id=$1 AND ($2::uuid IS NULL OR p.conversation_id=$2) ORDER BY p.created_at DESC LIMIT 100',[ownerId,conversationId??null])).rows.map(dto);
}
export async function getAction(ownerId:string,id:string):Promise<ActionProposal|null> {
 if(!z.uuid().safeParse(id).success)return null;
 const row=(await authPool.query(select+' WHERE p.id=$1 AND p.owner_id=$2',[id,ownerId])).rows[0];
 return row?dto(row):null;
}
export async function proposeAction(ownerId:string,raw:ActionInput,worker?:{sequence:number;workflowRunId:string}):Promise<Result> {
 const parsed=actionInput.safeParse(raw);if(!parsed.success)return {status:400,error:'INVALID_ACTION_INPUT'};
 const input=parsed.data;
 try{return await transaction(async client=>{
  const c=await ownedConversationLock(client,ownerId,input.conversationId,worker?.workflowRunId);
  if(worker&&(c.requested_sequence!==worker.sequence||!(await client.query("SELECT 1 FROM conversation_turns WHERE conversation_id=$1 AND sequence=$2 AND status='running'",[input.conversationId,worker.sequence])).rowCount))throw new CapabilityError('ACTION_WORKER_SUPERSEDED');
  const prior=(await client.query(select+' WHERE p.id=$1',[input.id])).rows[0];
  const payload:ActionPayload={...input,expiresAt:new Date(input.expiresAt??prior?.payload.expiresAt??Date.now()+600_000).toISOString(),ownerId,sequence:c.requested_sequence,kind:'fixture.record_note'};
  const digest=actionDigest(payload);
  if(prior){if(prior.owner_id!==ownerId)return {status:404,error:'ACTION_NOT_FOUND'};if(prior.digest!==digest)return {status:409,error:'ACTION_ID_CONFLICT'};return {status:200,proposal:dto(prior)};}
  assertActionExpiry(payload.expiresAt);
  await assertTurnAuthority(client,c.id,payload.sequence);
  await assertContextReferences(client,c.id,payload.sequence,ownerId);
  await connection(client,payload);
  const target=(await client.query('SELECT version FROM fixture_note_targets WHERE owner_id=$1 AND connection_id=$2 AND resource_id=$3',[ownerId,payload.connectionId,payload.resourceId])).rows[0];
  if((target?.version??0)!==payload.expectedTargetVersion)throw new CapabilityError('ACTION_TARGET_CONFLICT');
  const count=+(await client.query('SELECT count(*) FROM agent_action_proposals WHERE conversation_id=$1',[c.id])).rows[0].count;
  if(count>=50)throw new CapabilityError('ACTION_LIMIT',429);
  const inserted=await client.query(`INSERT INTO agent_action_proposals(id,owner_id,conversation_id,sequence,payload,digest) VALUES($1,$2,$3,$4,$5,$6) ON CONFLICT(id) DO NOTHING RETURNING *`,[input.id,ownerId,c.id,payload.sequence,JSON.stringify(payload),digest]);
  if(!inserted.rowCount)throw new CapabilityError('ACTION_ID_CONFLICT');
  return {status:201,proposal:dto(inserted.rows[0])};
 });}catch(error){return failure(error);}
}
export async function decideAction(ownerId:string,id:string,raw:ActionDecision,options?:{admissionDeadline:number}):Promise<Result> {
 const parsed=actionDecision.safeParse(raw);if(!parsed.success)return {status:400,error:'INVALID_ACTION_DECISION'};
 const existing=await getAction(ownerId,id);if(!existing)return {status:404,error:'ACTION_NOT_FOUND'};
 try{return await transaction(async client=>{
  await client.query("SET LOCAL statement_timeout='5s'");
  await client.query("SET LOCAL idle_in_transaction_session_timeout='5s'");
  const c=await ownedConversationLock(client,ownerId,existing.payload.conversationId);
  const row=(await client.query('SELECT * FROM agent_action_proposals WHERE id=$1 AND owner_id=$2 FOR UPDATE',[id,ownerId])).rows[0];
  if(row.digest!==parsed.data.digest)throw new CapabilityError('ACTION_DIGEST_CONFLICT');
  if(row.state!=='pending') {
   if((parsed.data.decision==='approve'&&['approved','executed'].includes(row.state))||(parsed.data.decision==='reject'&&row.state==='rejected'))return {status:200,proposal:dto((await client.query(select+' WHERE p.id=$1 AND p.owner_id=$2',[id,ownerId])).rows[0])};
   throw new CapabilityError('ACTION_DECISION_CONFLICT');
  }
  if(parsed.data.decision==='approve'){
   assertActionBinding(row.payload,row.digest,ownerId,c.requested_sequence);
   await assertTurnAuthority(client,c.id,row.sequence);
   await assertContextReferences(client,c.id,row.sequence,ownerId);
   await connection(client,row.payload);
   if(!options||!Number.isFinite(options.admissionDeadline)||!(await client.query('SELECT clock_timestamp() < $1::timestamptz AS admitted',[new Date(options.admissionDeadline).toISOString()])).rows[0].admitted)throw new CapabilityError('ACTION_ADMISSION_EXPIRED',503);
  }
  const updated=(await client.query("UPDATE agent_action_proposals SET state=$3,decided_by=$2,decided_digest=$4,decided_at=now(),updated_at=now() WHERE id=$1 AND owner_id=$2 RETURNING *",[id,ownerId,parsed.data.decision==='approve'?'approved':'rejected',parsed.data.digest])).rows[0];
  return {status:200,proposal:dto(updated)};
 });}catch(error){return failure(error);}
}
export async function actionExecutorState(id:string,ownerId:string):Promise<'wait'|'execute'|'done'> {
 const proposal=await getAction(ownerId,id);
 if(!proposal||proposal.state==='pending')return 'wait';
 return proposal.state==='approved'?'execute':'done';
}
export async function executeAction(id:string,ownerId:string):Promise<{state:string;receipt?:ActionReceipt;injectRecovery?:boolean}> {
 const existing=await getAction(ownerId,id);if(!existing)return {state:'missing'};
 return transaction(async client=>{
  // Stable lock order: conversation -> proposal -> context/connection -> target.
  await client.query('SELECT id FROM agent_conversations WHERE id=$1 AND owner_id=$2 FOR UPDATE',[existing.payload.conversationId,ownerId]);
  const row=(await client.query('SELECT * FROM agent_action_proposals WHERE id=$1 AND owner_id=$2 FOR UPDATE',[id,ownerId])).rows[0];
  if(!row)return {state:'missing'};
  const receipt=(await client.query('SELECT receipt FROM fixture_note_effects WHERE proposal_id=$1 AND owner_id=$2',[id,ownerId])).rows[0]?.receipt;
  if(receipt){await client.query('UPDATE agent_action_proposals SET attempts=attempts+1,updated_at=now() WHERE id=$1',[id]);return {state:'executed',receipt};}
  if(row.state!=='approved')return {state:row.state};
  await client.query('UPDATE agent_action_proposals SET attempts=attempts+1,updated_at=now() WHERE id=$1',[id]);
  try {
   const c=await lockConversation(client,existing.payload.conversationId,undefined,'read_context');
   assertActionBinding(row.payload,row.digest,ownerId,c.requested_sequence);
   if(row.decided_by!==ownerId||row.decided_digest!==row.digest)throw new CapabilityError('ACTION_APPROVAL_INVALID');
   await assertTurnAuthority(client,c.id,row.sequence);
   await assertContextReferences(client,c.id,row.sequence,ownerId);
   await connection(client,row.payload);
   await client.query('INSERT INTO fixture_note_targets(owner_id,connection_id,resource_id) VALUES($1,$2,$3) ON CONFLICT DO NOTHING',[ownerId,row.payload.connectionId,row.payload.resourceId]);
   const target=(await client.query('SELECT version FROM fixture_note_targets WHERE owner_id=$1 AND connection_id=$2 AND resource_id=$3 FOR UPDATE',[ownerId,row.payload.connectionId,row.payload.resourceId])).rows[0];
   if(target.version!==row.payload.expectedTargetVersion)throw new CapabilityError('ACTION_TARGET_CONFLICT');
   const version=target.version+1;
   const result:ActionReceipt={proposalId:id,kind:'fixture.record_note',fixture:true,resourceId:row.payload.resourceId,targetVersion:version,note:row.payload.note,committedAt:new Date().toISOString()};
   await client.query('INSERT INTO fixture_note_effects(proposal_id,owner_id,connection_id,resource_id,target_version,note,receipt) VALUES($1,$2,$3,$4,$5,$6,$7)',[id,ownerId,row.payload.connectionId,row.payload.resourceId,version,row.payload.note,JSON.stringify(result)]);
   await client.query('UPDATE fixture_note_targets SET version=$4 WHERE owner_id=$1 AND connection_id=$2 AND resource_id=$3',[ownerId,row.payload.connectionId,row.payload.resourceId,version]);
   await client.query("UPDATE agent_action_proposals SET state='executed',updated_at=now() WHERE id=$1",[id]);
   return {state:'executed',receipt:result,injectRecovery:row.payload.recoveryTest};
  }catch(error){
   // Capability/authority denial is certain: no effect was admitted. Unknown SQL
   // outcomes roll the transaction back and escape; external uncertain outcomes
   // must use needs_review, never blind replay. No external adapter exists here.
   if(!(error instanceof CapabilityError)&&!(error instanceof Error&&error.name==='FatalError'))throw error;
   const code=error instanceof CapabilityError?error.code:'ACTION_AUTHORITY_REVOKED';
   const state=code==='ACTION_EXPIRED'?'expired':'blocked';
   await client.query('UPDATE agent_action_proposals SET state=$2,error_code=$3,updated_at=now() WHERE id=$1',[id,state,code]);
   return {state};
  }
 });
}
