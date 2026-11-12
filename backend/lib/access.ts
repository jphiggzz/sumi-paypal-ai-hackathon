import { createHash, createHmac, timingSafeEqual } from 'node:crypto';

function equal(a: string, b: string) {
  const digest = (value: string) => createHash('sha256').update(value).digest();
  return timingSafeEqual(digest(a), digest(b));
}

export function checkCode(value: string) {
  const code = process.env.SUME_DEMO_CODE;
  return Boolean(code && equal(code, value));
}

export function runToken(id: string) {
  const code = process.env.SUME_DEMO_CODE;
  if (!code) throw new Error('Demo access missing');
  return createHmac('sha256', code).update(id).digest('base64url');
}

export function canAccess(request: Request, id: string) {
  return /^[a-f0-9-]{36}$/.test(id) && Boolean(process.env.SUME_DEMO_CODE) &&
    equal(request.headers.get('authorization') ?? '', 'Bearer ' + runToken(id));
}
