import { checkDatabase, closeDatabase } from '../lib/db.mjs';
import { logFailure } from '../lib/diagnostics.mjs';

try {
  await checkDatabase();
  console.log('Database connection and application schema are ready.');
} catch (error) {
  logFailure('Database check failed', error);
  process.exitCode = 1;
} finally { await closeDatabase(); }
