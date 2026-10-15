import { randomBytes, createHash, createHmac, timingSafeEqual } from 'node:crypto';
import { hash, verify } from '@node-rs/argon2';
import { database, transaction } from './db.mjs';
import { cookies, cookie, escape, html, json, redirect, readBody, fail, safeReturn } from './http.mjs';

export const PERMISSIONS = {
  'portal:admin': 'Website administrator', 'scouting:read': 'Quantitative scouting',
  'scouting:qualitative': 'Qualitative scouting', 'scouting:analytics': 'Scouting analytics',
  'scouting:sync': 'Synchronize team records', 'scouting:alliances': 'Alliance hub',
  'scouting:manage': 'Scouting events and rotations'
};
export const digest = token => createHash('sha256').update(token).digest();
export const csrf = token => token ? createHmac('sha256', token).update('portal-account-actions').digest('hex') : '';
export function equal(a, b) { const x = Buffer.from(String(a || '')), y = Buffer.from(String(b || '')); return x.length > 0 && x.length === y.length && timingSafeEqual(x, y); }
export async function session(req, conn) {
  const token = cookies(req).team1833_session;
  if (!token || token.length > 200) return null;
  conn ||= database();
  const { rows } = await conn.query(`SELECT u.id::text,u.email,s.expires_at,
    ARRAY(SELECT permission FROM shared_login.portal_permissions WHERE user_id=u.id ORDER BY permission) AS permissions
    FROM shared_login.portal_sessions s JOIN shared_login.portal_users u ON u.id=s.user_id
    WHERE s.token_hash=$1 AND s.expires_at>now() AND u.is_active`, [digest(token)]);
  if (!rows[0]) return null;
  const row = rows[0];
  return { authenticated: true, user: { id: row.id, email: row.email }, permissions: row.permissions, expires_at: row.expires_at.toISOString(), csrf_token: csrf(token) };
}
export function requireCsrf(req, identity, formToken) {
  if (!equal(identity?.csrf_token, formToken ?? req.headers['x-csrf-token'])) fail(403, 'Reload the page and try again.');
}
function page(title, body) {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Team 1833 · ${escape(title)}</title>
  <style> :root{font-family:Arial,Helvetica,sans-serif;color:#172b33;background:#edf3f4}*{box-sizing:border-box}body{padding:24px;margin:0}main{max-width:960px;margin:4vh auto;background:#fff;border:1px solid #d5e1e3;border-radius:16px;padding:clamp(20px,4vw,48px)}h1{letter-spacing:-.04em}p{line-height:1.6}a{color:#006b78}label{display:grid;gap:8px;margin:16px 0}input,select,button{font:inherit;padding:12px;border:1px solid #a8bdc2;border-radius:8px}button{background:#006b78;color:white;cursor:pointer}nav,.actions{display:flex;gap:16px;align-items:center;flex-wrap:wrap}.notice{padding:16px;background:#eef6f5;border-radius:8px}.account{border-top:1px solid #d5e1e3;padding:24px 0}.grant{display:flex;gap:12px;flex-wrap:wrap;align-items:center}.grant label{flex:1;min-width:180px}.permission{display:flex;gap:16px;align-items:center;margin:8px 0;justify-content:space-between}.permission button{padding:6px 10px;background:#fff;color:#8d2d2d}form.auth{max-width:420px}code{overflow-wrap:anywhere}.brand{font-size:12px;letter-spacing:.12em;color:#006b78;font-weight:bold}</style></head><body><main><p class="brand">TEAM BEAN · 1833 TOOLS</p>${body}</main></body></html>`;
}
const tokenField = token => `<input type="hidden" name="csrf_token" value="${escape(token)}">`;
function loginPage(token, returnTo, message = '') {
  return page('Sign in', `<h1>Sign in</h1><p>One account for all Team 1833 tools.</p>${message ? `<p class="notice">${escape(message)}</p>` : ''}
  <form class="auth" action="/login" method="post">${tokenField(token)}<input type="hidden" name="return_to" value="${escape(returnTo)}"><label>Email<input name="email" type="email" autocomplete="username" maxlength="320" required></label><label>Password<input name="password" type="password" autocomplete="current-password" required maxlength="256"></label><button>Sign in</button></form><p><a href="/signup">Create an account</a></p>`);
}
function signupPage(token, message = '') {
  return page('Create account', `<h1>Create account</h1><p>An administrator assigns access after you sign up.</p>${message ? `<p class="notice">${escape(message)}</p>` : ''}
  <form class="auth" action="/signup" method="post">${tokenField(token)}<label>Email<input name="email" type="email" autocomplete="username" maxlength="320" required></label><label>Password (12+ characters)<input name="password" type="password" autocomplete="new-password" minlength="12" maxlength="256" required></label><label>Confirm password<input name="confirm_password" type="password" autocomplete="new-password" required></label><button>Create account</button></form><p><a href="/">Sign in</a></p>`);
}
function accountPage(identity) {
  return page('Your account', `<h1>You're signed in</h1><p>${escape(identity.user.email)}</p><nav>
  ${identity.permissions.includes('scouting:read') ? '<a href="/scouting/">Open Scouting</a>' : ''}
  ${identity.permissions.includes('portal:admin') ? '<a href="/admin">Manage users and access</a>' : ''}
  <form action="/logout" method="post">${tokenField(identity.csrf_token)}<button>Sign out</button></form></nav><h2>Your access</h2>
  ${identity.permissions.length ? `<ul>${identity.permissions.map(key => `<li>${escape(PERMISSIONS[key] || key)} <code>${escape(key)}</code></li>`).join('')}</ul>` : '<p class="notice">No tool access has been assigned yet. Ask an administrator.</p>'}`);
}
async function rateLimit(req, email, action) {
  const ip = String(req.headers['x-vercel-forwarded-for'] || req.headers['x-forwarded-for'] || req.socket?.remoteAddress || 'unknown').split(',')[0].trim();
  await transaction(async conn => {
    for (const [key, maximum] of [[`${action}:email:${email}`, 10], [`${action}:ip:${ip}`, 60]]) {
      const result = await conn.query(`INSERT INTO shared_login.auth_attempts(key,window_start,attempts) VALUES($1,now(),1)
        ON CONFLICT(key) DO UPDATE SET attempts=CASE WHEN auth_attempts.window_start<now()-interval '10 minutes' THEN 1 ELSE auth_attempts.attempts+1 END,
        window_start=CASE WHEN auth_attempts.window_start<now()-interval '10 minutes' THEN now() ELSE auth_attempts.window_start END RETURNING attempts`, [digest(key).toString('hex')]);
      // Commit the rate-limit increments even when the request is rejected.
      if (result.rows[0].attempts > maximum) req.rateLimited = true;
    }
    await conn.query("DELETE FROM shared_login.auth_attempts WHERE window_start<now()-interval '1 day'");
  });
  if (req.rateLimited) fail(429, 'Too many attempts. Try again in ten minutes.');
}
async function changePermission(req, body) {
  await transaction(async conn => {
    await conn.query('SELECT pg_advisory_xact_lock(1833,1)');
    const identity = await session(req, conn);
    if (!identity?.permissions.includes('portal:admin')) fail(403, 'Website administrator access required');
    requireCsrf(req, identity, body.csrf_token);
    if (!/^\d+$/.test(String(body.user_id)) || !/^[a-zA-Z0-9][a-zA-Z0-9:._-]{0,119}$/.test(String(body.permission)) || !['grant', 'revoke'].includes(body.action)) fail(400, 'Invalid access change');
    const target = (await conn.query('SELECT is_active FROM shared_login.portal_users WHERE id=$1', [body.user_id])).rows[0];
    if (!target) fail(404, 'Account not found');
    if (body.action === 'grant') await conn.query('INSERT INTO shared_login.portal_permissions(user_id,permission) VALUES($1,$2) ON CONFLICT DO NOTHING', [body.user_id, body.permission]);
    else {
      if (body.permission === 'portal:admin' && target.is_active) {
        const admins = await conn.query(`SELECT u.id::text FROM shared_login.portal_users u JOIN shared_login.portal_permissions p ON p.user_id=u.id WHERE p.permission='portal:admin' AND u.is_active`);
        if (admins.rows.some(row => row.id === String(body.user_id)) && admins.rowCount === 1) fail(400, 'Grant another active administrator before removing the last administrator.');
      }
      await conn.query('DELETE FROM shared_login.portal_permissions WHERE user_id=$1 AND permission=$2', [body.user_id, body.permission]);
    }
  });
}
async function adminPage(identity) {
  const users = (await database().query(`SELECT u.id::text,u.email,u.is_active,ARRAY(SELECT permission FROM shared_login.portal_permissions WHERE user_id=u.id ORDER BY permission) AS permissions FROM shared_login.portal_users u ORDER BY email`)).rows;
  const choices = [...new Set([...Object.keys(PERMISSIONS), ...users.flatMap(u => u.permissions)])];
  return page('Manage access', `<a href="/">Your account</a><h1>Manage users and access</h1><p>Scouting requires <code>scouting:read</code>. Add the individual area permissions below. Changes apply to existing sessions.</p><p><a href="/scouting/#admin">Manage scouting events, schedules and rotations</a> (requires scouting access)</p>
    ${users.map(user => `<section class="account"><h2>${escape(user.email)}</h2><p>${user.is_active ? 'Active' : 'Inactive'}</p>${user.permissions.map(key => `<form class="permission" action="/admin/permissions" method="post">${tokenField(identity.csrf_token)}<input type="hidden" name="user_id" value="${user.id}"><input type="hidden" name="permission" value="${escape(key)}"><span>${escape(PERMISSIONS[key] || key)}</span><button name="action" value="revoke">Remove</button></form>`).join('')}
    <form class="grant" action="/admin/permissions" method="post">${tokenField(identity.csrf_token)}<input type="hidden" name="user_id" value="${user.id}"><label>Permission<select name="permission">${choices.map(key => `<option value="${escape(key)}">${escape(PERMISSIONS[key] || key)} — ${escape(key)}</option>`).join('')}</select></label><button name="action" value="grant">Grant access</button></form></section>`).join('')}`);
}
export async function handlePortal(req, res, url) {
  const path = url.pathname;
  if (req.method === 'GET' && path === '/api/session') { const identity = await session(req); return json(res, identity ? 200 : 401, identity || { authenticated: false }); }
  if (req.method === 'GET' && (path === '/' || path === '/signup')) {
    const identity = await session(req);
    if (identity && path === '/') { const destination = safeReturn(url.searchParams.get('return_to')); return destination === '/' ? html(res, 200, accountPage(identity)) : redirect(res, destination); }
    const token = randomBytes(32).toString('base64url'); res.setHeader('set-cookie', cookie('team1833_login_csrf', token, 600));
    return html(res, 200, path === '/signup' ? signupPage(token) : loginPage(token, safeReturn(url.searchParams.get('return_to')), url.searchParams.has('created') ? 'Account created. Sign in to continue.' : ''));
  }
  if (req.method === 'POST' && ['/login', '/signup'].includes(path)) {
    const body = await readBody(req), token = cookies(req).team1833_login_csrf;
    if (!equal(token, body.csrf_token)) fail(403, 'Reload the sign-in page and try again.');
    const email = String(body.email || '').trim().toLowerCase(), password = body.password;
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || email.length > 320 || typeof password !== 'string' || password.length > 256) fail(400, 'Enter a valid email and password');
    await rateLimit(req, email, path);
    if (path === '/signup') {
      if (password.length < 12 || password !== body.confirm_password) return html(res, 400, signupPage(token, 'Use matching passwords of at least 12 characters.'));
      const passwordHash = await hash(password);
      const inserted = await database().query('INSERT INTO shared_login.portal_users(email,password_hash) VALUES($1,$2) ON CONFLICT(email) DO NOTHING RETURNING id', [email, passwordHash]);
      if (!inserted.rowCount) return html(res, 409, signupPage(token, 'An account with this email exists. Sign in instead.'));
      res.setHeader('set-cookie', cookie('team1833_login_csrf', '', 0)); return redirect(res, '/?created=1');
    }
    const user = (await database().query('SELECT id,password_hash FROM shared_login.portal_users WHERE email=$1 AND is_active', [email])).rows[0];
    let valid = false;
    if (user) { try { valid = await verify(user.password_hash, password); } catch { valid = false; } }
    else { await hash(password); }
    if (!valid) return html(res, 401, loginPage(token, safeReturn(body.return_to), 'Email or password is incorrect.'));
    const raw = randomBytes(32).toString('base64url'), hours = Math.max(1, Math.min(168, Number(process.env.SESSION_TTL_HOURS || 12)));
    await database().query('INSERT INTO shared_login.portal_sessions(token_hash,user_id,expires_at) VALUES($1,$2,now()+($3::text)::interval)', [digest(raw), user.id, `${hours} hours`]);
    res.setHeader('set-cookie', [cookie('team1833_session', raw, hours * 3600), cookie('team1833_login_csrf', '', 0)]);
    return redirect(res, safeReturn(body.return_to));
  }
  if (req.method === 'POST' && path === '/logout') {
    const identity = await session(req), body = await readBody(req);
    requireCsrf(req, identity, body.csrf_token);
    await database().query('DELETE FROM shared_login.portal_sessions WHERE token_hash=$1', [digest(cookies(req).team1833_session)]);
    res.setHeader('set-cookie', cookie('team1833_session', '', 0)); return redirect(res, '/');
  }
  if (path === '/admin' && req.method === 'GET') {
    const identity = await session(req);
    if (!identity) return redirect(res, '/?return_to=%2Fadmin');
    if (!identity.permissions.includes('portal:admin')) fail(403, 'Website administrator access required');
    return html(res, 200, await adminPage(identity));
  }
  if (path === '/admin/permissions' && req.method === 'POST') { await changePermission(req, await readBody(req)); return redirect(res, '/admin'); }
  return json(res, 404, { error: 'Route not found' });
}
