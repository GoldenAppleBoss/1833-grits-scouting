import { database, closeDatabase } from '../lib/db.mjs';
const email = process.argv[2]?.trim().toLowerCase();
if (!email) throw new Error('Usage: npm run admin:grant -- existing-account@example.org');
try {
  const result = await database().query(`INSERT INTO shared_login.portal_permissions(user_id,permission)
    SELECT id,'portal:admin' FROM shared_login.portal_users WHERE email=$1 AND is_active ON CONFLICT DO NOTHING`, [email]);
  if (!(await database().query('SELECT 1 FROM shared_login.portal_users WHERE email=$1 AND is_active', [email])).rowCount) throw new Error('Sign up with this email first.');
  console.log(result.rowCount ? 'Granted website administrator access.' : 'Administrator access already exists.');
} finally { await closeDatabase(); }
