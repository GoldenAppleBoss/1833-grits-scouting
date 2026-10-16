import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { createTestServer, testRecord } from './helpers/server.mjs';
import { agreement, parseOfficialScores, reviewMatches } from '../lib/quality.mjs';
import { blendedOPR, classifiedReview, oprResults, rosterResults, reviewResults } from '../scouting/public/quality-ui.js';

export function officialMatch(edits={}) {
  return{key:'2026test_qm1',event_key:'2026test',comp_level:'qm',match_number:1,time:100,
    alliances:{red:{team_keys:['frc1833','frc100','frc200'],score:999},blue:{team_keys:['frc300','frc400','frc500'],score:999}},
    score_breakdown:{red:{totalPoints:999,autoTowerPoints:100,hubScore:{autoPoints:60,teleopPoints:90,totalPoints:150}},blue:{hubScore:{autoPoints:0,teleopPoints:0,totalPoints:0}}},...edits};
}

test('fuel review checks both phases and totals, ignores tower/fouls, and distinguishes missing data',()=>{
  const matches=parseOfficialScores('2026test',[officialMatch()]);
  assert.deepEqual(matches[0].alliances.red.scores,{auto:60,teleop:90,total:150});
  const records=[1833,100,200].map((teamNumber,i)=>testRecord({teamNumber,ownerUserId:String(i+1),completed:true,autoFuel:10,teleopFuel:30}));
  const result=reviewMatches({matches,records});
  assert.equal(result.matches[0].status,'flagged');
  const [red,blue]=result.matches[0].alliances;
  assert.deepEqual(red.failed,['auto','total']);assert.equal(red.accuracy.auto,.5);assert.equal(red.accuracy.teleop,1);
  assert.equal(blue.status,'incomplete');assert.equal(blue.accuracy,null);
  assert.throws(()=>reviewMatches({matches,records},.99),/80% and 90%/);
  assert.equal(agreement(85,100),.85);assert.equal(agreement(115,100),.85);
  assert.equal(agreement(0,0),1);assert.equal(agreement(1,0),0);
  records.forEach(r=>{r.autoFuel=20;});
  assert.equal(reviewMatches({matches,records}).matches[0].alliances[0].status,'passed');
  // Autonomous and teleop errors cannot cancel out just because total agrees.
  records.forEach(r=>{r.autoFuel=10;r.teleopFuel=40;});
  assert.deepEqual(reviewMatches({matches,records}).matches[0].alliances[0].failed,['auto','teleop']);
});

test('latest complete observation wins without double counting; unplayed matches remain unknown',()=>{
  const matches=parseOfficialScores('2026test',[officialMatch()]);
  const records=[1833,100,200].map(teamNumber=>testRecord({teamNumber,completed:true,autoFuel:20,teleopFuel:30,submittedAt:'2026-10-16T10:00:00Z'}));
  records.push({...records[0],recordId:randomUUID(),ownerUserId:'2',autoFuel:5,submittedAt:'2026-10-16T11:00:00Z'});
  records.push({...records[0],recordId:randomUUID(),autoFuel:1000,completed:false,submittedAt:'2026-10-16T12:00:00Z'});
  const red=reviewMatches({matches,records}).matches[0].alliances[0];
  assert.equal(red.scouted.auto,45);assert.equal(red.entries.length,4);assert.equal(red.entries.filter(r=>r.selected).length,3);
  const unplayed=parseOfficialScores('2026test',[officialMatch({score_breakdown:null})]);
  assert.equal(reviewMatches({matches:unplayed,records}).matches[0].status,'awaiting-results');
  assert.throws(()=>parseOfficialScores('2026test',[officialMatch({event_key:'2026wrong'})]),/Invalid TBA/);
});

test('OPR weighting preserves endpoints and unknowns; review threshold can change classification',()=>{
  const t={tbaFuelOPR:20,scoutingOPR:40};
  assert.equal(blendedOPR(t,.5),30);assert.equal(blendedOPR(t,0),20);assert.equal(blendedOPR(t,1),40);
  assert.equal(blendedOPR({...t,scoutingOPR:null},.5),null);assert.equal(blendedOPR({...t,scoutingOPR:null},0),20);
  const result={matches:[{key:'qm1',alliances:[{status:'flagged',accuracy:{auto:.85,teleop:1,total:.9}},{status:'passed',accuracy:{auto:1,teleop:1,total:1}}]}]};
  assert.equal(classifiedReview(result,.85)[0].status,'passed');assert.equal(classifiedReview(result,.9)[0].status,'flagged');
  assert.match(oprResults({teams:[],holdout:{alliances:0},rank:0},.5),/50 \/ 50/);
  assert.match(rosterResults({scouters:[{id:'1',name:'<img>',email:'safe@example.org',comparisons:0,status:'no-data',estimatedAccuracy:null,allianceAgreement:null,flagged:0}],alliances:0}),/&lt;img&gt;/);
  assert.match(reviewResults({matches:[],updatedAt:null}),/No matches in this selection/);
});

test('Vercel routes ratings to the Python function before the catch-all Node route',async()=>{
  const config=JSON.parse(await readFile(new URL('../vercel.json',import.meta.url),'utf8'));
  const route=config.rewrites.findIndex(r=>r.source==='/scouting/api/ratings');
  assert.ok(route>=0&&route<config.rewrites.findIndex(r=>r.source==='/scouting/:path*'));
  assert.equal(config.rewrites[route].destination,'/api/ratings');
  assert.equal(config.functions['api/ratings.py'].maxDuration,60);
  assert.match(await readFile(new URL('../requirements.txt',import.meta.url),'utf8'),/numpy==/);
});

test('administrator score pulls, match review and deletion use the migrated PostgreSQL schema',async t=>{
  const app=await createTestServer();t.after(()=>app.close());
  const originalFetch=globalThis.fetch,originalKey=process.env.TBA_API_KEY;
  let unavailableOpr=false;
  process.env.TBA_API_KEY='test-only-key';
  globalThis.fetch=async (url,options)=>{
    if(String(url).startsWith('https://www.thebluealliance.com/api/v3/')){
      assert.equal(options.headers['X-TBA-Auth-Key'],'test-only-key');
      if(String(url).endsWith('/matches'))return Response.json([officialMatch(),officialMatch({key:'2026test_qm2',match_number:2,score_breakdown:null})]);
      if(String(url).endsWith('/oprs'))return unavailableOpr?Response.json({error:'Unavailable'},{status:503}):Response.json({oprs:{frc1833:123}});
      throw new Error('Unexpected TBA endpoint');
    }
    return originalFetch(url,options);
  };
  t.after(()=>{globalThis.fetch=originalFetch;if(originalKey===undefined)delete process.env.TBA_API_KEY;else process.env.TBA_API_KEY=originalKey;});
  const request=(user,path,method='GET',body,headers={})=>app.request(user,'/scouting/api'+path,{method,headers:{'content-type':'application/json',...headers},body:body?JSON.stringify(body):undefined});
  const records=[1833,100,200].map((teamNumber,i)=>testRecord({teamNumber,ownerUserId:String(i+1),completed:true,autoFuel:10,teleopFuel:30}));
  await t.test('score pulls and private review endpoints require actual management permissions and CSRF',async()=>{
    for(const user of [1,2]){
      assert.equal((await request(user,'/admin/pull-scores','POST',{eventKey:'2026test'})).status,403);
      assert.equal((await request(user,'/admin/match-review?eventKey=2026test')).status,403);
      assert.equal((await request(user,'/admin/match-entries?eventKey=2026test')).status,403);
      assert.equal((await request(user,'/ratings?eventKey=2026test&mode=roster')).status,403);
      assert.equal((await request(user,'/admin/match-entry','DELETE',{recordId:records[0].recordId,reason:'bad'})).status,403);
    }
    assert.equal((await request(1,'/ratings?eventKey=2026test&mode=opr')).status,403);
    assert.equal((await request(3,'/admin/pull-scores','POST',{eventKey:'2026test'},{'x-csrf-token':'wrong'})).status,403);
    assert.equal((await request(3,'/admin/pull-scores','POST',{eventKey:'2026missing'})).status,400);
    const pull=await request(3,'/admin/pull-scores','POST',{eventKey:'2026test'});
    assert.equal(pull.status,200);assert.deepEqual(await pull.json(),{matches:2,scored:1});
  });
  await t.test('review uses all three robot entries and official scoring fuel',async()=>{
    for(const [i,r] of records.entries())assert.equal((await request(i+1,'/sync','POST',{record:r})).status,200);
    const response=await request(3,'/admin/match-review?eventKey=2026test');assert.equal(response.status,200);
    const report=await response.json();assert.equal(report.summary.flagged,1);assert.equal(report.summary['awaiting-results'],1);
    assert.equal(report.matches[0].alliances[0].scouted.total,120);assert.equal(report.matches[0].alliances[0].official.total,150);
    assert.equal((await request(3,'/admin/match-review?eventKey=2026test&threshold=0')).status,400);
    assert.equal((await(await request(3,'/admin/match-entries?eventKey=2026test')).json()).entries.length,3);
  });
  await t.test('deletion is audited, cannot be undone by offline replay, and unlocks a fresh rescout',async()=>{
    const r=records[0],body={recordId:r.recordId,reason:'Autonomous fuel was counted incorrectly'};
    assert.equal((await request(3,'/admin/match-entry','DELETE',body,{'x-csrf-token':'wrong'})).status,403);
    assert.equal((await request(3,'/admin/match-entry','DELETE',{...body,reason:''})).status,400);
    assert.equal((await request(3,'/admin/match-entry','DELETE',body)).status,200);
    const audit=(await app.db.query('SELECT payload,reason,deleted_by FROM scouting.deleted_records WHERE record_id=$1',[r.recordId])).rows[0];
    assert.equal(audit.reason,body.reason);assert.equal(String(audit.deleted_by),'3');assert.equal(audit.payload.autoFuel,10);
    assert.equal((await request(1,'/sync','POST',{record:r})).status,410);
    assert.equal((await request(1,'/sync','POST',{record:{...r,revision:999}})).status,410);
    const own=await(await request(1,'/context?eventKey=2026test')).json();assert.deepEqual(own.deletedRecordIds,[r.recordId]);assert.equal(own.completed.length,0);
    const lock=await(await request(1,'/scout-lock?eventKey=2026test&matchKey=qm1&teamNumber=1833')).json();assert.equal(lock.locked,false);
    const review=await(await request(3,'/admin/match-review?eventKey=2026test')).json();assert.equal(review.matches[0].alliances[0].status,'incomplete');
    const replacement={...r,recordId:randomUUID(),autoFuel:40};
    assert.equal((await request(1,'/sync','POST',{record:replacement})).status,200);
    const fixed=await(await request(3,'/admin/match-review?eventKey=2026test')).json();assert.equal(fixed.matches[0].alliances[0].status,'passed');
    assert.equal((await request(3,'/admin/match-entry','DELETE',body)).status,404);
  });
  await t.test('optional overall OPR outages do not block fuel score pulls',async()=>{
    unavailableOpr=true;
    assert.equal((await request(3,'/admin/pull-scores','POST',{eventKey:'2026test'})).status,200);
    const review=await(await request(3,'/admin/match-review?eventKey=2026test')).json();
    assert.equal(review.matches[0].alliances[0].official.total,150);
  });
});
