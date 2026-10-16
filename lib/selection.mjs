import { isDeepStrictEqual } from 'node:util';
import { database, transaction } from './db.mjs';
import { fail, json, readBody } from './http.mjs';
import { teamAnalytics, normalizeRecord } from '../scouting/public/model.js';
import { qualitativeSummary } from '../scouting/public/qualitative-model.js';
import { initialWorkspace, applySelectionOperation } from '../scouting/public/selection-model.js';

const admin=i=>i.permissions.some(p=>['portal:admin','scouting:manage'].includes(p));
export const selectionViewer=i=>admin(i)||i.permissions.some(p=>['scouting:alliances','scouting:analytics'].includes(p));
const editor=i=>admin(i)||i.permissions.includes('scouting:alliances');
export function eventParam(v){if(typeof v!=='string'||!/^2026[a-z0-9]+$/.test(v))fail(400,'Choose an imported 2026 event');return v;}
const nameSql="COALESCE(NULLIF(trim(u.first_name||' '||u.last_name),''),u.email)";
export async function eventNotes(event,conn=database()){
  return(await conn.query(`SELECT n.id::text,n.payload,n.owner_user_id::text,n.created_at,${nameSql} AS name FROM scouting.team_notes n JOIN shared_login.portal_users u ON u.id=n.owner_user_id WHERE n.event_key=$1 ORDER BY n.created_at DESC`,[event])).rows.map(r=>({...r.payload,id:r.id,ownerUserId:r.owner_user_id,scouterName:r.name,createdAt:new Date(r.created_at).toISOString()}));
}
export async function qualitativeRecords(event,conn=database()){
  return(await conn.query(`SELECT r.payload,r.record_id,r.event_key,r.match_key,r.kind,r.owner_user_id::text,r.server_received_at,${nameSql} AS name FROM scouting.records r JOIN shared_login.portal_users u ON u.id=r.owner_user_id WHERE r.event_key=$1 AND r.completed AND (r.kind='qualitative' OR COALESCE(r.payload->>'notes','')<>'' OR CASE WHEN jsonb_typeof(r.payload->'tags')='array' THEN jsonb_array_length(r.payload->'tags') ELSE 0 END>0)`,[event])).rows.map(r=>{const payload=r.kind==='qualitative'?r.payload:Object.fromEntries(['teamNumber','matchNumber','alliance','notes','tags','revision','completed'].map(k=>[k,r.payload[k]]));return{...normalizeRecord(payload),recordId:r.record_id,eventKey:r.event_key,matchKey:r.match_key,kind:'qualitative',ownerUserId:r.owner_user_id,scouterName:r.name,serverReceivedAt:new Date(r.server_received_at).toISOString(),legacyNotes:r.kind!=='qualitative'};});
}
async function selectionData(event){
  const teams=(await database().query('SELECT team_number,name FROM scouting.teams WHERE event_key=$1 ORDER BY team_number',[event])).rows;
  const quant=(await database().query("SELECT payload,server_received_at FROM scouting.records WHERE event_key=$1 AND completed AND kind='quantitative'",[event])).rows.map(r=>({...normalizeRecord(r.payload),serverReceivedAt:new Date(r.server_received_at).toISOString()}));
  const [observations,notes]=await Promise.all([qualitativeRecords(event),eventNotes(event)]);
  const q=new Map(teamAnalytics(quant,event,teams).map(t=>[t.teamNumber,t])),s=new Map(qualitativeSummary(observations,notes,teams).map(t=>[t.teamNumber,t]));
  return{teams:teams.map(t=>({teamNumber:Number(t.team_number),name:t.name,quantitative:q.get(Number(t.team_number))?.metrics||{},quantMatches:q.get(Number(t.team_number))?.records.length||0,qualitative:s.get(Number(t.team_number))})),updatedAt:new Date().toISOString()};
}
export async function selectionSnapshot(event,identity,since=-1,conn=database()){
  const row=(await conn.query('SELECT revision,payload,updated_at FROM scouting.selection_workspaces WHERE event_key=$1',[event])).rows[0],revision=Number(row?.revision||0);
  const presence=(await conn.query(`SELECT p.user_id::text,${nameSql} AS name FROM scouting.selection_presence p JOIN shared_login.portal_users u ON u.id=p.user_id WHERE p.event_key=$1 AND p.last_seen>now()-interval '45 seconds' AND u.is_active ORDER BY name`,[event])).rows;
  if(revision===since)return{unchanged:true,revision,presence,canEdit:editor(identity)};
  const history=(await conn.query(`SELECT c.id::text,c.revision,c.description,c.created_at,${nameSql} AS name FROM scouting.selection_changes c JOIN shared_login.portal_users u ON u.id=c.actor_id WHERE c.event_key=$1 ORDER BY c.revision DESC LIMIT 20`,[event])).rows.map(r=>({...r,revision:Number(r.revision),created_at:new Date(r.created_at).toISOString()}));
  return{eventKey:event,revision,state:row?.payload||initialWorkspace(),presence,history,canEdit:editor(identity),updatedAt:row?.updated_at?new Date(row.updated_at).toISOString():null};
}
async function mutate(event,body,identity){
  if(!editor(identity))fail(403,'Alliance selection editing access required');
  if(typeof body.operationId!=='string'||!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(body.operationId)||!body.operation||typeof body.operation!=='object')fail(400,'Invalid shared operation');
  await transaction(async conn=>{
    if(!(await conn.query('SELECT 1 FROM scouting.events WHERE event_key=$1',[event])).rowCount)fail(400,'Import the event first');
    await conn.query('INSERT INTO scouting.selection_workspaces(event_key,payload) VALUES($1,$2) ON CONFLICT(event_key) DO NOTHING',[event,initialWorkspace()]);
    const row=(await conn.query('SELECT revision,payload FROM scouting.selection_workspaces WHERE event_key=$1 FOR UPDATE',[event])).rows[0];
    const previous=(await conn.query('SELECT event_key,actor_id::text,request FROM scouting.selection_changes WHERE id=$1',[body.operationId])).rows[0];
    if(previous){if(previous.event_key!==event||previous.actor_id!==identity.user.id||!isDeepStrictEqual(previous.request,body.operation))fail(409,'This operation ID was already used');return;}
    const revision=Number(row.revision),actor={id:identity.user.id,name:[identity.user.firstName,identity.user.lastName].filter(Boolean).join(' ')||identity.user.email,time:new Date().toISOString(),admin:admin(identity)};
    let result;
    if(body.operation.type==='undo'){
      if(typeof body.operation.changeId!=='string'||!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(body.operation.changeId))fail(400,'Choose a valid shared change to undo');
      const change=(await conn.query('SELECT before_payload,revision,description FROM scouting.selection_changes WHERE id=$1 AND event_key=$2',[body.operation.changeId,event])).rows[0];
      if(!change||Number(change.revision)!==revision||body.operation.expectedRevision!==revision)fail(409,'Newer shared changes exist. Refresh before undoing.');
      result={state:change.before_payload,description:`Undo: ${change.description}`};
    }else{
      const teams=(await conn.query('SELECT team_number FROM scouting.teams WHERE event_key=$1',[event])).rows.map(r=>Number(r.team_number));
      result=applySelectionOperation(row.payload,body.operation,teams,actor,revision);
    }
    await conn.query('UPDATE scouting.selection_workspaces SET payload=$2,revision=revision+1,updated_by=$3,updated_at=now() WHERE event_key=$1',[event,result.state,identity.user.id]);
    await conn.query('INSERT INTO scouting.selection_changes(id,event_key,revision,actor_id,request,before_payload,description) VALUES($1,$2,$3,$4,$5,$6,$7)',[body.operationId,event,revision+1,identity.user.id,body.operation,row.payload,result.description]);
  });
  return selectionSnapshot(event,identity);
}
export async function handleSelection(req,res,url,identity,path){
  if(!selectionViewer(identity))fail(403,'Alliance selection or analytics access required');
  if(path==='/api/selection/data'&&req.method==='GET')return json(res,200,await selectionData(eventParam(url.searchParams.get('eventKey'))));
  if(path==='/api/selection/workspace'){
    if(req.method==='GET'){const since=Number(url.searchParams.get('since')??-1);return json(res,200,await selectionSnapshot(eventParam(url.searchParams.get('eventKey')),identity,since));}
    if(req.method==='POST'){const body=await readBody(req);if(!body||typeof body!=='object'||Array.isArray(body))fail(400,'Supply a shared operation');return json(res,200,await mutate(eventParam(body.eventKey),body,identity));}
  }
  if(path==='/api/selection/presence'&&req.method==='POST'){
    const event=eventParam((await readBody(req)).eventKey);
    if(!(await database().query('SELECT 1 FROM scouting.events WHERE event_key=$1',[event])).rowCount)fail(400,'Import the event first');
    await database().query('INSERT INTO scouting.selection_presence(event_key,user_id,last_seen) VALUES($1,$2,now()) ON CONFLICT(event_key,user_id) DO UPDATE SET last_seen=now()',[event,identity.user.id]);return json(res,200,{ok:true});
  }
  return json(res,404,{error:'Selection route not found'});
}
