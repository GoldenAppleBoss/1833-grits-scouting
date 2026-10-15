import { METRICS } from './model.js';
const esc=value=>String(value??'').replaceAll('&','&amp;').replaceAll('<','&lt;').replaceAll('>','&gt;').replaceAll('"','&quot;').replaceAll("'",'&#39;');
const fmt=value=>Number.isFinite(value)?Number(value).toFixed(2):'—';
const tick=value=>new Intl.NumberFormat('en',{maximumFractionDigits:1,notation:Math.abs(value)>=10000?'compact':'standard'}).format(value);
export function chartDomain(values,{zero=true}={}){
  const finite=values.filter(Number.isFinite);
  if(!finite.length)return [0,1];
  let min=Math.min(...finite),max=Math.max(...finite);
  if(zero&&min>=0)min=0;
  if(min===max){const pad=Math.max(1,Math.abs(min)*.1);min=zero&&min>=0?0:min-pad;max+=pad;}
  else max+=(max-min)*.08;
  return [min,max];
}
const scale=(domain,start,end)=>value=>start+(value-domain[0])/(domain[1]-domain[0])*(end-start);
const metricDomain=(values,metric)=>metric==='reliability'?[0,100]:chartDomain(values);
function ticks(domain,start,end,y){const x=scale(domain,start,end);return Array.from({length:6},(_,i)=>{const value=domain[0]+(domain[1]-domain[0])*i/5;return `<line x1="${x(value)}" x2="${x(value)}" y1="${y-4}" y2="${y+4}" class="axis-line"/><text x="${x(value)}" y="${y+22}" text-anchor="middle" class="axis-label">${esc(tick(value))}</text>`;}).join('');}
export function renderBoxPlot(teams,metric){
  const eligible=teams.filter(t=>t.metrics[metric]?.count>0);
  if(!eligible.length)return '<p class="empty-chart">No match samples for this metric. Select an event or a different metric.</p>';
  const domain=metricDomain(eligible.flatMap(t=>{const s=t.metrics[metric];return[s.min,s.max,...s.outliers];}),metric),x=scale(domain,210,850),height=eligible.length*78+80,axisY=height-50;
  return `<p class="chart-help">Each box shows a team’s middle 50% of matches. The orange line is its median. Whiskers show the non-outlier range; dots show outliers. Hover or focus a team for exact values.</p><svg class="chart distribution-chart" viewBox="0 0 900 ${height}" role="img" aria-label="Box and whisker plot of ${esc(METRICS[metric].label)}"><line x1="210" x2="850" y1="${axisY}" y2="${axisY}" class="axis-line"/>${ticks(domain,210,850,axisY)}${eligible.map((t,i)=>{
    const s=t.metrics[metric],y=i*78+32,tip=`Team ${t.teamNumber} · ${t.name}\nMatches: ${s.count}\nMedian: ${fmt(s.median)}\nQ1: ${fmt(s.q1)} · Q3: ${fmt(s.q3)}\nWhiskers: ${fmt(s.low)}–${fmt(s.high)}\nOutliers: ${s.outliers.length}`;
    return `<g class="chart-point" tabindex="0" data-chart-team="${t.teamNumber}" data-tip="${esc(tip)}" role="button" aria-label="${esc(tip)}"><title>${esc(tip)}</title><text x="10" y="${y-2}" class="team-axis-label">${t.teamNumber} ${esc(t.name.slice(0,20))}</text><text x="10" y="${y+18}" class="axis-label">${s.count} matches · median ${fmt(s.median)}</text><line x1="${x(s.low)}" x2="${x(s.high)}" y1="${y}" y2="${y}" class="whisker"/><line x1="${x(s.low)}" x2="${x(s.low)}" y1="${y-12}" y2="${y+12}" class="whisker"/><line x1="${x(s.high)}" x2="${x(s.high)}" y1="${y-12}" y2="${y+12}" class="whisker"/><rect data-quartile-box x="${x(s.q1)}" y="${y-16}" width="${Math.max(2,x(s.q3)-x(s.q1))}" height="32" rx="3" class="quartile-box"/><line data-median x1="${x(s.median)}" x2="${x(s.median)}" y1="${y-18}" y2="${y+18}" class="median-line"/>${s.outliers.map(v=>`<circle data-outlier cx="${x(v)}" cy="${y}" r="5" class="outlier"><title>${esc(t.name)}: ${fmt(v)}</title></circle>`).join('')}</g>`;
  }).join('')}<text x="530" y="${height-2}" text-anchor="middle" class="axis-title">${esc(METRICS[metric].label)}</text></svg>`;
}
export function bubblePoints(teams,xMetric,yMetric,sizeMetric='matches'){
  return teams.map(team=>({team,x:team.metrics[xMetric]?.mean,y:team.metrics[yMetric]?.mean,size:sizeMetric==='matches'?team.records.length:team.metrics[sizeMetric]?.mean}))
    .filter(p=>Number.isFinite(p.x)&&Number.isFinite(p.y)&&Number.isFinite(p.size)&&p.size>=0);
}
export function renderBubbleChart(teams,xMetric,yMetric,sizeMetric='matches'){
  const points=bubblePoints(teams,xMetric,yMetric,sizeMetric);
  if(!points.length)return '<p class="empty-chart">No teams have values for both axes. Try other metrics or include more matches.</p>';
  const xd=metricDomain(points.map(p=>p.x),xMetric),yd=metricDomain(points.map(p=>p.y),yMetric),x=scale(xd,100,835),y=scale(yd,405,55),maxSize=Math.max(1,...points.map(p=>p.size)),labels=[];
  const sizeLabel=sizeMetric==='matches'?'Matches scouted':METRICS[sizeMetric].label;
  return `<p class="chart-help">Each bubble is one team. Position uses the team’s mean for each axis; bubble area reflects ${esc(sizeLabel.toLowerCase())}. Hover or focus a bubble for values. Select it to inspect that team.</p><svg class="chart bubble-chart" viewBox="0 0 900 490" role="img" aria-label="Bubble chart: ${esc(METRICS[xMetric].label)} versus ${esc(METRICS[yMetric].label)}">${Array.from({length:6},(_,i)=>{const value=yd[0]+(yd[1]-yd[0])*i/5;return `<line x1="100" x2="835" y1="${y(value)}" y2="${y(value)}" class="grid-line"/><text x="86" y="${y(value)+5}" text-anchor="end" class="axis-label">${esc(tick(value))}</text>`;}).join('')}<line x1="100" x2="835" y1="405" y2="405" class="axis-line"/><line x1="100" x2="100" y1="55" y2="405" class="axis-line"/>${ticks(xd,100,835,405)}<text x="470" y="470" text-anchor="middle" class="axis-title">${esc(METRICS[xMetric].label)}</text><text transform="translate(24 230) rotate(-90)" text-anchor="middle" class="axis-title">${esc(METRICS[yMetric].label)}</text>${points.map((p,i)=>{
    const radius=Math.sqrt(64+576*p.size/maxSize),tip=`Team ${p.team.teamNumber} · ${p.team.name}\n${METRICS[xMetric].label}: ${fmt(p.x)}\n${METRICS[yMetric].label}: ${fmt(p.y)}\n${sizeLabel}: ${fmt(p.size)}`,px=x(p.x),py=y(p.y),labelWidth=String(p.team.teamNumber).length*9;
    let lx=px,ly=py-radius-7;
    for(let attempts=0;attempts<15&&labels.some(label=>Math.abs(label.x-lx)<(label.width+labelWidth)/2+5&&Math.abs(label.y-ly)<17);attempts++){
      if(ly>38)ly-=18;else lx=Math.max(60+labelWidth/2,lx-labelWidth-10);
    }
    labels.push({x:lx,y:ly,width:labelWidth});
    return `<g class="chart-point" tabindex="0" role="button" data-chart-team="${p.team.teamNumber}" data-tip="${esc(tip)}" aria-label="${esc(tip)}"><title>${esc(tip)}</title><circle data-bubble cx="${px}" cy="${py}" r="${radius}" fill="${i%2?'#f34732':'#1b97ad'}" fill-opacity=".65" stroke="currentColor" stroke-width="1.5"/>${lx!==px||ly!==py-radius-7?`<line x1="${px}" x2="${lx}" y1="${py-radius}" y2="${ly+3}" class="axis-line"/>`:''}<text x="${lx}" y="${ly}" text-anchor="middle" class="bubble-label">${p.team.teamNumber}</text></g>`;
  }).join('')}</svg>${points.length<teams.length?`<p class="section-help">${teams.length-points.length} team(s) omitted because a selected value is unknown.</p>`:''}`;
}
export function renderBars(teams,metric,{stacked=false}={}){
  const eligible=teams.filter(t=>stacked?t.metrics.totalFuel?.count:t.metrics[metric]?.count);
  if(!eligible.length)return '<p class="empty-chart">No completed matches for this selection yet.</p>';
  const values=eligible.map(t=>stacked?(t.metrics.autoFuel.mean||0)+(t.metrics.teleopFuel.mean||0):t.metrics[metric].mean),domain=stacked?chartDomain(values):metricDomain(values,metric),x=scale(domain,210,850),height=eligible.length*70+80,axisY=height-50;
  return `${stacked?'<p class="legend"><span class="auto-key">Autonomous fuel</span><span class="teleop-key">Teleop fuel</span></p>':''}<svg class="chart" viewBox="0 0 900 ${height}" role="img" aria-label="${stacked?'Stacked autonomous and teleop fuel points':'Metric comparison bar graph'}"><line x1="210" x2="850" y1="${axisY}" y2="${axisY}" class="axis-line"/>${ticks(domain,210,850,axisY)}${eligible.map((t,i)=>{
    const keys=stacked?['autoFuel','teleopFuel']:[metric];let start=x(0);
    return `<g tabindex="0" class="chart-point" role="button" data-chart-team="${t.teamNumber}" data-tip="${esc(`Team ${t.teamNumber} · ${t.name}\nMean: ${fmt(values[i])}`)}"><text x="10" y="${i*70+35}" class="team-axis-label">${t.teamNumber} ${esc(t.name.slice(0,20))}</text>${keys.map((key,j)=>{const value=t.metrics[key].mean||0,width=x(value)-x(0),markup=`<rect x="${start}" y="${i*70+15}" width="${width}" height="30" rx="3" fill="${j?'#f34732':'#1b97ad'}"><title>${esc(METRICS[key].label)}: ${fmt(t.metrics[key].mean)}</title></rect>`;start+=width;return markup;}).join('')}<text x="210" y="${i*70+61}" class="axis-label">${fmt(values[i])} · ${t.records.length} matches</text></g>`;
  }).join('')}</svg>`;
}
