import { readFile } from 'node:fs/promises';
import { isDeepStrictEqual } from 'node:util';
import { database, transaction, checkDatabase } from './db.mjs';
import { session, requireCsrf } from './portal.mjs';
import { json, html, redirect, readBody, fail, securityHeaders } from './http.mjs';
import { normalizeRecord, canonicalRecord, validateRecord, assignments, eventKey, manualScoutingAllowed, resolveScoutAssignment, assignedRecordError } from '../scouting/public/model.js';

const canManage = identity => identity.permissions.some(p=>['portal:admin','scouting:manage'].includes(p));
function requirePermission(identity,permission) { if (!identity.permissions.includes(permission)) fail(403, `${permission} access required`); }
function validEvent(value) { const key=eventKey(value); if (!/^2026[a-z0-9]+$/.test(key)) fail(400,'Use a 2026 TBA event key, such as 2026tnkn'); return key; }
export function scoutIdentity(identity) {
  return { user:{...identity.user,name:identity.user.email,role:canManage(identity)?'admin':'member',manualScouting:manualScoutingAllowed(identity.permissions),permissions:{
    analytics:identity.permissions.includes('scouting:analytics'),sync:identity.permissions.includes('scouting:sync'),
    qualitative:identity.permissions.includes('scouting:qualitative'),alliances:identity.permissions.includes('scouting:alliances'),admin:canManage(identity)
  }},csrfToken:identity.csrf_token,expiresAt:identity.expires_at };
}
const locked = r => ({ status:'locked',error:'You already submitted this robot and match at this event. Submitted records are locked.',lockedRecord:{recordId:r.recordId,matchNumber:r.matchNumber,matchKey:r.matchKey,eventKey:r.eventKey,teamNumber:r.teamNumber,submittedAt:r.submittedAt||null} });
async function completed(conn,owner,event,match,team,kind,exclude='') {
  const row=(await conn.query(`SELECT payload,event_key,match_key,kind FROM scouting.records WHERE owner_user_id=$1 AND event_key=$2 AND match_key=$3 AND team_number=$4 AND kind=$5 AND completed AND record_id<>$6 LIMIT 1`,[owner,event,match,team,kind,exclude])).rows[0];
  return row?normalizeRecord({...row.payload,eventKey:row.event_key,matchKey:row.match_key,kind:row.kind}):null;
}
async function sync(req,identity) {
  const body=await readBody(req), incoming=normalizeRecord(body.record||{}), validation=validateRecord(incoming);
  if(validation)fail(400,validation);
  if(incoming.kind==='qualitative')requirePermission(identity,'scouting:qualitative');
  incoming.ownerUserId=String(incoming.ownerUserId||identity.user.id); incoming.scoutUserId=incoming.ownerUserId;
  if(!/^\d{1,18}$/.test(incoming.ownerUserId)||(!identity.permissions.includes('scouting:sync')&&incoming.ownerUserId!==identity.user.id))fail(403,'You may only synchronize your own records');
  return transaction(async conn=>{
    for(const key of [`owner:${incoming.ownerUserId}`,`record:${incoming.recordId}`].sort())await conn.query('SELECT pg_advisory_xact_lock(hashtextextended($1,1833))',[key]);
    // Share the event lock with assignment changes and TBA schedule refreshes.
    await conn.query('SELECT pg_advisory_xact_lock(hashtextextended($1,1833))',[incoming.eventKey]);
    const row=(await conn.query('SELECT payload,event_key,match_key,kind FROM scouting.records WHERE record_id=$1 FOR UPDATE',[incoming.recordId])).rows[0];
    const existing=row?normalizeRecord({...row.payload,eventKey:row.event_key,matchKey:row.match_key,kind:row.kind}):null;
    if(existing&&(existing.ownerUserId!==incoming.ownerUserId||existing.kind!==incoming.kind))fail(403,'Record ownership and scouting type cannot change');
    if(existing&&incoming.revision===existing.revision&&isDeepStrictEqual(canonicalRecord(incoming),canonicalRecord(existing)))return[200,{status:'synced',recordId:incoming.recordId,revision:incoming.revision,idempotent:true}];
    if(existing?.completed)return[423,locked(existing)];
    const previous=await completed(conn,incoming.ownerUserId,incoming.eventKey,incoming.matchKey,incoming.teamNumber,incoming.kind,incoming.recordId);
    if(previous)return[423,locked(previous)];
    if(existing&&incoming.revision<=existing.revision)return[409,{status:'conflict',serverRecord:existing,error:'A different revision exists. Review both versions.'}];
    if(!(await conn.query('SELECT 1 FROM shared_login.portal_users WHERE id=$1 AND is_active',[incoming.ownerUserId])).rowCount)fail(400,'Record owner must be an active account');
    const scheduled=(await conn.query('SELECT red,blue,match_number FROM scouting.matches WHERE event_key=$1 AND match_key=$2',[incoming.eventKey,incoming.matchKey])).rows[0];
    if(scheduled&&(!scheduled[incoming.alliance]?.includes(incoming.teamNumber)||scheduled.match_number!==incoming.matchNumber))fail(400,'Team, alliance and match must agree with the imported schedule');
    if(incoming.kind==='quantitative'&&!manualScoutingAllowed(identity.permissions)){
      const rotation=(await conn.query('SELECT * FROM scouting.rotations WHERE event_key=$1 AND user_id=$2',[incoming.eventKey,incoming.ownerUserId])).rows[0];
      const match=(await conn.query('SELECT * FROM scouting.matches WHERE event_key=$1 AND match_key=$2',[incoming.eventKey,`qm${incoming.matchNumber}`])).rows;
      const issue=assignedRecordError(incoming,match,rotation);
      if(issue)fail(403,issue);
    }
    const stored={...canonicalRecord(incoming),syncStatus:'synced',lastSyncError:null,conflictServerRecord:null,serverReceivedAt:new Date().toISOString()};
    await conn.query(`INSERT INTO scouting.records(record_id,owner_user_id,match_number,team_number,revision,completed,payload,event_key,match_key,kind,server_received_at)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) ON CONFLICT(record_id) DO UPDATE SET
      match_number=excluded.match_number,team_number=excluded.team_number,revision=excluded.revision,completed=excluded.completed,payload=excluded.payload,event_key=excluded.event_key,match_key=excluded.match_key,server_received_at=excluded.server_received_at`,
    [stored.recordId,stored.ownerUserId,stored.matchNumber,stored.teamNumber,stored.revision,stored.completed,stored,stored.eventKey,stored.matchKey,stored.kind,stored.serverReceivedAt]);
    return[200,{status:'synced',recordId:stored.recordId,revision:stored.revision}];
  });
}
async function tba(path,key) {
  const response=await fetch('https://www.thebluealliance.com/api/v3'+path,{headers:{'X-TBA-Auth-Key':key},signal:AbortSignal.timeout(12000)});
  if(!response.ok)fail(502,`TBA returned ${response.status}. Check the API key and event key.`);
  return response.json();
}
async function tbaKey() {
  if(process.env.TBA_API_KEY?.trim())return process.env.TBA_API_KEY.trim();
  return (await database().query("SELECT value FROM shared_login.service_settings WHERE name='TBA_API_KEY'")).rows[0]?.value || '';
}
export function parseTbaSchedule(event,info,teams,matches) {
  if(info?.year!==2026||info.key!==event||!Array.isArray(teams)||!Array.isArray(matches)||matches.length>2000||teams.length>1000)fail(400,'TBA returned an invalid 2026 event');
  const normalizedTeams=teams.map(t=>({teamNumber:Number(t.team_number),name:String(t.nickname||t.name||`Team ${t.team_number}`).slice(0,200)}));
  if(normalizedTeams.some(t=>!Number.isInteger(t.teamNumber)||t.teamNumber<1))fail(400,'Invalid TBA team');
  const normalizedMatches=matches.map(m=>{
    const red=m.alliances?.red?.team_keys?.map(k=>Number(k.replace(/^frc/,''))),blue=m.alliances?.blue?.team_keys?.map(k=>Number(k.replace(/^frc/,'')));
    if(typeof m.key!=='string'||!m.key.startsWith(event+'_')||!/^[a-z0-9_]+$/.test(m.key)||!['qm','ef','qf','sf','f'].includes(m.comp_level)||!Number.isInteger(m.match_number)||m.match_number<1||red?.length!==3||blue?.length!==3||[...red,...blue].some(n=>!Number.isInteger(n)||n<1)||new Set([...red,...blue]).size!==6)fail(400,'Invalid TBA match');
    return{key:m.key.slice(event.length+1),number:m.match_number,level:m.comp_level,set:Number(m.set_number)||1,time:Number(m.predicted_time||m.time)||null,red,blue};
  });
  return{name:String(info.name).slice(0,200),teams:normalizedTeams,matches:normalizedMatches};
}
async function importEvent(body,identity){
  const event=validEvent(body.eventKey),key=String(body.apiKey||await tbaKey()).trim();
  if(!key)fail(400,'Set TBA_API_KEY in Vercel or supply a key for this import');
  const [info,teams,matches]=await Promise.all([tba(`/event/${event}`,key),tba(`/event/${event}/teams/simple`,key),tba(`/event/${event}/matches/simple`,key)]);
  const data=parseTbaSchedule(event,info,teams,matches);
  await transaction(async conn=>{
    await conn.query('SELECT pg_advisory_xact_lock(hashtextextended($1,1833))',[event]);
    await conn.query(`INSERT INTO scouting.events(event_key,name,year,imported_at,imported_by) VALUES($1,$2,2026,now(),$3) ON CONFLICT(event_key) DO UPDATE SET name=excluded.name,imported_at=now(),imported_by=excluded.imported_by`,[event,data.name,identity.user.id]);
    await conn.query(`INSERT INTO scouting.teams(event_key,team_number,name)
      SELECT $1,t."teamNumber",t.name FROM jsonb_to_recordset($2::jsonb) AS t("teamNumber" integer,name text)
      ON CONFLICT(event_key,team_number) DO UPDATE SET name=excluded.name`,[event,JSON.stringify(data.teams)]);
    await conn.query('DELETE FROM scouting.matches WHERE event_key=$1',[event]);
    await conn.query(`INSERT INTO scouting.matches(event_key,match_key,match_number,comp_level,set_number,scheduled_time,red,blue)
      SELECT $1,m.key,m.number,m.level,m."set",m.time,m.red,m.blue FROM jsonb_to_recordset($2::jsonb) AS m(key text,number integer,level text,"set" integer,time bigint,red integer[],blue integer[])`,[event,JSON.stringify(data.matches)]);
  });
  return{eventKey:event,teams:data.teams.length,matches:data.matches.length};
}
async function refreshScheduleIfNeeded(event) {
  const saved=(await database().query('SELECT imported_at FROM scouting.events WHERE event_key=$1',[event])).rows[0];
  if(!saved)fail(400,'Ask an administrator to import this event from TBA first.');
  if(saved.imported_at && Date.now()-new Date(saved.imported_at).getTime()<300000)return;
  const key=await tbaKey();
  if(!key)return; // An administrator can still import using a one-time key.
  const matches=await tba(`/event/${event}/matches/simple`,key);
  const data=parseTbaSchedule(event,{key:event,year:2026,name:event},[],matches);
  await transaction(async conn=>{
    await conn.query('SELECT pg_advisory_xact_lock(hashtextextended($1,1833))',[event]);
    await conn.query('DELETE FROM scouting.matches WHERE event_key=$1',[event]);
    await conn.query(`INSERT INTO scouting.matches(event_key,match_key,match_number,comp_level,set_number,scheduled_time,red,blue)
      SELECT $1,m.key,m.number,m.level,m."set",m.time,m.red,m.blue FROM jsonb_to_recordset($2::jsonb)
      AS m(key text,number integer,level text,"set" integer,time bigint,red integer[],blue integer[])`,[event,JSON.stringify(data.matches)]);
    await conn.query('UPDATE scouting.events SET imported_at=now() WHERE event_key=$1',[event]);
  });
}
async function saveRotations(body){
  const event=validEvent(body.eventKey),rows=body.rotations;
  if(!Array.isArray(rows)||rows.length>600)fail(400,'Invalid rotation list');
  const users=new Set(),slots=new Set();let count=null;
  for(const r of rows){
    if(!/^\d{1,18}$/.test(String(r.userId))||!Number.isInteger(r.rotationCount)||r.rotationCount<1||r.rotationCount>100||!Number.isInteger(r.rotation)||r.rotation<1||r.rotation>r.rotationCount||!['red','blue'].includes(r.alliance)||![1,2,3].includes(r.station))fail(400,'Each rotation needs an account, group, total groups, alliance and station');
    if(count!==null&&count!==r.rotationCount)fail(400,'Use the same total number of groups for this event');count=r.rotationCount;
    const slot=`${r.rotation}:${r.alliance}:${r.station}`;
    if(users.has(String(r.userId))||slots.has(slot))fail(400,'Each account and each group/alliance/station can be assigned once');
    users.add(String(r.userId));slots.add(slot);
  }
  await transaction(async conn=>{
    await conn.query('SELECT pg_advisory_xact_lock(hashtextextended($1,1833))',[event]);
    if(!(await conn.query('SELECT 1 FROM scouting.events WHERE event_key=$1',[event])).rowCount)fail(400,'Import the event first');
    for(const r of rows)if(!(await conn.query(`SELECT 1 FROM shared_login.portal_users u JOIN shared_login.portal_permissions p ON p.user_id=u.id WHERE u.id=$1 AND u.is_active AND p.permission='scouting:read'`,[r.userId])).rowCount)fail(400,'Every assigned scouter must be active with scouting:read access');
    await conn.query('DELETE FROM scouting.rotations WHERE event_key=$1',[event]);
    for(const r of rows)await conn.query('INSERT INTO scouting.rotations(event_key,user_id,rotation,rotation_count,alliance,station) VALUES($1,$2,$3,$4,$5,$6)',[event,r.userId,r.rotation,r.rotationCount,r.alliance,r.station]);
  });
  return{saved:rows.length};
}
async function staticFile(req,res,path){
  const files={ '/':'index.html','/index.html':'index.html','/app.js':'app.js','/model.js':'model.js','/styles.css':'styles.css','/brand.css':'brand.css','/sw.js':'sw.js','/manifest.webmanifest':'manifest.webmanifest','/icon.svg':'icon.png','/icon.png':'icon.png','/team1833-logo.png':'team1833-logo.png','/chewy.ttf':'chewy.ttf','/CHEWY-LICENSE.txt':'CHEWY-LICENSE.txt' };
  const file=files[path];if(!file||!['GET','HEAD'].includes(req.method))return json(res,404,{error:'Not found'});
  const data=await readFile(new URL('../scouting/public/'+file,import.meta.url));
  const types={html:'text/html; charset=utf-8',js:'text/javascript; charset=utf-8',css:'text/css; charset=utf-8',svg:'image/svg+xml',webmanifest:'application/manifest+json',png:'image/png',ttf:'font/ttf',txt:'text/plain; charset=utf-8'};
  res.writeHead(200,{...securityHeaders,'content-type':types[file.split('.').at(-1)],...(file==='sw.js'?{'service-worker-allowed':'/scouting/'}:{})});res.end(req.method==='HEAD'?undefined:data);
}
export async function handleScouting(req,res,url){
  const path=url.pathname.slice('/scouting'.length)||'/';
  if(path==='/api/health'&&req.method==='GET'){await checkDatabase();return json(res,200,{ok:true,service:'team1833-scouting'});}
  const identity=await session(req);
  if(!identity){if(path.startsWith('/api/'))return json(res,401,{error:'Authentication required'});return redirect(res,'/?return_to=%2Fscouting%2F');}
  requirePermission(identity,'scouting:read');
  if(url.pathname==='/scouting')return redirect(res,'/scouting/'+url.search,308);
  if(!path.startsWith('/api/'))return staticFile(req,res,path);
  if(!['GET','HEAD'].includes(req.method))requireCsrf(req,identity);
  if(path==='/api/auth/me'&&req.method==='GET')return json(res,200,scoutIdentity(identity));
  if(path==='/api/assignment'&&req.method==='GET'){
    const event=validEvent(url.searchParams.get('eventKey')),number=Number(url.searchParams.get('matchNumber'));
    if(!Number.isInteger(number)||number<1)fail(400,'Enter a positive qualification match number.');
    await refreshScheduleIfNeeded(event);
    const rotation=(await database().query('SELECT * FROM scouting.rotations WHERE event_key=$1 AND user_id=$2',[event,identity.user.id])).rows[0];
    const matches=(await database().query("SELECT * FROM scouting.matches WHERE event_key=$1 AND match_key=$2",[event,`qm${number}`])).rows;
    const assigned=resolveScoutAssignment(matches,rotation,number);
    if(assigned.error)fail(400,assigned.error);
    return json(res,200,assigned);
  }
  if(path==='/api/events'&&req.method==='GET'){
    const events=(await database().query(`SELECT event_key,name FROM scouting.events UNION SELECT DISTINCT event_key,event_key AS name FROM scouting.records WHERE event_key NOT IN(SELECT event_key FROM scouting.events) ORDER BY event_key DESC`)).rows;
    return json(res,200,{events});
  }
  if(path==='/api/context'&&req.method==='GET'){
    const event=String(url.searchParams.get('eventKey')||'');if(!/^(2026[a-z0-9]+|legacy)$/.test(event))fail(400,'Choose an event');
    const teams=(await database().query('SELECT team_number,name FROM scouting.teams WHERE event_key=$1 ORDER BY team_number',[event])).rows;
    const matches=(await database().query("SELECT * FROM scouting.matches WHERE event_key=$1 ORDER BY CASE comp_level WHEN 'qm' THEN 0 ELSE 1 END,scheduled_time,match_number",[event])).rows;
    const rotations=(await database().query('SELECT * FROM scouting.rotations WHERE event_key=$1',[event])).rows;
    const own=(await database().query('SELECT payload,event_key,match_key,kind FROM scouting.records WHERE event_key=$1 AND owner_user_id=$2 AND completed',[event,identity.user.id])).rows.map(r=>normalizeRecord({...r.payload,eventKey:r.event_key,matchKey:r.match_key,kind:r.kind}));
    return json(res,200,{teams,matches,rotation:rotations.find(r=>String(r.user_id)===identity.user.id)||null,assignments:assignments(matches,rotations,identity.user.id),completed:own});
  }
  if(path==='/api/records'&&req.method==='GET'){
    if(!identity.permissions.some(p=>['scouting:analytics','scouting:sync'].includes(p)))fail(403,'Analytics or team synchronization access required');
    const event=String(url.searchParams.get('eventKey')||'');if(!/^(2026[a-z0-9]+|legacy)$/.test(event))fail(400,'Choose an event');
    const records=(await database().query("SELECT payload,event_key,match_key,kind FROM scouting.records WHERE event_key=$1 AND (kind='quantitative' OR $2::boolean) ORDER BY server_received_at DESC",[event,identity.permissions.includes('scouting:qualitative')])).rows.map(r=>normalizeRecord({...r.payload,eventKey:r.event_key,matchKey:r.match_key,kind:r.kind}));
    return json(res,200,{records});
  }
  if(path==='/api/qualitative'&&req.method==='GET'){
    requirePermission(identity,'scouting:qualitative');
    const event=String(url.searchParams.get('eventKey')||'');if(!/^(2026[a-z0-9]+|legacy)$/.test(event))fail(400,'Choose an event');
    const rows=(await database().query(`SELECT record_id,owner_user_id::text,event_key,match_key,team_number,match_number,payload FROM scouting.records WHERE event_key=$1 AND completed AND (kind='qualitative' OR COALESCE(payload->>'notes','')<>'' OR CASE WHEN jsonb_typeof(payload->'tags')='array' THEN jsonb_array_length(payload->'tags') ELSE 0 END>0)`,[event])).rows;
    return json(res,200,{records:rows.map(r=>({recordId:r.record_id,ownerUserId:r.owner_user_id,eventKey:r.event_key,matchKey:r.match_key,teamNumber:r.team_number,matchNumber:r.match_number,kind:'qualitative',completed:true,revision:r.payload.revision,tags:r.payload.tags||[],notes:r.payload.notes||'',legacyNotes:r.payload.kind!=='qualitative'}))});
  }
  if(path==='/api/scout-lock'&&req.method==='GET'){
    const event=String(url.searchParams.get('eventKey')||''),match=String(url.searchParams.get('matchKey')||`qm${url.searchParams.get('matchNumber')}`),team=Number(url.searchParams.get('teamNumber')),kind=url.searchParams.get('kind')||'quantitative';
    if(!/^(2026[a-z0-9]+|legacy)$/.test(event)||!Number.isInteger(team)||team<1||!['quantitative','qualitative'].includes(kind))fail(400,'Invalid match identifiers');
    const record=await completed(database(),identity.user.id,event,match,team,kind);return json(res,200,{locked:Boolean(record),lockedRecord:record?locked(record).lockedRecord:null});
  }
  if(path==='/api/sync'&&req.method==='POST')return json(res,...await sync(req,identity));
  if(path.startsWith('/api/admin/')){
    if(!canManage(identity))fail(403,'Scouting administrator access required');
    if(path==='/api/admin/users'&&req.method==='GET')return json(res,200,{users:(await database().query(`SELECT u.id::text,u.email FROM shared_login.portal_users u WHERE u.is_active AND EXISTS(SELECT 1 FROM shared_login.portal_permissions p WHERE p.user_id=u.id AND p.permission='scouting:read') ORDER BY email`)).rows});
    if(path==='/api/admin/import-event'&&req.method==='POST')return json(res,200,await importEvent(await readBody(req),identity));
    if(path==='/api/admin/rotations'&&req.method==='PUT')return json(res,200,await saveRotations(await readBody(req)));
    if(path==='/api/admin/rotations'&&req.method==='GET')return json(res,200,{rotations:(await database().query('SELECT * FROM scouting.rotations WHERE event_key=$1',[url.searchParams.get('eventKey')])).rows});
  }
  if(path==='/api/alliances'){
    requirePermission(identity,'scouting:alliances');
    const event=validEvent(req.method==='GET'?url.searchParams.get('eventKey'):(req.allianceBody=await readBody(req)).eventKey);
    if(req.method==='GET')return json(res,200,{alliances:(await database().query('SELECT id,name,teams,strategy,created_by::text,updated_at FROM scouting.alliances WHERE event_key=$1 ORDER BY name',[event])).rows});
    const body=req.allianceBody;
    if(req.method==='POST'){
      if(typeof body.name!=='string'||!body.name.trim()||body.name.length>100||typeof body.strategy!=='string'||body.strategy.length>8000||!Array.isArray(body.teams)||body.teams.length<1||body.teams.length>3||new Set(body.teams).size!==body.teams.length||body.teams.some(t=>!Number.isInteger(t)||t<1)||!/^[0-9a-f-]{36}$/i.test(body.id||''))fail(400,'Enter a name and one to three distinct teams');
      for(const team of body.teams)if(!(await database().query('SELECT 1 FROM scouting.teams WHERE event_key=$1 AND team_number=$2',[event,team])).rowCount)fail(400,'Alliance teams must be in the selected event');
      await database().query('INSERT INTO scouting.alliances(event_key,id,name,teams,strategy,created_by) VALUES($1,$2,$3,$4,$5,$6)',[event,body.id,body.name.trim(),body.teams,body.strategy,identity.user.id]);return json(res,201,{ok:true});
    }
    if(req.method==='DELETE'){
      if(!/^[0-9a-f-]{36}$/i.test(body.id||''))fail(400,'Invalid alliance');
      const result=await database().query('DELETE FROM scouting.alliances WHERE event_key=$1 AND id=$2 AND (created_by=$3 OR $4::boolean)',[event,body.id,identity.user.id,canManage(identity)]);
      if(!result.rowCount)fail(403,'Only the author or an administrator may remove this alliance');return json(res,200,{ok:true});
    }
  }
  return json(res,404,{error:'API route not found'});
}
