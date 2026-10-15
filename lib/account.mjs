import { hash, verify } from '@node-rs/argon2';
import { database, transaction } from './db.mjs';
import { session, requireCsrf, digest, rateLimit } from './portal.mjs';
import { cookies, json, readBody, fail } from './http.mjs';

export function accountNames(body) {
  const first = typeof body.firstName === 'string' ? body.firstName.trim() : '';
  const last = typeof body.lastName === 'string' ? body.lastName.trim() : '';
  if (!first || !last || first.length > 80 || last.length > 80) fail(400, 'Enter your first and last names, up to 80 characters each.');
  return { first, last };
}

export async function handleAccount(req, res, url) {
  if (!url.pathname.startsWith('/api/account')) return false;
  const identity = await session(req);
  if (!identity) fail(401, 'Sign in to manage your account.');
  if (!['GET','HEAD'].includes(req.method)) requireCsrf(req, identity);
  const id = identity.user.id;
  if (url.pathname === '/api/account' && req.method === 'GET') {
    const user = (await database().query('SELECT first_name,last_name,email,created_at,preferences FROM shared_login.portal_users WHERE id=$1', [id])).rows[0];
    const sessions = (await database().query('SELECT created_at,expires_at,token_hash=$2 AS current FROM shared_login.portal_sessions WHERE user_id=$1 AND expires_at>now() ORDER BY created_at DESC', [id,digest(cookies(req).team1833_session)])).rows;
    json(res,200,{user:{id,email:user.email,firstName:user.first_name,lastName:user.last_name,createdAt:user.created_at},preferences:user.preferences,permissions:identity.permissions,sessions,csrfToken:identity.csrf_token});
    return true;
  }
  if (url.pathname === '/api/account' && req.method === 'PATCH') {
    const body = await readBody(req), names = body.firstName !== undefined || body.lastName !== undefined ? accountNames(body) : null;
    const preferences = {};
    if (body.theme !== undefined) {
      if (!['light','dark','bean'].includes(body.theme)) fail(400, 'Choose Light, Dark or Bean mode.');
      preferences.theme = body.theme;
    }
    if (body.reduceMotion !== undefined) {
      if (typeof body.reduceMotion !== 'boolean') fail(400, 'Invalid motion preference.');
      preferences.reduceMotion = body.reduceMotion;
    }
    await database().query(`UPDATE shared_login.portal_users SET first_name=COALESCE($2,first_name),last_name=COALESCE($3,last_name),
      preferences=preferences || $4::jsonb WHERE id=$1`,[id,names?.first ?? null,names?.last ?? null,JSON.stringify(preferences)]);
    json(res,200,{ok:true});return true;
  }
  if (url.pathname === '/api/account/password' && req.method === 'POST') {
    const body = await readBody(req);
    if (typeof body.currentPassword !== 'string' || body.currentPassword.length > 256) fail(400, 'Enter your current password.');
    if (typeof body.newPassword !== 'string' || body.newPassword.length < 12 || body.newPassword.length > 256 || body.newPassword !== body.confirmPassword) fail(400, 'Use matching new passwords of 12–256 characters.');
    await rateLimit(req,identity.user.email,'change-password',[5,30]);
    const changed = await transaction(async conn => {
      const user = (await conn.query('SELECT password_hash FROM shared_login.portal_users WHERE id=$1 AND is_active FOR UPDATE',[id])).rows[0];
      if (!user || !(await session(req,conn))) return false;
      let valid = false;
      try { valid = await verify(user.password_hash,body.currentPassword); } catch { /* Invalid stored hashes cannot authorize a change. */ }
      if (!valid) return false;
      await conn.query('UPDATE shared_login.portal_users SET password_hash=$2 WHERE id=$1',[id,await hash(body.newPassword)]);
      await conn.query('DELETE FROM shared_login.portal_sessions WHERE user_id=$1 AND token_hash<>$2',[id,digest(cookies(req).team1833_session)]);
      return true;
    });
    if (!changed) fail(400, 'Your current password is incorrect.');
    json(res,200,{ok:true});return true;
  }
  if (url.pathname === '/api/account/sessions' && req.method === 'DELETE') {
    await database().query('DELETE FROM shared_login.portal_sessions WHERE user_id=$1 AND token_hash<>$2',[id,digest(cookies(req).team1833_session)]);
    json(res,200,{ok:true});return true;
  }
  if (url.pathname === '/api/account/matches' && req.method === 'GET') {
    const matches = (await database().query('SELECT payload FROM scouting.records WHERE owner_user_id=$1 ORDER BY server_received_at DESC',[id])).rows.map(row=>row.payload);
    json(res,200,{matches});return true;
  }
  json(res,404,{error:'Account setting not found'});return true;
}
