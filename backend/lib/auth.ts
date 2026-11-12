import { betterAuth } from 'better-auth';
import { nextCookies } from 'better-auth/next-js';
import { Pool } from 'pg';

export const authPool = new Pool({ connectionString: process.env.DATABASE_URL, max: 3, idleTimeoutMillis: 10_000 });
export const auth = betterAuth({
  appName: 'Agent Foundation',
  secret: process.env.BETTER_AUTH_SECRET,
  baseURL: process.env.BETTER_AUTH_URL || (process.env.VERCEL_URL ? `https://${process.env.VERCEL_URL}` : 'http://localhost:3000'),
  database: authPool,
  user: { modelName: 'auth_users' },
  session: { modelName: 'auth_sessions', expiresIn: 60 * 60 * 24 * 7, cookieCache: { enabled: false } },
  account: { modelName: 'auth_accounts', accountLinking: { enabled: false }, encryptOAuthTokens: true },
  verification: { modelName: 'auth_verifications' },
  socialProviders: process.env.GOOGLE_CLIENT_ID && process.env.GOOGLE_CLIENT_SECRET ? {
    google: { clientId: process.env.GOOGLE_CLIENT_ID, clientSecret: process.env.GOOGLE_CLIENT_SECRET },
  } : {},
  plugins: [nextCookies()],
});

export async function currentUser(request: Request) {
  const session = await auth.api.getSession({ headers: request.headers });
  return session?.user ?? null;
}
