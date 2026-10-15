import pg from 'pg';
let pool;
export function database() {
  if (!pool) {
    if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL is required');
    const url = new URL(process.env.DATABASE_URL);
    const local = ['localhost', '127.0.0.1', 'database'].includes(url.hostname);
    for (const key of ['sslmode', 'sslrootcert', 'sslcert', 'sslkey']) url.searchParams.delete(key);
    pool = new pg.Pool({ connectionString: url.toString(), max: 1, connectionTimeoutMillis: 10000,
      idleTimeoutMillis: 10000, allowExitOnIdle: true,
      ssl: local ? false : { rejectUnauthorized: Boolean(process.env.DATABASE_CA_CERT),
        ...(process.env.DATABASE_CA_CERT ? { ca: process.env.DATABASE_CA_CERT.replaceAll('\\n', '\n') } : {}) }
    });
    pool.on('error', error => console.error('Idle database connection failed:', error.code));
  }
  return pool;
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
