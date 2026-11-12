import { readFile, readdir } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { Pool } from 'pg';

const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 1 });
const client = await pool.connect();
try {
  await client.query('BEGIN');
  // Transaction-scoped locks also work through Neon's transaction pooler.
  await client.query("SELECT pg_advisory_xact_lock(hashtext('agent-foundation-migrations'))");
  await client.query('CREATE TABLE IF NOT EXISTS foundation_migrations(name text PRIMARY KEY,checksum text NOT NULL,applied_at timestamptz NOT NULL DEFAULT now())');
  const names = ['000_campaign.sql', ...(await readdir(new URL('./migrations/', import.meta.url))).filter(name => name.endsWith('.sql')).sort()];
  for (const name of names) {
    const sql = await readFile(new URL(name === '000_campaign.sql' ? './schema.sql' : './migrations/' + name, import.meta.url), 'utf8');
    const checksum = createHash('sha256').update(sql).digest('hex');
    const previous = (await client.query('SELECT checksum FROM foundation_migrations WHERE name=$1', [name])).rows[0];
    if (previous) {
      if (previous.checksum !== checksum) throw new Error('Applied migration changed: ' + name);
      continue;
    }
    await client.query(sql);
    await client.query('INSERT INTO foundation_migrations(name,checksum) VALUES($1,$2)', [name, checksum]);
  }
  await client.query('COMMIT');
  console.log('Database migrations verified and applied.');
} catch (error) {
  await client.query('ROLLBACK');
  throw error;
} finally {
  client.release();
  await pool.end();
}
