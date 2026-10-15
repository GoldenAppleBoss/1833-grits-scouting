import { readdir, readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { database, transaction, closeDatabase } from '../lib/db.mjs';
if (process.env.MIGRATION_DATABASE_URL) process.env.DATABASE_URL = process.env.MIGRATION_DATABASE_URL;
const directory = fileURLToPath(new URL('../supabase/migrations/', import.meta.url));
try {
  await transaction(async conn => {
    await conn.query('SELECT pg_advisory_xact_lock(1833,3)');
    await conn.query('CREATE SCHEMA IF NOT EXISTS team1833_migrations');
    await conn.query('CREATE TABLE IF NOT EXISTS team1833_migrations.versions(version text PRIMARY KEY,applied_at timestamptz NOT NULL DEFAULT now())');
    for (const file of (await readdir(directory)).filter(f => f.endsWith('.sql')).sort()) {
      if ((await conn.query('SELECT 1 FROM team1833_migrations.versions WHERE version=$1', [file])).rowCount) continue;
      await conn.query(await readFile(new URL('../supabase/migrations/' + file, import.meta.url), 'utf8'));
      await conn.query('INSERT INTO team1833_migrations.versions(version) VALUES($1)', [file]);
      console.log('Applied', file);
    }
  });
  console.log('Supabase schema is current. Existing users and records are retained.');
} catch (error) { console.error('Migration failed:', error.code || error.name); process.exitCode = 1; }
finally { await closeDatabase(); }
