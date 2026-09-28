import assert from 'node:assert/strict';
import test from 'node:test';
import { runJob, publishIndex, collectGithubHistory, compactTvlObservation, computeIndex, collectMetricRows, putObservation } from '../src/pipeline.mjs';
import {addDays} from '../src/window.mjs';
import {METHOD_VERSION} from '../src/scoring.mjs';
const collectionState={start_day:'2026-06-29',initial_history_days:90,method_version:METHOD_VERSION,history_policy:'growing-permanent'};
const FIRST_DAY='2026-06-29',THROUGH_DAY='2026-09-26';

function failingAuditDatabase({ failInsert = false, failUpdate = false } = {}) {
  const calls = { acquired: 0, unlocked: 0, released: 0, inserted: 0, updated: 0 };
  const lock = {
    async query(sql) {
      if (sql.includes('pg_try_advisory_lock')) { calls.acquired += 1; return { rows: [{ locked: true }] }; }
      if (sql.includes('pg_advisory_unlock')) { calls.unlocked += 1; return { rows: [{ pg_advisory_unlock: true }] }; }
      assert.fail(`Unexpected lock query: ${sql}`);
    },
    release() { calls.released += 1; },
  };
  const db = {
    async connect() { return lock; },
    async query(sql) {
      if (sql.startsWith('INSERT INTO job_runs')) {
        calls.inserted += 1;
        if (failInsert) throw new Error('simulated job audit insert failure');
        return { rows: [{ id: 41 }] };
      }
      if (sql.startsWith('UPDATE job_runs')) {
        calls.updated += 1;
        if (failUpdate) throw new Error('simulated job audit update failure');
        return { rows: [], rowCount: 1 };
      }
      assert.fail(`Unexpected pool query: ${sql}`);
    },
  };
  return { db, calls };
}

const sourceFailure = async () => { throw new Error('source down'); };

test('publication advisory lock and pooled connection are released when job audit INSERT fails', async () => {
  const { db, calls } = failingAuditDatabase({ failInsert: true });
  await assert.rejects(runJob(db, { indexer: sourceFailure }), /simulated job audit insert failure/);
  assert.equal(calls.acquired, 1);
  assert.equal(calls.inserted, 1);
  assert.equal(calls.unlocked, 1, 'a failed audit insert must not strand the session advisory lock');
  assert.equal(calls.released, 1, 'the acquired pool client must always be returned');
});

test('publication advisory lock and pooled connection are released when final job audit UPDATE fails', async () => {
  const { db, calls } = failingAuditDatabase({ failUpdate: true });
  await assert.rejects(runJob(db, { indexer: sourceFailure }), /simulated job audit update failure/);
  assert.equal(calls.acquired, 1);
  assert.equal(calls.inserted, 1);
  assert.equal(calls.updated, 1);
  assert.equal(calls.unlocked, 1, 'an audit update failure must not skip unlocking');
  assert.equal(calls.released, 1, 'an audit update failure must not leak the pool client');
});

test('ordinary source failure records incomplete status and releases the publication lock exactly once', async () => {
  const { db, calls } = failingAuditDatabase();
  const result = await runJob(db, { indexer: sourceFailure });
  assert.equal(result.status, 'incomplete');
  assert.equal(result.error.message, 'source down');
  assert.deepEqual(calls, { acquired: 1, unlocked: 1, released: 1, inserted: 1, updated: 1 });
});

function publicationDatabase(deployments, contractCounts = [{day:FIRST_DAY,n:1}], checkpoints=Array.from({length:20},(_,chain)=>({chain,coverage_start:FIRST_DAY,block_time:addDays(THROUGH_DAY,1)+'T00:00:00Z'}))) {
  const calls = [];
  const client = {
    async query(sql) {
      calls.push(sql);
      if (sql.includes('FROM collection_state'))return{rows:[collectionState]};
      if (sql.includes('FROM chain_checkpoints')) return {rows:checkpoints};
      if (sql.includes('FROM account_extraction_state')) return {rows:[{version:'pact-transfer-v2',status:'ready'}]};
      if (sql.includes('FROM module_identity_reviews')) return {rows:[{n:0}]};
      if (sql.includes("artifact_status='included'")) return {rows:contractCounts};
      if (sql.includes('FROM module_deployments')) return {rows:deployments};
      if (sql.includes('SELECT max(day)')) return {rows:[{day:null}]};
      if (sql.startsWith('SELECT day,raw,method_version') || sql.startsWith('SELECT day,payload FROM index_snapshots'))return {rows:[]};
      if (['BEGIN','COMMIT','ROLLBACK','LOCK TABLE module_deployments IN SHARE MODE'].includes(sql) || sql.includes('pg_advisory_xact_lock') || sql.startsWith('INSERT INTO ') || sql.startsWith('DELETE FROM ')) return {rows:[]};
      assert.fail(`Unexpected publication query: ${sql}`);
    },
    release() {calls.push('release');},
  };
  return {db:{connect:async()=>client}, calls};
}
const publishRow = {day:FIRST_DAY,addresses:3,contracts:1,tvlKda:100,tvlUsd:10,kdaUsd:.1,hashratePh:2,commits:2,registryVersion:'fixture',coverage:{addresses:true,contracts:true,tvl:true,hashrate:true,commits:true}};

const publicationRows=()=>Array.from({length:90},(_,i)=>({...publishRow,day:addDays(FIRST_DAY,i),contracts:i===0?1:0}));

test('direct publication locks classifications and rolls back before writes on current policy drift or review', async () => {
  for (const [name,status] of [['free.test-policy-drift-fixture','included'],['free.bench-lottery-a1247acc','included'],['free.test-policy-drift-fixture','review']]) {
    const {db,calls} = publicationDatabase([{chain:1,name,artifact_status:status,policy_version:'historical'}]);
    await assert.rejects(publishIndex(db,publicationRows(),{throughDay:THROUGH_DAY}), error => error.code === 'MODULE_ARTIFACT_POLICY_REVIEW_REQUIRED');
    assert.ok(calls.indexOf('LOCK TABLE module_deployments IN SHARE MODE') < calls.findIndex(sql=>sql.includes('FROM module_deployments')));
    assert.ok(calls.includes('ROLLBACK'));
    assert.ok(!calls.includes('COMMIT'));
    assert.ok(!calls.some(sql=>sql.startsWith('INSERT INTO ')), 'no snapshots or raw daily metrics may be written');
    assert.equal(calls.at(-1), 'release');
  }
});

test('direct publication permits explicit inclusion and unchanged older policy stamps', async () => {
  const {db,calls} = publicationDatabase([{chain:1,name:'free.product-policy-fixture',artifact_status:'included',policy_version:'historical'}]);
  const result = await publishIndex(db,publicationRows(),{throughDay:THROUGH_DAY});
  assert.equal(result.days,90);
  assert.ok(calls.includes('COMMIT'));
  assert.equal(calls.filter(sql=>sql.startsWith('INSERT INTO ')).length,180);
});

test('publication rejects old raw counts after classification reconciliation has already completed', async () => {
  const {db,calls} = publicationDatabase([{chain:1,name:'free.product-policy-fixture',artifact_status:'included',policy_version:'current'}],[]);
  await assert.rejects(publishIndex(db,publicationRows(),{throughDay:THROUGH_DAY}), error => {
    assert.equal(error.code,'MODULE_CONTRACT_COUNTS_CHANGED');
    assert.deepEqual(error.details.days,[{day:FIRST_DAY,supplied:1,current:0}]);
    return true;
  });
  assert.ok(calls.includes('ROLLBACK'));
  assert.ok(!calls.some(sql=>sql.startsWith('INSERT INTO ')));
  const corrected = publicationDatabase([{chain:1,name:'free.product-policy-fixture',artifact_status:'included',policy_version:'current'}],[]);
  assert.equal((await publishIndex(corrected.db,publicationRows().map(row=>({...row,contracts:0})),{throughDay:THROUGH_DAY})).days,90);
});

test('direct publication requires the full initial ninety days and every subsequent day',async()=>{
 await assert.rejects(publishIndex({},[publishRow],{throughDay:FIRST_DAY}),/initial 90 completed days/);
 await assert.rejects(publishIndex({},[publishRow],{throughDay:THROUGH_DAY}),/fixed collection start/);
 await assert.rejects(publishIndex({},publicationRows().slice(1),{throughDay:THROUGH_DAY}),/fixed collection start/);
});
test('GitHub initially requests ninety days and keeps source evidence without raw API bodies',async()=>{
 const calls=[],client={query:async(sql,args)=>{calls.push({sql,args});return {rows:sql.includes('FROM collection_state')?[collectionState]:[]}},release(){}};
 const db={connect:async()=>client,query:async()=>({rows:[]})};
 const result=await collectGithubHistory(db,{throughDay:THROUGH_DAY,collector:async options=>{
  assert.equal(options.fromDay,FIRST_DAY);assert.equal(options.fromTimestamp,FIRST_DAY+'T00:00:00Z');
  return {days:publicationRows().map(row=>({day:row.day,commits:0})),repositories:[],sourceRefs:['fixture'],commitLedger:[],evidence:[{bodySha256:'digest',rawBody:'DO NOT RETAIN'}],collection:{cache:null}};
 }});
 assert.equal(result.days,90);
 assert.ok(!JSON.stringify(calls).includes('DO NOT RETAIN'));
 assert.ok(!calls.some(call=>call.sql.startsWith('DELETE FROM ')));
});

test('TVL observation keeps validated totals and boundary pins without duplicating raw state or escrow lists',()=>{
 const raw={tvlKda:12,tvlUsd:3,kdaUsd:.25,registryVersion:'fixture',protocols:[{id:'brodex',chain:'2',tvlKda:12,positions:['large-escrow-list'],ownership:['raw-ownership']}],evidence:{reads:[{chain:'2',header:{hash:'a'},metadata:{prevBlockHash:'a'},raw:'RAW STATE'}]}};
 const compact=compactTvlObservation(raw);
 assert.equal(compact.tvlKda,12);assert.deepEqual(compact.evidence.reads[0],{chain:'2',header:{hash:'a'},metadata:{prevBlockHash:'a'}});
 assert.equal(JSON.stringify(compact).includes('RAW STATE'),false);assert.equal(JSON.stringify(compact).includes('large-escrow-list'),false);
});
test('compute rejects incomplete collection chain rows before fetching additional source data',async()=>{
 await assert.rejects(computeIndex({query:async()=>assert.fail('no source reads')},{throughDay:THROUGH_DAY,chainMetrics:async()=>[publishRow],cutProvider:async()=>assert.fail('no network')}),/every day since the fixed collection start/);
});

test('publication rejects a moved collection baseline even when all contract counts are unchanged',async()=>{
 const checkpoints=Array.from({length:20},(_,chain)=>({chain,coverage_start:addDays(FIRST_DAY,1),block_time:addDays(THROUGH_DAY,2)+'T00:00:00Z'}));
 const {db,calls}=publicationDatabase([],[],checkpoints);
 await assert.rejects(publishIndex(db,publicationRows().map(row=>({...row,contracts:0})),{throughDay:THROUGH_DAY}),error=>error.code==='COLLECTION_COVERAGE_CHANGED');
 assert.ok(calls.includes('ROLLBACK'));assert.ok(!calls.some(sql=>sql.startsWith('INSERT INTO ')||sql.startsWith('DELETE FROM ')));
 assert.ok(calls.findIndex(sql=>sql.includes('pg_advisory_xact_lock'))<calls.findIndex(sql=>sql.includes('FROM chain_checkpoints')));
});
test('publication rejects missing chains and an unfinished collection cutoff before changing data',async()=>{
 for(const checkpoints of [[],Array.from({length:20},(_,chain)=>({chain,coverage_start:FIRST_DAY,block_time:THROUGH_DAY+'T23:59:59Z'}))]){
  const {db,calls}=publicationDatabase([],[],checkpoints);
  await assert.rejects(publishIndex(db,publicationRows().map(row=>({...row,contracts:0})),{throughDay:THROUGH_DAY}),error=>error.code==='COLLECTION_COVERAGE_CHANGED');
  assert.ok(!calls.some(sql=>sql.startsWith('INSERT INTO ')));
 }
});

test('GitHub daily updates fetch only missing days and never delete old source evidence',async()=>{
 const calls=[],client={query:async(sql,args)=>{calls.push({sql,args});return{rows:sql.includes('FROM collection_state')?[collectionState]:[],rowCount:1}},release(){}};
 const db={connect:async()=>client,query:async()=>({rows:publicationRows().slice(0,-1).map(row=>({day:row.day}))})};
 const result=await collectGithubHistory(db,{throughDay:THROUGH_DAY,collector:async options=>{
  assert.equal(options.fromDay,THROUGH_DAY);assert.equal(options.fromTimestamp,THROUGH_DAY+'T00:00:00Z');
  return{days:[{day:THROUGH_DAY,commits:3}],commitLedger:Array.from({length:3},(_,i)=>({sha:String(i+1).padStart(40,'0'),day:THROUGH_DAY,timestamp:Date.parse(THROUGH_DAY+'T12:00:00Z'),merge:false,bot:false})),repositories:[],sourceRefs:[],evidence:[],collection:{cache:null}};
 }});
 assert.equal(result.days,1);assert.equal(result.existingDays,89);
 assert.ok(!calls.some(call=>call.sql.startsWith('DELETE ')));
 assert.equal(calls.filter(call=>call.sql.startsWith('INSERT INTO source_observations')).length,1);
});
test('GitHub history gaps fail before requests and complete history makes no requests',async()=>{
 const collector=async()=>assert.fail('must not fetch');
 await assert.rejects(collectGithubHistory({query:async()=>({rows:[{day:addDays(FIRST_DAY,1)}]})},{throughDay:THROUGH_DAY,collector}),error=>error.code==='GITHUB_HISTORY_GAP');
 const result=await collectGithubHistory({query:async()=>({rows:publicationRows().map(row=>({day:row.day}))})},{throughDay:THROUGH_DAY,collector});
 assert.equal(result.upToDate,true);assert.equal(result.days,0);
});
test('a slow TVL read cannot insert evidence after a collection baseline change',async()=>{
 const {loadRegistry}=await import('../src/tvl.mjs');const registry=await loadRegistry(),calls=[];
 const headers=Object.fromEntries(['1','2','5'].map(chain=>[chain,{height:12,hash:'canonical-'+chain,creationTime:1000}]));
 const tvl={tvlKda:100,tvlUsd:10,kdaUsd:.1,registryVersion:registry.version,protocols:[],evidence:{reads:Object.entries(headers).map(([chain,header])=>({chain,header,metadata:{prevBlockHash:header.hash,blockHeight:13,blockTime:1000}}))}};
 const client={query:async sql=>{calls.push(sql);if(sql.includes('FROM collection_state'))return{rows:[collectionState]};if(sql.includes('FROM chain_checkpoints'))return{rows:Array.from({length:20},(_,chain)=>({chain,coverage_start:addDays(FIRST_DAY,1),block_time:addDays(THROUGH_DAY,2)+'T00:00:00Z'}))};return{rows:[]}},release(){}};
 const db={connect:async()=>client,query:async(sql,args)=>{
  if(args[0]==='github')return{rows:publicationRows().map(row=>({day:row.day,payload:{commits:0}}))};
  return{rows:[]};
 }};
 await assert.rejects(computeIndex(db,{throughDay:THROUGH_DAY,chainMetrics:async()=>publicationRows().map(row=>({...row,headers})),cutProvider:async()=>({}),tvlCollector:async()=>tvl}),error=>error.code==='COLLECTION_COVERAGE_CHANGED');
 assert.ok(calls.includes('ROLLBACK'));assert.ok(!calls.some(sql=>sql.startsWith('INSERT INTO ')));
});

test('stored source observations cannot be silently rewritten when a historical source changes',async()=>{
 const payload={commits:3},db={query:async sql=>sql.startsWith('INSERT')?{rows:[],rowCount:0}:{rows:[{payload}]}};
 await putObservation(db,'github',FIRST_DAY,'fixture',payload);
 await assert.rejects(putObservation(db,'github',FIRST_DAY,'fixture',{commits:4}),error=>error.code==='HISTORICAL_SOURCE_CHANGED');
});
test('repeated publication preserves existing scores and rejects a changed historical raw value',async()=>{
 const {calculateSeries,METHOD_VERSION}=await import('../src/scoring.mjs');
 const rows=publicationRows(),snapshots=calculateSeries(rows,{throughDay:THROUGH_DAY});
 const base=publicationDatabase([]),originalConnect=base.db.connect;
 base.db.connect=async()=>{
  const client=await originalConnect(),query=client.query;
  client.query=async sql=>{
   if(sql.startsWith('SELECT day,raw,method_version'))return{rows:rows.map(raw=>({day:raw.day,raw,method_version:METHOD_VERSION}))};
   if(sql.startsWith('SELECT day,payload FROM index_snapshots'))return{rows:snapshots.map(payload=>({day:payload.day,payload}))};
   return query(sql);
  };return client;
 };
 const result=await publishIndex(base.db,rows,{throughDay:THROUGH_DAY});
 assert.equal(result.days,90);assert.ok(!base.calls.some(sql=>sql.startsWith('INSERT ')||sql.startsWith('UPDATE ')||sql.startsWith('DELETE ')));
 await assert.rejects(publishIndex(base.db,rows.map((row,i)=>i?row:{...row,addresses:row.addresses+1}),{throughDay:THROUGH_DAY}),error=>error.code==='PUBLISHED_HISTORY_CHANGED');
});
test('one real-data-shaped day can be staged without writing daily metrics or publishing a score',async()=>{
 const {loadRegistry}=await import('../src/tvl.mjs');const registry=await loadRegistry(),calls=[];
 const headers=Object.fromEntries(['1','2','5'].map(chain=>[chain,{height:12,hash:'canonical-'+chain,creationTime:1000}]));
 const tvl={tvlKda:100,tvlUsd:10,kdaUsd:.1,registryVersion:registry.version,evidence:{reads:Object.entries(headers).map(([chain,header])=>({chain,header,metadata:{prevBlockHash:header.hash,blockHeight:13,blockTime:1000}}))}};
 const db={query:async(sql,args)=>{calls.push(sql);return{rows:args[0]==='github'?[{day:FIRST_DAY,payload:{commits:2}}]:[{payload:tvl}]}}};
 const rows=await collectMetricRows(db,{throughDay:FIRST_DAY,chainMetrics:async()=>[{...publishRow,headers}],cutProvider:async()=>({})});
 assert.equal(rows.length,1);assert.equal(rows[0].commits,2);assert.equal(rows[0].tvlKda,100);
 assert.ok(calls.every(sql=>sql.startsWith('SELECT ')));
});


test('a GitHub retry with identical commit decisions keeps the first observation despite changed acquisition metadata',async()=>{
 const payload={day:FIRST_DAY,commits:1,collectionStart:FIRST_DAY,commitLedgerDigest:'same',repositories:[{head:'old'}],throughDay:FIRST_DAY};
 const db={query:async sql=>sql.startsWith('INSERT')?{rows:[],rowCount:0}:{rows:[{payload}]}};
 await putObservation(db,'github',FIRST_DAY,'fixture',{...payload,repositories:[{head:'new'}],throughDay:THROUGH_DAY});
 await assert.rejects(putObservation(db,'github',FIRST_DAY,'fixture',{...payload,commitLedgerDigest:'different'}),error=>error.code==='HISTORICAL_SOURCE_CHANGED');
});
