import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { betterAuth } from "better-auth";
import { authPool } from "../lib/auth";
import { initialCampaign } from "../lib/creator/policy";

const base = process.env.WORKSPACE_VERIFY_URL || "http://localhost:3016";
if (!/^http:\/\/localhost:\d+$/.test(base)) throw Error("Local verification only");
const auth = betterAuth({ secret: process.env.BETTER_AUTH_SECRET, baseURL: base, database: authPool,
  user: { modelName: "auth_users" }, session: { modelName: "auth_sessions" },
  account: { modelName: "auth_accounts" }, verification: { modelName: "auth_verifications" },
  emailAndPassword: { enabled: true } });
let userId: string | undefined;
try {
  const signup = await auth.api.signUpEmail({ body: { email: `retry-${randomUUID()}@example.invalid`,
    name: "Retry test", password: randomUUID() + randomUUID() }, asResponse: true });
  assert.equal(signup.status, 200);
  userId = (await signup.json()).user.id;
  const cookie = signup.headers.getSetCookie().filter(c => c.split("=")[0].includes("session_token")).map(c => c.split(";")[0]).join("; ");
  const cid = randomUUID(), id = randomUUID(), attempt = randomUUID();
  await authPool.query("INSERT INTO workspace_chats(id,owner_id,mode) VALUES($1,$2,'creators')", [cid,userId]);
  await authPool.query("INSERT INTO workspace_chat_messages(id,conversation_id,role,content,mode,status) VALUES($1,$2,'assistant','Test','creators','completed')", [id,cid]);
  await authPool.query("INSERT INTO creator_campaigns(conversation_id,state) VALUES($1,$2)", [cid,JSON.stringify({...initialCampaign(),revision:1})]);
  // Deliberately invalid input makes the synthetic workflow fail before any model call.
  await authPool.query("INSERT INTO creator_runs(id,conversation_id,message_id,revision,status,input,attempt) VALUES($1,$2,$1,1,'running','{}',$3)", [id,cid,attempt]);
  const retry = () => fetch(base + "/api/creator-campaign/retry", { method:"POST", headers:{Origin:base,"Content-Type":"application/json","x-demo-code":process.env.SUME_DEMO_CODE || "",Cookie:cookie},body:JSON.stringify({runId:id}) });
  assert.equal((await retry()).status,409);
  await authPool.query("UPDATE creator_runs SET updated_at=now()-interval '4 minutes' WHERE id=$1", [id]);
  assert.equal((await retry()).status,200);
  const row = (await authPool.query("SELECT attempt FROM creator_runs WHERE id=$1", [id])).rows[0];
  assert.notEqual(row.attempt,attempt);
  console.log(JSON.stringify({checks:["fresh running attempt cannot retry", "stalled running attempt can retry", "retry changes fenced attempt"], modelCalls:0, paymentExecuted:false}));
} finally {
  if (userId) await authPool.query("DELETE FROM auth_users WHERE id=$1", [userId]);
  await authPool.end();
}
