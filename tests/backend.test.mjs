import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { execFileSync } from 'node:child_process';
import handler from '../api/index.mjs';
import { databaseOptions } from '../lib/db.mjs';
import { logFailure } from '../lib/diagnostics.mjs';

test('database configuration rejects API keys and HTTP URLs without exposing them', () => {
  assert.throws(() => databaseOptions({}), { code: 'DATABASE_URL_MISSING' });
  assert.throws(() => databaseOptions({ DATABASE_URL: '  ' }), { code: 'DATABASE_URL_MISSING' });
  for (const value of ['sb_secret_private', 'https://project.supabase.co', 'postgresql://user@host/postgres']) {
    assert.throws(() => databaseOptions({ DATABASE_URL: value }), error => {
      assert.equal(error.code, 'DATABASE_URL_INVALID');
      assert.ok(!error.message.includes(value));
      return true;
    });
  }
});

test('pooler credentials survive URL parsing and an explicit CA controls TLS verification', () => {
  const env = { DATABASE_URL: '  postgresql://postgres.project:p%40ss%23word@pooler.example:6543/postgres?sslmode=require  ', DATABASE_CA_CERT: 'line1\\nline2' };
  const config = databaseOptions(env);
  const url = new URL(config.connectionString);
  assert.equal(decodeURIComponent(url.password), 'p@ss#word');
  assert.equal(url.username, 'postgres.project');
  assert.equal(url.port, '6543');
  assert.equal(url.searchParams.has('sslmode'), false);
  assert.deepEqual(config.ssl, { rejectUnauthorized: true, ca: 'line1\nline2' });
  assert.equal(databaseOptions({ DATABASE_URL: env.DATABASE_URL }).ssl.rejectUnauthorized, false);
  assert.equal(databaseOptions({ DATABASE_URL: 'postgresql://user:pass@localhost/app' }).ssl, false);
});

test('database diagnostics give setup advice without logging database messages or details', () => {
  const original = console.error, logs = [];
  console.error = (...args) => logs.push(args);
  try {
    for (const code of ['DATABASE_URL_MISSING', '28P01', '42P01', '42703', '42501', 'ENETUNREACH', 'ETIMEDOUT', 'UNKNOWN']) {
      logFailure('Test failure', { code, message: 'private-password', detail: 'private-email@example.org', stack: 'private-stack' });
    }
  } finally { console.error = original; }
  const output = JSON.stringify(logs);
  assert.ok(output.includes('DATABASE_URL is missing'));
  assert.ok(output.includes('npm run db:migrate'));
  assert.ok(output.includes('IPv4-compatible'));
  assert.ok(!output.includes('private-'));
});

test('login reproduces the missing DATABASE_URL failure with actionable logs and a private response', async () => {
  const previous = process.env.DATABASE_URL, original = console.error, logs = [];
  delete process.env.DATABASE_URL;
  console.error = (...args) => logs.push(args);
  const server = http.createServer(handler);
  try {
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    const base = `http://127.0.0.1:${server.address().port}`;
    const home = await fetch(base);
    assert.equal(home.status, 200);
    const cookie = home.headers.get('set-cookie').split(';')[0];
    const token = decodeURIComponent(cookie.slice(cookie.indexOf('=') + 1));
    const page = await home.text();
    assert.ok(page.includes(`value="${token}"`));

    const badCsrf = await fetch(`${base}/login`, {
      method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded', cookie },
      body: new URLSearchParams({ csrf_token: 'invalid', email: 'scouter@example.org', password: 'private-password' })
    });
    assert.equal(badCsrf.status, 403);
    await badCsrf.text();

    const login = await fetch(`${base}/login`, {
      method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded', cookie },
      body: new URLSearchParams({ csrf_token: token, email: 'scouter@example.org', password: 'private-password' })
    });
    assert.equal(login.status, 503);
    assert.match(await login.text(), /temporarily unavailable/);

    const health = await fetch(`${base}/scouting/api/health`);
    assert.equal(health.status, 503);
    assert.deepEqual(await health.json(), { error: 'The service is temporarily unavailable. Please try again.' });
    const session = await fetch(`${base}/api/session`);
    assert.equal(session.status, 401);
    assert.deepEqual(await session.json(), { authenticated: false });
    assert.equal(logs.length, 2);
    assert.ok(logs.every(([, entry]) => entry.code === 'DATABASE_URL_MISSING'));
    assert.ok(!JSON.stringify(logs).includes('private-password'));
  } finally {
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
    console.error = original;
    if (previous === undefined) delete process.env.DATABASE_URL;
    else process.env.DATABASE_URL = previous;
  }
});

test('Vercel build rejects missing database configuration before publishing output', () => {
  const env = { ...process.env, VERCEL: '1' };
  delete env.DATABASE_URL;
  assert.throws(() => execFileSync(process.execPath, ['scripts/build.mjs'], { env, stdio: 'pipe' }), error => {
    assert.equal(error.status, 1);
    assert.match(error.stderr.toString(), /DATABASE_URL_MISSING/);
    return true;
  });
});
