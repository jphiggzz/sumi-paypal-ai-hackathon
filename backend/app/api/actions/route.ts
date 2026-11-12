import { admittedUser,noStore,sameOrigin } from '../../../lib/agent-api';
import { actionInput } from '../../../lib/action-policy';
import { listActions,proposeAction } from '../../../lib/action-store';
export async function GET(request:Request) {
 const access=await admittedUser(request);if(access.error)return access.error;
 const conversationId=new URL(request.url).searchParams.get('conversationId')??undefined;
 return Response.json({proposals:await listActions(access.user.id,conversationId)},{headers:noStore});
}
export async function POST(request:Request) {
 if(!sameOrigin(request))return new Response(null,{status:403});
 const access=await admittedUser(request);if(access.error)return access.error;
 const input=actionInput.safeParse(await request.json().catch(()=>null));
 if(!input.success)return Response.json({error:'INVALID_ACTION_INPUT'},{status:400,headers:noStore});
 const result=await proposeAction(access.user.id,input.data);
 return Response.json(result,{status:result.status,headers:noStore});
}
