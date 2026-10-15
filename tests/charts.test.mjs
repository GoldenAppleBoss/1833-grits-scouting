import test from 'node:test';
import assert from 'node:assert/strict';
import { statistics } from '../scouting/public/model.js';
import { chartDomain,renderBoxPlot,bubblePoints,renderBubbleChart,renderBars } from '../scouting/public/charts.js';

const team=(number,values,other=values)=>({teamNumber:number,name:`Team ${number}`,records:values.map(()=>({})),metrics:{totalFuel:statistics(values),cycles:statistics(other),reliability:statistics([100]),autoFuel:statistics(values),teleopFuel:statistics(values)}});
test('chart domains stay finite and nondegenerate for zeros, identical values and absent values',()=>{
  for(const values of [[],[0],[0,0],[12,12],[NaN,Infinity],[1,10000]]){
    const [min,max]=chartDomain(values);assert.ok(Number.isFinite(min)&&Number.isFinite(max)&&max>min);
  }
});
test('box plots show actual quartiles, median, non-outlier whiskers and outliers',()=>{
  const sample=team(1833,[1,2,3,4,100]),s=sample.metrics.totalFuel;
  assert.equal(s.median,3);assert.equal(s.q1,2);assert.equal(s.q3,4);assert.equal(s.low,1);assert.equal(s.high,4);assert.deepEqual(s.outliers,[100]);
  const svg=renderBoxPlot([sample],'totalFuel');
  assert.match(svg,/data-quartile-box/);assert.match(svg,/data-median/);assert.match(svg,/data-outlier/);assert.match(svg,/Median: 3.00/);
  assert.ok(!/NaN|Infinity/.test(svg));
  assert.ok(!/NaN|Infinity/.test(renderBoxPlot([team(1,[0,0]),team(2,[5])],'totalFuel')));
});
test('bubble points use independent selected axes and exclude unknown values',()=>{
  const data=[team(1,[1,3],[10,20]),team(2,[4,6],[2,4]),team(3,[],[])];
  assert.deepEqual(bubblePoints(data,'totalFuel','cycles').map(p=>[p.team.teamNumber,p.x,p.y,p.size]),[[1,2,15,2],[2,5,3,2]]);
  assert.deepEqual(bubblePoints(data,'cycles','totalFuel').map(p=>[p.x,p.y]),[[15,2],[3,5]]);
  const svg=renderBubbleChart(data,'totalFuel','cycles');
  assert.equal((svg.match(/data-bubble/g)||[]).length,2);assert.ok(!/NaN|Infinity/.test(svg));assert.match(svg,/omitted/);
  assert.ok(!/NaN|Infinity/.test(renderBubbleChart([team(1,[0],[0])],'totalFuel','cycles')));
});
test('all chart types give readable empty states',()=>{
  assert.match(renderBoxPlot([],'totalFuel'),/No match samples/);
  assert.match(renderBubbleChart([],'totalFuel','cycles'),/No teams/);
  assert.match(renderBars([],'totalFuel'),/No completed matches/);
});
