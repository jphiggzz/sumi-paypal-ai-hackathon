import { start } from 'workflow/api';
import { RetryableError, sleep } from 'workflow';
import { actionExecutorState, executeAction } from './action-store';

// Arm before the approval transaction. Missing/never-approved SQL intents expire
// here after a bounded wait, requiring no browser or subsequent request.
export async function armActionExecutor(id:string,ownerId:string) {
 const admissionDeadline=Date.now()+30_000;
 await start(actionExecutorWorkflow,[id,ownerId]);
 return {admissionDeadline};
}
export async function actionExecutorWorkflow(id:string,ownerId:string) {
 'use workflow';
 // Every admitted approval has its own bounded watcher; no terminal hook
 // dedup race can strand an approval. SQL proposal/effect locks deduplicate.
 for(let checks=0;checks<30;checks++) {
  const state=await readState(id,ownerId);
  if(state==='done')return;
  if(state==='execute'){await applyFixtureAction(id,ownerId);return;}
  if(checks<29)await sleep('2s');
 }
}
async function readState(id:string,ownerId:string) {
 'use step';
 return actionExecutorState(id,ownerId);
}
async function applyFixtureAction(id:string,ownerId:string) {
 'use step';
 const result=await executeAction(id,ownerId);
 if(result.injectRecovery)throw new RetryableError('Synthetic interruption after local fixture note commit',{retryAfter:'2s'});
 return result;
}
// At most three execution attempts; the synthetic after-commit interruption
// normally needs two. SQL receipts reconcile any uncertain local commit.
applyFixtureAction.maxRetries=2;
