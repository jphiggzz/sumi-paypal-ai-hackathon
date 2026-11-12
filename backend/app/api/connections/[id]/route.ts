import { z } from 'zod';
import { admittedUser, noStore, sameOrigin } from '../../../../lib/agent-api';
import { connectionChange } from '../../../../lib/connection-policy';
import { changeConnection, listConnections } from '../../../../lib/connection-store';

export async function GET(request:Request,{params}:{params:Promise<{id:string}>}) {
  const access=await admittedUser(request);
  if(access.error) return access.error;
  const {id}=await params;
  if(!z.uuid().safeParse(id).success) return Response.json({error:'connection_not_found'},{status:404,headers:noStore});
  const connection=(await listConnections(access.user.id)).find(value=>value.id===id);
  return Response.json(connection?{connection}:{error:'connection_not_found'},{status:connection?200:404,headers:noStore});
}
export async function PATCH(request:Request,{params}:{params:Promise<{id:string}>}) {
  if(!sameOrigin(request)) return new Response(null,{status:403});
  const access=await admittedUser(request);
  if(access.error) return access.error;
  const {id}=await params;
  if(!z.uuid().safeParse(id).success) return Response.json({error:'connection_not_found'},{status:404,headers:noStore});
  const parsed=connectionChange.safeParse(await request.json().catch(()=>null));
  if(!parsed.success) return Response.json({error:'invalid_connection_change'},{status:400,headers:noStore});
  const result=await changeConnection(access.user.id,id,parsed.data);
  return Response.json({...result,consentRequired:result.error==='consent_required'},{status:result.status,headers:noStore});
}
