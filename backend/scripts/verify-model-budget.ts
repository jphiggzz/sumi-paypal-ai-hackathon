import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import { authPool } from '../lib/auth';
import { reserveModelBudget } from '../lib/model-budget';
async function reserved(){return Number((await authPool.query("SELECT COALESCE((SELECT reserved_usd FROM agent_model_budget WHERE day=(now() AT TIME ZONE 'UTC')::date),0) AS reserved")).rows[0].reserved);}
try {
 const before=await reserved();
 assert.ok(before<14,'Run against the isolated development ledger with spare reservation capacity.');
 // Local verifier configuration only; does not alter hosted environment vars.
 process.env.AGENT_MODEL_DAILY_USD=(before+0.01).toFixed(6);
 const result=await Promise.allSettled([reserveModelBudget('amazon/nova-micro'),reserveModelBudget('amazon/nova-micro')]);
 assert.equal(result.filter(x=>x.status==='fulfilled').length,1);
 assert.equal(result.filter(x=>x.status==='rejected'&&/MODEL_DAILY_BUDGET_EXHAUSTED/.test(String(x.reason))).length,1);
 const after=await reserved();assert.equal(after.toFixed(6),(before+0.01).toFixed(6));
 const evidence={completedAt:new Date().toISOString(),check:'Two concurrent reservations with one call of remaining capacity admit exactly one reservation.',beforeUsd:before,temporaryLocalLimitUsd:+process.env.AGENT_MODEL_DAILY_USD,afterUsd:after,providerInferenceCalls:0,note:'Actual Gateway catalog validation and shared SQL gate; no inference. The local-only limit does not change the hosted $5 default. One $0.01 reservation remains in the ledger for audit. Run without unrelated concurrent inference.'};
 if(process.env.AGENT_EVIDENCE_PATH)await writeFile(process.env.AGENT_EVIDENCE_PATH,JSON.stringify(evidence,null,2)+'\n');
 console.log(JSON.stringify(evidence,null,2));
} finally {await authPool.end();}
