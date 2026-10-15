import test from 'node:test';
import assert from 'node:assert/strict';
import { COUNTERS, estimatedCycles, METRICS, teamAnalytics, validateRecord } from '../scouting/public/model.js';
import { testRecord } from './helpers/server.mjs';

const crossings=(a,b,c,d)=>({autoBumpCrossings:a,autoTrenchCrossings:b,teleopBumpCrossings:c,teleopTrenchCrossings:d});
test('cycles are truncated per match from all bump and trench crossings',()=>{
  for(const [counts,expected] of [[[0,0,0,0],0],[[1,0,0,0],0],[[1,2,3,4],9],[[2,3,3,3],9],[[4,4,3,3],12]]){
    const record={...crossings(...counts),autoCycles:999,teleopCycles:999};
    assert.equal(estimatedCycles(record),expected);
    assert.equal(METRICS.cycles.value(record),expected);
  }
  assert.equal(estimatedCycles({autoBumpCrossings:1}),null);
});
test('fuel per cycle uses the estimate and handles zero or unknown cycles',()=>{
  assert.equal(METRICS.fuelPerCycle.value({...crossings(1,2,3,4),autoFuel:9,teleopFuel:18}),3);
  assert.equal(METRICS.fuelPerCycle.value({...crossings(0,0,0,0),autoFuel:1,teleopFuel:2}),null);
  assert.equal(METRICS.fuelPerCycle.value({autoFuel:1,teleopFuel:2}),null);
});
test('team analytics averages per-match cycle estimates',()=>{
  const records=[1,2].map((count,i)=>testRecord({...crossings(count,0,0,0),completed:true,matchNumber:i+1,matchKey:`qm${i+1}`}));
  const [team]=teamAnalytics(records,'2026test');
  assert.equal(team.metrics.cycles.mean,.5);
});
test('scoring ignores all historic climbing and separate endgame data',()=>{
  const record={autoFuel:7,teleopFuel:21,autoClimb:true,endgameLevel:3,endgameFuel:15};
  assert.equal(METRICS.autoPoints.value(record),7);
  assert.equal(METRICS.teleopPoints.value(record),21);
  assert.equal(METRICS.estimatedPoints.value(record),28);
  assert.equal(METRICS.endgamePoints,undefined);
});
test('simplified records require no climbing, cycles, starting position or endgame fuel',()=>{
  const record=testRecord();
  for(const field of ['startingLocation','autoClimb','endgameLevel','autoCycles','teleopCycles','endgameFuel','teleopInactiveFuel']){
    assert.equal(record[field],undefined);
    assert.ok(!COUNTERS.includes(field));
  }
  assert.equal(validateRecord(record),null);
  assert.equal(validateRecord({...record,schemaVersion:4}),null);
  assert.match(validateRecord({...record,teleopTrenchCrossings:-1}),/nonnegative/);
});
