import { createHash, timingSafeEqual } from 'node:crypto';

export function checkJudgeCode(value: string) {
  const code = process.env.SUME_JUDGE_CODE;
  if (!code || !value) return false;
  const hash = (s: string) => createHash('sha256').update(s).digest();
  return timingSafeEqual(hash(code), hash(value));
}

export function isJudgeEmail(email: string) {
  return /^judge-[a-f0-9-]{36}@sumi\.invalid$/.test(email);
}
