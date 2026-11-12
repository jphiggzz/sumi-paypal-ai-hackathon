import { admittedUser, noStore, sameOrigin } from '../../../lib/agent-api';
import { connectionInput } from '../../../lib/connection-policy';
import { createConnection, listConnections } from '../../../lib/connection-store';

export async function GET(request:Request) {
  const access=await admittedUser(request);
  if(access.error) return access.error;
  return Response.json({connections:await listConnections(access.user.id)},{headers:noStore});
}
export async function POST(request:Request) {
  if(!sameOrigin(request)) return new Response(null,{status:403});
  const access=await admittedUser(request);
  if(access.error) return access.error;
  const parsed=connectionInput.safeParse(await request.json().catch(()=>null));
  if(!parsed.success) return Response.json({error:'invalid_connection'},{status:400,headers:noStore});
  const result=await createConnection(access.user.id,parsed.data);
  return Response.json({...result,consentRequired:result.connection?.status==='requires_authorization'},{status:result.status,headers:noStore});
}
