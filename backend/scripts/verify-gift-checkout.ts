/** Synthetic gift plans and users; real PayPal Sandbox orders and test-card captures. */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { betterAuth } from 'better-auth';
import { authPool } from '../lib/auth';
import { giftPayPal } from '../lib/gift-paypal';
import { executeGiftAction, giftActionInput } from '../lib/gift-api';
import { createGiftGroup, joinGiftGroup, selectGiftOption, setGiftLimit, readGiftState } from '../lib/gift-store';
const base = process.env.WORKSPACE_VERIFY_URL || 'http://localhost:3016';
if (!/^http:\/\/localhost:\d+$/.test(base)) throw Error('Local verification only');
const auth = betterAuth({ secret: process.env.BETTER_AUTH_SECRET, baseURL: base, database: authPool, user: { modelName: 'auth_users' }, session: { modelName: 'auth_sessions' }, account: { modelName: 'auth_accounts' }, verification: { modelName: 'auth_verifications' }, emailAndPassword: { enabled: true } });
const users: { id: string; name: string }[] = [];
async function account(name: string) {
  const response = await auth.api.signUpEmail({ body: { email: `checkout-test-${randomUUID()}@example.invalid`, name, password: randomUUID() + randomUUID() }, asResponse: true });
  assert.equal(response.status, 200); const { user } = await response.json(); users.push(user); return user;
}
async function action(user: {id:string;name:string}, groupId: string, input: object) {
  return await executeGiftAction(user, giftActionInput.parse({ groupId, ...input }), base, '/workspace?conversation=00000000-0000-4000-8000-000000000000') as any;
}
async function scenario(group: boolean) {
  const owner = await account(group ? 'Synthetic organizer' : 'Synthetic solo');
  const friend = group ? await account('Synthetic friend') : null;
  const outsider = await account('Synthetic outsider');
  const id = randomUUID(); const created = await createGiftGroup(owner, { id, recipient: 'Test recipient', occasion: 'Synthetic gift', reserveCents: 1000 });
  if (friend) await joinGiftGroup(friend, created.inviteToken!);
  await setGiftLimit(owner.id, id, 5000); if (friend) await setGiftLimit(friend.id, id, 5000);
  const before = await readGiftState(owner.id, id) as any;
  const jobId = randomUUID();
  const product = { id:'fixture-product', title:'Synthetic gift', description:'Fixture', category:'test', url:'https://example.com/gift', image:null, merchant:'example.com', cents:3000, currency:'USD', retrievedAt:new Date().toISOString() };
  const option = { id:'0', title:'Synthetic gift plan', reason:'Fixture', factIds:[], cautions:[], lines:[product], subtotalCents:3000, reserveCents:1000, goalCents:4000 };
  await authPool.query("INSERT INTO gift_jobs(id,group_id,member_id,kind,revision,status,input,result) VALUES($1,$2,$3,'plan',$4,'ready',$5,$6)", [jobId,id,before.me.id,before.group.revision,JSON.stringify({}),JSON.stringify({options:[option]})]);
  await selectGiftOption(owner.id,id,jobId,'0');
  let state = await readGiftState(owner.id,id) as any; const digest=state.option.digest;
  await assert.rejects(() => action(outsider,id,{action:'checkout',id:randomUUID(),digest,cents:100}));
  await assert.rejects(() => action(owner,id,{action:'checkout',id:randomUUID(),digest:'a'.repeat(64),cents:100}));
  await assert.rejects(() => action(owner,id,{action:'checkout',id:randomUUID(),digest,cents:5001}));
  assert.equal((await readGiftState(owner.id,id) as any).me.approvedDigest, null);
  for (const user of [owner,...(friend ? [friend] : [])]) {
    const contribution = randomUUID();
    const simultaneous = await Promise.all([action(user,id,{action:'checkout',id:contribution,digest,cents:100}), action(user,id,{action:'checkout',id:contribution,digest,cents:100})]);
    state = simultaneous[0];
    assert.equal(simultaneous[0].payments.find((p:any)=>p.id===contribution).order_id, simultaneous[1].payments.find((p:any)=>p.id===contribution).order_id);
    let payment=state.payments.find((p:any)=>p.id===contribution);
    assert.equal(state.me.approvedDigest,digest); assert.equal(payment.status,'created');
    assert.match(payment.approval_url,/^https:\/\/(www\.)?sandbox\.paypal\.com\//);
    const retry=await action(user,id,{action:'checkout',id:contribution,digest,cents:100});
    assert.equal(retry.payments.find((p:any)=>p.id===contribution).order_id,payment.order_id);
    await assert.rejects(() => action(user,id,{action:'checkout',id:contribution,digest,cents:101}));
    await assert.rejects(() => action(outsider,id,{action:'capture',id:contribution}));
    // A return without payer approval must not capture or report success.
    const notApproved=await action(user,id,{action:'capture',id:contribution});
    assert.notEqual(notApproved.payments.find((p:any)=>p.id===contribution).status,'completed');
    const confirmation=await giftPayPal(`/v2/checkout/orders/${payment.order_id}/confirm-payment-source`,'POST',{payment_source:{card:{number:'4005519200000004',expiry:'2030-12',security_code:'123',name:'Sandbox Test'}}},'checkout-test-'+contribution);
    assert.ok(confirmation.ok,'Sandbox test card approval failed');
    state=await action(user,id,{action:'capture',id:contribution}); payment=state.payments.find((p:any)=>p.id===contribution);
    assert.equal(payment.status,'completed'); assert.ok(payment.capture_id);
    const repeated=await action(user,id,{action:'capture',id:contribution});
    assert.equal(repeated.payments.find((p:any)=>p.id===contribution).capture_id,payment.capture_id);
    if (friend && user.id === owner.id) assert.equal((await readGiftState(friend.id,id) as any).me.approvedDigest,null);
  }
  if (!group) {
    const pendingId=randomUUID();
    const pending=await action(owner,id,{action:'checkout',id:pendingId,digest,cents:100});
    const pendingOrder=pending.payments.find((p:any)=>p.id===pendingId).order_id;
    const approval=await giftPayPal(`/v2/checkout/orders/${pendingOrder}/confirm-payment-source`,'POST',{payment_source:{card:{number:'4005519200000004',expiry:'2030-12',security_code:'123',name:'Sandbox Test'}}},'stale-'+pendingId);
    assert.ok(approval.ok);
    await setGiftLimit(owner.id,id,4900);
    await assert.rejects(() => action(owner,id,{action:'capture',id:pendingId}));
    const unchanged=await giftPayPal(`/v2/checkout/orders/${pendingOrder}`);
    assert.equal(unchanged.data.status,'APPROVED');
  }
  console.log(JSON.stringify({scenario:group?'group':'solo',sandboxCaptures:friend?2:1,duplicateProtection:true,unauthorizedDenied:true,unapprovedNotCaptured:true,individualApprovals:true,staleBeforeCaptureTested:!group}));
}
try { await scenario(false); await scenario(true); }
finally { for (const u of users) await authPool.query('DELETE FROM auth_users WHERE id=$1',[u.id]); await authPool.end(); }
