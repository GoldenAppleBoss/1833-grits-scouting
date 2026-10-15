import test from 'node:test';
import assert from 'node:assert/strict';
import { createTestServer, testRecord } from './helpers/server.mjs';
import { csrf } from '../lib/portal.mjs';

test('assignment restrictions and station management with PostgreSQL',async t=>{
  const app=await createTestServer();
  t.after(()=>app.close());
  const sync=(user,record)=>app.request(user,'/scouting/api/sync',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({record})});
  await t.test('health and assignment endpoint work with the migrated schema',async()=>{
    assert.equal((await app.request(1,'/scouting/api/health')).status,200);
    const result=await app.request(1,'/scouting/api/assignment?eventKey=2026test&matchNumber=1');
    assert.equal(result.status,200);assert.equal((await result.json()).teamNumber,1833);
    assert.equal((await app.request(4,'/scouting/api/assignment?eventKey=2026test&matchNumber=1')).status,400);
  });
  await t.test('quantitative users cannot forge station, unscheduled match, legacy event or owner',async()=>{
    for(const edits of [{teamNumber:100},{teamNumber:300,alliance:'blue'},{matchKey:'f1m1'},{matchNumber:99,matchKey:'qm99'},{eventKey:'legacy'},{ownerUserId:'2'}]){
      const result=await sync(1,testRecord(edits));
      assert.ok([400,403].includes(result.status),JSON.stringify(edits));
    }
    assert.equal((await sync(4,testRecord({ownerUserId:'4'}))).status,403);
    assert.equal((await sync(1,testRecord())).status,200);
  });
  await t.test('an extra permission retains manual robots and unscheduled matches',async()=>{
    assert.equal((await sync(2,testRecord({ownerUserId:'2',teamNumber:500,alliance:'blue'}))).status,200);
    assert.equal((await sync(2,testRecord({ownerUserId:'2',teamNumber:777,matchKey:'f1m1'}))).status,200);
    assert.equal((await app.request(2,'/scouting/api/admin/users')).status,403);
  });
  await t.test('portal station changes enforce admin, CSRF, uniqueness and group consistency',async()=>{
    const body={user_id:'5',event_key:'2026test',scout_station:'red:1',rotation:'1',rotation_count:'1',csrf_token:csrf('test-token-3')};
    const save=(user,edits={})=>app.request(user,'/admin/scout-station',{method:'POST',headers:{'content-type':'application/x-www-form-urlencoded'},body:new URLSearchParams({...body,...edits})});
    assert.equal((await save(1)).status,403);
    assert.equal((await save(3,{csrf_token:'invalid'})).status,403);
    assert.equal((await save(3)).status,409);
    assert.equal((await save(3,{scout_station:'blue:2',rotation_count:'2'})).status,400);
    assert.equal((await save(3,{scout_station:'blue:2'})).status,303);
    const resolved=await app.request(5,'/scouting/api/assignment?eventKey=2026test&matchNumber=1');
    assert.equal((await resolved.json()).teamNumber,400);
    const portal=await app.request(3,'/admin');
    const html=await portal.text();assert.match(html,/Blue scout 2/);assert.match(html,/Quantitative only: assigned robots required/);
    assert.equal((await save(3,{scout_station:'unassigned'})).status,303);
    assert.equal((await app.request(5,'/scouting/api/assignment?eventKey=2026test&matchNumber=1')).status,400);
  });
  await t.test('rotation restrictions apply to quantitative users while extra permissions bypass them',async()=>{
    await app.db.query('UPDATE scouting.rotations SET rotation_count=2 WHERE user_id=1');
    assert.equal((await app.request(1,'/scouting/api/assignment?eventKey=2026test&matchNumber=2')).status,400);
    assert.equal((await sync(1,testRecord({matchNumber:2,matchKey:'qm2'}))).status,403);
    assert.equal((await sync(2,testRecord({ownerUserId:'2',matchNumber:2,matchKey:'qm2'}))).status,200);
    await app.db.query('UPDATE scouting.rotations SET rotation_count=1 WHERE user_id=1');
  });
  await t.test('stale schedules refresh through TBA using private server configuration',async()=>{
    await app.db.query("INSERT INTO shared_login.service_settings(name,value) VALUES('TBA_API_KEY','private-test-key')");
    await app.db.query("UPDATE scouting.events SET imported_at=now()-interval '10 minutes'");
    const original=globalThis.fetch,previous=process.env.TBA_API_KEY;
    delete process.env.TBA_API_KEY;
    let calls=0;
    globalThis.fetch=(input,options)=>{
      if(String(input).startsWith('https://www.thebluealliance.com/api/v3/')){
        calls++;assert.equal(options.headers['X-TBA-Auth-Key'],'private-test-key');
        return Promise.resolve(Response.json([{key:'2026test_qm1',match_number:1,comp_level:'qm',set_number:1,
          alliances:{red:{team_keys:['frc600','frc100','frc200']},blue:{team_keys:['frc300','frc400','frc500']}}}]));
      }
      return original(input,options);
    };
    try{
      const result=await app.request(1,'/scouting/api/assignment?eventKey=2026test&matchNumber=1');
      assert.equal(result.status,200);assert.equal((await result.json()).teamNumber,600);
      assert.equal(calls,1);
      const again=await app.request(1,'/scouting/api/assignment?eventKey=2026test&matchNumber=1');
      assert.equal(again.status,200);assert.equal(calls,1);
      assert.equal((await sync(1,testRecord())).status,400);
      const context=await app.request(1,'/scouting/api/context?eventKey=2026test');
      assert.ok(!(await context.text()).includes('private-test-key'));
    }finally{
      globalThis.fetch=original;
      if(previous===undefined)delete process.env.TBA_API_KEY;else process.env.TBA_API_KEY=previous;
    }
  });
});
