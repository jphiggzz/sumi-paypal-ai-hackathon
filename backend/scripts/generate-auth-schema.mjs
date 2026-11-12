import { writeFile } from 'node:fs/promises';
import { Pool } from 'pg';
import { getMigrations } from 'better-auth/db/migration';

const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 1 });
try {
  const plan = await getMigrations({
    database: pool,
    user: { modelName: 'auth_users' },
    session: { modelName: 'auth_sessions' },
    account: { modelName: 'auth_accounts' },
    verification: { modelName: 'auth_verifications' },
  });
  await writeFile(new URL('./migrations/001_auth.sql', import.meta.url), await plan.compileMigrations());
  console.log('Auth migration generated. No schema changes applied.');
} finally { await pool.end(); }
