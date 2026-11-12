import { admittedUser,noStore,sameOrigin } from '../../../../lib/agent-api';
import { actionDecision } from '../../../../lib/action-policy';
import { decideAction,getAction } from '../../../../lib/action-store';
import { armActionExecutor } from '../../../../lib/action-workflow';
type Context={params:Promise<{id:string}>};
export async function GET(request:Request,{params}:Context) {
 const access=await admittedUser(request);if(access.error)return access.error;
 const proposal=await getAction(access.user.id,(await params).id);
 return Response.json(proposal?{proposal}:{error:'ACTION_NOT_FOUND'},{status:proposal?200:404,headers:noStore});
}
export async function POST(request:Request,{params}:Context) {
 if(!sameOrigin(request))return new Response(null,{status:403});
 const access=await admittedUser(request);if(access.error)return access.error;
 const {id}=await params;
 const input=actionDecision.safeParse(await request.json().catch(()=>null));
 if(!input.success)return Response.json({error:'INVALID_ACTION_DECISION'},{status:400,headers:noStore});
 const proposal=await getAction(access.user.id,id);
 if(!proposal)return Response.json({error:'ACTION_NOT_FOUND'},{status:404,headers:noStore});
 // Never arm an unowned or mismatched intent. The commit below revalidates all
 // authority; arming first closes the approval-to-dispatch crash window.
 if(proposal.digest!==input.data.digest)return Response.json({error:'ACTION_DIGEST_CONFLICT'},{status:409,headers:noStore});
 if((input.data.decision==='approve'&&proposal.state==='executed')||(input.data.decision==='reject'&&proposal.state==='rejected'))return Response.json({status:200,proposal},{headers:noStore});
 const admission=input.data.decision==='approve'?await armActionExecutor(id,access.user.id):undefined;
 const result=await decideAction(access.user.id,id,input.data,admission);
 return Response.json(result,{status:result.status,headers:noStore});
}
