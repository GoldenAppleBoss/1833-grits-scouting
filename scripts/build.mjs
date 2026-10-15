import { mkdir, writeFile } from 'node:fs/promises';
import { databaseOptions } from '../lib/db.mjs';
import { logFailure } from '../lib/diagnostics.mjs';
// Fail a misconfigured Vercel deployment before it can replace the working app.
// Builds do not open a database connection or apply migrations.
if (process.env.VERCEL === '1') {
  try { databaseOptions(); }
  catch (error) { logFailure('Vercel configuration check failed', error); process.exit(1); }
}
// Protected application files are bundled with the function, not published by the CDN.
await mkdir('dist', { recursive: true });
await writeFile('dist/robots.txt', 'User-agent: *\nDisallow: /\n');
console.log('Vercel output prepared; protected routes are served by api/index.mjs.');
