import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createTestServer, testRecord } from './helpers/server.mjs';
import { assignRank, qualitativeSummary, qualitativeError, allianceObservationError } from '../scouting/public/qualitative-model.js';

test('subjective rankings swap instead of duplicating; aggregation keeps unknowns separate from zeros',()=>{
  const rows=[{teamNumber:1,subjectiveRank:1},{teamNumber:2,subjectiveRank:2},{teamNumber:3,subjectiveRank:null}];
  assert.deepEqual(assignRank(rows,2,'subjectiveRank',1).map(r=>r.subjectiveRank),[2,1,null]);
  assert.deepEqual(assignRank(rows,1,'subjectiveRank',1).map(r=>r.subjectiveRank),[null,2,null]);
  assert.match(qualitativeError({playedDefense:false,defenseEffectiveness:'shutdown'}),/defense/);
  const r=testRecord({kind:'qualitative',completed:true,subjectiveRank:1,agilityRank:null,starred:true,playedDefense:true,defenseEffectiveness:'impactful',tags:['Good Driver']});
  const summary=qualitativeSummary([r],[{teamNumber:1833,text:'Changed',isUpdate:true}], [{team_number:1833,name:'BEAN'},{team_number:100,name:'Unknown'}]);
  assert.equal(summary[0].averages.subjectiveRank,1);assert.equal(summary[0].averages.agilityRank,null);assert.equal(summary[0].defenseAverage,3);assert.equal(summary[0].stars,1);assert.equal(summary[1].averages.subjectiveRank,null);
});

test('ranked alliance submissions are atomic, validated, idempotent, and distinct from quantitative scouting',async t=>{
  const app=await createTestServer();t.after(()=>app.close());
  await app.db.query("INSERT INTO shared_login.portal_permissions(user_id,permission) VALUES(4,'scouting:qualitative')");
  const groupId=randomUUID(),records=[1833,100,200].map((teamNumber,i)=>testRecord({teamNumber,ownerUserId:'4',kind:'qualitative',qualGroupId:groupId,completed:true,subjectiveRank:i+1,agilityRank:i+1,fieldAwarenessRank:null,driverAbilityRank:null,starred:i===0,playedDefense:i===0,defenseEffectiveness:i===0?'shutdown':null,notes:'Observed team '+teamNumber}));
  const submit=(user,rs,headers={})=>app.request(user,'/scouting/api/qualitative/alliance',{method:'POST',headers:{'content-type':'application/json',...headers},body:JSON.stringify({records:rs})});
  await t.test('permissions, CSRF, team membership and unique ranks are enforced',async()=>{
    assert.equal((await submit(1,records)).status,403);assert.equal((await submit(4,records,{'x-csrf-token':'bad'})).status,403);
    assert.equal((await submit(4,[null,{},{}])).status,400);
    for(const rs of [records.slice(0,2),records.map(r=>({...r,subjectiveRank:1})),records.map(r=>({...r,subjectiveRank:null})),records.map((r,i)=>i===0?{...r,teamNumber:300}:r)])assert.equal((await submit(4,rs)).status,400);
    assert.equal((await app.db.query('SELECT count(*) AS n FROM scouting.records WHERE owner_user_id=4')).rows[0].n,0);
    assert.equal((await app.request(4,'/scouting/api/sync',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({record:records[0]})})).status,400);
  });
  await t.test('all three observations submit together and network retries are idempotent',async()=>{
    assert.equal((await submit(4,records)).status,200);assert.equal((await submit(4,records)).status,200);
    assert.equal((await app.db.query('SELECT count(*) AS n FROM scouting.records WHERE owner_user_id=4')).rows[0].n,3);
    const response=await app.request(4,'/scouting/api/qualitative?eventKey=2026test');assert.equal(response.status,200);const data=await response.json();assert.equal(data.records.length,3);assert.equal(data.records.find(r=>r.teamNumber===1833).subjectiveRank,1);assert.equal(data.records.find(r=>r.teamNumber===1833).defenseEffectiveness,'shutdown');
    const changed=records.map(r=>({...r,revision:2,notes:'Changed locked observation'}));assert.equal((await submit(4,changed)).status,423);
    const duplicate=records.map(r=>({...r,recordId:randomUUID(),qualGroupId:randomUUID()}));assert.equal((await submit(4,duplicate)).status,400);
  });
  await t.test('a deleted robot can be rescouted while retaining the other two locked observations',async()=>{
    const removed=records[0];
    const deleted=await app.request(3,'/scouting/api/admin/match-entry',{method:'DELETE',headers:{'content-type':'application/json'},body:JSON.stringify({recordId:removed.recordId,reason:'Incorrect subjective observation'})});assert.equal(deleted.status,200);
    const replacement={...removed,recordId:randomUUID(),notes:'Corrected robot observation'};
    assert.equal((await submit(4,[replacement,...records.slice(1)])).status,200);
    assert.equal((await submit(4,records)).status,410);
    assert.equal((await app.db.query('SELECT count(*) AS n FROM scouting.records WHERE owner_user_id=4')).rows[0].n,3);
    records[0]=replacement;
  });
  await t.test('failure on a later locked robot rolls back earlier new observations',async()=>{
    const rs=records.map(r=>({...r,recordId:randomUUID()}));
    await app.db.query('DELETE FROM scouting.records WHERE owner_user_id=4 AND team_number IN(1833,100)');
    assert.equal((await submit(4,rs)).status,423);
    assert.equal((await app.db.query('SELECT count(*) AS n FROM scouting.records WHERE owner_user_id=4')).rows[0].n,1);
  });
  await t.test('event notes support significant updates, defense, optional match and immutable retry-safe IDs',async()=>{
    const note={id:randomUUID(),eventKey:'2026test',teamNumber:1833,matchKey:null,text:'Passing improved after repair',isUpdate:true,starred:true,playedDefense:true,defenseEffectiveness:'impactful'};
    const send=(user,body)=>app.request(user,'/scouting/api/qualitative/notes',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(body)});
    assert.equal((await send(1,note)).status,403);assert.equal((await send(4,note)).status,200);assert.equal((await send(4,note)).status,200);
    assert.equal((await send(4,{...note,text:'different'})).status,409);assert.equal((await send(4,{...note,id:randomUUID(),teamNumber:777})).status,400);
    const read=await app.request(4,'/scouting/api/qualitative/notes?eventKey=2026test');assert.equal((await read.json()).notes.length,1);
    const combined=await(await app.request(2,'/scouting/api/selection/data?eventKey=2026test')).json();assert.equal(combined.teams.find(t=>t.teamNumber===1833).qualitative.notes[0].isUpdate,true);
  });
});
