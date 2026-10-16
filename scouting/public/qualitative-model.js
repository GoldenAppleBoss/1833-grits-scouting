export const SKILLS={subjectiveRank:'Overall contribution',agilityRank:'Agility',fieldAwarenessRank:'Field awareness',driverAbilityRank:'Driver ability'};
export const QUAL_TAGS={Offense:['High BPS Shooter','Accurate Scorer','Fast Cycling','High Capacity','Inaccurate Scorer','Slow Cycling'],Defense:['Aggressive Defender','Shutdown Defense','Weak Defense'],Mobility:['Agile Maneuvering','Slow Moving','Good Driver','Poor Driver'],Reliability:['Very Reliable','Breakdown Prone','Inconsistent'],Teamwork:['Consistent Passer','Good Communication','Flexible Role']};
export const DEFENSE=['minimal','decent','impactful','shutdown'];
export function qualitativeError(r){
  for(const key of Object.keys(SKILLS))if(r[key]!=null&&![1,2,3].includes(r[key]))return `${SKILLS[key]} must be 1, 2, 3, or unobserved`;
  for(const key of ['starred','noShow','incap','playedDefense','isUpdate'])if(r[key]!=null&&typeof r[key]!=='boolean')return `${key} must be true or false`;
  if(r.defenseEffectiveness!=null&&(!r.playedDefense||!DEFENSE.includes(r.defenseEffectiveness)))return 'Choose a valid defense effectiveness after marking played defense';
  if(r.qualGroupId!=null&&(typeof r.qualGroupId!=='string'||!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(r.qualGroupId)))return 'Invalid alliance observation ID';
  return null;
}
export function allianceObservationError(records,match){
  if(!Array.isArray(records)||records.length!==3)return 'An alliance observation must contain all three robots';
  const first=records[0];
  if(!first.qualGroupId||records.some(r=>r.kind!=='qualitative'||!r.completed||r.qualGroupId!==first.qualGroupId||r.eventKey!==first.eventKey||r.matchKey!==first.matchKey||r.matchNumber!==first.matchNumber||String(r.ownerUserId)!==String(first.ownerUserId)||r.alliance!==first.alliance)||new Set(records.map(r=>r.recordId)).size!==3)return 'Use one scouter, event, match, and alliance for all three observations';
  if(!match||match.match_number!==first.matchNumber||records.some(r=>!match[first.alliance]?.includes(r.teamNumber))||new Set(records.map(r=>r.teamNumber)).size!==3)return 'The three robots must match the imported TBA alliance';
  for(const key of Object.keys(SKILLS)){
    const ranks=records.map(r=>r[key]).filter(r=>r!=null);
    if(key==='subjectiveRank'&&ranks.length!==3)return 'Rank all three robots by overall contribution before submitting';
    if(new Set(ranks).size!==ranks.length)return `Each ${SKILLS[key].toLowerCase()} rank may be used once per alliance`;
  }
  return records.map(qualitativeError).find(Boolean)||null;
}
export function assignRank(rows,teamNumber,key,rank){
  const chosen=rows.find(r=>r.teamNumber===teamNumber),old=chosen[key]??null;
  return rows.map(r=>r.teamNumber===teamNumber?{...r,[key]:old===rank?null:rank}:r[key]===rank?{...r,[key]:old}:r);
}
export function qualitativeSummary(records,notes=[],teams=[]){
  const summaries=new Map(teams.map(t=>[Number(t.team_number),{teamNumber:Number(t.team_number),name:t.name,observations:[],notes:[],tags:{},stars:0,noShows:0,incapacitated:0,defense:{},ranks:{}}]));
  const unique=new Map();
  for(const r of records.filter(r=>r.completed&&r.kind==='qualitative')){
    const key=`${r.ownerUserId}:${r.matchKey}:${r.teamNumber}`,old=unique.get(key);
    if(!old||String(r.serverReceivedAt||r.updatedAt||'')>String(old.serverReceivedAt||old.updatedAt||''))unique.set(key,r);
  }
  const get=n=>{if(!summaries.has(n))summaries.set(n,{teamNumber:n,name:`Team ${n}`,observations:[],notes:[],tags:{},stars:0,noShows:0,incapacitated:0,defense:{},ranks:{}});return summaries.get(n);};
  for(const r of unique.values()){
    const t=get(Number(r.teamNumber));t.observations.push(r);t.stars+=r.starred?1:0;t.noShows+=r.noShow?1:0;t.incapacitated+=r.incap?1:0;
    for(const tag of new Set(r.tags||[]))t.tags[tag]=(t.tags[tag]||0)+1;
    for(const key of Object.keys(SKILLS))if([1,2,3].includes(r[key]))(t.ranks[key]||=[]).push(r[key]);
    if(r.playedDefense&&DEFENSE.includes(r.defenseEffectiveness))t.defense[r.defenseEffectiveness]=(t.defense[r.defenseEffectiveness]||0)+1;
  }
  for(const n of notes){const t=get(Number(n.teamNumber));t.notes.push(n);t.stars+=n.starred?1:0;if(n.playedDefense&&DEFENSE.includes(n.defenseEffectiveness))t.defense[n.defenseEffectiveness]=(t.defense[n.defenseEffectiveness]||0)+1;}
  return [...summaries.values()].map(t=>({...t,averages:Object.fromEntries(Object.keys(SKILLS).map(k=>[k,t.ranks[k]?.length?t.ranks[k].reduce((a,b)=>a+b,0)/t.ranks[k].length:null])),defenseAverage:Object.keys(t.defense).length?Object.entries(t.defense).reduce((s,[k,n])=>s+(DEFENSE.indexOf(k)+1)*n,0)/Object.values(t.defense).reduce((a,b)=>a+b,0):null}));
}
