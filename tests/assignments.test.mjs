import test from 'node:test';
import assert from 'node:assert/strict';
import { resolveScoutAssignment, assignedRecordError, manualScoutingAllowed } from '../scouting/public/model.js';
import { scoutIdentity, parseTbaSchedule } from '../lib/scouting.mjs';

const matches = [1,2,3].map(n=>({event_key:'2026test',match_key:`qm${n}`,match_number:n,comp_level:'qm',red:[1833,100,200],blue:[300,400,500]}));
test('each of the six scout stations resolves the correct TBA robot',()=>{
  for(const alliance of ['red','blue'])for(const station of [1,2,3]){
    const assigned=resolveScoutAssignment(matches,{alliance,station,rotation:1,rotation_count:1},2);
    assert.equal(assigned.teamNumber,matches[1][alliance][station-1]);
    assert.equal(assigned.matchKey,'qm2');
    assert.equal(assigned.alliance,alliance);
  }
});
test('unassigned users, absent matches, invalid numbers and off-group matches are blocked',()=>{
  const rotation={alliance:'red',station:1,rotation:1,rotation_count:2};
  assert.match(resolveScoutAssignment(matches,null,1).error,/no scout station/);
  for(const n of [0,-1,1.5,NaN])assert.ok(resolveScoutAssignment(matches,rotation,n).error);
  assert.match(resolveScoutAssignment(matches,rotation,99).error,/not in the TBA schedule/);
  assert.match(resolveScoutAssignment(matches,rotation,2).error,/different rotation/);
  assert.equal(resolveScoutAssignment(matches,rotation,3).teamNumber,1833);
});
test('forged robots, alliances, playoff keys and absent schedules cannot bypass assignment rules',()=>{
  const rotation={alliance:'blue',station:2,rotation:1,rotation_count:1};
  const record={matchNumber:1,matchKey:'qm1',teamNumber:400,alliance:'blue'};
  assert.equal(assignedRecordError(record,matches,rotation),null);
  for(const edit of [{teamNumber:1833},{alliance:'red'},{matchKey:'f1m1'},{matchNumber:100}])assert.ok(assignedRecordError({...record,...edit},matches,rotation));
  assert.ok(assignedRecordError(record,[],rotation));
});
test('each permission beyond quantitative permits manual scouting without expanding management access',()=>{
  assert.equal(manualScoutingAllowed(['scouting:read']),false);
  for(const permission of ['scouting:qualitative','scouting:analytics','scouting:sync','scouting:alliances','scouting:manage','portal:admin','another:permission']){
    const identity=scoutIdentity({user:{id:'1',email:'test@example.org'},permissions:['scouting:read',permission]});
    assert.equal(identity.user.manualScouting,true);
    assert.equal(identity.user.permissions.admin,['scouting:manage','portal:admin'].includes(permission));
  }
});
test('TBA alliance station order is retained during schedule import',()=>{
  const data=parseTbaSchedule('2026test',{key:'2026test',year:2026,name:'Test'},[],[{key:'2026test_qm1',match_number:1,comp_level:'qm',set_number:1,alliances:{red:{team_keys:['frc1833','frc100','frc200']},blue:{team_keys:['frc300','frc400','frc500']}}}]);
  assert.deepEqual(data.matches[0].red,[1833,100,200]);
  assert.deepEqual(data.matches[0].blue,[300,400,500]);
});
