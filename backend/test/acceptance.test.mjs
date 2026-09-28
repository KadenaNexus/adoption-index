import{test}from'node:test';import assert from'node:assert/strict';import{sevenDayAcceptance,acceptanceReport}from'../src/acceptance.mjs';import{addDays}from'../src/scoring.mjs';
const now=new Date('2026-09-27T12:00:00Z');
const run=(day,extra={})=>({kind:'daily',trigger:'scheduler',status:'succeeded',started_at:`${day}T00:00:00Z`,completed_at:`${day}T00:30:00Z`,through_day:addDays(day,-1),...extra});
test('requires seven real separate elapsed scheduled days',()=>{const runs=['2026-09-20','2026-09-21','2026-09-22','2026-09-23','2026-09-24','2026-09-25','2026-09-26'].map(d=>run(d));assert.equal(sevenDayAcceptance(runs,now).passed,true);assert.equal(sevenDayAcceptance(runs.slice(1),now).passed,false);assert.equal(sevenDayAcceptance(runs.map(r=>({...r,trigger:'manual'})),now).passed,false);assert.equal(sevenDayAcceptance(Array(7).fill(run('2026-09-26')),now).passed,false);assert.equal(sevenDayAcceptance(runs.map(r=>({...r,kind:'backfill'})),now).passed,false)});
test('today can be seventh run but an incorrect data date or midday run cannot qualify',()=>{const runs=Array.from({length:7},(_,i)=>run(addDays('2026-09-21',i)));assert.equal(sevenDayAcceptance(runs,now).passed,true);assert.equal(sevenDayAcceptance(runs.map(r=>({...r,through_day:'2026-09-26'})),now).passed,false);assert.equal(sevenDayAcceptance(runs.map(r=>({...r,started_at:r.started_at.replace('00:00:00','12:00:00')})),now).passed,false);assert.equal(sevenDayAcceptance(runs,new Date('2026-09-27T00:20:00Z')).passed,false)});

import{evidenceDigest,sampleStillMatches}from'../src/acceptance.mjs';import{METHOD_VERSION}from'../src/scoring.mjs';
test('reproduction evidence becomes invalid when raw input or published formula changes',()=>{const rows=[{day:'2026-09-25',addresses:123}],snapshot={baselineDay:'2026-09-25',day:'2026-09-25',score:42,methodVersion:METHOD_VERSION};const sample={baselineDay:snapshot.baselineDay,day:snapshot.day,stored:42,methodVersion:METHOD_VERSION,passed:true,rawSeriesSha256:evidenceDigest(rows),snapshotSha256:evidenceDigest(snapshot)};assert.equal(sampleStillMatches(sample,rows,snapshot),true);assert.equal(sampleStillMatches(sample,[{...rows[0],addresses:124}],snapshot),false);assert.equal(sampleStillMatches({...sample,methodVersion:'obsolete'},rows,snapshot),false);assert.equal(sampleStillMatches({...sample,baselineDay:'2026-09-24'},rows,snapshot),false);assert.equal(sampleStillMatches(sample,rows,{...snapshot,score:43}),false)});

test('logical evidence hashes survive nested jsonb key reordering but preserve array order',()=>{
 const original=[{day:'2026-06-29',addresses:438,coverage:{addresses:true,contracts:true},nested:[{z:2,a:1},null]}];
 const reordered=[{nested:[{a:1,z:2},null],coverage:{contracts:true,addresses:true},addresses:438,day:'2026-06-29'}];
 assert.equal(evidenceDigest(original),evidenceDigest(reordered));
 assert.notEqual(evidenceDigest(original),evidenceDigest([{...reordered[0],nested:[null,{a:1,z:2}]}]));
 assert.notEqual(evidenceDigest(original),evidenceDigest([{...reordered[0],addresses:439}]));
 const snapshot={baselineDay:'2026-06-29',day:'2026-06-29',score:65,methodVersion:METHOD_VERSION};
 const sample={passed:true,baselineDay:snapshot.baselineDay,day:snapshot.day,stored:snapshot.score,methodVersion:METHOD_VERSION,rawSeriesSha256:evidenceDigest(original),snapshotSha256:evidenceDigest(snapshot)};
 assert.equal(sampleStillMatches(sample,reordered,Object.fromEntries(Object.entries(snapshot).reverse())),true);
});

test('otherwise complete acceptance stays blocked by account reconstruction or unresolved module identities',async()=>{
 const firstDay='2026-06-29';
 const rows=Array.from({length:90},(_,i)=>({day:addDays(firstDay,i),addresses:10}));
 const snapshot={baselineDay:firstDay,day:rows.at(-1).day,score:100,methodVersion:METHOD_VERSION};
 const sample={baselineDay:snapshot.baselineDay,day:snapshot.day,stored:100,methodVersion:METHOD_VERSION,passed:true,rawSeriesSha256:evidenceDigest(rows),snapshotSha256:evidenceDigest(snapshot)};
 const checkNow=now;
 function db(accountState,identities=0,deployments=[]){return{query:async sql=>{
  if(sql.includes('FROM job_runs'))return{rows:rows.map(r=>run(addDays(r.day,1)))};
  if(sql.startsWith('SELECT day FROM index_snapshots'))return{rows:rows.map(r=>({day:r.day}))};
  if(sql.includes('FROM module_deployments'))return{rows:deployments};
  if(sql.includes('FROM module_identity_reviews'))return{rows:[{count:identities}]};
  if(sql.includes('FROM account_extraction_state'))return{rows:accountState?[accountState]:[]};
  if(sql.includes('FROM source_evidence'))return{rows:[{payload:sample}]};
  if(sql.includes('SELECT raw FROM daily_metrics'))return{rows:rows.map(raw=>({raw}))};
  if(sql.includes('SELECT payload FROM index_snapshots'))return{rows:[{payload:snapshot}]};
  throw new Error('Unexpected SQL: '+sql);
 }}}
 const ready={version:'pact-transfer-v2',status:'ready'};
 const report=await acceptanceReport(db(ready),checkNow);assert.equal(report.dataAcceptancePassed,true);assert.equal(report.milestoneComplete,false);assert.equal(report.initialHistoryDays,90);assert.equal(report.baselineDay,firstDay);
 for(const state of [null,{...ready,status:'repairing'},{...ready,version:'old'}])assert.equal((await acceptanceReport(db(state),checkNow)).dataAcceptancePassed,false);
 assert.equal((await acceptanceReport(db(ready,1),checkNow)).dataAcceptancePassed,false);
 for(const [name,expected] of [['free.test-policy-drift-fixture','review'],['free.bench-fixture','review']]){
  const result=await acceptanceReport(db(ready,0,[{chain:1,name,artifact_status:'included',policy_version:'old'}]),checkNow);
  assert.equal(result.dataAcceptancePassed,false);
  assert.equal(result.moduleArtifactPolicy.mismatches,1);
  assert.equal(result.moduleArtifactPolicy.issues[0].expectedStatus,expected);
 }
 const historical=await acceptanceReport(db(ready,0,[{chain:1,name:'free.fixture-app',artifact_status:'included',policy_version:'historical-version'}]),checkNow);
 assert.equal(historical.dataAcceptancePassed,true);
 assert.equal(historical.moduleArtifactPolicy.passed,true);
});
