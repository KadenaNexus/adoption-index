import {test} from 'node:test';
import assert from 'node:assert/strict';
import {stagedReport,stagedMarkdown,independentDay} from '../src/staging.mjs';
import {calculateSeries} from '../src/scoring.mjs';
import {COLLECTION_START,addDays} from '../src/window.mjs';
const row=(i,extra={})=>({day:addDays(COLLECTION_START,i),addresses:20,contracts:1,tvlKda:400,tvlUsd:40,kdaUsd:.1,hashratePh:2,commits:1,registryVersion:'fixture',coverage:{addresses:true,contracts:true,tvl:true,hashrate:true,commits:true},...extra});
const rows=Array.from({length:40},(_,i)=>row(i,i>=33?{addresses:40}:{}));

test('independent day arithmetic matches the scoring engine and shows every input against its baseline',()=>{
 const report=stagedReport(rows,{day:rows.at(-1).day});
 assert.equal(report.composite,calculateSeries(rows,{throughDay:rows.at(-1).day}).at(-1).score);
 assert.equal(report.composite,65);assert.equal(report.independentCalculationPassed,true);assert.equal(report.components.length,5);
 const addresses=report.components.find(c=>c.id==='addresses');
 assert.equal(addresses.currentValue,40);assert.equal(addresses.baselineValue,20);assert.equal(addresses.ratio,2);assert.equal(addresses.componentIndex,100);
 const md=stagedMarkdown(report);
 assert.match(md,/Baseline: \*\*2026-06-29 to 2026-07-28\*\*/);assert.match(md,/Component index \(50 × ratio\)/);assert.match(md,/never restated/);
});
test('a day inside the baseline period uses the complete 30-day baseline and a labelled startup window',()=>{
 const report=stagedReport(rows.slice(0,1),{day:COLLECTION_START,baselineRows:rows});
 assert.equal(report.windowDays,1);assert.equal(report.startupWindow,true);assert.equal(report.composite,50);
 assert.match(stagedMarkdown(report),/1-day \(startup window/);
 assert.throws(()=>stagedReport(rows.slice(0,1),{day:COLLECTION_START}),error=>error.code==='BASELINE_INCOMPLETE');
});
test('the small-baseline rule is applied and disclosed in the independent calculation',()=>{
 const sparse=rows.map(r=>({...r,contracts:0,commits:0}));
 const day=independentDay(sparse,sparse.at(-1).day),contracts=day.components.find(c=>c.id==='contracts');
 assert.equal(contracts.baselineRule,'minimum');assert.equal(contracts.baselineValue,7);assert.equal(contracts.baselineObservedDailyMean,0);
 assert.equal(day.composite,calculateSeries(sparse,{throughDay:sparse.at(-1).day}).at(-1).score);
 assert.throws(()=>stagedReport([{...rows[0],coverage:{}},...rows.slice(1)],{day:rows.at(-1).day}),/coverage/);
});
test('independent worksheet sorts dates exactly as the scoring engine does',()=>{
 const report=stagedReport(rows.toReversed(),{day:rows.at(-1).day});
 assert.equal(report.rawSeries[0].day,COLLECTION_START);assert.equal(report.rawValues.addresses,40);
});
