// Pure shared rules used by browser, API and unit tests.
export const COUNTERS = ['autoFuel','teleopFuel','autoPassed','teleopPassed','autoBumpCrossings','autoTrenchCrossings','teleopBumpCrossings','teleopTrenchCrossings'];
export const STATUSES = ['Normal','No Show','Disabled','Disconnected','Immobilized / Stuck','Tipped','Mechanical Failure','Other Failure'];
export function eventKey(value) { return String(value || '').trim().toLowerCase(); }
export function normalizeRecord(record) {
  return { ...record, eventKey: eventKey(record.eventKey) || 'legacy', matchKey: record.matchKey || `qm${record.matchNumber}`, kind: record.kind || 'quantitative', ownerUserId: record.ownerUserId == null ? null : String(record.ownerUserId) };
}
export function validateRecord(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return 'Match is required';
  const r = normalizeRecord(input);
  if (!/^(2026[a-z0-9]+|legacy)$/.test(r.eventKey)) return 'Choose a 2026 event key';
  if (typeof r.matchKey !== 'string' || !/^[a-zA-Z0-9_-]{1,100}$/.test(r.matchKey)) return 'Invalid match key';
  if (!['quantitative','qualitative'].includes(r.kind)) return 'Invalid scouting page';
  for (const key of ['recordId','deviceId']) if (typeof r[key] !== 'string' || !r[key] || r[key].length > 200) return `${key==='recordId'?'Match ID':'Device ID'} is required`;
  for (const key of ['matchNumber','teamNumber','revision']) if (!Number.isInteger(r[key]) || r[key] < 1 || r[key] > 2147483647) return `${key} must be a positive integer`;
  if (typeof r.completed !== 'boolean') return 'completed must be a boolean';
  if (r.schemaVersion >= 4 && !['red','blue'].includes(r.alliance)) return 'Choose a red or blue alliance';
  if (r.kind === 'quantitative') {
    for (const key of COUNTERS) {
      if (r[key] != null && (!Number.isInteger(r[key]) || r[key] < 0 || r[key] > 100000)) return `${key} must be a nonnegative integer`;
      if (r.schemaVersion >= 4 && r[key] == null) return `${key} is required`;
    }
    if (!STATUSES.includes(r.robotStatus)) return 'Choose a robot status';
    if (r.robotStatus === 'Normal' && r.robotStatusPeriod) return 'Normal robots do not need a failure period';
  }
  if ((r.notes != null && typeof r.notes !== 'string') || (r.notes || '').length > 8000 || !Array.isArray(r.tags || []) || (r.tags || []).some(t => typeof t !== 'string' || t.length > 40) || (r.tags || []).length > 20) return 'Keep notes under 8000 characters and use up to 20 short tags';
  return null;
}
export function canonicalRecord(record) {
  const copy = normalizeRecord(structuredClone(record));
  for (const key of ['syncStatus','lastSyncError','conflictServerRecord','serverReceivedAt']) delete copy[key];
  return copy;
}
export function sameMatch(a,b) { return normalizeRecord(a).eventKey === normalizeRecord(b).eventKey && normalizeRecord(a).matchKey === normalizeRecord(b).matchKey && Number(a.teamNumber) === Number(b.teamNumber) && (a.kind || 'quantitative') === (b.kind || 'quantitative'); }
export const manualScoutingAllowed = permissions => permissions.some(permission => permission !== 'scouting:read');
export function resolveScoutAssignment(matches, rotation, matchNumber) {
  if (!rotation) return { error: 'Your account has no scout station for this event. Ask an administrator to assign Red or Blue scout 1, 2 or 3.' };
  if (!Number.isInteger(matchNumber) || matchNumber < 1) return { error: 'Enter a positive qualification match number.' };
  const match = matches.find(m => m.comp_level === 'qm' && m.match_number === matchNumber && m.match_key === `qm${matchNumber}`);
  if (!match) return { error: 'This qualification match is not in the TBA schedule yet. Ask an administrator to refresh the event.' };
  if ((matchNumber - 1) % rotation.rotation_count !== rotation.rotation - 1) return { error: 'This match belongs to a different rotation group.' };
  const teamNumber = match[rotation.alliance]?.[rotation.station - 1];
  if (!Number.isInteger(teamNumber) || teamNumber < 1) return { error: 'The TBA schedule has no robot for your assigned station.' };
  return { eventKey: match.event_key, matchKey: match.match_key, matchNumber, teamNumber, alliance: rotation.alliance, station: rotation.station };
}
export function assignedRecordError(record, matches, rotation) {
  const assigned = resolveScoutAssignment(matches, rotation, record.matchNumber);
  if (assigned.error) return assigned.error;
  if (record.matchKey !== assigned.matchKey || record.teamNumber !== assigned.teamNumber || record.alliance !== assigned.alliance) return 'Scout the robot at your assigned alliance station for this qualification match.';
  return null;
}
export function assignments(matches, rotations, userId) {
  const rotation = rotations.find(r => String(r.user_id) === String(userId));
  if (!rotation) return [];
  return matches.filter(m => m.comp_level === 'qm' && (m.match_number - 1) % rotation.rotation_count === rotation.rotation - 1)
    .map(m => ({ ...m, alliance: rotation.alliance, station: rotation.station, teamNumber: m[rotation.alliance][rotation.station - 1] })).filter(m => m.teamNumber);
}
const number = value => value == null || !Number.isFinite(Number(value)) ? null : Number(value);
const sumFields = (r, fields) => fields.every(f => number(r[f]) !== null) ? fields.reduce((sum,f) => sum + Number(r[f]), 0) : null;
const crossingFields = ['autoBumpCrossings','autoTrenchCrossings','teleopBumpCrossings','teleopTrenchCrossings'];
export function estimatedCycles(record) {
  const crossings = sumFields(record, crossingFields);
  return crossings === null ? null : Math.trunc(0.9 * crossings);
}
export const METRICS = {
  autoFuel: { label:'Autonomous fuel', value:r => number(r.autoFuel) },
  teleopFuel: { label:'Teleop fuel (includes endgame)', value:r => number(r.teleopFuel) },
  totalFuel: { label:'Total active-hub fuel', value:r => sumFields(r,['autoFuel','teleopFuel']) },
  autoPassed: { label:'Fuel passed in autonomous', value:r => number(r.autoPassed) },
  teleopPassed: { label:'Fuel passed in teleop', value:r => number(r.teleopPassed) },
  totalPassed: { label:'Total fuel passed', value:r => sumFields(r,['autoPassed','teleopPassed']) },
  cycles: { label:'Estimated cycles', value:estimatedCycles },
  fuelPerCycle: { label:'Estimated fuel per cycle', value:r => { const cycles=estimatedCycles(r),fuel=sumFields(r,['autoFuel','teleopFuel']); return cycles>0&&fuel!==null ? fuel/cycles : null; } },
  autoPoints: { label:'Estimated autonomous fuel points', value:r => number(r.autoFuel) },
  teleopPoints: { label:'Estimated teleop fuel points', value:r => number(r.teleopFuel) },
  estimatedPoints: { label:'Estimated fuel points', value:r => sumFields(r,['autoFuel','teleopFuel']) },
  reliability: { label:'Reliability (%)', value:r => STATUSES.includes(r.robotStatus)?(r.robotStatus==='Normal'?100:0):null },
  bumpCrossings: { label:'Bump crossings', value:r => sumFields(r,['autoBumpCrossings','teleopBumpCrossings']) },
  trenchCrossings: { label:'Trench crossings', value:r => sumFields(r,['autoTrenchCrossings','teleopTrenchCrossings']) },
  crossings: { label:'Bump + trench crossings', value:r => sumFields(r,crossingFields) }
};
export function quantile(sorted, q) { if (!sorted.length) return null; const position=(sorted.length-1)*q,low=Math.floor(position); return sorted[low]+(sorted[Math.ceil(position)]-sorted[low])*(position-low); }
export function statistics(values, { trim=0 }={}) {
  const sorted=values.filter(v=>v!==null&&Number.isFinite(v)).sort((a,b)=>a-b);
  const count=Math.min(Math.max(0,Math.floor(trim)),Math.max(0,Math.floor((sorted.length-1)/2)));
  const kept=sorted.slice(count,sorted.length-count);
  if (!kept.length) return { count:0,removed:0,mean:null,median:null,min:null,max:null,q1:null,q3:null,low:null,high:null,outliers:[] };
  const q1=quantile(kept,.25),q3=quantile(kept,.75),iqr=q3-q1,inside=kept.filter(v=>v>=q1-1.5*iqr&&v<=q3+1.5*iqr);
  return { count:kept.length,removed:sorted.length-kept.length,mean:kept.reduce((a,b)=>a+b,0)/kept.length,median:quantile(kept,.5),min:kept[0],max:kept.at(-1),q1,q3,low:inside[0],high:inside.at(-1),outliers:kept.filter(v=>v<q1-1.5*iqr||v>q3+1.5*iqr) };
}
export function teamAnalytics(records, event, teams=[], options={}) {
  const eligible=records.map(normalizeRecord).filter(r=>r.completed&&r.kind==='quantitative'&&r.eventKey===event);
  // Multiple scouters observing one robot/match count once: latest observation wins.
  const unique=new Map();
  for (const r of eligible) { const key=`${r.teamNumber}:${r.matchKey}`; const old=unique.get(key); if(!old||String(r.serverReceivedAt||r.updatedAt||'')>String(old.serverReceivedAt||old.updatedAt||''))unique.set(key,r); }
  const grouped=new Map();
  for(const r of unique.values()){if(!grouped.has(r.teamNumber))grouped.set(r.teamNumber,[]);grouped.get(r.teamNumber).push(r);}
  return [...grouped].map(([teamNumber,matches])=>({teamNumber,name:teams.find(t=>Number(t.team_number)===teamNumber)?.name||`Team ${teamNumber}`,records:matches,
    metrics:Object.fromEntries(Object.entries(METRICS).map(([key,metric])=>{
      const config=options[key]||{}, exclusions=new Set(config.excludedByTeam?.[teamNumber]||config.excluded||[]);
      const selected=matches.filter(r=>!exclusions.has(r.matchKey));
      return [key,statistics(selected.map(metric.value),{trim:Number(config.trim)||0})];
    }))}));
}
export function percentile(values,value) {
  const eligible=values.filter(v=>v!==null&&Number.isFinite(v));
  if(!eligible.length||value===null)return null;
  if(eligible.length===1)return 100;
  const lower=eligible.filter(v=>v<value).length,equal=eligible.filter(v=>v===value).length;
  return (lower+(equal-1)/2)/(eligible.length-1)*100;
}
export function searchTeams(teams,search) {
  const queries=search.toLowerCase().split(/[,;\n]+/).map(q=>q.trim()).filter(Boolean);
  return teams.filter(t=>!queries.length||queries.some(q=>`${t.teamNumber} ${t.name}`.toLowerCase().includes(q)));
}
