/** Actual production queries over transaction-local temporary fixtures. No real
 * event sequence/cursor/data is changed and no model/workflow is started. */
import assert from 'node:assert/strict';
import {writeFile} from 'node:fs/promises';
import {authPool} from '../lib/auth';
import {readResults} from '../lib/result-store';
import {readHistory} from '../lib/history-store';
const c=await authPool.connect();
try{await c.query('BEGIN');const actor=(await c.query("SELECT c.id,c.owner_id FROM agent_conversations c JOIN auth_users u ON u.id=c.owner_id WHERE u.email LIKE 'documents-jobs-%@example.invalid' ORDER BY c.created_at DESC LIMIT 1")).rows[0];assert.ok(actor);
 await c.query('CREATE TEMP TABLE result_events(id bigint,owner_id text,conversation_id uuid,job_id uuid,kind text,detail jsonb,created_at timestamptz) ON COMMIT DROP');
 await c.query("INSERT INTO result_events VALUES(9,$1,$2,NULL,'fixture','{}',now()),(10,$1,$2,NULL,'fixture','{}',now())",[actor.owner_id,actor.id]);
 const first=await readResults(c,actor.owner_id,{after:'0',limit:1});assert.equal(first.events[0].id,'9');assert.equal(first.hasMore,true);const second=await readResults(c,actor.owner_id,{after:first.nextCursor,limit:1});assert.equal(second.events[0].id,'10');assert.equal(second.hasMore,false);
 await c.query('CREATE TEMP TABLE conversation_messages(id bigint,conversation_id uuid,sequence integer,role text,content text) ON COMMIT DROP');
 await c.query("INSERT INTO conversation_messages VALUES(9,$1,1,'user','earlier'),(10,$1,1,'user','later')",[actor.id]);
 const recent=await readHistory(c,actor.owner_id,actor.id,1,{query:'',limit:1});assert.equal(recent.messages[0].id,'10');assert.equal(recent.nextCursor,'1:10');const older=await readHistory(c,actor.owner_id,actor.id,1,{query:'',limit:1,beforeCursor:recent.nextCursor!});assert.equal(older.messages[0].id,'9');assert.equal(older.nextCursor,null);
 const evidence={checkedAt:new Date().toISOString(),success:true,checks:['Result-feed query orders IDs numerically across9/10; two pages contain both events.','History query orders message IDs numerically within one sequence; the continuation retains both messages.'],method:'Production query functions execute against transaction-local temporary tables shadowing only the two read tables. No identity sequence was reset or advanced, no fixture event was added to the real feed, and the transaction is rolled back.',inferenceCalls:0};if(process.env.AGENT_EVIDENCE_PATH)await writeFile(process.env.AGENT_EVIDENCE_PATH,JSON.stringify(evidence,null,2)+'\n');console.log(JSON.stringify(evidence,null,2));
}finally{await c.query('ROLLBACK');c.release();await authPool.end();}
