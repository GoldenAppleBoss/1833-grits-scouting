import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { database, transaction } from './db.mjs';
import { fail } from './http.mjs';
import { normalizeRecord } from '../scouting/public/model.js';

const fuel = r => ({auto:r.autoFuel,teleop:r.teleopFuel,total:r.autoFuel+r.teleopFuel});
const validFuel = r => [r.autoFuel,r.teleopFuel].every(n=>Number.isInteger(n)&&n>=0);
export const agreement = (actual,official) => Math.max(0,1-Math.abs(actual-official)/Math.max(official,1));
export function latestObservations(records) {
  const latest=new Map();
  for(const r of records.filter(r=>r.completed&&r.kind==='quantitative'&&validFuel(r)).sort((a,b)=>String(a.serverReceivedAt||a.submittedAt||a.updatedAt||'').localeCompare(String(b.serverReceivedAt||b.submittedAt||b.updatedAt||''))||a.recordId.localeCompare(b.recordId)))latest.set(`${r.matchKey}:${r.teamNumber}`,r);
  return latest;
}
export function parseOfficialScores(event,matches) {
  if(!Array.isArray(matches)||matches.length>2000)fail(502,'Invalid TBA score response');
  return matches.map(m=>{
    if(m.event_key!==event||!m.key?.startsWith(event+'_')||!['qm','ef','qf','sf','f'].includes(m.comp_level)||!Number.isInteger(m.match_number)||m.match_number<1)fail(502,'Invalid TBA match result');
    const result={key:m.key.slice(event.length+1),number:m.match_number,level:m.comp_level,time:m.actual_time||m.time||0,alliances:{}};
    for(const alliance of ['red','blue']){
      const teams=m.alliances?.[alliance]?.team_keys?.map(k=>Number(k.replace(/^frc/,'')));
      if(teams?.length!==3||teams.some(n=>!Number.isInteger(n)||n<1)||new Set(teams).size!==3)fail(502,'Invalid TBA alliance');
      const hub=m.score_breakdown?.[alliance]?.hubScore;
      // Points count only scoring fuel, excluding inactive-hub fuel, tower and fouls.
      const scores=hub?{auto:hub.autoPoints,teleop:hub.teleopPoints,total:hub.totalPoints}:null;
      const ready=m.alliances[alliance].score>=0&&scores&&Object.values(scores).every(n=>Number.isInteger(n)&&n>=0)&&scores.total===scores.auto+scores.teleop;
      result.alliances[alliance]={teams,scores:ready?scores:null};
    }
    return result;
  }).sort((a,b)=>(a.level==='qm'?0:1)-(b.level==='qm'?0:1)||a.time-b.time||a.number-b.number||a.key.localeCompare(b.key));
}
export function reviewMatches(data,threshold=.85) {
  if(!Number.isFinite(threshold)||threshold<.8||threshold>.9)fail(400,'Accuracy cutoff must be between 80% and 90%');
  const latest=latestObservations(data.records),names=new Map((data.users||[]).map(u=>[String(u.id),u.name||u.email]));
  const matches=(data.matches||[]).map(m=>{
    const alliances=['red','blue'].map(color=>{
      const official=m.alliances[color],observed=official.teams.map(n=>latest.get(`${m.key}:${n}`)),missing=official.teams.filter((n,i)=>!observed[i]);
      const entries=data.records.filter(r=>r.completed&&r.kind==='quantitative'&&r.matchKey===m.key&&official.teams.includes(r.teamNumber)).map(r=>({recordId:r.recordId,teamNumber:r.teamNumber,ownerUserId:r.ownerUserId,scouter:names.get(String(r.ownerUserId))||'Former scouter',selected:latest.get(`${m.key}:${r.teamNumber}`)?.recordId===r.recordId,...(validFuel(r)?fuel(r):{auto:null,teleop:null,total:null})}));
      const scouted=missing.length?null:observed.reduce((s,r)=>{const f=fuel(r);for(const k of Object.keys(s))s[k]+=f[k];return s;},{auto:0,teleop:0,total:0});
      const accuracy=official.scores&&scouted?Object.fromEntries(['auto','teleop','total'].map(k=>[k,agreement(scouted[k],official.scores[k])])):null;
      const failed=accuracy?Object.keys(accuracy).filter(k=>accuracy[k]+1e-10<threshold):[];
      return{color,teams:official.teams,official:official.scores,scouted,accuracy,failed,missing,entries,status:!official.scores?'awaiting-results':missing.length?'incomplete':failed.length?'flagged':'passed'};
    });
    return{key:m.key,number:m.number,level:m.level,alliances,status:alliances.some(a=>a.status==='flagged')?'flagged':alliances.some(a=>a.status==='incomplete')?'incomplete':alliances.every(a=>a.status==='passed')?'passed':'awaiting-results'};
  });
  return{threshold,updatedAt:data.updatedAt||null,matches,summary:Object.fromEntries(['flagged','incomplete','passed','awaiting-results'].map(s=>[s,matches.filter(m=>m.status===s).length]))};
}
export async function ratingData(event,includeUsers=false) {
  const saved=(await database().query('SELECT payload,updated_at FROM scouting.event_scores WHERE event_key=$1',[event])).rows[0];
  const records=(await database().query("SELECT payload,event_key,match_key,kind,owner_user_id::text,server_received_at FROM scouting.records WHERE event_key=$1 AND completed AND kind='quantitative'",[event])).rows.map(r=>normalizeRecord({...r.payload,eventKey:r.event_key,matchKey:r.match_key,kind:r.kind,ownerUserId:r.owner_user_id,serverReceivedAt:new Date(r.server_received_at).toISOString()}));
  const teams=(await database().query('SELECT team_number,name FROM scouting.teams WHERE event_key=$1 ORDER BY team_number',[event])).rows;
  const schedule=(await database().query('SELECT match_key,comp_level,red,blue FROM scouting.matches WHERE event_key=$1',[event])).rows.map(m=>({key:m.match_key,level:m.comp_level,alliances:{red:{teams:m.red},blue:{teams:m.blue}}}));
  const users=includeUsers?(await database().query(`SELECT u.id::text,u.email,COALESCE(NULLIF(trim(u.first_name||' '||u.last_name),''),u.email) AS name FROM shared_login.portal_users u WHERE EXISTS(SELECT 1 FROM scouting.rotations r WHERE r.event_key=$1 AND r.user_id=u.id) OR EXISTS(SELECT 1 FROM scouting.records r WHERE r.event_key=$1 AND r.owner_user_id=u.id) ORDER BY name`,[event])).rows:[];
  return{...saved?.payload,matches:saved?.payload?.matches||[],schedule,updatedAt:saved?.updated_at?new Date(saved.updated_at).toISOString():null,records,teams,users};
}
export async function deleteMatchEntry(recordId,reason,identity) {
  if(typeof recordId!=='string'||recordId.length>200||!recordId)fail(400,'Choose a match entry');
  if(typeof reason!=='string'||!reason.trim()||reason.length>1000)fail(400,'Enter a deletion reason (up to 1000 characters)');
  return transaction(async conn=>{
    const found=(await conn.query('SELECT owner_user_id::text,event_key FROM scouting.records WHERE record_id=$1',[recordId])).rows[0];
    if(!found)fail(404,'Match entry has already been deleted or does not exist');
    for(const key of [`owner:${found.owner_user_id}`,`record:${recordId}`].sort())await conn.query('SELECT pg_advisory_xact_lock(hashtextextended($1,1833))',[key]);
    await conn.query('SELECT pg_advisory_xact_lock(hashtextextended($1,1833))',[found.event_key]);
    const r=(await conn.query('SELECT * FROM scouting.records WHERE record_id=$1 FOR UPDATE',[recordId])).rows[0];
    if(!r)fail(404,'Match entry has already been deleted');
    await conn.query('INSERT INTO scouting.deleted_records(record_id,owner_user_id,event_key,match_key,team_number,payload,reason,deleted_by) VALUES($1,$2,$3,$4,$5,$6,$7,$8)',[recordId,r.owner_user_id,r.event_key,r.match_key,r.team_number,r.payload,reason.trim(),identity.user.id]);
    await conn.query('DELETE FROM scouting.records WHERE record_id=$1',[recordId]);
    return{deleted:true,recordId,eventKey:r.event_key,matchKey:r.match_key,teamNumber:r.team_number};
  });
}
// The deployed route uses Vercel's Python function. Local Node development uses
// the exact same NumPy code over stdin, without exposing a second local server.
export function localRatings(data,mode) {
  return new Promise((resolve,reject)=>{
    const executable=process.env.PYTHON_EXECUTABLE||(process.platform==='win32'?'py':'python3');
    const child=spawn(executable,[fileURLToPath(new URL('../api/ratings.py',import.meta.url)),'--stdio'],{windowsHide:true,stdio:['pipe','pipe','pipe'],timeout:45000});
    let output='';child.stdout.on('data',d=>{output+=d;});child.stderr.resume();
    child.on('error',()=>reject(Object.assign(new Error('Install Python and run python -m pip install -r requirements.txt to enable local NumPy ratings.'),{statusCode:503})));
    child.on('close',code=>{if(code!==0)return reject(Object.assign(new Error('NumPy ratings unavailable. Install requirements.txt in your local Python environment.'),{statusCode:503}));try{resolve(JSON.parse(output));}catch{reject(new Error('Invalid NumPy response'));}});
    child.stdin.on('error',()=>{});child.stdin.end(JSON.stringify({data,mode}));
  });
}
