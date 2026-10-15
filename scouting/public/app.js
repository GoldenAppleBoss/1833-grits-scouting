import { COUNTERS, STATUSES, STARTS, METRICS, normalizeRecord, validateRecord, sameMatch, teamAnalytics, searchTeams, percentile } from './model.js';

const $=selector=>document.querySelector(selector), $$=selector=>[...document.querySelectorAll(selector)];
const esc=value=>String(value??'').replaceAll('&','&amp;').replaceAll('<','&lt;').replaceAll('>','&gt;').replaceAll('"','&quot;').replaceAll("'",'&#39;');
const fmt=value=>value==null?'—':Number(value).toFixed(2);
const uuid=()=>crypto.randomUUID(), now=()=>new Date().toISOString();
const API='/scouting/api', SNAPSHOT='team1833-scouting-portal-session-v1';
let db,auth=null,offline=false,events=[],event='',context={teams:[],matches:[],assignments:[],completed:[]},draft=null;
let remoteRecords=[],viewVersion=0,syncing=false,saveTimer,adminData=null,allianceData=[],analysisOptions={},search='',metric='totalFuel',view='leaderboard',selectedMatch=null;
let draftRows=[];
const can=p=>Boolean(auth?.user.permissions?.[p]);
const route=()=>['quantitative','qualitative','analytics','alliances','sync','admin','profile'].includes(location.hash.slice(1))?location.hash.slice(1):'quantitative';
const allowed=r=>r==='quantitative'||r==='profile'||(r==='qualitative'?can('qualitative'):r==='alliances'?can('alliances'):can(r));
const title=r=>({quantitative:'Quantitative scouting',qualitative:'Qualitative scouting',analytics:'Event analytics',alliances:'Alliance hub',sync:'Synchronization',admin:'Scouting administration',profile:'Your account'})[r];
const teamName=n=>context.teams.find(t=>Number(t.team_number)===Number(n))?.name||`Team ${n}`;
const teamLabel=n=>`${n} · ${teamName(n)}`;
const matchLabel=r=>r.match_key||r.matchKey||`qm${r.match_number||r.matchNumber}`;

function openDb(){return new Promise((resolve,reject)=>{const request=indexedDB.open('team1833-scouting-portal-2026',1);request.onupgradeneeded=()=>{for(const [name,keyPath]of[['records','recordId'],['meta','key']])if(!request.result.objectStoreNames.contains(name))request.result.createObjectStore(name,{keyPath});};request.onsuccess=()=>resolve(request.result);request.onerror=()=>reject(request.error);});}
function store(name,mode,work){return new Promise((resolve,reject)=>{const tx=db.transaction(name,mode),req=work(tx.objectStore(name));tx.oncomplete=()=>resolve(req.result);tx.onerror=()=>reject(tx.error);tx.onabort=()=>reject(tx.error);});}
const put=r=>store('records','readwrite',s=>s.put(r)), get=id=>store('records','readonly',s=>s.get(id)), all=()=>store('records','readonly',s=>s.getAll());
const meta=(key,value)=>store('meta','readwrite',s=>s.put({key,value}));
async function readMeta(key){return(await store('meta','readonly',s=>s.get(key)))?.value;}
function toast(message){const el=document.createElement('div');el.className='toast';el.textContent=message;$('#toastHost').appendChild(el);setTimeout(()=>el.remove(),5000);}
async function api(path,{method='GET',body,allowFailure=false}={}){
  const response=await fetch(API+path,{method,credentials:'same-origin',headers:{...(body?{'content-type':'application/json'}:{}),...(!['GET','HEAD'].includes(method)&&auth?.csrfToken?{'x-csrf-token':auth.csrfToken}:{})},body:body?JSON.stringify(body):undefined});
  const data=await response.json().catch(()=>({}));
  if(!response.ok){if(!allowFailure&&response.status===401){auth=null;draft=null;localStorage.removeItem(SNAPSHOT);shell();}throw Object.assign(new Error(data.error||`Request failed (${response.status})`),{status:response.status,payload:data});}return data;
}
async function refreshAuth(){
  const previous=auth?.user.id;
  try{auth=await api('/auth/me',{allowFailure:true});offline=false;localStorage.setItem(SNAPSHOT,JSON.stringify({user:auth.user,expiresAt:auth.expiresAt}));if(previous!==auth.user.id){draft=null;remoteRecords=[];context={teams:[],matches:[],assignments:[],completed:[]};}}
  catch(error){if(error.status===401||error.status===403){auth=null;draft=null;remoteRecords=[];localStorage.removeItem(SNAPSHOT);}else{const saved=JSON.parse(localStorage.getItem(SNAPSHOT)||'null');if(saved&&new Date(saved.expiresAt)>new Date()&&!error.status){auth={...saved,csrfToken:null};offline=true;}else auth=null;}}
  shell();
}
async function refreshContext(){
  if(!auth)return;
  try{
    events=(await api('/events')).events;
    if(!event)event=await readMeta('selectedEvent')||events[0]?.event_key||'';
    if(event&&!/^(2026[a-z0-9]+|legacy)$/.test(event))event='';
    if(event){context=await api('/context?'+new URLSearchParams({eventKey:event}));await meta(`context:${auth.user.id}:${event}`,context);}
    if(event&&(can('analytics')||can('sync')))remoteRecords=(await api('/records?'+new URLSearchParams({eventKey:event}))).records;
    if(event&&can('qualitative')){const observations=(await api('/qualitative?'+new URLSearchParams({eventKey:event}))).records;remoteRecords.push(...observations.filter(r=>!remoteRecords.some(old=>old.recordId===r.recordId)));}
    if(event)await meta(`records:${auth.user.id}:${event}`,remoteRecords);
  }catch(error){const cached=event?await readMeta(`context:${auth.user.id}:${event}`):null;if(cached)context=cached;if(!error.status&&event)remoteRecords=await readMeta(`records:${auth.user.id}:${event}`)||[];if(error.status)toast(error.message);}
  analysisOptions=await readMeta(`analysis:${auth.user.id}:${event}`)||{};
  shell();
}
async function records(){const local=(await all()).map(normalizeRecord).filter(r=>r.eventKey===event&&(r.ownerUserId===auth?.user.id||can('analytics')||can('sync'))),map=new Map();for(const r of [...remoteRecords,...context.completed,...local]){const old=map.get(r.recordId);if(!old||r.revision>=old.revision)map.set(r.recordId,r);}return[...map.values()];}
function isLocked(candidate,local){return [...local,...context.completed].some(r=>r.completed&&String(r.ownerUserId)===auth.user.id&&sameMatch(r,candidate));}
async function saveDraft(){if(!draft||draft.completed)return;draft.revision++;draft.updatedAt=now();draft.syncStatus='pending';draft.lastSyncError=null;await put(draft);clearTimeout(saveTimer);saveTimer=setTimeout(()=>syncAll(),1800);shell();}
async function syncOne(record){
  if(offline||!navigator.onLine||!auth?.csrfToken)return;
  if(record.ownerUserId!==auth.user.id&&!can('sync'))return;
  try{const result=await api('/sync',{method:'POST',body:{record}});const latest=await get(record.recordId);if(latest?.revision===record.revision){const updated={...latest,syncStatus:'synced',lastSyncError:null};await put(updated);if(draft?.recordId===record.recordId)draft=updated;}return result;}
  catch(error){const latest=await get(record.recordId);if(latest?.revision!==record.revision)return;const updated={...latest,syncStatus:error.status===423?'locked':error.status===409?'conflict':'failed',lastSyncError:error.message,conflictServerRecord:error.payload?.serverRecord||null};await put(updated);if(draft?.recordId===record.recordId)draft=updated;}
}
async function syncAll(){
  if(syncing||!auth||offline||!navigator.onLine)return;syncing=true;
  try{for(const r of(await all()).filter(r=>['pending','failed','local'].includes(r.syncStatus)&&(r.ownerUserId===auth.user.id||can('sync'))))await syncOne(r);}
  finally{syncing=false;shell();}
}
function shell(){
  $('#networkBadge').textContent=offline||!navigator.onLine?'Offline · saved on device':'Online';
  $('#syncBadge').hidden=!auth;$('#syncBadge').textContent=syncing?'Syncing…':'Local autosave';
  $('#profileArea').innerHTML=auth?`<a class="account-link" href="/">${esc(auth.user.email)}</a>`:'';
  $('#mainNav').hidden=!auth;
  $('#mainNav').innerHTML=auth?['quantitative','qualitative','analytics','alliances','sync','admin'].filter(allowed).map(r=>`<a class="${route()===r?'active':''}" href="#${r}">${title(r)}</a>`).join(''):'';
  $('#deviceLabel').textContent=auth?'2026 REBUILT · Team 1833':'';
}
function eventPicker(){
  const options=[...events];if(event&&!options.some(e=>e.event_key===event))options.push({event_key:event,name:event==='legacy'?'Legacy records':event});
  return `<div class="event-bar"><label>Event<select id="eventPicker"><option value="">Choose an event</option>${options.map(e=>`<option value="${esc(e.event_key)}" ${event===e.event_key?'selected':''}>${esc(e.name)} · ${esc(e.event_key)}</option>`).join('')}</select></label><p>${offline?'Cached schedule. Reconnect to refresh assignments.':'All analytics, matches and alliances are scoped to this event.'}</p></div>`;
}
function options(values,current){return values.map(v=>`<option value="${esc(v)}" ${v===current?'selected':''}>${esc(v)}</option>`).join('');}
function heading(name,description){return`<div class="page-heading"><div><h1>${name}</h1><p>${description}</p></div></div>`;}
function field(label,name,value,type='text',extra=''){return`<label class="field">${label}<input name="${name}" type="${type}" value="${esc(value)}" ${extra}></label>`;}
function matchStart(kind){
  return`<section class="card"><h2>Start ${kind==='qualitative'?'a qualitative observation':'a match'}</h2><form id="startForm" class="grid grid-2">${field('Event key','eventKey',event,'text','required pattern="2026[a-z0-9]+" placeholder="2026tnkn"')}${field('Match number','matchNumber','','number','min="1" max="2147483647" required')}${field('Match key (optional for qualifications)','matchKey','','text','placeholder="qm1, sf1m1, f1m1"')}${field('Team number','teamNumber','','number','min="1" required list="teamNumbers"')}
    <datalist id="teamNumbers">${context.teams.map(t=>`<option value="${t.team_number}">${esc(t.name)}</option>`).join('')}</datalist>
    <label class="field">Alliance<select name="alliance" required><option value="">Choose red or blue</option>${options(['red','blue'],'')}</select></label>
    ${kind==='quantitative'?`<label class="field">Starting location (facing the field)<select name="startingLocation" required><option value="">Choose a position</option>${options(STARTS,'')}</select></label>`:''}
    <button class="button button-primary" type="submit">Start Match</button></form></section>`;
}
async function renderScouting(kind){
  const local=(await all()).map(normalizeRecord),own=[...new Map([...context.completed,...local].map(r=>[r.recordId,r])).values()].filter(r=>r.ownerUserId===auth.user.id&&r.eventKey===event&&r.kind===kind);
  if(draft&&draft.kind!==kind)draft=null;
  if(!draft){
    const assigned=kind==='quantitative'?context.assignments:[];
    const cards=assigned.map(a=>{const candidate={eventKey:event,matchKey:a.match_key,teamNumber:a.teamNumber,kind},locked=isLocked(candidate,local);return`<button class="assignment ${a.alliance} ${locked?'locked':''}" data-assigned="${esc(a.match_key)}" ${locked?'disabled aria-disabled="true"':''}><span class="assignment-status">${locked?'Submitted · locked':a.alliance.toUpperCase()+' '+a.station}</span><strong>${esc(a.match_key.toUpperCase())}</strong><span>${esc(teamLabel(a.teamNumber))}</span><small>${a.scheduled_time?new Date(Number(a.scheduled_time)*1000).toLocaleTimeString([], {hour:'numeric',minute:'2-digit'}):'Time pending'}</small></button>`;}).join('');
    const observations=kind==='qualitative'?(await records()).filter(r=>r.completed&&(r.kind==='qualitative'||r.notes||(r.tags||[]).length)):[];
    return heading(title(kind),kind==='quantitative'?'Your assigned matches and fast counts, with automatic local saving.':'Record observations, tags, defense, and strategy separately from quantitative counts.')+
      (observations.length?`<section class="card"><h2>Event observations</h2>${observations.map(r=>`<details><summary>${esc(teamLabel(r.teamNumber))} · ${esc(r.matchKey)}${r.kind!=='qualitative'?' · legacy notes':''}</summary><p>${(r.tags||[]).map(esc).join(' · ')}</p><p class="preserve-lines">${esc(r.notes)}</p></details>`).join('')}</section>`:'')+
      (cards?`<section class="card"><h2>Your scouting rotation</h2><p>Alliance color and robot are assigned by your administrator. Submitted matches are disabled.</p><div class="assignments">${cards}</div></section>`:'')+
      (kind==='qualitative'||!context.rotation?matchStart(kind):`<details class="card"><summary>Manual playoff or unscheduled match</summary>${matchStart(kind)}</details>`)+
      `<section class="card"><h2>Your event records</h2>${own.length?`<div class="table-wrap"><table><thead><tr><th>Match</th><th>Team</th><th>Status</th><th></th></tr></thead><tbody>${own.map(r=>`<tr><td>${esc(r.matchKey)}</td><td>${esc(teamLabel(r.teamNumber))}</td><td>${esc(r.syncStatus||'local')}${r.lastSyncError?`<small class="error-text">${esc(r.lastSyncError)}</small>`:''}</td><td>${!r.completed&&r.syncStatus!=='locked'?`<button class="mini-button" data-resume="${esc(r.recordId)}">Resume</button>`:'Submitted · locked'}</td></tr>`).join('')}</tbody></table></div>`:'<p>No records at this event yet.</p>'}</section>`;
  }
  if(draft.syncStatus==='locked')return`<section class="card"><h1>Submission locked</h1><p>${esc(draft.lastSyncError)}</p><button class="button" id="closeDraft">Back to matches</button></section>`;
  return heading(`${draft.kind==='qualitative'?'Qualitative':'Quantitative'} · ${esc(draft.matchKey.toUpperCase())}`,`${teamLabel(draft.teamNumber)} · ${draft.alliance.toUpperCase()} · ${draft.eventKey}`)+
    (draft.kind==='qualitative'?renderQualitative():renderQuantitative())+
    `<section class="card"><p>Saved locally · revision ${draft.revision} · ${esc(draft.syncStatus)}</p><div class="button-row split"><button class="button button-secondary" id="closeDraft">Save & return</button><button class="button button-primary" id="submitMatch">Submit & lock ${draft.kind==='qualitative'?'observation':'match'}</button></div></section>`;
}
function counter(label,key,description=''){
  const value=draft[key]??0;
  return`<section class="counter-card"><h3>${label}</h3>${description?`<p class="section-help">${description}</p>`:''}<div class="counter-controls"><button class="counter-button negative" data-counter="${key}" data-delta="-1" aria-label="Decrease ${label}">−</button><output id="count-${key}">${value}</output><button class="counter-button positive" data-counter="${key}" data-delta="1" aria-label="Increase ${label}">+</button></div><div class="button-row">${[-10,-5,5,10,50].map(delta=>`<button class="mini-button" data-counter="${key}" data-delta="${delta}">${delta>0?'+':''}${delta}</button>`).join('')}</div></section>`;
}
function renderQuantitative(){
  const phase=draft.phase||'auto',prefix=phase==='auto'?'auto':'teleop';
  return`<div class="phase-tabs">${['setup','auto','teleop','post'].map(p=>`<button class="phase-tab ${p===phase?'active':''}" data-phase="${p}">${({setup:'Starting position',auto:'Autonomous',teleop:'Teleop',post:'Post-match'})[p]}</button>`).join('')}</div>`+
    (phase==='setup'?`<section class="card"><h2>Starting position</h2><p>Facing the field from your driver stations.</p><div class="choice-row">${STARTS.map(s=>`<button class="select-chip ${draft.startingLocation===s?'selected':''}" data-start="${s}">${s}</button>`).join('')}</div></section>`:
    ['auto','teleop'].includes(phase)?`<div class="grid grid-2">${counter('Fuel scored in active hub',prefix+'Fuel',phase==='teleop'?'Include fuel scored during the final 30 seconds.':'Count successful scores only.')}${counter('Fuel passed',prefix+'Passed','Count fuel transferred, not scored.')}${counter('Observed cycles',prefix+'Cycles','Count completed collect-and-score or passing cycles.')}${counter('Bump crossings',prefix+'BumpCrossings')}${counter('Trench crossings',prefix+'TrenchCrossings')}${phase==='teleop'?counter('Fuel in inactive hub','teleopInactiveFuel','Tracked separately; earns zero points.'):''}</div>`+
      (phase==='auto'?`<section class="card"><label class="toggle-label"><input id="autoClimb" type="checkbox" ${draft.autoClimb?'checked':''}> Autonomous Level 1 climb achieved (15 estimated points)</label></section>`:''):
      `<section class="card"><h2>Post-match</h2><label class="field">Robot status / incapacitated?<select id="robotStatus">${options(STATUSES,draft.robotStatus)}</select></label><div id="failurePeriod" ${draft.robotStatus==='Normal'?'hidden':''}><label class="field">Approximate failure period<select id="robotStatusPeriod">${options(['','Autonomous','Teleop','Endgame'],draft.robotStatusPeriod||'')}</select></label></div><label class="field">Endgame tower level<select id="endgameLevel">${[0,1,2,3].map(n=>`<option value="${n}" ${draft.endgameLevel===n?'selected':''}>${n===0?'No climb':`Level ${n} · ${n*10} points`}</option>`).join('')}</select></label></section>${counter('Active-hub fuel in final 30 seconds','endgameFuel','Subset of teleop fuel. Do not count it twice.')}`)+
    `<section class="card summary"><div><small>Active-hub fuel</small><strong>${draft.autoFuel+draft.teleopFuel}</strong></div><div><small>Fuel passed</small><strong>${draft.autoPassed+draft.teleopPassed}</strong></div><div><small>Starting location</small><strong>${esc(draft.startingLocation)}</strong></div></section>`;
}
function renderQualitative(){return`<section class="card"><h2>Qualitative scouting</h2><label class="field">Tags (comma separated)<input id="qualTags" maxlength="820" value="${esc((draft.tags||[]).join(', '))}" placeholder="Strong defense, consistent passer"></label><label class="field">Defense, teamwork, strategy and other observations<textarea id="qualNotes" maxlength="8000" rows="8" placeholder="Describe what you observed and what would help alliance partners.">${esc(draft.notes||'')}</textarea></label><p>These observations do not change quantitative counts or calculated metrics.</p></section>`;}
async function analyticsTeams(){return teamAnalytics(await records(),event,context.teams,analysisOptions);}
function percentileCell(teams,t,key){const value=t.metrics[key]?.mean,p=percentile(teams.map(x=>x.metrics[key]?.mean??null),value);return`<td class="rank-${p===null?'none':p>=67?'green':p>=33?'yellow':'red'}" title="${p==null?'No observations':fmt(p)+' percentile within this event'}">${fmt(value)}</td>`;}
function dataControls(teams){
  const opts=analysisOptions[metric]||{};
  return`<section class="card"><h2>Sample controls · ${esc(METRICS[metric].label)}</h2><p>Choose matches for this metric only. Trimming removes this many values from each tail per team, always keeping at least one. Raw records remain unchanged.</p><label class="field">Remove values from each tail<input id="trimCount" type="number" min="0" max="100" value="${Number(opts.trim)||0}"></label><details><summary>Include / exclude individual matches</summary><div class="sample-grid">${teams.map(t=>`<fieldset><legend>${esc(teamLabel(t.teamNumber))}</legend>${t.records.map(r=>`<label><input type="checkbox" data-sample="${esc(r.matchKey)}" data-sample-team="${t.teamNumber}" ${!(opts.excludedByTeam?.[t.teamNumber]||[]).includes(r.matchKey)?'checked':''}> ${esc(r.matchKey)} · ${fmt(METRICS[metric].value(r))}</label>`).join('')}</fieldset>`).join('')}</div></details></section>`;
}
function chart(teams){
  if(!teams.length)return'<p>No matching teams have observations.</p>';
  const width=900,row=68,height=teams.length*row+50;
  if(view==='bar'){
    const maximum=Math.max(1,...teams.map(t=>['autoPoints','teleopPoints','endgamePoints'].reduce((sum,k)=>sum+(t.metrics[k].mean||0),0)));
    return`<p class="legend"><span class="auto-key">Autonomous</span><span class="teleop-key">Teleop before endgame</span><span class="endgame-key">Endgame</span></p><p>Estimated points from observed active-hub fuel and achieved tower levels. Endgame fuel is excluded from the middle section.</p><svg class="chart" viewBox="0 0 ${width} ${height}" role="img" aria-label="Stacked autonomous, teleop and endgame estimated points">${teams.map((t,i)=>{let x=220;const bars=['autoPoints','teleopPoints','endgamePoints'].map((k,j)=>{const value=t.metrics[k].mean,w=(value||0)/maximum*600,rect=`<rect x="${x}" y="${i*row+15}" width="${w}" height="28" fill="${['#087e8b','#f2b450','#6656ad'][j]}"><title>${esc(t.name)}: ${esc(METRICS[k].label)} ${fmt(value)}</title></rect>`;x+=w;return rect;}).join('');return`<text x="8" y="${i*row+34}">${esc(t.teamNumber+' '+t.name.slice(0,22))}</text>${bars}<text x="220" y="${i*row+60}">${['autoPoints','teleopPoints','endgamePoints'].map(k=>fmt(t.metrics[k].mean)).join(' / ')}</text>`;}).join('')}</svg>`;
  }
  const max=Math.max(1,...teams.map(t=>t.metrics[metric].max||0)),scale=n=>220+n/max*600;
  if(view==='box')return`<p>Box: 25th–75th percentile; center: median; whiskers: values within 1.5×IQR; dots: outliers.</p><svg class="chart" viewBox="0 0 ${width} ${height}" role="img" aria-label="Box and whisker plot">${teams.map((t,i)=>{const s=t.metrics[metric],y=i*row+30;if(!s.count)return`<text x="8" y="${y}">${t.teamNumber}: no data</text>`;return`<text x="8" y="${y+5}">${esc(t.teamNumber+' '+t.name.slice(0,22))}</text><line x1="${scale(s.low)}" x2="${scale(s.high)}" y1="${y}" y2="${y}" stroke="#536b73"/><line x1="${scale(s.low)}" x2="${scale(s.low)}" y1="${y-8}" y2="${y+8}" stroke="#536b73"/><line x1="${scale(s.high)}" x2="${scale(s.high)}" y1="${y-8}" y2="${y+8}" stroke="#536b73"/><rect x="${scale(s.q1)}" y="${y-12}" width="${Math.max(2,scale(s.q3)-scale(s.q1))}" height="24" fill="#b9dfe1" stroke="#087e8b"/><line x1="${scale(s.median)}" x2="${scale(s.median)}" y1="${y-12}" y2="${y+12}" stroke="#14353e" stroke-width="3"/>${s.outliers.map(v=>`<circle cx="${scale(v)}" cy="${y}" r="4" fill="#bd5347"/>`).join('')}<text x="220" y="${y+31}">Median ${fmt(s.median)} · Q1 ${fmt(s.q1)} · Q3 ${fmt(s.q3)} · n=${s.count}</text>`;}).join('')}</svg>`;
  return`<svg class="chart" viewBox="0 0 ${width} ${height}" role="img" aria-label="Metric comparison bar graph">${teams.map((t,i)=>`<text x="8" y="${i*row+34}">${esc(t.teamNumber+' '+t.name.slice(0,22))}</text><rect x="220" y="${i*row+15}" width="${(t.metrics[metric].mean||0)/max*600}" height="28" fill="#087e8b"/><text x="220" y="${i*row+60}">Mean ${fmt(t.metrics[metric].mean)} · median ${fmt(t.metrics[metric].median)}</text>`).join('')}</svg>`;
}
async function renderAnalytics(){
  const teams=await analyticsTeams(),filtered=searchTeams(teams,search).sort((a,b)=>(b.metrics[metric].mean??-Infinity)-(a.metrics[metric].mean??-Infinity));
  const keys=['autoFuel','teleopFuel','totalFuel','totalPassed','cycles','reliability'];
  const table=`<div class="table-wrap"><table><thead><tr><th>Team</th><th>Matches</th>${keys.map(k=>`<th><button class="table-sort" data-metric="${k}">${esc(METRICS[k].label)}</button></th>`).join('')}<th>Selected metric median</th></tr></thead><tbody>${filtered.map(t=>`<tr><td><button class="team-link" data-team-focus="${t.teamNumber}">${esc(teamLabel(t.teamNumber))}</button></td><td>${t.records.length}</td>${keys.map(k=>percentileCell(teams,t,k)).join('')}<td>${fmt(t.metrics[metric].median)}</td></tr>`).join('')}</tbody></table></div>`;
  const common=context.matches.filter(m=>{const selected=filtered.map(t=>t.teamNumber);return selected.length>=2&&selected.filter(t=>[...m.red,...m.blue].includes(t)).length>=2;});
  const matchDetail=selectedMatch?context.matches.find(m=>m.match_key===selectedMatch):null;
  const matchTeams=selectedMatch?teamAnalytics((await records()).filter(r=>r.matchKey===selectedMatch),event,context.teams):[];
  return heading('Event analytics','Compare teams by number or name. Comma-separate searches, for example “1833, Robonauts”.')+
    `<section class="card"><div class="grid grid-2">${field('Teams or names','analyticsSearch',search,'search','id="analyticsSearch" placeholder="1833, 1002, Team BEAN"')}<label class="field">Metric<select id="metricPicker">${Object.entries(METRICS).map(([k,m])=>`<option value="${k}" ${k===metric?'selected':''}>${esc(m.label)}</option>`).join('')}</select></label></div><div class="button-row">${[['leaderboard','Leaderboard'],['comparison','Metric bars'],['bar','Auto / teleop / endgame'],['box','Box & whisker']].map(([v,label])=>`<button class="button ${view===v?'button-primary':'button-secondary'}" data-view="${v}">${label}</button>`).join('')}</div><p>All numbers use two decimal places. Colors indicate event percentile: green ≥67, yellow ≥33, red &lt;33. Reliability is normal robot observations / total observed matches.</p></section>`+
    dataControls(filtered)+`<section class="card"><h2>${view==='leaderboard'?'Event leaderboard':esc(METRICS[metric].label)}</h2>${view==='leaderboard'?table:chart(filtered)}</section>`+
    (search&&filtered.length>=2?`<section class="card"><h2>Matches involving selected teams</h2>${common.length?common.map(m=>`<button class="mini-button" data-match="${esc(m.match_key)}">${esc(m.match_key.toUpperCase())} · ${[...m.red,...m.blue].filter(n=>filtered.some(t=>t.teamNumber===n)).join(', ')}</button>`).join(''):'<p>No shared scheduled matches for these teams.</p>'}</section>`:'')+
    (matchDetail?`<section class="card"><h2>${esc(matchDetail.match_key.toUpperCase())} · Match analytics</h2><p class="red-text">Red: ${matchDetail.red.map(teamLabel).map(esc).join(' / ')}</p><p class="blue-text">Blue: ${matchDetail.blue.map(teamLabel).map(esc).join(' / ')}</p><div class="button-row">${['leaderboard','comparison','bar','box'].map(v=>`<button class="mini-button" data-match-view="${v}">Compare these six · ${v}</button>`).join('')}</div>${chart(matchTeams)}</section>`:'')+
    `<section class="card"><h2>Individual teams and matches</h2>${filtered.map(t=>`<details class="team-details"><summary><strong>${esc(teamLabel(t.teamNumber))}</strong><span>${t.records.length} observed matches · ${fmt(t.metrics.totalFuel.mean)} mean fuel · ${fmt(t.metrics.reliability.mean)}% working</span></summary>${t.records.sort((a,b)=>a.matchNumber-b.matchNumber).map(r=>`<details class="match-details"><summary>${esc(r.matchKey.toUpperCase())} · ${esc(r.alliance||'Unknown alliance')} · ${esc(r.robotStatus)}</summary><div class="metric-grid">${Object.entries(METRICS).map(([k,m])=>`<div><small>${esc(m.label)}</small><strong>${fmt(m.value(r))}</strong></div>`).join('')}</div><div class="button-row"><button class="mini-button" data-match="${esc(r.matchKey)}">Open match analytics</button>${['leaderboard','comparison','bar','box'].map(v=>`<button class="mini-button" data-team-view="${t.teamNumber}:${v}">${v}</button>`).join('')}</div></details>`).join('')}</details>`).join('')||'<p>No completed quantitative observations for this event.</p>'}</section>`;
}
async function renderAlliances(){
  const teams=can('analytics')?await analyticsTeams():[];
  if(!offline&&event){try{allianceData=(await api('/alliances?'+new URLSearchParams({eventKey:event}))).alliances;await meta(`alliances:${event}`,allianceData);}catch(error){toast(error.message);}}else allianceData=await readMeta(`alliances:${event}`)||[];
  return heading('Alliance hub','Build three-team scenarios, compare roles, and share strategy within the event.')+
    `<section class="card"><h2>New alliance plan</h2><form id="allianceForm" class="grid grid-2">${field('Plan name','name','','text','required maxlength="100"')}${[1,2,3].map(n=>`<label class="field">Team ${n}${n===1?' (required)':''}<select name="team${n}" ${n===1?'required':''}><option value="">Select a team</option>${context.teams.map(t=>`<option value="${t.team_number}">${esc(teamLabel(t.team_number))}</option>`).join('')}</select></label>`).join('')}<label class="field wide">Strategy<textarea name="strategy" maxlength="8000" rows="4" placeholder="Scorer, passer, defense, autonomous paths and climb plan"></textarea></label><button class="button button-primary" ${offline||!event?'disabled':''}>Save alliance plan</button></form></section>`+
    allianceData.map(a=>{const members=teams.filter(t=>a.teams.includes(t.teamNumber));const estimated=members.length===a.teams.length&&members.every(t=>t.metrics.estimatedPoints.mean!==null)?members.reduce((sum,t)=>sum+t.metrics.estimatedPoints.mean,0):null;return`<section class="card"><h2>${esc(a.name)}</h2><p>${a.teams.map(teamLabel).map(esc).join(' / ')}</p><p class="preserve-lines">${esc(a.strategy)}</p>${can('analytics')?`<p>Estimated combined points: <strong>${fmt(estimated)}</strong> · individual means, without interaction or opponent modeling.</p><div class="button-row"><button class="button button-secondary" data-alliance-compare="${a.teams.join(',')}">Compare these teams</button></div>`:''}${a.created_by===auth.user.id||can('admin')?`<button class="mini-button danger" data-delete-alliance="${a.id}">Remove plan</button>`:''}</section>`;}).join('');
}
async function renderAdmin(){
  if(!offline){try{adminData={users:(await api('/admin/users')).users,rotations:event?(await api('/admin/rotations?'+new URLSearchParams({eventKey:event}))).rotations:[]};}catch(error){return`<section class="card">${esc(error.message)}</section>`;}}
  if(!adminData)return'<section class="card">Reconnect to manage events and rotations.</section>';
  draftRows=adminData.rotations.map(r=>({userId:String(r.user_id),rotation:r.rotation,rotationCount:r.rotation_count,alliance:r.alliance,station:r.station}));
  return heading('Scouting administration','Import a 2026 event, then assign scouters to repeating qualification-match rotations.')+
    `<section class="card"><a href="/admin">Manage user permissions</a><h2>Import / refresh TBA schedule</h2><form id="importEventForm" class="grid grid-2">${field('TBA event key','eventKey',event==='legacy'?'':event,'text','required pattern="2026[a-z0-9]+" placeholder="2026tnkn"')}${field('TBA Read API key (optional if configured on server)','apiKey','','password','autocomplete="off"')}<button class="button button-primary" ${offline?'disabled':''}>Import event, teams and matches</button></form><p>The key is used only for the import and is not saved in browser storage. Reimporting retains all scouting records.</p></section>`+
    `<section class="card"><h2>Scouting rotations · ${esc(event||'choose an imported event')}</h2><p>With 2 groups: group 1 scouts qualification matches 1, 3, 5… and group 2 scouts 2, 4, 6… . Each slot assigns red/blue and station 1–3. Playoffs can be selected manually.</p><form id="rotationsForm"><label class="field">Total rotation groups<input name="rotationCount" type="number" min="1" max="100" value="${draftRows[0]?.rotationCount||1}" required></label><div class="table-wrap"><table><thead><tr><th>Scouter</th><th>Group</th><th>Alliance</th><th>Station</th><th></th></tr></thead><tbody id="rotationRows">${draftRows.map((r,i)=>rotationRow(r,i)).join('')}</tbody></table></div><div class="button-row"><button type="button" id="addRotation" class="button button-secondary">Add scouter</button><button class="button button-primary" ${offline||!event?'disabled':''}>Save rotations</button></div><p id="coverageNotice" class="section-help"></p></form></section>`;
}
function rotationRow(r,i){return`<tr data-rotation-row="${i}"><td><select name="userId" required><option value="">Choose scouter</option>${adminData.users.map(u=>`<option value="${u.id}" ${u.id===r.userId?'selected':''}>${esc(u.email)}</option>`).join('')}</select></td><td><input name="rotation" type="number" min="1" max="100" value="${r.rotation||1}" required></td><td><select name="alliance">${options(['red','blue'],r.alliance||'red')}</select></td><td><select name="station">${[1,2,3].map(n=>`<option value="${n}" ${n===r.station?'selected':''}>${n}</option>`).join('')}</select></td><td><button type="button" class="mini-button danger" data-remove-rotation>Remove</button></td></tr>`;}
async function renderSync(){const local=(await all()).filter(r=>r.ownerUserId===auth.user.id||can('sync'));return heading('Synchronization','Pending observations stay on this device until the server acknowledges their revision.')+`<section class="card"><button class="button button-primary" id="syncNow">Retry pending records</button><div class="table-wrap"><table><thead><tr><th>Event</th><th>Match / team</th><th>Type</th><th>Status</th><th>Resolution</th></tr></thead><tbody>${local.map(r=>`<tr><td>${esc(r.eventKey)}</td><td>${esc(r.matchKey||r.matchNumber)} / ${r.teamNumber}</td><td>${esc(r.kind||'quantitative')}</td><td>${esc(r.syncStatus)}<small class="error-text">${esc(r.lastSyncError||'')}</small></td><td>${r.syncStatus==='conflict'?`<button class="mini-button" data-server-version="${esc(r.recordId)}">Keep server version</button>${!r.completed?`<button class="mini-button" data-local-version="${esc(r.recordId)}">Retry local draft as newer</button>`:''}`:''}</td></tr>`).join('')}</tbody></table></div></section>`;}
async function render(){
  const version=++viewVersion;shell();
  if(!auth){$('#mainContent').innerHTML=`<section class="card"><h1>Sign in to Team BEAN Scouting</h1><p>Use your Team 1833 account. An administrator must assign your scouting access.</p><a class="button button-primary" href="/?return_to=%2Fscouting%2F">Shared sign in</a></section>`;return;}
  const r=route();let body;
  if(!allowed(r))body='<section class="card"><h1>Access required</h1><p>Ask a website administrator to grant access to this area.</p><a href="/">Your permissions</a></section>';
  else if(['quantitative','qualitative'].includes(r))body=await renderScouting(r);
  else if(r==='analytics')body=await renderAnalytics();
  else if(r==='alliances')body=await renderAlliances();
  else if(r==='admin')body=await renderAdmin();
  else if(r==='sync')body=await renderSync();
  else body=`<section class="card"><h1>${esc(auth.user.email)}</h1><p>All accounts and permissions are managed by the shared portal.</p><a href="/">Your account</a><button id="signOut" class="button">Sign out</button></section>`;
  if(version!==viewVersion)return;$('#mainContent').innerHTML=eventPicker()+body;bind();
}
async function start(input){
  const kind=route()==='qualitative'?'qualitative':'quantitative',eventKey=String(input.eventKey||event).trim().toLowerCase(),matchNumber=Number(input.matchNumber),teamNumber=Number(input.teamNumber);
  const candidate={...input,eventKey,matchNumber,teamNumber,kind,matchKey:input.matchKey||`qm${matchNumber}`};
  const local=(await all()).map(normalizeRecord);if(isLocked(candidate,local))throw new Error('You already submitted this match/team at this event.');
  if(!offline&&navigator.onLine){const lock=await api('/scout-lock?'+new URLSearchParams({eventKey,matchKey:candidate.matchKey,teamNumber,kind}));if(lock.locked)throw new Error('This match is already submitted and locked.');}
  let device=await readMeta('deviceId');if(!device){device=uuid();await meta('deviceId',device);}
  const r={...Object.fromEntries(COUNTERS.map(k=>[k,0])),...candidate,recordId:uuid(),schemaVersion:4,ownerUserId:auth.user.id,scoutUserId:auth.user.id,scoutName:auth.user.name,deviceId:device,revision:1,completed:false,phase:'setup',autoClimb:false,endgameLevel:0,robotStatus:'Normal',robotStatusPeriod:'',tags:[],notes:'',createdAt:now(),updatedAt:now(),syncStatus:'pending'};
  if(kind==='quantitative'&&!r.startingLocation)r.startingLocation='Center';
  const validation=validateRecord(r);if(validation)throw new Error(validation);
  draft=r;
  if(event!==eventKey){context={teams:[],matches:[],assignments:[],completed:[]};remoteRecords=[];}
  event=eventKey;await meta('selectedEvent',event);await put(r);await meta(`active:${auth.user.id}:${kind}`,r.recordId);await refreshContext();await render();
}
async function selectEvent(value){event=value;draft=null;remoteRecords=[];context={teams:[],matches:[],assignments:[],completed:[]};selectedMatch=null;await meta('selectedEvent',event);await refreshContext();await render();}
async function persistAnalysis(){await meta(`analysis:${auth.user.id}:${event}`,analysisOptions);await render();}
function guard(fn){return async e=>{try{await fn(e);}catch(error){toast(error.message);}};}
function bind(){
  $('#eventPicker')?.addEventListener('change',guard(e=>selectEvent(e.target.value)));
  $('#startForm')?.addEventListener('submit',guard(async e=>{e.preventDefault();await start(Object.fromEntries(new FormData(e.currentTarget)));}));
  $$('[data-assigned]').forEach(b=>b.addEventListener('click',guard(async()=>{const a=context.assignments.find(m=>m.match_key===b.dataset.assigned);await start({eventKey:event,matchKey:a.match_key,matchNumber:a.match_number,teamNumber:a.teamNumber,alliance:a.alliance,startingLocation:'Center'});}))); 
  $$('[data-resume]').forEach(b=>b.addEventListener('click',guard(async()=>{draft=await get(b.dataset.resume);if(draft.ownerUserId!==auth.user.id||draft.completed)throw new Error('This record is locked');await render();})));
  $('#closeDraft')?.addEventListener('click',guard(async()=>{draft=null;await render();}));
  $$('[data-phase]').forEach(b=>b.addEventListener('click',guard(async()=>{draft.phase=b.dataset.phase;await saveDraft();await render();})));
  $$('[data-start]').forEach(b=>b.addEventListener('click',guard(async()=>{draft.startingLocation=b.dataset.start;await saveDraft();await render();})));
  $$('[data-counter]').forEach(b=>b.addEventListener('click',guard(async()=>{const key=b.dataset.counter;draft[key]=Math.max(0,(draft[key]||0)+Number(b.dataset.delta));if(key==='endgameFuel')draft[key]=Math.min(draft[key],draft.teleopFuel);if(key==='teleopFuel')draft.endgameFuel=Math.min(draft.endgameFuel,draft.teleopFuel);await saveDraft();await render();})));
  $('#autoClimb')?.addEventListener('change',guard(async e=>{draft.autoClimb=e.target.checked;await saveDraft();}));
  $('#robotStatus')?.addEventListener('change',guard(async e=>{draft.robotStatus=e.target.value;if(draft.robotStatus==='Normal')draft.robotStatusPeriod='';await saveDraft();$('#failurePeriod').hidden=draft.robotStatus==='Normal';}));
  $('#robotStatusPeriod')?.addEventListener('change',guard(async e=>{draft.robotStatusPeriod=e.target.value;await saveDraft();}));
  $('#endgameLevel')?.addEventListener('change',guard(async e=>{draft.endgameLevel=Number(e.target.value);await saveDraft();}));
  $('#qualTags')?.addEventListener('input',guard(async e=>{draft.tags=e.target.value.split(',').map(t=>t.trim()).filter(Boolean);await saveDraft();}));
  $('#qualNotes')?.addEventListener('input',guard(async e=>{draft.notes=e.target.value;await saveDraft();}));
  $('#submitMatch')?.addEventListener('click',guard(async()=>{const validation=validateRecord(draft);if(validation)throw new Error(validation);draft.completed=true;draft.submittedAt=now();draft.updatedAt=now();draft.revision++;draft.syncStatus='pending';await put(draft);const submitted=draft;draft=null;await meta(`active:${auth.user.id}:${submitted.kind}`,null);await syncOne(submitted);await refreshContext();toast('Observation saved. This match/team is now locked.');await render();}));
  $('#analyticsSearch')?.addEventListener('change',guard(async e=>{search=e.target.value;selectedMatch=null;await render();}));
  $('#metricPicker')?.addEventListener('change',guard(async e=>{metric=e.target.value;await render();}));
  $$('[data-metric]').forEach(b=>b.addEventListener('click',guard(async()=>{metric=b.dataset.metric;await render();})));
  $$('[data-view]').forEach(b=>b.addEventListener('click',guard(async()=>{view=b.dataset.view;await render();})));
  $('#trimCount')?.addEventListener('change',guard(async e=>{analysisOptions[metric]={...analysisOptions[metric],trim:Math.max(0,Math.min(100,Number(e.target.value)||0))};await persistAnalysis();}));
  $$('[data-sample]').forEach(b=>b.addEventListener('change',guard(async()=>{const opts=analysisOptions[metric]||{},byTeam={...opts.excludedByTeam},set=new Set(byTeam[b.dataset.sampleTeam]||[]);if(b.checked)set.delete(b.dataset.sample);else set.add(b.dataset.sample);byTeam[b.dataset.sampleTeam]=[...set];analysisOptions[metric]={...opts,excludedByTeam:byTeam};await persistAnalysis();})));
  $$('[data-team-focus]').forEach(b=>b.addEventListener('click',guard(async()=>{search=b.dataset.teamFocus;await render();})));
  $$('[data-team-view]').forEach(b=>b.addEventListener('click',guard(async()=>{[search,view]=b.dataset.teamView.split(':');await render();})));
  $$('[data-match]').forEach(b=>b.addEventListener('click',guard(async()=>{selectedMatch=b.dataset.match;await render();})));
  $$('[data-match-view]').forEach(b=>b.addEventListener('click',guard(async()=>{const m=context.matches.find(m=>m.match_key===selectedMatch);search=[...m.red,...m.blue].join(', ');view=b.dataset.matchView;await render();})));
  $('#allianceForm')?.addEventListener('submit',guard(async e=>{e.preventDefault();const form=Object.fromEntries(new FormData(e.currentTarget)),teams=[form.team1,form.team2,form.team3].filter(Boolean).map(Number);await api('/alliances',{method:'POST',body:{id:uuid(),eventKey:event,name:form.name,strategy:form.strategy,teams}});await render();}));
  $$('[data-delete-alliance]').forEach(b=>b.addEventListener('click',guard(async()=>{await api('/alliances',{method:'DELETE',body:{eventKey:event,id:b.dataset.deleteAlliance}});await render();})));
  $$('[data-alliance-compare]').forEach(b=>b.addEventListener('click',()=>{search=b.dataset.allianceCompare;view='bar';location.hash='analytics';}));
  $('#importEventForm')?.addEventListener('submit',guard(async e=>{e.preventDefault();const form=e.currentTarget,body=Object.fromEntries(new FormData(form)),button=form.querySelector('button');button.disabled=true;try{const imported=await api('/admin/import-event',{method:'POST',body});form.elements.apiKey.value='';toast(`Imported ${imported.teams} teams and ${imported.matches} matches`);await selectEvent(imported.eventKey);}finally{button.disabled=false;}}));
  $('#addRotation')?.addEventListener('click',()=>$('#rotationRows').insertAdjacentHTML('beforeend',rotationRow({},Date.now())));
  $('#rotationRows')?.addEventListener('click',e=>{if(e.target.matches('[data-remove-rotation]'))e.target.closest('tr').remove();});
  $('#rotationsForm')?.addEventListener('submit',guard(async e=>{e.preventDefault();const rotationCount=Number(e.currentTarget.elements.rotationCount.value),rotations=$$('#rotationRows tr').map(tr=>({userId:tr.querySelector('[name=userId]').value,rotation:Number(tr.querySelector('[name=rotation]').value),rotationCount,alliance:tr.querySelector('[name=alliance]').value,station:Number(tr.querySelector('[name=station]').value)}));await api('/admin/rotations',{method:'PUT',body:{eventKey:event,rotations}});toast(`Saved ${rotations.length} scouters. ${rotationCount*6-rotations.length} station/group slots are unassigned.`);await refreshContext();await render();}));
  $('#syncNow')?.addEventListener('click',guard(async()=>{await syncAll();await refreshContext();await render();}));
  $$('[data-server-version]').forEach(b=>b.addEventListener('click',guard(async()=>{const record=await get(b.dataset.serverVersion);if(record.conflictServerRecord)await put({...record.conflictServerRecord,syncStatus:'synced'});await render();})));
  $$('[data-local-version]').forEach(b=>b.addEventListener('click',guard(async()=>{const record=await get(b.dataset.localVersion);if(record.completed)throw new Error('Submitted records cannot be changed');await put({...record,revision:Math.max(record.revision,record.conflictServerRecord?.revision||0)+1,conflictServerRecord:null,syncStatus:'pending'});await syncAll();await render();})));
  $('#signOut')?.addEventListener('click',guard(async()=>{if(offline)throw new Error('Reconnect to sign out');const response=await fetch('/logout',{method:'POST',headers:{'content-type':'application/x-www-form-urlencoded'},body:new URLSearchParams({csrf_token:auth.csrfToken})});if(!response.ok)throw new Error('Could not sign out');localStorage.removeItem(SNAPSHOT);location.assign('/');}));
}
async function init(){
  db=await openDb();await refreshAuth();if(auth)await refreshContext();
  if('serviceWorker'in navigator)navigator.serviceWorker.register('/scouting/sw.js',{scope:'/scouting/'}).catch(()=>{});
  if(!location.hash)history.replaceState(null,'','#quantitative');
  if(auth){const id=await readMeta(`active:${auth.user.id}:${route()}`);if(id){const saved=await get(id);if(saved&&!saved.completed&&saved.ownerUserId===auth.user.id&&normalizeRecord(saved).eventKey===event)draft=normalizeRecord(saved);}}
  window.addEventListener('hashchange',guard(async()=>{draft=null;const id=await readMeta(`active:${auth?.user.id}:${route()}`);if(id){const saved=await get(id);if(saved&&!saved.completed&&saved.ownerUserId===auth?.user.id&&normalizeRecord(saved).eventKey===event)draft=normalizeRecord(saved);}await render();}));
  window.addEventListener('offline',()=>{offline=true;shell();});
  window.addEventListener('online',guard(async()=>{await refreshAuth();await syncAll();await refreshContext();await render();}));
  setInterval(async()=>{try{const previous=JSON.stringify(auth?.user);await refreshAuth();await syncAll();if(previous!==JSON.stringify(auth?.user))await render();}catch{/* Retry on next refresh. */}},30000);
  await render();await syncAll();
}
init().catch(error=>{$('#mainContent').textContent='Scouting could not start: '+error.message;});
