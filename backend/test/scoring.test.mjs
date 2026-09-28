import {test} from 'node:test';
import assert from 'node:assert/strict';
import {addDays,calculateSeries,computeBaseline,changes,weekOverWeek,METHOD_VERSION,BASELINE_LEVEL} from '../src/scoring.mjs';
const FIRST_DAY='2026-06-29';
// Baseline activity: 100 addresses/day, 10 contracts/day, 50 KDA TVL, 10 PH/s, 10 commits/day.
const BASE={addresses:100,contracts:10,tvlKda:50,hashratePh:10,commits:10};
const row=(i,extra={})=>({day:addDays(FIRST_DAY,i),...BASE,tvlUsd:5,kdaUsd:.1,coverage:{addresses:true,contracts:true,tvl:true,hashrate:true,commits:true},registryVersion:'test',...extra});
const scaled=(i,factor)=>row(i,{addresses:Math.round(BASE.addresses*factor),contracts:Math.round(BASE.contracts*factor),tvlKda:BASE.tvlKda*factor,hashratePh:BASE.hashratePh*factor,commits:Math.round(BASE.commits*factor)});
const history=(days,factorFor=()=>1)=>Array.from({length:days},(_,i)=>i<30?row(i):scaled(i,factorFor(i)));
const through=rows=>({throughDay:rows.at(-1).day});

test('baseline activity scores 50 and the index has no ceiling (Naif\'s worked examples)',()=>{
 for(const [factor,expected] of [[1,50],[2,100],[3,150],[.8,40]]){
  const rows=history(44,()=>factor),out=calculateSeries(rows,through(rows));
  assert.equal(out.at(-1).score,expected,`factor ${factor}`);
  assert.equal(out.at(-1).windowDays,7);
 }
 assert.equal(BASELINE_LEVEL,50);
});
test('formula is 50 × Σ weight × current ÷ fixed baseline, with mixed metric movements',()=>{
 const rows=history(44).map((r,i)=>i<37?r:{...r,addresses:200,contracts:5,tvlKda:50,hashratePh:12,commits:0});
 const last=calculateSeries(rows,through(rows)).at(-1);
 // 50 × (0.30×2 + 0.25×0.5 + 0.20×1 + 0.15×1.2 + 0.10×0) = 55.25
 assert.equal(last.score,55.3);
 const c=last.components;
 assert.equal(c.addresses.ratio,2);assert.equal(c.contracts.ratio,.5);assert.equal(c.tvl.ratio,1);assert.ok(Math.abs(c.hashrate.ratio-1.2)<1e-12);assert.equal(c.commits.ratio,0);
 assert.equal(c.contracts.rawValue,35);assert.equal(c.contracts.baselineValue,70,'count baseline = 7 × mean daily count');
 assert.equal(c.addresses.baselineValue,100,'average baseline = 30-day mean');
 const hand=Object.values(c).reduce((s,x)=>s+x.contribution,0);assert.ok(Math.abs(hand-55.25)<1e-9);
});
test('sustained growth then decline: scores pass 100, fall back, and new highs never restate earlier days',()=>{
 const growth=i=>i<90?1+(i-29)*.03:2.8-(i-89)*.04; // +3%/day of baseline for 60 days, then −4%/day
 const start='2026-01-01',rows=history(120,growth).map((r,i)=>({...r,day:addDays(start,i)}));
 const series=(input,day)=>calculateSeries(input,{firstDay:start,throughDay:day});
 const full=series(rows,rows.at(-1).day);
 const peak=Math.max(...full.map(s=>s.score));
 assert.ok(peak>100,'sustained growth exceeds 100');assert.ok(full.at(-1).score<peak,'decline lowers the index');
 assert.ok(full.slice(30,90).every((s,i,a)=>i===0||s.score>=a[i-1].score),'no drawdowns while activity grows');
 const early=series(rows.slice(0,95),rows[94].day);
 assert.deepEqual(full.slice(0,95),early,'appending later days, including new highs, changes no earlier score');
 assert.ok(full.every(s=>s.baseline.fromDay===start&&s.baseline.throughDay===addDays(start,29)));
});
test('startup windows use the available days, labelled as shorter windows',()=>{
 const rows=history(40),out=calculateSeries(rows,through(rows));
 assert.equal(out[0].windowDays,1);assert.equal(out[0].startupWindow,true);assert.equal(out[5].windowDays,6);assert.equal(out[6].windowDays,7);assert.equal(out[6].startupWindow,false);
 assert.equal(out[0].components.contracts.rawValue,10);assert.equal(out[0].components.contracts.baselineValue,10,'a 1-day count is compared with 1 day of baseline');
 assert.equal(out[0].score,50);assert.equal(out[2].components.commits.rawValue,30);
});
test('zero or very small baselines follow the documented rule instead of an arbitrary divisor',()=>{
 const sparse=history(40).map((r,i)=>({...r,contracts:i===3?3:0,commits:0}));
 const base=computeBaseline(sparse);
 assert.equal(base.metrics.contracts.observedDailyMean,.1);assert.equal(base.metrics.contracts.rule,'minimum');assert.equal(base.metrics.contracts.dailyMean,1);
 assert.equal(base.metrics.commits.observedDailyMean,0);assert.equal(base.metrics.commits.rule,'minimum');assert.equal(base.metrics.commits.dailyMean,1);
 assert.equal(base.metrics.addresses.rule,'observed');
 const last=calculateSeries(sparse,through(sparse)).at(-1);
 assert.equal(last.components.commits.baselineValue,7);assert.equal(last.components.commits.baselineRule,'minimum');
 assert.throws(()=>computeBaseline(sparse,{minimums:{}}),error=>error.code==='BASELINE_ZERO','without a documented minimum a zero count baseline stops');
 const noTvl=history(40).map(r=>({...r,tvlKda:0}));
 assert.throws(()=>calculateSeries(noTvl,through(noTvl)),error=>error.code==='BASELINE_ZERO'&&error.details.metric==='tvl','a zero average baseline stops publication');
 assert.equal(Object.keys(base.metrics).length,5,'weights and inputs are never dropped or redistributed');
});
test('the baseline needs the first 30 collected days, and early days can be scored against it',()=>{
 const rows=history(40);
 assert.throws(()=>calculateSeries(rows.slice(0,10),{throughDay:rows[9].day}),error=>error.code==='BASELINE_INCOMPLETE');
 const early=calculateSeries(rows.slice(0,10),{throughDay:rows[9].day,baselineRows:rows});
 assert.deepEqual(early,calculateSeries(rows,through(rows)).slice(0,10));
 assert.throws(()=>calculateSeries(rows.slice(1),{throughDay:rows.at(-1).day}),/fixed collection start/);
});
test('rejects gaps, duplicates, missing metrics and unknown coverage',()=>{
 const rows=history(40);
 assert.throws(()=>calculateSeries([rows[0],rows[2]],{throughDay:rows[2].day}),/Missing/);
 assert.throws(()=>calculateSeries([rows[0],rows[0],rows[2]],{throughDay:rows[2].day}),/duplicate/);
 assert.throws(()=>calculateSeries([row(0,{tvlKda:null})],{throughDay:FIRST_DAY}),/tvlKda/);
 assert.throws(()=>calculateSeries([row(0,{coverage:{}})],{throughDay:FIRST_DAY}),/coverage/);
});
test('KDA scoring ignores USD price moves; snapshots carry the method, baseline and inputs',()=>{
 const rows=history(40),a=calculateSeries(rows,through(rows));
 const b=calculateSeries(rows.map((r,i)=>({...r,tvlUsd:i+1,kdaUsd:(i+1)/50})),through(rows));
 assert.deepEqual(a.map(s=>s.score),b.map(s=>s.score));
 const last=a.at(-1);
 assert.equal(last.methodVersion,METHOD_VERSION);assert.equal(last.normalization,'fixed-baseline-first-30-days');assert.equal(last.baselineDay,FIRST_DAY);assert.equal(last.baseline.level,50);
 assert.equal(last.band,undefined,'peak-based bands are gone');assert.equal(last.components.addresses.high,undefined,'peak normalization is gone');
});
test('exact date deltas in index points and week-over-week changes',()=>{
 const rows=history(70,i=>i<60?1:2),scores=calculateSeries(rows,through(rows)),last=scores.at(-1);
 assert.deepEqual(changes(scores,last),{sevenDay:Math.round((last.score-scores.at(-8).score)*10)/10,thirtyDay:Math.round((last.score-scores.at(-31).score)*10)/10});
 assert.deepEqual(changes(scores,scores[0]),{sevenDay:null,thirtyDay:null});
 assert.deepEqual(weekOverWeek(5,0),{absolute:5,percent:null});
});
