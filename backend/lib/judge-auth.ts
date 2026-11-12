import { betterAuth } from 'better-auth';
import { authPool } from './auth';

// This instance is only called on the server; public auth routes do not expose password sign-up.
export const judgeAuth = betterAuth({
  appName: 'Agent Foundation',
  secret: process.env.BETTER_AUTH_SECRET,
  baseURL: process.env.BETTER_AUTH_URL || (process.env.VERCEL_URL ? `https://${process.env.VERCEL_URL}` : 'http://localhost:3000'),
  database: authPool,
  user: { modelName: 'auth_users' },
  session: { modelName: 'auth_sessions', expiresIn: 60 * 60 * 24 * 7, cookieCache: { enabled: false } },
  account: { modelName: 'auth_accounts', accountLinking: { enabled: false }, encryptOAuthTokens: true },
  verification: { modelName: 'auth_verifications' },
  emailAndPassword: { enabled: true },
});
