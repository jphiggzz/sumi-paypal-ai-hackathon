import { currentUser } from './auth';
import { checkCode } from './access';

export async function admittedUser(request: Request) {
  const user = await currentUser(request);
  if (!user) return { error: Response.json({ error: 'Sign in to continue.' }, { status: 401 }) };
  return { user };
}
export function sameOrigin(request: Request) {
  return request.headers.get('origin') === new URL(request.url).origin;
}
export function isAdmittedEmail(email: string, verified: boolean) {
  return verified && (process.env.AGENT_ALLOWED_EMAILS ?? '').split(',').map(value => value.trim().toLowerCase()).filter(Boolean).includes(email.toLowerCase());
}
export function canStartTask(request: Request, user: { email: string; emailVerified: boolean }) {
  // Separate account authentication from admission to a metered shared preview.
  return isAdmittedEmail(user.email, user.emailVerified) || checkCode(request.headers.get('x-demo-code') ?? '');
}
export const noStore = { 'Cache-Control': 'private, no-store' };
