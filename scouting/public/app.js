import { COUNTERS, STATUSES, METRICS, normalizeRecord, validateRecord, sameMatch, teamAnalytics, searchTeams, percentile, resolveScoutAssignment, assignedRecordError } from './model.js';
import { renderBoxPlot, renderBubbleChart, renderBars } from './charts.js';
import { accountRequest, settingsMarkup, bindSettings, downloadMatches } from './settings.js';
import { oprMarkup, oprResults, rosterMarkup, rosterResults, reviewMarkup, reviewResults, entryResults } from './quality-ui.js';
import { createQualitative } from './qualitative.js';
import { createSelection } from './selection.js';

const $=selector=>document.querySelector(selector), $$=selector=>[...document.querySelectorAll(selector)];
const esc=value=>String(value??'').replaceAll('&','&amp;').replaceAll('<','&lt;').replaceAll('>','&gt;').replaceAll('"','&quot;').replaceAll("'",'&#39;');
const fmt=value=>value==null?'—':Number(value).toFixed(2);
const uuid=()=>crypto.randomUUID(), now=()=>new Date().toISOString();
const API='/scouting/api', SNAPSHOT='team1833-scouting-portal-session-v1';
let db,auth=null,offline=false,events=[],event='',context={teams:[],matches:[],assignments:[],completed:[]},draft=null;
let remoteRecords=[],viewVersion=0,syncing=false,saveTimer,adminData=null,allianceData=[],analysisOptions={},search='',metric='totalFuel',view='leaderboard',selectedMatch=null;
let draftRows=[];
let settingsAccount=null,settingsTab='account',bubbleX='totalFuel',bubbleY='reliability',bubbleSize='matches';
let qualityData={review:null,roster:null,entries:[]},ratingReport=null,oprWeight=.5,oprSort='adjusted',rosterSearch='',rosterSort='estimatedAccuracy',reviewThreshold=.85,reviewFilter='needs-review',reviewSearch='',entrySearch='';
let qualLegacy=false;
const can=p=>Boolean(auth?.user.permissions?.[p]);
const assignedOnly=()=>auth?.user.manualScouting!==true;
const route=()=>location.hash==='#profile'?'settings':['quantitative','qualitative','analytics','alliances','selection','sync','admin','settings'].includes(location.hash.slice(1))?location.hash.slice(1):'quantitative';
const allowed=r=>r==='quantitative'||r==='settings'||(r==='selection'?can('alliances')||can('analytics')||can('admin'):r==='qualitative'?can('qualitative'):r==='alliances'?can('alliances'):can(r));
const title=r=>({quantitative:'Quantitative scouting',qualitative:'Qualitative scouting',analytics:'Event analytics',alliances:'Alliance plans',selection:'Alliance selection',sync:'Synchronization',admin:'Scouting administration',profile:'Your account'})[r];
const teamName=n=>context.teams.find(t=>Number(t.team_number)===Number(n))?.name||`Team ${n}`;
const teamLabel=n=>`${n} · ${teamName(n)}`;
const matchLabel=r=>r.match_key||r.matchKey||`qm${r.match_number||r.matchNumber}`;

function openDb(){return new Promise((resolve,reject)=>{const request=indexedDB.open('team1833-scouting-portal-2026',2);request.onupgradeneeded=()=>{for(const [name,keyPath]of[['records','recordId'],['meta','key'],['qualitative','id'],['teamNotes','id']])if(!request.result.objectStoreNames.contains(name))request.result.createObjectStore(name,{keyPath});};request.onblocked=()=>reject(new Error('Close other scouting tabs, then reload to update local storage. Saved matches will be retained.'));request.onsuccess=()=>{request.result.onversionchange=()=>request.result.close();resolve(request.result);};request.onerror=()=>reject(request.error);});}
function store(name,mode,work){return new Promise((resolve,reject)=>{const tx=db.transaction(name,mode),req=work(tx.objectStore(name));tx.oncomplete=()=>resolve(req.result);tx.onerror=()=>reject(tx.error);tx.onabort=()=>reject(tx.error);});}
const put=r=>store('records','readwrite',s=>s.put(r)), get=id=>store('records','readonly',s=>s.get(id)), all=()=>store('records','readonly',s=>s.getAll());
const removeLocal=id=>store('records','readwrite',s=>s.delete(id));
const meta=(key,value)=>store('meta','readwrite',s=>s.put({key,value}));
async function readMeta(key){return(await store('meta','readonly',s=>s.get(key)))?.value;}
const workflowHooks={state:()=>({auth,event,offline,context}),api,meta,readMeta,toast,records,refresh:refreshContext,allStore:name=>store(name,'readonly',s=>s.getAll()),putStore:(name,value)=>store(name,'readwrite',s=>s.put(value)),putRecord:put,legacy:async()=>{qualLegacy=true;await render();},weight:value=>{oprWeight=value;}};
const qualitative=createQualitative(workflowHooks),selection=createSelection(workflowHooks);
function toast(message){const el=document.createElement('div');el.className='toast';el.textContent=message;$('#toastHost').appendChild(el);setTimeout(()=>el.remove(),5000);}
async function api(path,{method='GET',body,allowFailure=false}={}){
  const response=await fetch(API+path,{method,credentials:'same-origin',headers:{...(body?{'content-type':'application/json'}:{}),...(!['GET','HEAD'].includes(method)&&auth?.csrfToken?{'x-csrf-token':auth.csrfToken}:{})},body:body?JSON.stringify(body):undefined});
  const data=await response.json().catch(()=>({}));
  if(!response.ok){if(!allowFailure&&response.status===401){auth=null;draft=null;localStorage.removeItem(SNAPSHOT);shell();}throw Object.assign(new Error(data.error||`Request failed (${response.status})`),{status:response.status,payload:data});}return data;
}
async function refreshAuth(){
  const previous=auth?.user.id;
  try{auth=await api('/auth/me',{allowFailure:true});offline=false;if(!window.Team1833Appearance.hasLocal())window.Team1833Appearance.apply(auth.user.preferences);localStorage.setItem(SNAPSHOT,JSON.stringify({user:auth.user,expiresAt:auth.expiresAt}));if(previous!==auth.user.id){draft=null;settingsAccount=null;remoteRecords=[];context={teams:[],matches:[],assignments:[],completed:[]};}}
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
    for(const id of context.deletedRecordIds||[]){await removeLocal(id);if(draft?.recordId===id)draft=null;}
    if(event&&(can('analytics')||can('sync')))remoteRecords=(await api('/records?'+new URLSearchParams({eventKey:event}))).records;
    if(event&&can('qualitative')){const observations=(await api('/qualitative?'+new URLSearchParams({eventKey:event}))).records;remoteRecords.push(...observations.filter(r=>!remoteRecords.some(old=>old.recordId===r.recordId)));}
    if(event)await meta(`records:${auth.user.id}:${event}`,remoteRecords);
  }catch(error){const cached=event?await readMeta(`context:${auth.user.id}:${event}`):null;if(cached)context=cached;if(!error.status&&event)remoteRecords=await readMeta(`records:${auth.user.id}:${event}`)||[];if(error.status)toast(error.message);}
  analysisOptions=await readMeta(`analysis:${auth.user.id}:${event}`)||{};
  oprWeight=await readMeta(`oprWeight:${auth.user.id}:${event}`)??.5;
  reviewThreshold=await readMeta(`reviewThreshold:${auth.user.id}:${event}`)??.85;
  shell();
}
async function records(){const deleted=new Set(context.deletedRecordIds||[]),local=(await all()).map(normalizeRecord).filter(r=>r.eventKey===event&&(r.ownerUserId===auth?.user.id||can('analytics')||can('sync'))),map=new Map();for(const r of [...remoteRecords,...context.completed,...local]){if(deleted.has(r.recordId))continue;const old=map.get(r.recordId);if(!old||r.revision>=old.revision)map.set(r.recordId,r);}return[...map.values()];}
function isLocked(candidate,local){return [...local,...context.completed].some(r=>r.completed&&String(r.ownerUserId)===auth.user.id&&sameMatch(r,candidate));}
async function saveDraft(){if(!draft||draft.completed)return;draft.revision++;draft.updatedAt=now();draft.syncStatus='pending';draft.lastSyncError=null;await put(draft);clearTimeout(saveTimer);saveTimer=setTimeout(()=>syncAll(),1800);shell();}
async function syncOne(record){
  if(offline||!navigator.onLine||!auth?.csrfToken)return;
  if(record.ownerUserId!==auth.user.id&&!can('sync'))return;
  try{const result=await api('/sync',{method:'POST',body:{record}});const latest=await get(record.recordId);if(latest?.revision===record.revision){const updated={...latest,syncStatus:'synced',lastSyncError:null};await put(updated);if(draft?.recordId===record.recordId)draft=updated;}return result;}
  catch(error){if(error.status===410){await removeLocal(record.recordId);remoteRecords=remoteRecords.filter(r=>r.recordId!==record.recordId);context.completed=context.completed.filter(r=>r.recordId!==record.recordId);if(draft?.recordId===record.recordId)draft=null;toast(error.message);return;}const latest=await get(record.recordId);if(latest?.revision!==record.revision)return;const updated={...latest,syncStatus:error.status===423?'locked':error.status===409?'conflict':'failed',lastSyncError:error.message,conflictServerRecord:error.payload?.serverRecord||null};await put(updated);if(draft?.recordId===record.recordId)draft=updated;}
}
async function syncAll(){
  if(syncing||!auth||offline||!navigator.onLine)return;syncing=true;
  try{for(const r of(await all()).filter(r=>['pending','failed','local'].includes(r.syncStatus)&&(r.ownerUserId===auth.user.id||can('sync'))))await syncOne(r);await qualitative.syncPending();}
  finally{syncing=false;shell();}
}
function shell(){
  $('#networkBadge').textContent=offline||!navigator.onLine?'Offline · saved on device':'Online';
  $('#syncBadge').hidden=!auth;$('#syncBadge').textContent=syncing?'Syncing…':'Local autosave';
  $('#profileArea').innerHTML=auth?`<a class="settings-button ${route()==='settings'?'active':''}" href="#settings" aria-label="Settings" title="Settings"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M9.7 4.3 10.2 2h3.6l.5 2.3 1.8 1 2.2-.7 1.8 3.1-1.7 1.6v2.1l1.7 1.6-1.8 3.1-2.2-.7-1.8 1-.5 2.3h-3.6l-.5-2.3-1.8-1-2.2.7-1.8-3.1 1.7-1.6V9.3L3.9 7.7l1.8-3.1 2.2.7z" transform="translate(0 1)"/><circle cx="12" cy="11.5" r="3"/></svg></a>`:'';
  $('#mainNav').hidden=!auth;
  $('#mainNav').innerHTML=auth?['quantitative','qualitative','analytics','selection','alliances','sync','admin'].filter(allowed).map(r=>`<a class="${route()===r?'active':''}" href="#${r}">${title(r)}</a>`).join(''):'';
  $('#deviceLabel').textContent=auth?'2026 REBUILT · Team 1833':'';
}
function eventPicker(){
  const options=[...events];if(event&&!options.some(e=>e.event_key===event))options.push({event_key:event,name:event==='legacy'?'Legacy matches':event});
  return `<div class="event-bar"><label>Event<select id="eventPicker"><option value="">Choose an event</option>${options.map(e=>`<option value="${esc(e.event_key)}" ${event===e.event_key?'selected':''}>${esc(e.name)} · ${esc(e.event_key)}</option>`).join('')}</select></label><p>${offline?'Cached schedule. Reconnect to refresh assignments.':'All analytics, matches and alliances are scoped to this event.'}</p></div>`;
}
function options(values,current){return values.map(v=>`<option value="${esc(v)}" ${v===current?'selected':''}>${esc(v)}</option>`).join('');}
function heading(name,description){return`<div class="page-heading"><div><h1>${name}</h1><p>${description}</p></div></div>`;}
function field(label,name,value,type='text',extra=''){return`<label class="field">${label}<input name="${name}" type="${type}" value="${esc(value)}" ${extra}></label>`;}
function matchStart(kind){
  if(kind==='quantitative'&&assignedOnly()){
    const rotation=context.rotation;
    return `<section class="card match-launch"><span class="eyebrow">YOUR NEXT MATCH</span><h2>One match. One robot.</h2><p>${rotation?`You are <strong>${rotation.alliance==='red'?'Red':'Blue'} scout ${rotation.station}</strong>. Enter a qualification match number and we’ll find your robot from TBA.`:'Ask an administrator to assign your scout station for this event.'}</p>
      <form id="assignedStartForm"><label class="field">Qualification match number<input id="assignedMatchNumber" name="matchNumber" type="number" inputmode="numeric" min="1" max="2147483647" placeholder="e.g. 12" required ${!event||!rotation?'disabled':''} aria-describedby="assignmentPreview"></label>
      <div id="assignmentPreview" class="assignment-preview" aria-live="polite">${event?'Enter a match number to see your robot.':'Choose your event above to get started.'}</div>
      <button class="button button-primary" ${!event||!rotation?'disabled':''}>Find my robot & start</button></form></section>`;
  }
  return`<section class="card"><h2>Start ${kind==='qualitative'?'a qualitative observation':'a match'}</h2><form id="startForm" class="grid grid-2">${field('Event key','eventKey',event,'text','required pattern="2026[a-z0-9]+" placeholder="2026tnkn"')}${field('Match number','matchNumber','','number','min="1" max="2147483647" required')}${field('Match key (optional for qualifications)','matchKey','','text','placeholder="qm1, sf1m1, f1m1"')}${field('Team number','teamNumber','','number','min="1" required list="teamNumbers"')}
    <datalist id="teamNumbers">${context.teams.map(t=>`<option value="${t.team_number}">${esc(t.name)}</option>`).join('')}</datalist>
    <label class="field">Alliance<select name="alliance" required><option value="">Choose red or blue</option>${options(['red','blue'],'')}</select></label>
    <button class="button button-primary" type="submit">Start Match</button></form></section>`;
}
function robotBanner(record, preview=false){
  const station=record.station||(assignedOnly()?context.rotation?.station:null);
  return `<section class="robot-banner ${record.alliance==='red'?'red':'blue'} ${preview?'preview':''}" aria-label="Assigned robot">
    <div><span class="eyebrow">${preview?'YOUR ASSIGNED ROBOT':'YOU ARE SCOUTING'}</span><div class="robot-number"><span>TEAM</span> ${Number(record.teamNumber)}</div><p>${esc(teamName(record.teamNumber))}</p></div>
    <div class="robot-meta"><span class="station-pill">${record.alliance==='red'?'RED':'BLUE'}${station?` SCOUT ${station}`:' ALLIANCE'}</span><strong>${/^qm\d+$/.test(record.matchKey)?`QUALIFICATION ${Number(record.matchNumber)}`:esc(String(record.matchKey).toUpperCase())}</strong><span>${esc(record.eventKey||event)}</span></div></section>`;
}
async function renderScouting(kind){
  const local=(await all()).map(normalizeRecord),own=[...new Map([...context.completed,...local].map(r=>[r.recordId,r])).values()].filter(r=>r.ownerUserId===auth.user.id&&r.eventKey===event&&r.kind===kind);
  if(draft&&draft.kind!==kind)draft=null;
  if(!draft){
    const assigned=kind==='quantitative'?context.assignments:[];
    const cards=assigned.map(a=>{const candidate={eventKey:event,matchKey:a.match_key,teamNumber:a.teamNumber,kind},locked=isLocked(candidate,local);return`<button class="assignment ${a.alliance} ${locked?'locked':''}" data-assigned="${esc(a.match_key)}" ${locked?'disabled aria-disabled="true"':''}><span class="assignment-status">${locked?'Submitted · locked':a.alliance.toUpperCase()+' '+a.station}</span><strong>${esc(a.match_key.toUpperCase())}</strong><span>${esc(teamLabel(a.teamNumber))}</span><small>${a.scheduled_time?new Date(Number(a.scheduled_time)*1000).toLocaleTimeString([], {hour:'numeric',minute:'2-digit'}):'Time pending'}</small></button>`;}).join('');
    const observations=kind==='qualitative'?(await records()).filter(r=>r.completed&&(r.kind==='qualitative'||r.notes||(r.tags||[]).length)):[];
    return heading(title(kind),kind==='quantitative'?'Your assigned matches and fast counts, with automatic local saving.':'Add observations, tags, defense, and strategy separately from quantitative counts.')+
      (observations.length?`<section class="card"><h2>Event observations</h2>${observations.map(r=>`<details><summary>${esc(teamLabel(r.teamNumber))} · ${esc(r.matchKey)}${r.kind!=='qualitative'?' · legacy notes':''}</summary><p>${(r.tags||[]).map(esc).join(' · ')}</p><p class="preserve-lines">${esc(r.notes)}</p></details>`).join('')}</section>`:'')+
      (kind==='quantitative'&&assignedOnly()?matchStart(kind):'')+
      (cards?`<section class="card"><div class="section-top"><h2>Your match schedule</h2><span class="badge">${assigned.length} assigned matches</span></div><p>${context.rotation?`${context.rotation.alliance==='red'?'Red':'Blue'} scout ${context.rotation.station} · Group ${context.rotation.rotation} of ${context.rotation.rotation_count}. `:''}Submitted matches are locked.</p><div class="assignments">${cards}</div></section>`:'')+
      (kind==='quantitative'&&assignedOnly()?'':kind==='qualitative'||!context.rotation?matchStart(kind):`<details class="card"><summary>Manual playoff or unscheduled match</summary>${matchStart(kind)}</details>`)+
      `<section class="card"><h2>Your event matches</h2>${own.length?`<div class="table-wrap"><table><thead><tr><th>Match</th><th>Team</th><th>Status</th><th></th></tr></thead><tbody>${own.map(r=>`<tr><td>${esc(r.matchKey)}</td><td>${esc(teamLabel(r.teamNumber))}</td><td>${esc(r.syncStatus||'local')}${r.lastSyncError?`<small class="error-text">${esc(r.lastSyncError)}</small>`:''}</td><td>${!r.completed&&r.syncStatus!=='locked'?`<button class="mini-button" data-resume="${esc(r.recordId)}">Resume</button>`:'Submitted · locked'}</td></tr>`).join('')}</tbody></table></div>`:'<p>No matches at this event yet.</p>'}</section>`;
  }
  if(draft.syncStatus==='locked')return`<section class="card"><h1>Submission locked</h1><p>${esc(draft.lastSyncError)}</p><button class="button" id="closeDraft">Back to matches</button></section>`;
  const assignmentIssue=kind==='quantitative'&&assignedOnly()?assignedRecordError(draft,context.matches,context.rotation):null;
  if(assignmentIssue)return `<section class="card"><h1>Your assignment changed</h1><p>${esc(assignmentIssue)}</p><p>Your saved draft is still on this device. Ask an administrator to review it.</p><button class="button" id="closeDraft">Back to matches</button></section>`;
  return (draft.kind==='quantitative'?robotBanner(draft):heading(`Qualitative · ${esc(draft.matchKey.toUpperCase())}`,`${esc(teamLabel(draft.teamNumber))} · ${draft.alliance.toUpperCase()} · ${draft.eventKey}`))+
    (draft.kind==='qualitative'?renderQualitative():renderQuantitative())+
    `<section class="card"><p>Saved locally · revision ${draft.revision} · ${esc(draft.syncStatus)}</p><div class="button-row split"><button class="button button-secondary" id="closeDraft">Save & return</button><button class="button button-primary" id="submitMatch">Submit & lock ${draft.kind==='qualitative'?'observation':'match'}</button></div></section>`;
}
function counter(label,key,description=''){
  const value=draft[key]??0, crossing=/Crossings$/.test(key);
  return`<section class="counter-card ${crossing?'crossing-card':''}"><h3>${label}</h3>${description?`<p class="section-help">${description}</p>`:''}<div class="counter-controls"><button class="counter-button negative" data-counter="${key}" data-delta="-1" aria-label="Decrease ${label}">${crossing?'−1':'−'}</button><output id="count-${key}">${value}</output><button class="counter-button positive" data-counter="${key}" data-delta="1" aria-label="Increase ${label}">${crossing?'+1':'+'}</button></div>${crossing?'':`<div class="button-row">${[-10,-5,5,10,50].map(delta=>`<button class="mini-button" data-counter="${key}" data-delta="${delta}">${delta>0?'+':''}${delta}</button>`).join('')}</div>`}</section>`;
}
function renderQuantitative(){
  const phase=['auto','teleop','post'].includes(draft.phase)?draft.phase:'auto',prefix=phase==='auto'?'auto':'teleop';
  return`<div class="phase-tabs">${['auto','teleop','post'].map(p=>`<button class="phase-tab ${p===phase?'active':''}" data-phase="${p}">${({auto:'Autonomous',teleop:'Teleop',post:'Post-match'})[p]}</button>`).join('')}</div>`+
    (['auto','teleop'].includes(phase)?`<div class="grid grid-2">${counter('Fuel scored in active hub',prefix+'Fuel','Count successful scores only.')}${counter('Fuel passed',prefix+'Passed','Count fuel transferred, not scored.')}${counter('Bump crossings',prefix+'BumpCrossings')}${counter('Trench crossings',prefix+'TrenchCrossings')}</div>`:
      `<section class="card"><h2>Post-match</h2><label class="field">Robot status / incapacitated?<select id="robotStatus">${options(STATUSES,draft.robotStatus)}</select></label><div id="failurePeriod" ${draft.robotStatus==='Normal'?'hidden':''}><label class="field">Approximate failure period<select id="robotStatusPeriod">${options(['','Autonomous','Teleop','Endgame'],draft.robotStatusPeriod||'')}</select></label></div></section>`)+
    `<section class="card summary"><div><small>Active-hub fuel</small><strong>${draft.autoFuel+draft.teleopFuel}</strong></div><div><small>Fuel passed</small><strong>${draft.autoPassed+draft.teleopPassed}</strong></div><div><small>Bump + trench crossings</small><strong>${['autoBumpCrossings','autoTrenchCrossings','teleopBumpCrossings','teleopTrenchCrossings'].reduce((sum,k)=>sum+(draft[k]||0),0)}</strong></div></section>`;
}
function renderQualitative(){return`<section class="card"><h2>Qualitative scouting</h2><label class="field">Tags (comma separated)<input id="qualTags" maxlength="820" value="${esc((draft.tags||[]).join(', '))}" placeholder="Strong defense, consistent passer"></label><label class="field">Defense, teamwork, strategy and other observations<textarea id="qualNotes" maxlength="8000" rows="8" placeholder="Describe what you observed and what would help alliance partners.">${esc(draft.notes||'')}</textarea></label><p>These observations do not change quantitative counts or calculated metrics.</p></section>`;}
async function analyticsTeams(){return teamAnalytics(await records(),event,context.teams,analysisOptions);}
function percentileCell(teams,t,key){const value=t.metrics[key]?.mean,p=percentile(teams.map(x=>x.metrics[key]?.mean??null),value);return`<td class="rank-${p===null?'none':p>=67?'green':p>=33?'yellow':'red'}" title="${p==null?'No observations':fmt(p)+' percentile within this event'}">${fmt(value)}</td>`;}
function dataControls(teams){
  const opts=analysisOptions[metric]||{};
  return`<section class="card"><h2>Sample controls · ${esc(METRICS[metric].label)}</h2><p>Choose matches for this metric only. Trimming removes this many values from each tail per team, always keeping at least one. Saved matches remain unchanged.</p><label class="field">Remove values from each tail<input id="trimCount" type="number" min="0" max="100" value="${Number(opts.trim)||0}"></label><details><summary>Include / exclude individual matches</summary><div class="sample-grid">${teams.map(t=>`<fieldset><legend>${esc(teamLabel(t.teamNumber))}</legend>${t.records.map(r=>`<label><input type="checkbox" data-sample="${esc(r.matchKey)}" data-sample-team="${t.teamNumber}" ${!(opts.excludedByTeam?.[t.teamNumber]||[]).includes(r.matchKey)?'checked':''}> ${esc(r.matchKey)} · ${fmt(METRICS[metric].value(r))}</label>`).join('')}</fieldset>`).join('')}</div></details></section>`;
}
function chart(teams){
  if(view==='box')return renderBoxPlot(teams,metric);
  if(view==='bubble')return renderBubbleChart(teams,bubbleX,bubbleY,bubbleSize);
  return renderBars(teams,metric,{stacked:view==='bar'});
}
async function renderAnalytics(version){
  if(!METRICS[metric])metric='totalFuel';
  const teams=await analyticsTeams(),filtered=searchTeams(teams,search).sort((a,b)=>(b.metrics[metric].mean??-Infinity)-(a.metrics[metric].mean??-Infinity));
  const keys=['totalFuel','totalPassed','cycles','reliability'];
  const choices=[['leaderboard','Leaderboard'],['comparison','Bar chart'],['box','Box plot'],['bubble','Bubble chart'],['bar','Fuel breakdown'],['opr','Adjusted OPR']];
  if(view==='opr'){
    const selectedEvent=event,userId=auth.user.id;let report=null;
    if(selectedEvent&&!offline){try{report=await api('/ratings?'+new URLSearchParams({eventKey:selectedEvent,mode:'opr'}));await meta(`ratings:${userId}:${selectedEvent}`,report);}catch(error){report={error:error.message};}}
    else if(selectedEvent)report=await readMeta(`ratings:${userId}:${selectedEvent}`)||null;
    if(version!==viewVersion)return'';ratingReport=report;
    return heading('Event analytics','Combine scouting and official fuel contributions, then check predictions on later matches.')+`<section class="card analytics-controls"><label class="field">Find teams<input type="search" id="analyticsSearch" value="${esc(search)}" placeholder="Team number or name; commas compare teams"></label><div class="chart-tabs" aria-label="Analytics views">${choices.map(([key,label])=>`<button class="chart-tab ${view===key?'active':''}" data-view="${key}" aria-pressed="${view===key}">${label}</button>`).join('')}</div></section>`+oprMarkup(ratingReport,oprWeight,search,oprSort);
  }
  const metricOptions=selected=>Object.entries(METRICS).map(([key,item])=>`<option value="${key}" ${key===selected?'selected':''}>${esc(item.label)}</option>`).join('');
  const table=`<div class="table-wrap"><table><thead><tr><th>Team</th><th>Matches</th>${keys.map(k=>`<th><button class="table-sort" data-metric="${k}">${esc(METRICS[k].label)}</button></th>`).join('')}<th>${esc(METRICS[metric].label)} · median</th></tr></thead><tbody>${filtered.map(t=>`<tr><td><button class="team-link" data-team-focus="${t.teamNumber}">${esc(teamLabel(t.teamNumber))}</button></td><td>${t.records.length}</td>${keys.map(k=>percentileCell(teams,t,k)).join('')}<td>${fmt(t.metrics[metric].median)}</td></tr>`).join('')||'<tr><td colspan="7">No completed matches for this selection yet.</td></tr>'}</tbody></table></div>`;
  const common=context.matches.filter(m=>{const selected=filtered.map(t=>t.teamNumber);return selected.length>=2&&selected.filter(t=>[...m.red,...m.blue].includes(t)).length>=2;});
  const matchDetail=selectedMatch?context.matches.find(m=>m.match_key===selectedMatch):null;
  const matchTeams=selectedMatch?teamAnalytics((await records()).filter(r=>r.matchKey===selectedMatch),event,context.teams):[];
  return heading('Event analytics','Find a team, compare performance, or explore the spread across matches.')+
    `<div class="analytics-summary"><div><strong>${teams.length}</strong><span>teams scouted</span></div><div><strong>${new Set(teams.flatMap(t=>t.records.map(r=>r.matchKey))).size}</strong><span>matches scouted</span></div><div><strong>${filtered.length}</strong><span>teams in this view</span></div></div>`+
    `<section class="card analytics-controls"><div class="grid grid-2">${field('Find teams','analyticsSearch',search,'search','id="analyticsSearch" placeholder="Team number or name; commas compare teams"')}<label class="field">${view==='bubble'?'Sample-filter metric':'Compare by'}<select id="metricPicker">${metricOptions(metric)}</select></label></div><div class="chart-tabs" aria-label="Analytics views">${choices.map(([key,label])=>`<button class="chart-tab ${view===key?'active':''}" data-view="${key}" aria-pressed="${view===key}">${label}</button>`).join('')}</div>${view==='bubble'?`<div class="bubble-controls"><label class="field">X axis<select id="bubbleX">${metricOptions(bubbleX)}</select></label><label class="field">Y axis<select id="bubbleY">${metricOptions(bubbleY)}</select></label><label class="field">Bubble size<select id="bubbleSize"><option value="matches" ${bubbleSize==='matches'?'selected':''}>Matches scouted</option>${metricOptions(bubbleSize)}</select></label></div>`:''}</section>`+
    `<section class="card analytics-plot"><div class="section-top"><h2>${view==='leaderboard'?'Team leaderboard':view==='bubble'?`${esc(METRICS[bubbleX].label)} × ${esc(METRICS[bubbleY].label)}`:view==='bar'?'Autonomous & teleop fuel':esc(METRICS[metric].label)}</h2><span class="badge">${filtered.length} teams</span></div>${view==='leaderboard'?'<p class="section-help">Values are team averages. Select a heading to sort; select a team to focus. Green / yellow / red show performance relative to this event.</p>':''}${view==='leaderboard'?table:chart(filtered)}<div id="chartTooltip" class="chart-tooltip" role="tooltip" hidden></div></section>`+
    `<details class="card analytics-filters"><summary>Adjust match samples · ${esc(METRICS[metric].label)}</summary>${dataControls(filtered)}</details>`+
    `<details class="card analytics-explainer"><summary>How these numbers work</summary><p>Estimated cycles per match = trunc(0.9 × (bump crossings + trench crossings)). Fuel per cycle uses that estimate. Unknown values are left out instead of counted as zero.</p><p>Reliability is the percentage of observed matches with Normal robot status. Duplicate observations of one robot in one match use the latest observation.</p></details>`+
    (search&&filtered.length>=2?`<section class="card"><h2>Shared matches</h2>${common.length?common.map(m=>`<button class="mini-button" data-match="${esc(m.match_key)}">${esc(m.match_key.toUpperCase())} · ${[...m.red,...m.blue].filter(n=>filtered.some(t=>t.teamNumber===n)).join(', ')}</button>`).join(''):'<p>No shared scheduled matches for these teams.</p>'}</section>`:'')+
    (matchDetail?`<section class="card"><h2>${esc(matchDetail.match_key.toUpperCase())} · Match comparison</h2><p class="red-text">Red: ${matchDetail.red.map(teamLabel).map(esc).join(' / ')}</p><p class="blue-text">Blue: ${matchDetail.blue.map(teamLabel).map(esc).join(' / ')}</p>${view==='leaderboard'?renderBars(matchTeams,metric):chart(matchTeams)}</section>`:'')+
    `<section class="card"><h2>Team match history</h2>${filtered.map(t=>`<details class="team-details"><summary><strong>${esc(teamLabel(t.teamNumber))}</strong><span>${t.records.length} matches · ${fmt(t.metrics.totalFuel.mean)} mean fuel · ${fmt(t.metrics.reliability.mean)}% reliability</span></summary>${t.records.sort((a,b)=>a.matchNumber-b.matchNumber).map(r=>`<details class="match-details"><summary>${esc(r.matchKey.toUpperCase())} · ${esc(r.robotStatus)}</summary><div class="metric-grid">${Object.entries(METRICS).map(([k,m])=>`<div><small>${esc(m.label)}</small><strong>${fmt(m.value(r))}</strong></div>`).join('')}</div><button class="mini-button" data-match="${esc(r.matchKey)}">Compare this match</button></details>`).join('')}</details>`).join('')||'<p>No completed matches for this event yet.</p>'}</section>`;
}

async function renderAlliances(){
  const teams=can('analytics')?await analyticsTeams():[];
  if(!offline&&event){try{allianceData=(await api('/alliances?'+new URLSearchParams({eventKey:event}))).alliances;await meta(`alliances:${event}`,allianceData);}catch(error){toast(error.message);}}else allianceData=await readMeta(`alliances:${event}`)||[];
  return heading('Alliance hub','Build three-team scenarios, compare roles, and share strategy within the event.')+
    `<section class="card"><h2>New alliance plan</h2><form id="allianceForm" class="grid grid-2">${field('Plan name','name','','text','required maxlength="100"')}${[1,2,3].map(n=>`<label class="field">Team ${n}${n===1?' (required)':''}<select name="team${n}" ${n===1?'required':''}><option value="">Select a team</option>${context.teams.map(t=>`<option value="${t.team_number}">${esc(teamLabel(t.team_number))}</option>`).join('')}</select></label>`).join('')}<label class="field wide">Strategy<textarea name="strategy" maxlength="8000" rows="4" placeholder="Scorer, passer, defense and autonomous paths"></textarea></label><button class="button button-primary" ${offline||!event?'disabled':''}>Save alliance plan</button></form></section>`+
    allianceData.map(a=>{const members=teams.filter(t=>a.teams.includes(t.teamNumber));const estimated=members.length===a.teams.length&&members.every(t=>t.metrics.estimatedPoints.mean!==null)?members.reduce((sum,t)=>sum+t.metrics.estimatedPoints.mean,0):null;return`<section class="card"><h2>${esc(a.name)}</h2><p>${a.teams.map(teamLabel).map(esc).join(' / ')}</p><p class="preserve-lines">${esc(a.strategy)}</p>${can('analytics')?`<p>Estimated combined points: <strong>${fmt(estimated)}</strong> · individual means, without interaction or opponent modeling.</p><div class="button-row"><button class="button button-secondary" data-alliance-compare="${a.teams.join(',')}">Compare these teams</button></div>`:''}${a.created_by===auth.user.id||can('admin')?`<button class="mini-button danger" data-delete-alliance="${a.id}">Remove plan</button>`:''}</section>`;}).join('');
}
async function renderAdmin(version){
  const selectedEvent=event,userId=auth.user.id;
  if(!offline){try{adminData={users:(await api('/admin/users')).users,rotations:selectedEvent?(await api('/admin/rotations?'+new URLSearchParams({eventKey:selectedEvent}))).rotations:[]};}catch(error){return`<section class="card">${esc(error.message)}</section>`;}}
  if(version!==viewVersion)return'';
  if(!adminData)return'<section class="card">Reconnect to manage events and rotations.</section>';
  draftRows=adminData.rotations.map(r=>({userId:String(r.user_id),rotation:r.rotation,rotationCount:r.rotation_count,alliance:r.alliance,station:r.station}));
  let data={review:null,roster:null,entries:[]};
  if(selectedEvent&&!offline){
    const query=new URLSearchParams({eventKey:selectedEvent});
    const results=await Promise.allSettled([api('/admin/match-review?'+query),api('/ratings?'+query+'&mode=roster'),api('/admin/match-entries?'+query)]);
    data={review:results[0].status==='fulfilled'?results[0].value:{error:results[0].reason.message},roster:results[1].status==='fulfilled'?results[1].value:{error:results[1].reason.message},entries:results[2].status==='fulfilled'?results[2].value.entries:[]};
    await meta(`quality:${userId}:${selectedEvent}`,data);
  }else if(selectedEvent)data=await readMeta(`quality:${userId}:${selectedEvent}`)||data;
  if(version!==viewVersion)return'';qualityData=data;
  return heading('Scouting administration','Import the TBA schedule. Assign each scouter a Red or Blue station for this event.')+
    `<section class="card"><a href="/admin">Manage user permissions</a><h2>Import / refresh TBA schedule</h2><form id="importEventForm" class="grid grid-2">${field('TBA event key','eventKey',event==='legacy'?'':event,'text','required pattern="2026[a-z0-9]+" placeholder="2026tnkn"')}${field('TBA Read API key (optional if configured on server)','apiKey','','password','autocomplete="off"')}<button class="button button-primary" ${offline?'disabled':''}>Import event, teams and matches</button></form><p>The key is used only for the import and is not saved in browser storage. Reimporting retains all scouted matches.</p></section>`+
    `<section class="card"><span class="eyebrow">EVENT CREW</span><h2>Scout stations · ${esc(event||'choose an imported event')}</h2><p>One group scouts every qualification match. With 2 groups, group 1 scouts odd matches and group 2 scouts even matches. Quantitative-only users must follow their station; users with additional permissions retain manual selection.</p><form id="rotationsForm"><label class="field">Total rotation groups<input name="rotationCount" type="number" min="1" max="100" value="${draftRows[0]?.rotationCount||1}" required></label><div class="table-wrap"><table><thead><tr><th>Scouter</th><th>Group</th><th>Scout station</th><th></th></tr></thead><tbody id="rotationRows">${draftRows.map((r,i)=>rotationRow(r,i)).join('')}</tbody></table></div><div class="button-row"><button type="button" id="addRotation" class="button button-secondary">Add scouter</button><button class="button button-primary" ${offline||!event?'disabled':''}>Save scout stations</button></div><p id="coverageNotice" class="section-help"></p></form></section>`+
    rosterMarkup(qualityData.roster,rosterSearch,rosterSort)+reviewMarkup(qualityData.review,qualityData.entries,{threshold:reviewThreshold,filter:reviewFilter,query:reviewSearch,entryQuery:entrySearch,offline:offline||!event});
}
function rotationRow(r,i){return`<tr data-rotation-row="${i}"><td><select name="userId" aria-label="Scouter" required><option value="">Choose scouter</option>${adminData.users.map(u=>`<option value="${u.id}" ${u.id===r.userId?'selected':''}>${esc(u.email)}</option>`).join('')}</select></td><td><input name="rotation" aria-label="Rotation group" type="number" min="1" max="100" value="${r.rotation||1}" required></td><td><select name="scoutStation" aria-label="Scout station">${['red','blue'].flatMap(a=>[1,2,3].map(n=>`<option value="${a}:${n}" ${a===(r.alliance||'red')&&n===(r.station||1)?'selected':''}>${a==='red'?'Red':'Blue'} scout ${n}</option>`)).join('')}</select></td><td><button type="button" class="mini-button danger" data-remove-rotation>Remove</button></td></tr>`;}
async function renderSync(){const local=(await all()).filter(r=>r.ownerUserId===auth.user.id||can('sync'));return heading('Synchronization','Pending matches stay on this device until the server acknowledges their revision.')+`<section class="card"><button class="button button-primary" id="syncNow">Retry pending matches</button><div class="table-wrap"><table><thead><tr><th>Event</th><th>Match / team</th><th>Type</th><th>Status</th><th>Resolution</th></tr></thead><tbody>${local.map(r=>`<tr><td>${esc(r.eventKey)}</td><td>${esc(r.matchKey||r.matchNumber)} / ${r.teamNumber}</td><td>${esc(r.kind||'quantitative')}</td><td>${esc(r.syncStatus)}<small class="error-text">${esc(r.lastSyncError||'')}</small></td><td>${r.syncStatus==='conflict'?`<button class="mini-button" data-server-version="${esc(r.recordId)}">Keep server version</button>${!r.completed?`<button class="mini-button" data-local-version="${esc(r.recordId)}">Retry local draft as newer</button>`:''}`:''}</td></tr>`).join('')}</tbody></table></div></section>`;}
async function renderSettings(){
  if(settingsAccount?.user.id!==auth.user.id)settingsAccount=null;
  if(!settingsAccount){
    try{settingsAccount=await accountRequest();await meta(`account:${auth.user.id}`,settingsAccount);}
    catch(error){if(!offline&&error.status)throw error;settingsAccount=await readMeta(`account:${auth.user.id}`)||{user:auth.user,permissions:[],sessions:[]};}
  }
  settingsAccount.csrfToken=offline?null:auth.csrfToken;
  const local=(await all()).filter(r=>r.ownerUserId===auth.user.id);
  return settingsMarkup(settingsAccount,{tab:settingsTab,offline,pending:local.filter(r=>!['synced','locked'].includes(r.syncStatus)).length,localCount:local.length});
}
async function exportMyMatches(){
  const grouped=(await store('qualitative','readonly',s=>s.getAll())).filter(g=>g.ownerUserId===auth.user.id&&g.syncStatus!=='deleted').flatMap(g=>g.records.map(r=>({...r,syncStatus:g.syncStatus}))),local=[...(await all()).filter(r=>r.ownerUserId===auth.user.id),...grouped],remote=offline?[]:(await accountRequest('/matches')).matches,map=new Map();
  for(const match of [...remote,...local]){const previous=map.get(match.recordId);if(!previous||match.revision>=previous.revision)map.set(match.recordId,match);}
  downloadMatches([...map.values()]);
}
async function clearMySchedules(){
  const entries=await store('meta','readonly',s=>s.getAll());
  for(const entry of entries)if([`context:${auth.user.id}:`,`records:${auth.user.id}:`].some(prefix=>entry.key.startsWith(prefix)))await store('meta','readwrite',s=>s.delete(entry.key));
}
async function render(){
  const version=++viewVersion;selection.stop();shell();
  if(!auth){$('#mainContent').innerHTML=`<section class="card"><h1>Sign in to Team BEAN Scouting</h1><p>Use your Team 1833 account. An administrator must assign your scouting access.</p><a class="button button-primary" href="/?return_to=%2Fscouting%2F">Shared sign in</a></section>`;return;}
  const r=route();let body;
  if(!allowed(r))body='<section class="card"><h1>Access required</h1><p>Ask a website administrator to grant access to this area.</p><a href="/">Your permissions</a></section>';
  else if(r==='quantitative')body=await renderScouting(r);
  else if(r==='qualitative')body=qualLegacy?'<button id="returnAllianceQual" class="button button-secondary">Back to alliance subjective scouting</button>'+await renderScouting(r):await qualitative.render();
  else if(r==='selection')body=await selection.render();
  else if(r==='analytics')body=await renderAnalytics(version);
  else if(r==='alliances')body=await renderAlliances();
  else if(r==='admin')body=await renderAdmin(version);
  else if(r==='sync')body=await renderSync();
  else if(r==='settings')body=await renderSettings();
  else body=`<section class="card"><h1>${esc(auth.user.email)}</h1><p>All accounts and permissions are managed by the shared portal.</p><a href="/">Your account</a><button id="signOut" class="button">Sign out</button></section>`;
  if(version!==viewVersion)return;$('#mainContent').innerHTML=(r==='settings'?'':eventPicker())+body;bind();if(r==='qualitative'&&!qualLegacy)qualitative.bind();if(r==='selection')selection.bind();
}
async function start(input){
  if(route()!=='qualitative'&&assignedOnly()){
    if(!event)throw new Error('Choose your assigned event first.');
    let assigned;
    if(!offline&&navigator.onLine){
      assigned=await api('/assignment?'+new URLSearchParams({eventKey:event,matchNumber:input.matchNumber}));
      await refreshContext();
    }else assigned=resolveScoutAssignment(context.matches,context.rotation,Number(input.matchNumber));
    if(assigned.error)throw new Error(assigned.error);
    input={...assigned,eventKey:event};
  }
  const kind=route()==='qualitative'?'qualitative':'quantitative',eventKey=String(input.eventKey||event).trim().toLowerCase(),matchNumber=Number(input.matchNumber),teamNumber=Number(input.teamNumber);
  const candidate={...input,eventKey,matchNumber,teamNumber,kind,matchKey:input.matchKey||`qm${matchNumber}`};
  const local=(await all()).map(normalizeRecord);if(isLocked(candidate,local))throw new Error('You already submitted this match/team at this event.');
  if(!offline&&navigator.onLine){const lock=await api('/scout-lock?'+new URLSearchParams({eventKey,matchKey:candidate.matchKey,teamNumber,kind}));if(lock.locked)throw new Error('This match is already submitted and locked.');}
  let device=await readMeta('deviceId');if(!device){device=uuid();await meta('deviceId',device);}
  const r={...Object.fromEntries(COUNTERS.map(k=>[k,0])),...candidate,recordId:uuid(),schemaVersion:5,ownerUserId:auth.user.id,scoutUserId:auth.user.id,scoutName:auth.user.name,deviceId:device,revision:1,completed:false,phase:'auto',robotStatus:'Normal',robotStatusPeriod:'',tags:[],notes:'',createdAt:now(),updatedAt:now(),syncStatus:'pending'};
  const validation=validateRecord(r);if(validation)throw new Error(validation);
  draft=r;
  if(event!==eventKey){context={teams:[],matches:[],assignments:[],completed:[]};remoteRecords=[];}
  event=eventKey;await meta('selectedEvent',event);await put(r);await meta(`active:${auth.user.id}:${kind}`,r.recordId);await refreshContext();await render();
}
async function selectEvent(value){event=value;draft=null;remoteRecords=[];context={teams:[],matches:[],assignments:[],completed:[]};selectedMatch=null;await meta('selectedEvent',event);await refreshContext();await render();}
function updateRoster(){if($('#rosterResults'))$('#rosterResults').innerHTML=rosterResults(qualityData.roster,rosterSearch,rosterSort);}
function updateReview(){if($('#reviewResults'))$('#reviewResults').innerHTML=reviewResults(qualityData.review,reviewThreshold,reviewFilter,reviewSearch,offline);}
function updateOpr(){if($('#oprResults'))$('#oprResults').innerHTML=oprResults(ratingReport,oprWeight,search,oprSort);if($('#oprWeightLabel'))$('#oprWeightLabel').textContent=Math.round(oprWeight*100)+'%';}
function bindQuality(){
  $('#oprWeight')?.addEventListener('input',e=>{oprWeight=Number(e.target.value)/100;updateOpr();});
  $('#oprWeight')?.addEventListener('change',guard(async()=>{await meta(`oprWeight:${auth.user.id}:${event}`,oprWeight);}));
  $('#resetOprWeight')?.addEventListener('click',guard(async()=>{oprWeight=.5;$('#oprWeight').value=50;updateOpr();await meta(`oprWeight:${auth.user.id}:${event}`,oprWeight);}));
  $('#rosterSearch')?.addEventListener('input',e=>{rosterSearch=e.target.value;updateRoster();});
  $('#reviewSearch')?.addEventListener('input',e=>{reviewSearch=e.target.value;updateReview();});
  $('#reviewFilter')?.addEventListener('change',e=>{reviewFilter=e.target.value;updateReview();});
  $('#entrySearch')?.addEventListener('input',e=>{entrySearch=e.target.value;$('#entryResults').innerHTML=entryResults(qualityData.entries,entrySearch,offline);});
  $('#reviewThreshold')?.addEventListener('input',e=>{reviewThreshold=Number(e.target.value)/100;$('#reviewThresholdLabel').textContent=Math.round(reviewThreshold*100)+'%';updateReview();});
  $('#reviewThreshold')?.addEventListener('change',guard(async()=>{await meta(`reviewThreshold:${auth.user.id}:${event}`,reviewThreshold);}));
  $('#pullScores')?.addEventListener('click',guard(async e=>{const button=e.currentTarget;button.disabled=true;button.textContent='Pulling official scores…';try{const result=await api('/admin/pull-scores',{method:'POST',body:{eventKey:event}});toast(`Pulled ${result.matches} matches; ${result.scored} have official fuel scores.`);await render();}finally{button.disabled=false;button.textContent='Pull every match score from TBA';}}));
  $('#cancelDeleteMatch')?.addEventListener('click',()=>$('#deleteMatchDialog').close());
  $('#deleteMatchForm')?.addEventListener('submit',async e=>{
    e.preventDefault();const form=e.currentTarget,button=form.querySelector('button[type=submit],button:not([type])');button.disabled=true;$('#deleteMatchError').textContent='';
    try{const result=await api('/admin/match-entry',{method:'DELETE',body:Object.fromEntries(new FormData(form))});await removeLocal(result.recordId);if(draft?.recordId===result.recordId)draft=null;$('#deleteMatchDialog').close();await refreshContext();toast(`Deleted ${result.matchKey.toUpperCase()} / team ${result.teamNumber}. Its owner can rescout.`);await render();}
    catch(error){$('#deleteMatchError').textContent=error.message;}finally{button.disabled=false;}
  });
  $('#mainContent').onclick=guard(async e=>{
    const button=e.target.closest('button');if(!button)return;
    if(button.dataset.rosterSort){rosterSort=button.dataset.rosterSort;updateRoster();}
    if(button.dataset.oprSort){oprSort=button.dataset.oprSort;updateOpr();}
    if(button.closest('#oprResults')&&button.dataset.teamFocus){search=button.dataset.teamFocus;$('#analyticsSearch').value=search;updateOpr();}
    if(button.dataset.scouterFocus){const scouter=qualityData.roster?.scouters?.find(s=>s.id===button.dataset.scouterFocus);entrySearch=scouter?.name||'';$('#entrySearch').value=entrySearch;$('#entryResults').innerHTML=entryResults(qualityData.entries,entrySearch,offline);$('#allEntries').open=true;$('#allEntries').scrollIntoView({behavior:'smooth',block:'start'});}
    if(button.dataset.deleteRecord){const record=qualityData.entries.find(r=>r.recordId===button.dataset.deleteRecord);if(!record)throw new Error('Reload to find this match entry.');const form=$('#deleteMatchForm');form.reset();form.elements.recordId.value=record.recordId;$('#deleteMatchDescription').textContent=`${record.matchKey.toUpperCase()} · Team ${record.teamNumber} · ${record.scouter} · ${record.kind}`;$('#deleteMatchError').textContent='';$('#deleteMatchDialog').showModal();}
  });
}
async function persistAnalysis(){await meta(`analysis:${auth.user.id}:${event}`,analysisOptions);await render();}
function guard(fn){return async e=>{try{await fn(e);}catch(error){toast(error.message);}};}
function bind(){
  $('#returnAllianceQual')?.addEventListener('click',guard(async()=>{qualLegacy=false;await render();}));
  if(route()==='settings')bindSettings($('#mainContent'),{account:settingsAccount,changeTab:async tab=>{settingsTab=tab;await render();},refresh:async(load=true)=>{if(load)settingsAccount=null;await render();},notify:toast,onSync:syncAll,onExport:exportMyMatches,onClear:clearMySchedules,onNameChange:body=>{auth.user.firstName=body.firstName;auth.user.lastName=body.lastName;auth.user.name=body.firstName+' '+body.lastName;}});
  $('#eventPicker')?.addEventListener('change',guard(e=>selectEvent(e.target.value)));
  $('#startForm')?.addEventListener('submit',guard(async e=>{e.preventDefault();await start(Object.fromEntries(new FormData(e.currentTarget)));}));
  $('#assignedStartForm')?.addEventListener('submit',guard(async e=>{e.preventDefault();const form=e.currentTarget,button=form.querySelector('button');button.disabled=true;try{await start(Object.fromEntries(new FormData(form)));}finally{button.disabled=false;}}));
  $('#assignedMatchNumber')?.addEventListener('input',e=>{const assigned=resolveScoutAssignment(context.matches,context.rotation,Number(e.target.value));$('#assignmentPreview').innerHTML=assigned.error?`<p>${esc(assigned.error)}</p>`:robotBanner({...assigned,eventKey:event},true);});
  $$('[data-assigned]').forEach(b=>b.addEventListener('click',guard(async()=>{const a=context.assignments.find(m=>m.match_key===b.dataset.assigned);await start({eventKey:event,matchKey:a.match_key,matchNumber:a.match_number,teamNumber:a.teamNumber,alliance:a.alliance});})));
  $$('[data-resume]').forEach(b=>b.addEventListener('click',guard(async()=>{draft=await get(b.dataset.resume);if(draft.ownerUserId!==auth.user.id||draft.completed)throw new Error('This match is locked');await render();})));
  $('#closeDraft')?.addEventListener('click',guard(async()=>{draft=null;await render();}));
  $$('[data-phase]').forEach(b=>b.addEventListener('click',guard(async()=>{draft.phase=b.dataset.phase;await saveDraft();await render();})));
  $$('[data-counter]').forEach(b=>b.addEventListener('click',guard(async()=>{const key=b.dataset.counter,delta=Number(b.dataset.delta);if(!COUNTERS.includes(key)||(/Crossings$/.test(key)&&![-1,1].includes(delta)))return;draft[key]=Math.max(0,(draft[key]||0)+delta);await saveDraft();await render();})));
  $('#robotStatus')?.addEventListener('change',guard(async e=>{draft.robotStatus=e.target.value;if(draft.robotStatus==='Normal')draft.robotStatusPeriod='';await saveDraft();$('#failurePeriod').hidden=draft.robotStatus==='Normal';}));
  $('#robotStatusPeriod')?.addEventListener('change',guard(async e=>{draft.robotStatusPeriod=e.target.value;await saveDraft();}));
  $('#qualTags')?.addEventListener('input',guard(async e=>{draft.tags=e.target.value.split(',').map(t=>t.trim()).filter(Boolean);await saveDraft();}));
  $('#qualNotes')?.addEventListener('input',guard(async e=>{draft.notes=e.target.value;await saveDraft();}));
  $('#submitMatch')?.addEventListener('click',guard(async()=>{const validation=validateRecord(draft);if(validation)throw new Error(validation);draft.completed=true;draft.submittedAt=now();draft.updatedAt=now();draft.revision++;draft.syncStatus='pending';await put(draft);const submitted=draft;draft=null;await meta(`active:${auth.user.id}:${submitted.kind}`,null);await syncOne(submitted);await refreshContext();toast('Observation saved. This match/team is now locked.');await render();}));
  $('#analyticsSearch')?.addEventListener('change',guard(async e=>{search=e.target.value;selectedMatch=null;await render();}));
  $('#metricPicker')?.addEventListener('change',guard(async e=>{metric=e.target.value;await render();}));
  $$('[data-metric]').forEach(b=>b.addEventListener('click',guard(async()=>{metric=b.dataset.metric;await render();})));
  $$('[data-view]').forEach(b=>b.addEventListener('click',guard(async()=>{view=b.dataset.view;await render();})));
  for(const [id,setValue]of [['bubbleX',v=>{bubbleX=v;}],['bubbleY',v=>{bubbleY=v;}],['bubbleSize',v=>{bubbleSize=v;}]])$('#'+id)?.addEventListener('change',guard(async e=>{setValue(e.target.value);await render();}));
  $$('[data-chart-team]').forEach(point=>{
    const show=()=>{const tooltip=$('#chartTooltip');if(tooltip){tooltip.textContent=point.dataset.tip;tooltip.hidden=false;}};
    const hide=()=>{const tooltip=$('#chartTooltip');if(tooltip)tooltip.hidden=true;};
    const focusTeam=guard(async()=>{search=point.dataset.chartTeam;await render();});
    point.addEventListener('pointerenter',show);point.addEventListener('pointerleave',hide);point.addEventListener('focus',show);point.addEventListener('blur',hide);point.addEventListener('click',focusTeam);point.addEventListener('keydown',e=>{if(['Enter',' '].includes(e.key)){e.preventDefault();focusTeam(e);}});
  });
  $('#trimCount')?.addEventListener('change',guard(async e=>{analysisOptions[metric]={...analysisOptions[metric],trim:Math.max(0,Math.min(100,Number(e.target.value)||0))};await persistAnalysis();}));
  $$('[data-sample]').forEach(b=>b.addEventListener('change',guard(async()=>{const opts=analysisOptions[metric]||{},byTeam={...opts.excludedByTeam},set=new Set(byTeam[b.dataset.sampleTeam]||[]);if(b.checked)set.delete(b.dataset.sample);else set.add(b.dataset.sample);byTeam[b.dataset.sampleTeam]=[...set];analysisOptions[metric]={...opts,excludedByTeam:byTeam};await persistAnalysis();})));
  $$('[data-team-focus]:not(#oprResults [data-team-focus])').forEach(b=>b.addEventListener('click',guard(async()=>{search=b.dataset.teamFocus;await render();})));
  $$('[data-team-view]').forEach(b=>b.addEventListener('click',guard(async()=>{[search,view]=b.dataset.teamView.split(':');await render();})));
  $$('[data-match]').forEach(b=>b.addEventListener('click',guard(async()=>{selectedMatch=b.dataset.match;await render();})));
  $$('[data-match-view]').forEach(b=>b.addEventListener('click',guard(async()=>{const m=context.matches.find(m=>m.match_key===selectedMatch);search=[...m.red,...m.blue].join(', ');view=b.dataset.matchView;await render();})));
  $('#allianceForm')?.addEventListener('submit',guard(async e=>{e.preventDefault();const form=Object.fromEntries(new FormData(e.currentTarget)),teams=[form.team1,form.team2,form.team3].filter(Boolean).map(Number);await api('/alliances',{method:'POST',body:{id:uuid(),eventKey:event,name:form.name,strategy:form.strategy,teams}});await render();}));
  $$('[data-delete-alliance]').forEach(b=>b.addEventListener('click',guard(async()=>{await api('/alliances',{method:'DELETE',body:{eventKey:event,id:b.dataset.deleteAlliance}});await render();})));
  $$('[data-alliance-compare]').forEach(b=>b.addEventListener('click',()=>{search=b.dataset.allianceCompare;view='bar';location.hash='analytics';}));
  $('#importEventForm')?.addEventListener('submit',guard(async e=>{e.preventDefault();const form=e.currentTarget,body=Object.fromEntries(new FormData(form)),button=form.querySelector('button');button.disabled=true;try{const imported=await api('/admin/import-event',{method:'POST',body});form.elements.apiKey.value='';toast(`Imported ${imported.teams} teams and ${imported.matches} matches`);await selectEvent(imported.eventKey);}finally{button.disabled=false;}}));
  $('#addRotation')?.addEventListener('click',()=>$('#rotationRows').insertAdjacentHTML('beforeend',rotationRow({},Date.now())));
  $('#rotationRows')?.addEventListener('click',e=>{if(e.target.matches('[data-remove-rotation]'))e.target.closest('tr').remove();});
  $('#rotationsForm')?.addEventListener('submit',guard(async e=>{e.preventDefault();const rotationCount=Number(e.currentTarget.elements.rotationCount.value),rotations=$$('#rotationRows tr').map(tr=>{const [alliance,station]=tr.querySelector('[name=scoutStation]').value.split(':');return{userId:tr.querySelector('[name=userId]').value,rotation:Number(tr.querySelector('[name=rotation]').value),rotationCount,alliance,station:Number(station)};});await api('/admin/rotations',{method:'PUT',body:{eventKey:event,rotations}});toast(`Saved ${rotations.length} scouters. ${rotationCount*6-rotations.length} station/group slots are unassigned.`);await refreshContext();await render();}));
  $('#syncNow')?.addEventListener('click',guard(async()=>{await syncAll();await refreshContext();await render();}));
  $$('[data-server-version]').forEach(b=>b.addEventListener('click',guard(async()=>{const record=await get(b.dataset.serverVersion);if(record.conflictServerRecord)await put({...record.conflictServerRecord,syncStatus:'synced'});await render();})));
  $$('[data-local-version]').forEach(b=>b.addEventListener('click',guard(async()=>{const record=await get(b.dataset.localVersion);if(record.completed)throw new Error('Submitted matches cannot be changed');await put({...record,revision:Math.max(record.revision,record.conflictServerRecord?.revision||0)+1,conflictServerRecord:null,syncStatus:'pending'});await syncAll();await render();})));
  $('#signOut')?.addEventListener('click',guard(async()=>{if(offline)throw new Error('Reconnect to sign out');const response=await fetch('/logout',{method:'POST',headers:{'content-type':'application/x-www-form-urlencoded'},body:new URLSearchParams({csrf_token:auth.csrfToken})});if(!response.ok)throw new Error('Could not sign out');localStorage.removeItem(SNAPSHOT);location.assign('/');}));
  bindQuality();
}
async function init(){
  db=await openDb();await refreshAuth();if(auth)await refreshContext();
  if('serviceWorker'in navigator)navigator.serviceWorker.register('/scouting/sw.js',{scope:'/scouting/'}).catch(()=>{});
  if(!location.hash)history.replaceState(null,'','#quantitative');
  if(auth){const id=await readMeta(`active:${auth.user.id}:${route()}`);if(id){const saved=await get(id);if(saved&&!saved.completed&&saved.ownerUserId===auth.user.id&&normalizeRecord(saved).eventKey===event)draft=normalizeRecord(saved);}}
  window.addEventListener('hashchange',guard(async()=>{draft=null;const id=await readMeta(`active:${auth?.user.id}:${route()}`);if(id){const saved=await get(id);if(saved&&!saved.completed&&saved.ownerUserId===auth?.user.id&&normalizeRecord(saved).eventKey===event)draft=normalizeRecord(saved);}await render();}));
  window.addEventListener('offline',()=>{offline=true;shell();if(route()==='settings')render().catch(error=>toast(error.message));});
  window.addEventListener('online',guard(async()=>{await refreshAuth();await syncAll();await refreshContext();await render();}));
  setInterval(async()=>{try{const previous=JSON.stringify(auth?.user);await refreshAuth();await syncAll();if(previous!==JSON.stringify(auth?.user))await render();}catch{/* Retry on next refresh. */}},30000);
  await render();await syncAll();
}
init().catch(error=>{$('#mainContent').textContent='Scouting could not start: '+error.message;});
