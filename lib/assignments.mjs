import { fail } from './http.mjs';

// The caller authenticates the administrator and supplies a transaction.
export async function setScoutStation(conn, body) {
  const event = String(body.event_key || '').trim().toLowerCase(), userId = String(body.user_id || '');
  if (!/^2026[a-z0-9]+$/.test(event) || !/^\d+$/.test(userId)) fail(400, 'Choose an imported event and an account.');
  await conn.query('SELECT pg_advisory_xact_lock(hashtextextended($1,1833))', [event]);
  if (!(await conn.query('SELECT 1 FROM scouting.events WHERE event_key=$1', [event])).rowCount) fail(400, 'Import this event from TBA first.');
  if (body.scout_station === 'unassigned') {
    await conn.query('DELETE FROM scouting.rotations WHERE event_key=$1 AND user_id=$2', [event, userId]);
    return;
  }
  const slot = /^(red|blue):([123])$/.exec(String(body.scout_station || ''));
  const group = Number(body.rotation), count = Number(body.rotation_count);
  if (!slot || !Number.isInteger(group) || !Number.isInteger(count) || count < 1 || count > 100 || group < 1 || group > count) fail(400, 'Choose a scout station and a valid rotation group.');
  if (!(await conn.query(`SELECT 1 FROM shared_login.portal_users u WHERE id=$1 AND is_active AND EXISTS
    (SELECT 1 FROM shared_login.portal_permissions WHERE user_id=u.id AND permission='scouting:read')`, [userId])).rowCount) fail(400, 'Grant this active account quantitative scouting access first.');
  const others = (await conn.query('SELECT * FROM scouting.rotations WHERE event_key=$1 AND user_id<>$2', [event, userId])).rows;
  if (others.some(r => r.rotation_count !== count)) fail(400, 'Use the same total rotation groups as the other scouters at this event. Change the whole event in Scouting administration.');
  if (others.some(r => r.rotation === group && r.alliance === slot[1] && r.station === Number(slot[2]))) fail(409, 'That scout station is already assigned in this rotation group.');
  await conn.query(`INSERT INTO scouting.rotations(event_key,user_id,rotation,rotation_count,alliance,station)
    VALUES($1,$2,$3,$4,$5,$6) ON CONFLICT(event_key,user_id) DO UPDATE SET rotation=excluded.rotation,
    rotation_count=excluded.rotation_count,alliance=excluded.alliance,station=excluded.station`, [event,userId,group,count,slot[1],Number(slot[2])]);
}
