import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createTestServer, testRecord } from './helpers/server.mjs';
import { initialWorkspace, applySelectionOperation, metricValues, rankedTeams } from '../scouting/public/selection-model.js';
const teams=[1833,100,200,300,400,500],actor={id:'3',name:'Admin',time:'2026-10-16T10:00:00Z'};

test('draft board defaults, membership, unique slots, moves, swaps and layout preservation',()=>{
  let state=initialWorkspace();assert.equal(state.board.rows,8);assert.equal(state.board.columns,3);
  const apply=op=>{state=applySelectionOperation(state,op,teams,actor,0).state;};
  apply({type:'board.assign',row:0,column:0,teamNumber:1833,expectedTeam:null,expectedSource:null});
  assert.throws(()=>apply({type:'board.assign',row:0,column:1,teamNumber:777,expectedTeam:null}),/imported event/);
  assert.throws(()=>apply({type:'board.assign',row:0,column:1,teamNumber:1833,expectedTeam:null,expectedSource:null}),/robot moved/);
  apply({type:'board.assign',row:0,column:1,teamNumber:1833,expectedTeam:null,expectedSource:{column:0,row:0}});
  assert.equal(state.board.slots[0][0],null);assert.equal(state.board.slots[0][1],1833);
  apply({type:'board.assign',row:1,column:0,teamNumber:100,expectedTeam:null,expectedSource:null});
  apply({type:'board.swap',row:0,column:1,otherRow:1,otherColumn:0,expectedTeam:1833,expectedOtherTeam:100});
  assert.equal(state.board.slots[0][1],100);assert.equal(state.board.slots[1][0],1833);
  apply({type:'board.layout',rows:8,columns:4,expectedRevision:0});
  apply({type:'board.assign',row:0,column:3,teamNumber:200,expectedTeam:null,expectedSource:null});
  assert.throws(()=>apply({type:'board.layout',rows:8,columns:3,expectedRevision:0}),/occupied slots/);
  apply({type:'board.layout',rows:8,columns:3,expectedRevision:0,allowDrop:true});
  assert.equal(state.board.slots.flat().includes(200),false);assert.equal(state.board.slots[0][1],100);
});

test('team metrics retain unknowns, use fuel OPR weights and put lower subjective ranks first',()=>{
  const t={quantitative:{totalFuel:{mean:30}},qualitative:{averages:{subjectiveRank:1.5},defenseAverage:3}};
  assert.equal(metricValues(t,{tbaFuelOPR:20,scoutingOPR:40,scoutingPassingOPR:12},.5).adjustedOPR,30);
  assert.equal(metricValues(t,{tbaFuelOPR:20},.5).adjustedOPR,null);
  assert.equal(metricValues(t,{tbaFuelOPR:20},0).adjustedOPR,20);
  assert.deepEqual(rankedTeams([3,1,2],n=>({subjectiveRank:{1:2,2:null,3:1}[n]}),'subjectiveRank'),[3,1,2]);
});

test('shared selection operations enforce permissions, merge independent edits and reject stale changes',async t=>{
  const app=await createTestServer();t.after(()=>app.close());
  await app.db.query("INSERT INTO shared_login.portal_permissions(user_id,permission) VALUES(5,'scouting:alliances')");
  const get=(user=3,suffix='')=>app.request(user,'/scouting/api/selection/workspace?eventKey=2026test'+suffix);
  const read=async user=>(await get(user)).json();
  const send=(user,operation,operationId=randomUUID(),headers={})=>app.request(user,'/scouting/api/selection/workspace',{method:'POST',headers:{'content-type':'application/json',...headers},body:JSON.stringify({eventKey:'2026test',operationId,operation})});
  const defense=randomUUID(),offense=randomUUID();
  await t.test('viewing and editing are separate; quant-only users and forged CSRF are blocked',async()=>{
    assert.equal((await get(1)).status,403);assert.equal((await get(2)).status,200);assert.equal((await read(2)).canEdit,false);
    assert.equal((await send(2,{type:'list.create',listId:defense,name:'Defense'})).status,403);
    assert.equal((await send(3,{type:'list.create',listId:defense,name:'Defense'},randomUUID(),{'x-csrf-token':'bad'})).status,403);
    assert.equal((await get(1)).status,403);
    const s=await read(3);assert.equal(s.revision,0);assert.equal(s.state.board.rows,8);
  });
  await t.test('independent collaborators can create and append without lost updates',async()=>{
    const responses=await Promise.all([send(3,{type:'list.create',listId:defense,name:'Defense'}),send(5,{type:'list.create',listId:offense,name:'Offensive firepower'})]);
    responses.forEach(r=>assert.equal(r.status,200));
    const added=await Promise.all([send(3,{type:'list.add',listId:defense,teamNumber:1833}),send(5,{type:'list.add',listId:defense,teamNumber:100})]);added.forEach(r=>assert.equal(r.status,200));
    const s=await read(3);assert.equal(s.state.lists.length,2);assert.deepEqual(new Set(s.state.lists.find(l=>l.id===defense).teams.map(t=>t.number)),new Set([1833,100]));
    const thin=await(await get(5,'&since='+s.revision)).json();assert.equal(thin.unchanged,true);assert.equal(thin.state,undefined);
  });
  await t.test('competing assignments to one slot produce one winner, not duplicate robots',async()=>{
    const responses=await Promise.all([send(3,{type:'board.assign',row:0,column:0,teamNumber:1833,expectedTeam:null,expectedSource:null}),send(5,{type:'board.assign',row:0,column:0,teamNumber:100,expectedTeam:null,expectedSource:null})]);
    assert.deepEqual(responses.map(r=>r.status).sort(),[200,409]);
    const s=await read(3),winner=s.state.board.slots[0][0];assert.ok([1833,100].includes(winner));
    assert.equal((await send(5,{type:'board.assign',row:0,column:1,teamNumber:winner,expectedTeam:null,expectedSource:null})).status,409);
    assert.equal((await send(5,{type:'board.assign',row:0,column:1,teamNumber:winner,expectedTeam:null,expectedSource:{row:0,column:0}})).status,200);
    const after=await read(3);assert.equal(after.state.board.slots.flat().filter(n=>n===winner).length,1);
  });
  await t.test('stale reorders and team-note overwrites are rejected while independent notes merge',async()=>{
    const stale=(await read(3)).state.lists.find(l=>l.id===defense);
    assert.equal((await send(5,{type:'list.team-note',listId:defense,teamNumber:1833,expectedNote:'',note:'Strong defense'})).status,200);
    assert.equal((await send(3,{type:'list.reorder',listId:defense,expectedRevision:stale.revision,order:[100,1833]})).status,409);
    assert.equal((await send(3,{type:'list.team-note',listId:defense,teamNumber:1833,expectedNote:'',note:'stale replacement'})).status,409);
    assert.equal((await send(3,{type:'list.team-note',listId:defense,teamNumber:100,expectedNote:'',note:'Good passing'})).status,200);
    const list=(await read(3)).state.lists.find(l=>l.id===defense);assert.equal(list.teams.find(t=>t.number===1833).note,'Strong defense');assert.equal(list.teams.find(t=>t.number===100).note,'Good passing');
    assert.equal((await send(5,{type:'list.remove',listId:defense,teamNumber:1833,expectedNote:''})).status,409);
  });
  await t.test('request retries are idempotent and undo cannot erase a newer collaborator edit',async()=>{
    const operation={type:'list.comment',listId:defense,commentId:randomUUID(),text:'Review this list together'},operationId=randomUUID();
    const first=await send(5,operation,operationId);assert.equal(first.status,200);const before=await first.json();
    const second=await send(5,operation,operationId);assert.equal(second.status,200);assert.equal((await second.json()).revision,before.revision);
    assert.equal((await send(3,{type:'pool.hide',teamNumber:300,hidden:true})).status,200);
    assert.equal((await send(3,{type:'undo',changeId:before.history[0].id,expectedRevision:before.revision})).status,409);
    const latest=await read(3);assert.equal((await send(5,{type:'undo',changeId:latest.history[0].id,expectedRevision:latest.revision})).status,200);
    const after=await read(3);assert.equal(after.state.hiddenTeams.includes(300),false);assert.equal(after.state.lists.find(l=>l.id===defense).comments.length,1);
  });
  await t.test('selection readers receive combined team metrics and qualitative history',async()=>{
    const r=testRecord({ownerUserId:'2',completed:true,autoFuel:12,teleopFuel:30,autoPassed:3,teleopPassed:20});
    assert.equal((await app.request(2,'/scouting/api/sync',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({record:r})})).status,200);
    const response=await app.request(5,'/scouting/api/selection/data?eventKey=2026test');assert.equal(response.status,200);const body=await response.json();
    assert.equal(body.teams.find(t=>t.teamNumber===1833).quantitative.totalFuel.mean,42);
    assert.equal((await app.request(1,'/scouting/api/selection/data?eventKey=2026test')).status,403);
    const presence=await app.request(2,'/scouting/api/selection/presence',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({eventKey:'2026test'})});assert.equal(presence.status,200);assert.ok((await read(3)).presence.some(p=>p.user_id==='2'));
  });
  await t.test('comments can be removed by their author or an actual administrator',async()=>{
    const id=randomUUID();assert.equal((await send(3,{type:'list.comment',listId:defense,commentId:id,text:'Captain discussion'})).status,200);
    assert.equal((await send(5,{type:'list.comment-remove',listId:defense,commentId:id,admin:true})).status,403);
    assert.equal((await send(3,{type:'list.comment-remove',listId:defense,commentId:id})).status,200);
    const authoredByFive=(await read(3)).state.lists.find(l=>l.id===defense).comments[0].id;
    assert.equal((await send(5,{type:'list.comment-remove',listId:defense,commentId:authoredByFive})).status,200);
  });
});
