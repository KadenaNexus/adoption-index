import {test} from 'node:test';
import assert from 'node:assert/strict';
import {randomBytes,createHash} from 'node:crypto';
import {mkdtemp,readFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {spawnSync} from 'node:child_process';
import {acceptanceReport,evidenceDigest} from '../src/acceptance.mjs';
import {database} from '../src/db.mjs';
import {migrate,migrateMethod} from '../src/migrate.mjs';
import {publishIndex} from '../src/pipeline.mjs';
import {stagedReport} from '../src/staging.mjs';
import {createServer} from '../src/server.mjs';
import {persistBlock,persistBlocks,dailyChainMetrics,rebaseChain,pruneRetention} from '../src/ingest.mjs';
import {FORK_HEIGHT,METHOD_VERSION,calculateSeries} from '../src/scoring.mjs';
import {windowFor,addDays,completedDay,COLLECTION_START} from '../src/window.mjs';
const connection=process.env.TEST_DATABASE_URL;
const hash=value=>createHash('sha256').update(String(value)).digest('base64url');
const target=Buffer.alloc(32,255).toString('base64url');
const policy={version:'test',includedModules:[],excludedModules:[],reviewNamePatterns:[]};
const header=(chain,height,time)=>({chainId:chain,height,hash:hash(`${chain}:${height}`),parent:hash(`${chain}:${height-1}`),payloadHash:hash(`payload:${chain}:${height}`),target,weight:hash('weight'),creationTime:Date.parse(time)*1000+123,chainwebVersion:'mainnet01'});
const tx=(requestKey,modules,participants=['alice'])=>({requestKey,success:true,modules,participants,code:'fixture source',result:'fixture',signers:[],sender:'alice'});
const declaration=name=>({identityResolved:true,qualifiedName:name});
const block=(h,transactions=[])=>({header:h,blockTime:new Date(h.creationTime/1000).toISOString(),payload:{fixture:h.hash},transactions});
async function isolated(t){
 const url=new URL(connection);if(!url.pathname.endsWith('_test'))throw new Error('Integration tests require a dedicated *_test database');
 const schema='compact_'+randomBytes(8).toString('hex'),admin=database(connection);
 await admin.query(`CREATE SCHEMA ${schema}`);url.searchParams.set('options',`-c search_path=${schema}`);const db=database(url.href);
 t.after(async()=>{await db.end();try{await admin.query(`DROP SCHEMA ${schema} CASCADE`)}finally{await admin.end()}});
 await migrate(db);await migrate(db);db.testConnectionString=url.href;return db;
}
async function baseline(db,chain,window,{height=FORK_HEIGHT-1,modules=['coin','free.old']}={}){
 const before=header(chain,height,addDays(window.fromDay,-1)+'T23:59:59Z');
 await rebaseChain(db,{chain,before,inventory:{chain,height,blockHash:before.hash,modules},window,tipHash:hash('tip')});return before;
}

test('PostgreSQL compact ingestion: bounded replay, exact work, atomic source proofs, growing-history publication and API authorization',{skip:!connection},async t=>{
 const db=await isolated(t),window=windowFor(),day=window.fromDay;
 const empty=await acceptanceReport(db);
 assert.equal(empty.missingBackfillDays.length,window.days);assert.equal(empty.missingBackfillDays[0],window.fromDay);assert.equal(empty.missingBackfillDays.at(-1),window.throughDay);
 assert.equal(empty.localDataReady,false);assert.equal(empty.dataAcceptancePassed,false);assert.equal(empty.milestoneComplete,false);
 const server=createServer(db);await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));t.after(()=>new Promise(resolve=>server.close(resolve)));
 const base=`http://127.0.0.1:${server.address().port}`,get=(path,key)=>fetch(base+path,{headers:key?{'X-API-Key':key}:{}});
 assert.equal((await get('/index/today')).status,503);assert.equal((await get('/metrics/breakdown')).status,401);
 for(let chain=0;chain<20;chain++)await baseline(db,chain,window);
 const h=header(0,FORK_HEIGHT,day+'T00:00:10Z');
 const first=block(h,[tx('old',[declaration('free.old')],['alice','bob']),tx('new',[declaration('free.real')],['alice','carol']),
  tx('unknown',[{identityResolved:false,literalName:'unknown',identitySource:'unresolved'}],['alice'])]);
 assert.equal(await persistBlock(db,first,policy),true);assert.equal(await persistBlock(db,first,policy),false);
 assert.deepEqual((await db.query('SELECT name,kind FROM module_deployments ORDER BY name')).rows,[{name:'free.old',kind:'upgrade'},{name:'free.real',kind:'new'}]);
 const bad=block(header(0,FORK_HEIGHT+1,day+'T00:00:40Z'),[tx('invalid',[],['dan',''])]);
 await assert.rejects(persistBlock(db,bad,policy),/Invalid decoded account/);
 assert.equal((await db.query('SELECT block_count FROM daily_chain_stats WHERE chain=0')).rows[0].block_count,'1');
 for(const [offset,count] of [[1,500],[501,200]])await persistBlocks(db,Array.from({length:count},(_,i)=>block(header(0,FORK_HEIGHT+offset+i,new Date(Date.parse(day+'T00:00:10Z')+(offset+i)*30000).toISOString()))),policy);
 assert.equal((await db.query('SELECT count(*)::int AS n FROM blocks WHERE chain=0')).rows[0].n,500);
 assert.equal((await db.query('SELECT work::text,block_count::text FROM daily_chain_stats WHERE chain=0')).rows[0].work,'701');
 assert.equal((await db.query('SELECT count(*)::int AS n FROM daily_accounts')).rows[0].n,3);
 const proof=(await db.query('SELECT evidence FROM module_identity_reviews')).rows[0].evidence;
 assert.equal(proof.sourceHeader.hash,h.hash);assert.equal(proof.code,'fixture source');
 await assert.rejects(persistBlock(db,first,policy),/bounded header tail/);
 await assert.rejects(dailyChainMetrics(db,window.throughDay),error=>error.code==='MODULE_IDENTITY_REVIEW_REQUIRED');
 // Test fixture reconciliation only. Production never silently clears this queue.
 await db.query("DELETE FROM module_identity_reviews WHERE request_key='unknown'");
 for(let chain=1;chain<20;chain++)await persistBlock(db,block(header(chain,FORK_HEIGHT,day+'T00:00:10Z')),policy);
 for(let chain=0;chain<20;chain++)await persistBlock(db,block(header(chain,FORK_HEIGHT+(chain===0?701:1),window.cutoff)),policy);
 const metrics=await dailyChainMetrics(db,window.throughDay);
 assert.equal(metrics.length,window.days);assert.equal(metrics[0].addresses,3);assert.equal(metrics[0].contracts,1);
 assert.equal(metrics[0].upgrades,1);assert.equal(metrics[0].headers['0'].creationTime,Date.parse(day+'T00:00:10Z')*1000+700*30000000+123);
 assert.ok(Math.abs(metrics[0].hashratePh-720/86400/1e15)<1e-25);
 assert.equal(metrics[1].addresses,0);assert.deepEqual(metrics.at(-1).headers,metrics[0].headers);
 const rows=metrics.map(({headers,...r})=>({...r,tvlKda:100,tvlUsd:10,kdaUsd:.1,commits:2,registryVersion:'fixture',coverage:{addresses:true,contracts:true,tvl:true,hashrate:true,commits:true}}));
 await assert.rejects(publishIndex(db,rows.map(r=>({...r,coverage:{}})),{throughDay:window.throughDay}),/coverage/);
 await publishIndex(db,rows,{throughDay:window.throughDay});
 assert.equal((await db.query('SELECT count(*)::int AS n FROM index_snapshots')).rows[0].n,window.days);
 const withoutSample=await acceptanceReport(db);assert.equal(withoutSample.missingBackfillDays.length,0);assert.equal(withoutSample.localDataReady,false);assert.equal(withoutSample.sampleCurrent,false);
 const storedRaw=(await db.query('SELECT raw FROM daily_metrics ORDER BY day')).rows.map(row=>row.raw);
 const storedSnapshot=(await db.query('SELECT payload FROM index_snapshots WHERE day=$1',[window.throughDay])).rows[0].payload;
 // Hash in-memory source values, then verify the actual jsonb round trip.
 const inputSnapshot=calculateSeries(rows,{throughDay:window.throughDay}).at(-1);
 assert.notEqual(JSON.stringify(rows[0]),JSON.stringify(storedRaw[0]));
 assert.equal(evidenceDigest(rows),evidenceDigest(storedRaw));
 assert.equal(evidenceDigest(inputSnapshot),evidenceDigest(storedSnapshot));
 const sample={passed:true,methodVersion:METHOD_VERSION,baselineDay:window.fromDay,day:window.throughDay,stored:storedSnapshot.score,rawSeriesSha256:evidenceDigest(rows),snapshotSha256:evidenceDigest(inputSnapshot)};
 await db.query("INSERT INTO source_evidence(source,day,digest,payload) VALUES('manual-score-reproduction',$1,$2,$3)",[window.throughDay,evidenceDigest(sample),sample]);
 const staged={...stagedReport([rows[0]],{day:window.fromDay,baselineRows:rows}),githubLedgerAuditPassed:true};
 await db.query("INSERT INTO source_evidence(source,day,digest,payload) VALUES('staged-real-day',$1,$2,$3)",[window.fromDay,evidenceDigest(staged),staged]);
 const ready=await acceptanceReport(db);assert.equal(ready.missingBackfillDays.length,0);assert.equal(ready.localDataReady,true);assert.equal(ready.sampleCurrent,true);assert.equal(ready.stagedRunReady,true);assert.equal(ready.readyForPipelineReview,true);assert.equal(ready.unattended.passed,false);assert.equal(ready.dataAcceptancePassed,false);assert.equal(ready.milestoneComplete,false);
 assert.notEqual(JSON.stringify(staged.rawSeries),JSON.stringify(ready.stagedRun.rawSeries));
 assert.equal(ready.stagedRun.rawSeriesSha256,evidenceDigest(ready.stagedRun.rawSeries));
 // Exercise actual CLI queries rather than reproducing their SQL in a mock:
 // PostgreSQL must infer date bounds and JSON text comparisons compatibly.
 const exportDir=await mkdtemp(join(tmpdir(),'kce-compact-export-test-'));t.after(()=>rm(exportDir,{recursive:true,force:true}));
 const exported=spawnSync(process.execPath,[fileURLToPath(new URL('../src/cli.mjs',import.meta.url)),'export','--directory',exportDir],{encoding:'utf8',env:{...process.env,DATABASE_URL:db.testConnectionString}});
 assert.equal(exported.status,0,exported.stderr||exported.stdout);
 const exportedMetrics=JSON.parse(await readFile(join(exportDir,'daily-metrics.json'),'utf8')),exportedHistory=JSON.parse(await readFile(join(exportDir,'index-history.json'),'utf8'));
 assert.equal(exportedMetrics.length,window.days);assert.equal(exportedHistory.length,window.days);assert.equal(exportedHistory[0].day,window.fromDay);assert.equal(exportedHistory.at(-1).day,window.throughDay);
 assert.equal(JSON.parse(await readFile(join(exportDir,'acceptance.json'),'utf8')).localDataReady,true);
 assert.equal(JSON.parse(await readFile(join(exportDir,'manifest.json'),'utf8')).completeHistory,true);
 const today=await(await get('/index/today')).json();assert.equal(today.date,window.throughDay);assert.equal(today.baselineDay,window.fromDay);assert.equal(today.initialHistoryDays,90);assert.equal(today.components,undefined);
 const key=randomBytes(32).toString('base64url');await db.query('INSERT INTO api_keys(label,key_hash) VALUES($1,$2)',['test',createHash('sha256').update(key).digest('hex')]);
 const history=await(await get('/index/history?range=all',key)).json();assert.equal(history.series.length,window.days);assert.equal(history.summaryRetention,'permanent');assert.equal(history.availableRanges['1y'],false);
 assert.equal((await get('/index/history?range=garbage',key)).status,400);
 const breakdown=await(await get('/metrics/breakdown',key)).json();assert.equal(breakdown.metrics.length,5);assert.equal(breakdown.methodVersion,METHOD_VERSION);
 await db.query(`INSERT INTO module_deployments(chain,height,block_hash,block_time,request_key,name,kind,artifact_status,policy_version,evidence) VALUES(1,$1,$2,$3,'drift','free.test-policy-drift','new','included','old','{}')`,[FORK_HEIGHT,h.hash,first.blockTime]);
 await assert.rejects(publishIndex(db,rows,{throughDay:window.throughDay}),error=>error.code==='MODULE_ARTIFACT_POLICY_REVIEW_REQUIRED');
 await db.query("DELETE FROM module_deployments WHERE request_key='drift'");
 await assert.rejects(publishIndex(db,rows.map((r,i)=>i? r:{...r,contracts:2}),{throughDay:window.throughDay}),error=>error.code==='MODULE_CONTRACT_COUNTS_CHANGED');
 await db.query('UPDATE api_keys SET revoked_at=now()');assert.equal((await get('/metrics/breakdown',key)).status,401);
});

test('growing collection preserves days, source evidence, identities and classifications beyond the initial 90 days',{skip:!connection},async t=>{
 const now=Date.parse(addDays(COLLECTION_START,181)+'T12:00:00Z');
 t.mock.timers.enable({apis:['Date'],now});
 const db=await isolated(t),window=windowFor();assert.equal(window.days,181);
 const before=await baseline(db,0,window);
 const first=header(0,FORK_HEIGHT,COLLECTION_START+'T00:00:10Z');
 await persistBlock(db,block(first,[tx('first',[declaration('free.mystery')])]),policy);
 const lateDay=addDays(COLLECTION_START,170);
 const late=header(0,FORK_HEIGHT+1,lateDay+'T00:00:10Z');
 await persistBlock(db,block(late,[tx('later',[declaration('free.mystery')]),tx('unknown',[{identityResolved:false,literalName:'unknown',identitySource:'unresolved'}])]),policy);
 await db.query("INSERT INTO source_observations(source,day,version,payload) VALUES('fixture',$1,'v','{}'),('fixture',$2,'v','{}')",[COLLECTION_START,lateDay]);
 await db.query("INSERT INTO source_evidence(source,day,digest,payload) VALUES('fixture',$1,'proof','{}')",[COLLECTION_START]);
 await db.query("INSERT INTO daily_metrics(day,raw,coverage,registry_version,method_version) VALUES($1,'{}','{}','fixture',$2)",[COLLECTION_START,METHOD_VERSION]);
 await db.query("INSERT INTO index_snapshots(day,score,payload) VALUES($1,75,'{}')",[COLLECTION_START]);
 await pruneRetention(db,window.throughDay);
 assert.deepEqual((await db.query('SELECT day FROM daily_chain_stats ORDER BY day')).rows,[{day:COLLECTION_START},{day:lateDay}]);
 assert.deepEqual((await db.query('SELECT day FROM daily_accounts ORDER BY day')).rows,[{day:COLLECTION_START},{day:lateDay}]);
 assert.deepEqual((await db.query('SELECT day FROM source_observations ORDER BY day')).rows,[{day:COLLECTION_START},{day:lateDay}]);
 assert.equal((await db.query('SELECT count(*)::int AS n FROM source_evidence')).rows[0].n,1);
 assert.equal((await db.query('SELECT count(*)::int AS n FROM index_snapshots')).rows[0].n,1);
 assert.equal((await db.query('SELECT count(*)::int AS n FROM module_identity_reviews')).rows[0].n,1);
 assert.deepEqual((await db.query('SELECT kind FROM module_deployments ORDER BY height')).rows.map(row=>row.kind),['new','upgrade']);
 const checkpoint=(await db.query('SELECT baseline_header,coverage_start,height,baseline_inventory FROM chain_checkpoints')).rows[0];
 assert.equal(checkpoint.baseline_header.hash,before.hash);assert.equal(checkpoint.coverage_start,COLLECTION_START);
 await rebaseChain(db,{chain:0,before,inventory:checkpoint.baseline_inventory,window,tipHash:hash('another-tip')});
 assert.equal((await db.query('SELECT height FROM chain_checkpoints')).rows[0].height,checkpoint.height);
 await assert.rejects(rebaseChain(db,{chain:0,before:late,inventory:{chain:0,height:late.height,blockHash:late.hash,modules:['coin','free.mystery']},window:{...window,fromDay:lateDay,startTime:lateDay+'T00:00:00Z'},tipHash:hash('tip')}),/Invalid fixed collection inventory/);
 await assert.rejects(dailyChainMetrics(db,window.throughDay),error=>error.code==='MODULE_IDENTITY_REVIEW_REQUIRED');
 assert.equal((await db.query('SELECT count(*)::int AS n FROM module_identity_reviews')).rows[0].n,1);
});

test('schema v7 metadata is durable and incompatible start/method changes preserve stored history',{skip:!connection},async t=>{
 const db=await isolated(t),window=windowFor();
 await baseline(db,0,window);
 assert.equal((await db.query('SELECT max(version)::int AS n FROM schema_migrations')).rows[0].n,8);
 assert.deepEqual((await db.query('SELECT start_day,initial_history_days,method_version,history_policy FROM collection_state')).rows,[{start_day:COLLECTION_START,initial_history_days:90,method_version:METHOD_VERSION,history_policy:'growing-permanent'}]);
 await db.query('UPDATE collection_state SET start_day=$1',[addDays(COLLECTION_START,1)]);
 await assert.rejects(migrate(db),/Immutable collection metadata/);
 assert.equal((await db.query('SELECT count(*)::int AS n FROM chain_checkpoints')).rows[0].n,1);
 await db.query('UPDATE collection_state SET start_day=$1',[COLLECTION_START]);
 await db.query('UPDATE chain_checkpoints SET coverage_start=$1',[addDays(COLLECTION_START,1)]);
 await assert.rejects(migrate(db),/Existing collection start differs/);
 assert.equal((await db.query('SELECT count(*)::int AS n FROM chain_checkpoints')).rows[0].n,1);
 await db.query('UPDATE chain_checkpoints SET coverage_start=$1',[COLLECTION_START]);
 await db.query("INSERT INTO daily_metrics(day,raw,coverage,registry_version,method_version) VALUES($1,'{}','{}','fixture','legacy')",[COLLECTION_START]);
 await assert.rejects(migrate(db),/Existing published scoring method differs/);
 assert.equal((await db.query('SELECT count(*)::int AS n FROM daily_metrics')).rows[0].n,1);
});

test('fixed-baseline publication: scores above 100, idempotent daily runs, no restatement and an explicit audited method migration',{skip:!connection},async t=>{
 const start=Date.parse(addDays(COLLECTION_START,100)+'T12:00:00Z');
 t.mock.timers.enable({apis:['Date'],now:start});
 const db=await isolated(t),window=windowFor();assert.equal(window.days,100);
 const farFuture=addDays(window.throughDay,30)+'T00:00:00Z';
 for(let chain=0;chain<20;chain++)await db.query("INSERT INTO chain_checkpoints(chain,height,hash,block_time,anchor_hash,baseline_inventory,baseline_header,coverage_start) VALUES($1,1,'h','"+farFuture+"','a','{}','{}',$2)",[chain,COLLECTION_START]);
 // Baseline for 30 days, growth to three times baseline, no contracts (the documented minimum applies).
 const factor=i=>i<30?1:i<60?1+(i-29)/15:3;
 const rowFor=i=>({day:addDays(COLLECTION_START,i),addresses:Math.round(100*factor(i)),contracts:0,tvlKda:50*factor(i),tvlUsd:5,kdaUsd:.1,hashratePh:10*factor(i),commits:Math.round(10*factor(i)),registryVersion:'fixture',coverage:{addresses:true,contracts:true,tvl:true,hashrate:true,commits:true}});
 const rows=Array.from({length:window.days},(_,i)=>rowFor(i));
 await publishIndex(db,rows,{throughDay:window.throughDay});
 const snapshots=async()=>(await db.query('SELECT day::text AS day,score::float AS score,payload FROM index_snapshots ORDER BY day')).rows;
 const first=await snapshots();assert.equal(first.length,100);
 const latest=first.at(-1);assert.equal(latest.score,112.5,'50 × (0.3×3 + 0.25×0 + 0.2×3 + 0.15×3 + 0.1×3)');
 assert.equal(latest.payload.components.contracts.baselineRule,'minimum');assert.equal(latest.payload.band,undefined);
 // Idempotent: publishing the same completed days again changes nothing.
 await publishIndex(db,rows,{throughDay:window.throughDay});
 assert.equal(evidenceDigest(await snapshots()),evidenceDigest(first));
 // API: above-100 scores, fixed baselines, no bands.
 const server=createServer(db);await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));t.after(()=>new Promise(resolve=>server.close(resolve)));
 const get=(path,key)=>fetch(`http://127.0.0.1:${server.address().port}${path}`,{headers:key?{'X-API-Key':key}:{}});
 const today=await(await get('/index/today')).json();
 assert.equal(today.score,113);assert.equal(today.band,undefined);assert.equal(today.normalization,'fixed-baseline-first-30-days');
 assert.equal(today.baseline.level,50);assert.equal(today.baseline.fromDay,COLLECTION_START);assert.equal(today.baseline.throughDay,addDays(COLLECTION_START,29));
 assert.equal(today.baseline.metrics.addresses.perWindow,100);assert.equal(today.baseline.metrics.contracts.perWindow,7);assert.equal(today.baseline.metrics.contracts.rule,'minimum');
 const key=randomBytes(32).toString('base64url');await db.query('INSERT INTO api_keys(label,key_hash) VALUES($1,$2)',['test',createHash('sha256').update(key).digest('hex')]);
 const history=await(await get('/index/history?range=all',key)).json();
 assert.equal(history.series.length,100);assert.equal(history.baselineLevel,50);assert.ok(Math.max(...history.series.map(p=>p.score))>100);assert.equal(history.series[0].windowDays,1);
 const breakdown=await(await get('/metrics/breakdown',key)).json(),addresses=breakdown.metrics.find(m=>m.id==='addresses');
 assert.equal(addresses.baselineValue,100);assert.equal(addresses.ratio,3);assert.equal(addresses.index,150);assert.equal(breakdown.score,112.5);
 // A new completed day is appended; earlier scores are never restated.
 t.mock.timers.setTime(start+86400000);
 const next=windowFor();assert.equal(next.days,101);
 await publishIndex(db,[...rows,rowFor(100)],{throughDay:next.throughDay});
 const appended=await snapshots();assert.equal(appended.length,101);
 assert.equal(evidenceDigest(appended.slice(0,100)),evidenceDigest(first));
 // Explicit migration from the previous method, as on a restored v3 database.
 const OLD='kce-v3-growing-90d-2026-09-27',rawBefore=(await db.query('SELECT raw FROM daily_metrics ORDER BY day')).rows.map(r=>r.raw);
 const checkpointsBefore=(await db.query('SELECT * FROM chain_checkpoints ORDER BY chain')).rows;
 await db.query('UPDATE daily_metrics SET method_version=$1',[OLD]);await db.query('UPDATE collection_state SET method_version=$1',[OLD]);
 await db.query("UPDATE index_snapshots SET score=LEAST(score,100),payload=jsonb_build_object('methodVersion',$1::text,'day',day::text,'band','Thriving')",[OLD]);
 await assert.rejects(migrate(db),/migrate-method -- --from kce-v3-growing-90d-2026-09-27/);
 await assert.rejects(migrateMethod(db,{from:'kce-v2-unknown'}),/records method kce-v3/);
 const result=await migrateMethod(db,{from:OLD});
 assert.equal(result.days,101);assert.equal(result.archivedScores,101);assert.equal(result.to,METHOD_VERSION);
 assert.equal((await db.query('SELECT count(*)::int AS n FROM index_snapshot_archive WHERE method_version=$1',[OLD])).rows[0].n,101);
 const migrated=await snapshots();assert.ok(migrated.every(r=>r.payload.methodVersion===METHOD_VERSION));
 assert.equal(evidenceDigest(migrated.map(r=>r.payload)),evidenceDigest(calculateSeries(rawBefore,{throughDay:next.throughDay})));
 assert.equal(evidenceDigest((await db.query('SELECT raw FROM daily_metrics ORDER BY day')).rows.map(r=>r.raw)),evidenceDigest(rawBefore),'raw observations untouched');
 assert.deepEqual((await db.query('SELECT * FROM chain_checkpoints ORDER BY chain')).rows,checkpointsBefore,'checkpoints untouched');
 assert.equal((await db.query('SELECT method_version FROM collection_state')).rows[0].method_version,METHOD_VERSION);
 assert.equal((await db.query('SELECT count(*)::int AS n FROM method_migrations')).rows[0].n,1);
 assert.deepEqual(await migrateMethod(db,{from:OLD}),{alreadyCurrent:true,methodVersion:METHOD_VERSION},'re-running is a no-op');
 await migrate(db);await publishIndex(db,[...rows,rowFor(100)],{throughDay:next.throughDay});
 assert.equal(evidenceDigest(await snapshots()),evidenceDigest(migrated),'publication after migration is idempotent');
});

