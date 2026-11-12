import { randomBytes, randomUUID } from 'node:crypto';
import { z } from 'zod';
import { authPool } from '../../../lib/auth';
import { sameOrigin, noStore } from '../../../lib/agent-api';
import { boundedJson, apiFailure } from '../../../lib/foundation-api';
import { checkJudgeCode } from '../../../lib/judge-access';
import { judgeAuth } from '../../../lib/judge-auth';

async function reserve(kind: string, limit: number) {
  const result = await authPool.query(
    "INSERT INTO foundation_work_quota VALUES((now() AT TIME ZONE 'UTC')::date,$1,$2,1) ON CONFLICT(day,owner_id,kind) DO UPDATE SET count=foundation_work_quota.count+1 WHERE foundation_work_quota.count<$3 RETURNING count",
    ['judge-access', kind, limit],
  );
  return Boolean(result.rowCount);
}

export async function POST(request: Request) {
  if (!sameOrigin(request)) return new Response(null, { status: 403, headers: noStore });
  try {
    const parsed = z.object({ code: z.string().min(1).max(256) }).safeParse(await boundedJson(request));
    if (!parsed.success) return Response.json({ error: 'Invalid code.' }, { status: 400, headers: noStore });
    if (!await reserve('attempts', 300)) return Response.json({ error: 'Access limit reached.' }, { status: 429, headers: noStore });
    if (!checkJudgeCode(parsed.data.code)) return Response.json({ error: 'Invalid code.' }, { status: 403, headers: noStore });
    if (!await reserve('sessions', 40)) return Response.json({ error: 'Access limit reached.' }, { status: 429, headers: noStore });
    const result = await judgeAuth.api.signUpEmail({ body: {
      name: 'Judge', email: `judge-${randomUUID()}@sumi.invalid`, password: randomBytes(32).toString('base64url'),
    }, asResponse: true });
    if (!result.ok) return Response.json({ error: 'Could not start a session.' }, { status: 503, headers: noStore });
    const response = Response.json({ ok: true }, { headers: noStore });
    for (const cookie of result.headers.getSetCookie()) response.headers.append('Set-Cookie', cookie);
    return response;
  } catch (error) { return apiFailure(error); }
}
