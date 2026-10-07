/**
 * Minimal, dependency-light migration runner.
 * Applies prisma/migrations/<timestamp>_<name>/migration.sql in order inside a transaction each,
 * and records them in "_schema_migrations". Idempotent: already-applied migrations are skipped.
 *
 *   npm run db:migrate            apply pending migrations
 *   npm run db:migrate -- --reset drop & recreate the public schema first (DEV ONLY)
 */
import fs from 'node:fs';
import path from 'node:path';
import { Client } from 'pg';
import dotenv from 'dotenv';

dotenv.config({ path: path.resolve(__dirname, '../../.env'), quiet: true });

export async function migrate(databaseUrl: string, opts: { reset?: boolean; log?: boolean } = {}): Promise<string[]> {
  const dir = path.resolve(__dirname, '../prisma/migrations');
  const names = fs
    .readdirSync(dir, { withFileTypes: true })
    .filter((d) => d.isDirectory())
    .map((d) => d.name)
    .sort();

  const client = new Client({ connectionString: databaseUrl });
  await client.connect();
  const applied: string[] = [];
  try {
    // Prevent two containers migrating at once.
    await client.query('SELECT pg_advisory_lock(727274)');
    if (opts.reset) {
      await client.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public;');
    }
    await client.query(`CREATE TABLE IF NOT EXISTS "_schema_migrations" (
      name TEXT PRIMARY KEY, applied_at TIMESTAMPTZ NOT NULL DEFAULT now())`);
    const done = new Set((await client.query('SELECT name FROM "_schema_migrations"')).rows.map((r) => r.name));

    for (const name of names) {
      if (done.has(name)) continue;
      const sql = fs.readFileSync(path.join(dir, name, 'migration.sql'), 'utf8');
      await client.query('BEGIN');
      try {
        await client.query(sql);
        await client.query('INSERT INTO "_schema_migrations"(name) VALUES ($1)', [name]);
        await client.query('COMMIT');
        applied.push(name);
        if (opts.log) console.log(`applied ${name}`);
      } catch (e) {
        await client.query('ROLLBACK');
        throw new Error(`Migration ${name} failed: ${(e as Error).message}`);
      }
    }
    if (opts.log && applied.length === 0) console.log('database is up to date');
  } finally {
    await client.query('SELECT pg_advisory_unlock(727274)').catch(() => undefined);
    await client.end();
  }
  return applied;
}

if (require.main === module) {
  const url = process.env.DATABASE_URL;
  if (!url) {
    console.error('DATABASE_URL is not set');
    process.exit(1);
  }
  migrate(url, { reset: process.argv.includes('--reset'), log: true }).catch((e) => {
    console.error(e.message);
    process.exit(1);
  });
}
