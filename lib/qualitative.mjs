import { isDeepStrictEqual } from 'node:util';
import { database, transaction } from './db.mjs';
import { json, fail, readBody } from './http.mjs';
import { qualitativeError } from '../scouting/public/qualitative-model.js';
import { eventNotes, eventParam, selectionViewer } from './selection.mjs';

export async function handleTeamNotes(req,res,url,identity){
  if(req.method==='GET'){
    if(!identity.permissions.includes('scouting:qualitative')&&!selectionViewer(identity))fail(403,'Qualitative scouting access required');
    return json(res,200,{notes:await eventNotes(eventParam(url.searchParams.get('eventKey')))});
  }
  if(req.method!=='POST')return json(res,405,{error:'Use GET or POST'});
  if(!identity.permissions.includes('scouting:qualitative'))fail(403,'Qualitative scouting access required');
  const input=await readBody(req);if(!input||typeof input!=='object'||Array.isArray(input))fail(400,'Supply a team note');const event=eventParam(input.eventKey);
  if(typeof input.id!=='string'||!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(input.id)||!Number.isInteger(input.teamNumber)||input.teamNumber<1)fail(400,'Choose a valid team and note ID');
  if(typeof input.text!=='string'||input.text.length>8000)fail(400,'Keep the note under 8000 characters');
  if(input.matchKey!=null&&(typeof input.matchKey!=='string'||input.matchKey.length>100))fail(400,'Choose a valid match');
  const note={id:input.id,eventKey:event,teamNumber:input.teamNumber,matchKey:input.matchKey||null,text:input.text.trim(),starred:input.starred??false,isUpdate:input.isUpdate??false,playedDefense:input.playedDefense??false,defenseEffectiveness:input.defenseEffectiveness??null};
  const error=qualitativeError(note);if(error)fail(400,error);
  if(!note.text&&!note.playedDefense&&!note.starred)fail(400,'Add an observation, a star, or a defense assessment');
  await transaction(async conn=>{
    if(!(await conn.query('SELECT 1 FROM scouting.teams WHERE event_key=$1 AND team_number=$2',[event,note.teamNumber])).rowCount)fail(400,'Choose a team from the imported event');
    if(note.matchKey){const match=(await conn.query('SELECT red,blue FROM scouting.matches WHERE event_key=$1 AND match_key=$2',[event,note.matchKey])).rows[0];if(!match||![...match.red,...match.blue].includes(note.teamNumber))fail(400,'This robot is not in the selected match');}
    await conn.query('INSERT INTO scouting.team_notes(id,event_key,team_number,match_key,owner_user_id,payload) VALUES($1,$2,$3,$4,$5,$6) ON CONFLICT(id) DO NOTHING',[note.id,event,note.teamNumber,note.matchKey,identity.user.id,note]);
    const saved=(await conn.query('SELECT owner_user_id::text,payload FROM scouting.team_notes WHERE id=$1 FOR UPDATE',[note.id])).rows[0];
    if(saved.owner_user_id!==identity.user.id)fail(403,'This note ID belongs to another scouter');
    if(!isDeepStrictEqual(saved.payload,note))fail(409,'A different version of this submitted note exists. Add a significant update instead.');
  });
  return json(res,200,{saved:true,id:note.id});
}
