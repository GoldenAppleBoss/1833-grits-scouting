import pg from 'pg';
import { logFailure } from './diagnostics.mjs';
let pool;
function configurationError(code, message) { return Object.assign(new Error(message), { code }); }
export function databaseOptions(env = process.env) {
  const connectionString = env.DATABASE_URL?.trim();
  if (!connectionString) throw configurationError('DATABASE_URL_MISSING', 'Set DATABASE_URL to the Supabase transaction pooler PostgreSQL URI. Supabase API keys cannot replace it.');
  let url;
  try { url = new URL(connectionString); }
  catch { throw configurationError('DATABASE_URL_INVALID', 'DATABASE_URL must be a valid PostgreSQL URI with a URL-encoded database password.'); }
  if (!['postgres:', 'postgresql:'].includes(url.protocol) || !url.hostname || !url.username || !url.password || !url.pathname.slice(1)) {
    throw configurationError('DATABASE_URL_INVALID', 'DATABASE_URL must include the PostgreSQL scheme, username, password, host and database name. Copy it from Supabase Connect.');
  }
  const local = ['localhost', '127.0.0.1', '[::1]', 'database'].includes(url.hostname);
  for (const key of ['sslmode', 'sslrootcert', 'sslcert', 'sslkey']) url.searchParams.delete(key);
  return { connectionString: url.toString(), max: 1, connectionTimeoutMillis: 10000,
    idleTimeoutMillis: 10000, allowExitOnIdle: true,
    ssl: local ? false : { rejectUnauthorized: Boolean(env.DATABASE_CA_CERT),
      ...(env.DATABASE_CA_CERT ? { ca: env.DATABASE_CA_CERT.replaceAll('\\n', '\n') } : {}) }
  };
}
export function database() {
  if (!pool) {
    pool = new pg.Pool(databaseOptions());
    pool.on('error', error => logFailure('Idle database connection failed', error));
  }
  return pool;
}
// Validate the application schema and SELECT privileges without reading user data.
export async function checkDatabase(conn = database()) {
  await conn.query(`
    SELECT id,email,password_hash,is_active FROM shared_login.portal_users LIMIT 0;
    SELECT user_id,permission FROM shared_login.portal_permissions LIMIT 0;
    SELECT token_hash,user_id,expires_at FROM shared_login.portal_sessions LIMIT 0;
    SELECT key,window_start,attempts FROM shared_login.auth_attempts LIMIT 0;
    SELECT name,value,updated_at FROM shared_login.service_settings LIMIT 0;
    SELECT record_id,owner_user_id,match_number,team_number,revision,completed,payload,
      server_received_at,event_key,match_key,kind FROM scouting.records LIMIT 0;
    SELECT event_key,name,year,imported_at,imported_by FROM scouting.events LIMIT 0;
    SELECT event_key,team_number,name FROM scouting.teams LIMIT 0;
    SELECT event_key,match_key,match_number,comp_level,set_number,scheduled_time,red,blue FROM scouting.matches LIMIT 0;
    SELECT event_key,user_id,rotation,rotation_count,alliance,station FROM scouting.rotations LIMIT 0;
    SELECT event_key,id,name,teams,strategy,created_by,updated_at FROM scouting.alliances LIMIT 0;
  `);
}
export async function transaction(work) {
  const conn = await database().connect();
  try {
    await conn.query('BEGIN');
    const result = await work(conn);
    await conn.query('COMMIT');
    return result;
  } catch (error) { await conn.query('ROLLBACK'); throw error; }
  finally { conn.release(); }
}
export async function closeDatabase() { if (pool) { await pool.end(); pool = undefined; } }
