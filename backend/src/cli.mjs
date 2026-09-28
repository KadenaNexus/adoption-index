import {randomBytes,createHash} from 'node:crypto';
import {mkdir,writeFile,readdir,readFile,statfs} from 'node:fs/promises';
import {resolve} from 'node:path';
import {setTimeout as sleep} from 'node:timers/promises';
import {database} from './db.mjs';
import {migrate} from './migrate.mjs';
import {indexBlocks,saveEvidence,pruneRetention,dailyChainMetrics} from './ingest.mjs';
import {runJob,collectGithubWithWait,computeIndex,collectMetricRows,putObservation,compactTvlObservation} from './pipeline.mjs';
import {acceptanceReport,evidenceDigest} from './acceptance.mjs';
import {completedDay,addDays,METHOD_VERSION} from './scoring.mjs';
import {writeStagedReview,stagedReport,stagedMarkdown,independentDay} from './staging.mjs';
import {loadRegistry} from './tvl.mjs';
import {windowFor,INITIAL_HISTORY_DAYS,COLLECTION_START,GITHUB_OBSERVATION_VERSION,BASELINE_THROUGH,NORMALIZATION,validateDay} from './window.mjs';

const [command,...args]=process.argv.slice(2);
const option=(name,fallback)=>{const index=args.indexOf('--'+name);return index<0?fallback:args[index+1]};
const log=value=>console.log(JSON.stringify(value));
const numberOption=(name,fallback)=>{const value=Number(option(name,fallback));if(!Number.isSafeInteger(value)||value<1)throw new Error(`Invalid --${name}`);return value};
const throughDay=option('through',completedDay());
validateDay(throughDay);
if(throughDay<COLLECTION_START||throughDay>completedDay())throw new Error('Date must be a completed UTC day on or after the fixed collection start');
const window=windowFor(throughDay);
const db=database();
const stop=new AbortController();
for(const signal of ['SIGINT','SIGTERM'])process.once(signal,()=>stop.abort());
try{
 if(command==='migrate')await migrate(db);
 else if(command==='index'){const result=await indexBlocks(db,{throughDay,maxBlocks:numberOption('max-blocks',2000),chunkSize:numberOption('chunk-size',process.env.INDEX_CHUNK_SIZE??200),onProgress:log,signal:stop.signal});await pruneRetention(db,throughDay);log(result)}
 else if(command==='github')log(await collectGithubWithWait(db,{throughDay,waitForQuota:args.includes('--wait'),onProgress:log,signal:stop.signal}));
 else if(command==='compute')log(await computeIndex(db,{throughDay,onProgress:log}));
 else if(command==='backfill-worker'){
  const deadline=Date.now()+numberOption('max-hours',4)*3600000,maxBlocks=numberOption('max-blocks',6000000),chunk=numberOption('chunk-blocks',20000);
  let indexed=0,failures=0,complete=false;
  while(Date.now()<deadline&&indexed<maxBlocks&&!stop.signal.aborted){
   const disk=await statfs('.');if(disk.bavail*disk.bsize<20*1024**3)throw new Error('Backfill paused: less than 20 GiB free on the working volume');
   const checkpoints=(await db.query('SELECT min(block_time) AS earliest,count(*)::int AS chains FROM chain_checkpoints')).rows[0];
   if(checkpoints.chains===20&&new Date(checkpoints.earliest)>=new Date(addDays(throughDay,1)+'T00:00:00Z')){complete=true;break}
   try{const result=await indexBlocks(db,{throughDay,maxBlocks:Math.min(chunk,maxBlocks-indexed),onProgress:log,signal:stop.signal});await pruneRetention(db,throughDay);indexed+=result.blocksIndexed;failures=0;log({event:'backfill_checkpoint',blocksThisRun:indexed,throughDay})}
   catch(error){if(stop.signal.aborted)throw error;log({event:'backfill_source_failure',name:error.name,message:error.message,attempt:++failures});if(failures>=3)throw error;await sleep(30000,undefined,{signal:stop.signal})}
  }
  log({event:complete?'chain_backfill_complete':'backfill_budget_reached',blocksThisRun:indexed,throughDay});
  if(complete&&!args.includes('--chain-only')){await collectGithubWithWait(db,{throughDay,waitForQuota:true,onProgress:log,signal:stop.signal});log(await computeIndex(db,{throughDay,onProgress:log}))}
  else if(!complete)process.exitCode=2;
 }
 else if(['backfill','daily'].includes(command)){
  const result=await runJob(db,{kind:command,maxBlocks:numberOption('max-blocks',command==='daily'?120000:2000),throughDay,onProgress:log,signal:stop.signal});log(result);if(result.status!=='succeeded')process.exitCode=2;
 }else if(command==='scheduler'){
  // A restart never retroactively labels a manual/backfilled run as a midnight run.
  let target=new Date();target.setUTCHours(24,0,0,0);
  log({event:'scheduler_ready',nextRun:target.toISOString()});
  while(!stop.signal.aborted){
   await sleep(Math.min(30000,Math.max(1,target-Date.now())),undefined,{signal:stop.signal});
   if(Date.now()<target)continue;
   const scheduled=target;target=new Date(target.getTime()+86400000);
   if(Date.now()-scheduled>120000){log({event:'missed_midnight',scheduled:scheduled.toISOString()});continue}
   try{log(await runJob(db,{kind:'daily',trigger:'scheduler',maxBlocks:120000,throughDay:completedDay(),onProgress:log,signal:stop.signal}))}catch(error){log({event:'scheduler_failure',name:error.name,message:error.message})}
  }
 }else if(command==='status'){
  const [checkpoints,counts,report]=await Promise.all([db.query('SELECT chain,height,block_time,coverage_start FROM chain_checkpoints ORDER BY chain'),db.query("SELECT (SELECT count(*) FROM blocks) AS replay_headers,(SELECT count(*) FROM daily_chain_stats) AS daily_chain_rows,(SELECT count(*) FROM daily_accounts) AS daily_account_rows,(SELECT count(*) FROM daily_metrics) AS raw_days,(SELECT count(*) FROM index_snapshots) AS score_days,(SELECT count(*) FROM module_identity_reviews) AS pending_module_identities,(SELECT count(*) FROM module_deployments WHERE kind='new' AND artifact_status='review') AS pending_artifact_reviews"),acceptanceReport(db)]);
  log({window,collectionStart:COLLECTION_START,initialHistoryDays:INITIAL_HISTORY_DAYS,summaryRetention:'permanent',checkpoints:checkpoints.rows,...counts.rows[0],acceptance:report});
 }else if(command==='create-key'){
  const label=option('label','review'),key=randomBytes(32).toString('base64url'),hash=createHash('sha256').update(key).digest('hex');
  const id=(await db.query('INSERT INTO api_keys(label,key_hash) VALUES($1,$2) RETURNING id',[label,hash])).rows[0].id;
  const file=resolve(option('out',`data/api-key-${id}.txt`));await writeFile(file,key+'\n',{mode:0o600,flag:'wx'});log({id,label,keyFile:file});
 }else if(command==='revoke-key'){
  const id=numberOption('id',0);log({revoked:(await db.query('UPDATE api_keys SET revoked_at=now() WHERE id=$1 AND revoked_at IS NULL',[id])).rowCount===1});
 }else if(command==='import-tvl'){
  const dir=option('directory');if(!dir)throw new Error('--directory is required');const registry=await loadRegistry();let imported=0;
  for(const file of (await readdir(dir)).sort()){
   if(!/^\d{4}-\d{2}-\d{2}\.json$/.test(file))continue;
   const day=file.slice(0,10);if(day<window.fromDay||day>window.throughDay)throw new Error(`Observation ${file} is outside the collection history`);
   const value=JSON.parse(await readFile(resolve(dir,file),'utf8')),payload=value.result??value.tvl??value;
   if(payload.registryVersion!==registry.version||!payload.evidence?.reads?.length)throw new Error(`Invalid native observation ${file}`);
   // These observations do not become scores until matched to the raw indexer's canonical headers.
   await saveEvidence(db,'pact-tvl',payload.evidence,day);await putObservation(db,'tvl',day,registry.version,compactTvlObservation(payload));imported++;
  }log({imported,published:false});
 }else if(command==='export'){
  const report=await acceptanceReport(db),dir=resolve(option('directory','data/export'));await mkdir(dir,{recursive:true});
  const rows=(await db.query('SELECT day::text,raw FROM daily_metrics WHERE day>=$1 AND day<=$2 AND method_version=$3 ORDER BY day',[window.fromDay,throughDay,METHOD_VERSION])).rows;
  const snapshots=(await db.query("SELECT payload FROM index_snapshots WHERE day>=$1 AND day<=$2 AND payload->>'methodVersion'=$3 AND payload->>'baselineDay'=$1::text ORDER BY day",[window.fromDay,throughDay,METHOD_VERSION])).rows.map(r=>r.payload);
  await writeFile(resolve(dir,'daily-metrics.json'),JSON.stringify(rows,null,2)+'\n');await writeFile(resolve(dir,'index-history.json'),JSON.stringify(snapshots,null,2)+'\n');await writeFile(resolve(dir,'acceptance.json'),JSON.stringify(report,null,2)+'\n');
  const registry=await loadRegistry();await writeFile(resolve(dir,'protocol-registry.json'),JSON.stringify(registry,null,2)+'\n');
  const hashes={};for(const file of await readdir(dir))if(file.endsWith('.json')&&file!=='manifest.json')hashes[file]=createHash('sha256').update(await readFile(resolve(dir,file))).digest('hex');
  await writeFile(resolve(dir,'manifest.json'),JSON.stringify({exportedAt:new Date().toISOString(),methodVersion:METHOD_VERSION,days:rows.length,completeHistory:report.localDataReady,baselineDay:window.fromDay,collectionStart:COLLECTION_START,initialHistoryDays:INITIAL_HISTORY_DAYS,summaryRetention:'permanent',sha256:hashes},null,2)+'\n');log({directory:dir,days:rows.length,completeHistory:report.localDataReady,baselineDay:window.fromDay,collectionStart:COLLECTION_START,initialHistoryDays:INITIAL_HISTORY_DAYS,summaryRetention:'permanent'});
 }else if(command==='stage-day'){
  const day=validateDay(option('day',COLLECTION_START));windowFor(day);
  await indexBlocks(db,{throughDay:day,maxBlocks:numberOption('max-blocks',100000),onProgress:log,signal:stop.signal});
  await dailyChainMetrics(db,day);
  await collectGithubWithWait(db,{throughDay:day,waitForQuota:args.includes('--wait'),onProgress:log,signal:stop.signal});
  const dir=resolve(option('directory','data/staged-review')),report=await writeStagedReview(db,{day,directory:dir,onProgress:log});
  log({day,stagedOnly:true,published:false,composite:report.composite,directory:dir,independentCalculationPassed:true});
 }else if(command==='finish-initial-review'){
  // A one-off bounded continuation of the running bootstrap; never a recurring job.
  const deadline=Date.now()+numberOption('max-hours',8)*3600000,dir=resolve(option('directory','data/staged-review'));
  let lastState='',staged=false,finished=false;
  while(Date.now()<deadline&&!stop.signal.aborted){
   const checkpoint=(await db.query('SELECT count(*)::int chains,min(block_time) earliest FROM chain_checkpoints')).rows[0];
   const githubDays=(await db.query("SELECT day::text FROM source_observations WHERE source='github' AND version=$1 AND day>=$2 AND day<=$3 ORDER BY day",[GITHUB_OBSERVATION_VERSION,COLLECTION_START,throughDay])).rows.map(row=>row.day);
   const contiguous=githubDays.every((day,i)=>day===addDays(COLLECTION_START,i));
   if(!contiguous)throw new Error('GitHub observations have a historical gap');
   const state=JSON.stringify({chains:checkpoint.chains,chainThrough:checkpoint.earliest,githubDays:githubDays.length,requiredDays:window.days});
   if(state!==lastState){log({event:'bootstrap_sources',...JSON.parse(state)});lastState=state}
   if(!staged&&checkpoint.chains===20&&Date.parse(checkpoint.earliest)>=Date.parse(addDays(COLLECTION_START,1))&&githubDays.length){
    const report=await writeStagedReview(db,{day:COLLECTION_START,directory:dir,onProgress:log});staged=true;
    log({event:'real_day_review_ready',day:report.day,composite:report.composite,directory:dir,publiclyPublished:false});
   }
   if(checkpoint.chains===20&&Date.parse(checkpoint.earliest)>=Date.parse(window.cutoff)&&githubDays.length===window.days){
    const publication=await computeIndex(db,{throughDay,onProgress:log});
    const report=await writeStagedReview(db,{day:throughDay,directory:dir,onProgress:log});
    const snapshot=(await db.query('SELECT payload FROM index_snapshots WHERE day=$1',[throughDay])).rows[0]?.payload;
    const sample={day:throughDay,baselineDay:COLLECTION_START,methodVersion:METHOD_VERSION,stored:snapshot?.score,calculated:report.composite,rawSeriesSha256:report.rawSeriesSha256,snapshotSha256:evidenceDigest(snapshot),passed:snapshot?.score===report.composite};
    if(!sample.passed)throw new Error('Stored full-history sample does not match the independent calculation');
    await saveEvidence(db,'manual-score-reproduction',sample,throughDay);
    await writeFile(resolve(dir,'status.json'),JSON.stringify({completedAt:new Date().toISOString(),publication,stagedReview:report.day,acceptance:await acceptanceReport(db)},null,2)+'\n');
    log({event:'initial_data_and_review_ready',publication,directory:dir,deploymentDeferred:true});finished=true;break;
   }
   await sleep(30000,undefined,{signal:stop.signal});
  }
  if(!finished){log({event:'bootstrap_wait_budget_reached',stagedReviewReady:staged});process.exitCode=2}
 }else if(command==='verify-sample'){
  const day=validateDay(option('day',throughDay));
  if(day<BASELINE_THROUGH||day>throughDay)throw new Error(`Sample date must be between ${BASELINE_THROUGH} (end of the baseline period) and ${throughDay}`);
  const data=(await db.query('SELECT raw FROM daily_metrics WHERE day>=$1 AND day<=$2 AND method_version=$3 ORDER BY day',[window.fromDay,day,METHOD_VERSION])).rows.map(r=>r.raw);
  if(!data.length||data[0].day!==window.fromDay||data.at(-1).day!==day||data.some((r,i)=>r.day!==addDays(window.fromDay,i)))throw new Error('The stored sample must include every day from the collection start through its selected day');
  const independent=independentDay(data,day),stored=(await db.query('SELECT score,payload FROM index_snapshots WHERE day=$1',[day])).rows[0];
  const report={day,baselineDay:window.fromDay,collectionStart:COLLECTION_START,initialHistoryDays:INITIAL_HISTORY_DAYS,summaryRetention:'permanent',methodVersion:METHOD_VERSION,normalization:NORMALIZATION,components:independent.components,calculated:independent.composite,stored:stored?Number(stored.score):null,rawSeriesSha256:evidenceDigest(data),snapshotSha256:stored?evidenceDigest(stored.payload):null,passed:!!stored&&stored.payload.methodVersion===METHOD_VERSION&&stored.payload.baselineDay===window.fromDay&&independent.composite===Number(stored.score)};
  await saveEvidence(db,'manual-score-reproduction',report,day);log(report);if(!report.passed)process.exitCode=2;
 }else if(command==='report'){
  // Read-only report from stored, verified data: one day's raw values and sub-scores,
  // TVL by protocol, the 7-day new-module list and the fixed baselines. No network access.
  const day=validateDay(option('day',throughDay)),dir=resolve(option('directory','data/report-'+day));
  const rows=(await db.query('SELECT raw FROM daily_metrics WHERE method_version=$1 ORDER BY day',[METHOD_VERSION])).rows.map(r=>r.raw);
  if(!rows.some(r=>r.day===day))throw new Error(`No stored ${METHOD_VERSION} daily metrics for ${day}`);
  const calculation=stagedReport(rows.filter(r=>r.day<=day),{day,baselineRows:rows});
  const stored=(await db.query('SELECT score FROM index_snapshots WHERE day=$1',[day])).rows[0];
  if(!stored||Number(stored.score)!==calculation.composite)throw new Error('Stored index does not match the independent calculation for this day');
  const registry=await loadRegistry(),tvl=(await db.query("SELECT payload FROM source_observations WHERE source='tvl' AND day=$1 AND version=$2",[day,registry.version])).rows[0]?.payload;
  if(!tvl?.protocols?.length)throw new Error('No stored per-protocol TVL observation for this day');
  const names=new Map(registry.protocols.map(p=>[p.id,p.name]));
  const protocols=tvl.protocols.map(p=>({id:p.id,name:names.get(p.id)??p.id,chain:String(p.chain),tvlKda:p.tvlKda,approxUsd:p.tvlKda*tvl.kdaUsd,share:tvl.tvlKda>0?p.tvlKda/tvl.tvlKda:0})).sort((a,b)=>b.tvlKda-a.tvlKda);
  const weekFrom=addDays(day,-6),modules=(await db.query("SELECT chain,name,height::text AS height,request_key,block_time,artifact_status FROM module_deployments WHERE kind='new' AND block_time>=$1 AND block_time<$2 ORDER BY block_time,chain,name",[weekFrom+'T00:00:00Z',addDays(day,1)+'T00:00:00Z'])).rows.map(m=>({chain:m.chain,name:m.name,height:m.height,requestKey:m.request_key,blockTime:new Date(m.block_time).toISOString(),status:m.artifact_status}));
  const counted=modules.filter(m=>m.status==='included').length,contracts=calculation.components.find(c=>c.id==='contracts');
  if(contracts.windowDays===7&&counted!==contracts.currentValue)throw new Error('The new-module list does not match the 7-day contracts count');
  const fmt=v=>Number.isInteger(v)?v.toLocaleString('en-US'):Number(v.toFixed(2)).toLocaleString('en-US');
  const md=[stagedMarkdown(calculation).trimEnd(),'',`## TVL by protocol on ${day}`,'',`Registry ${registry.version}. Total ${fmt(tvl.tvlKda)} KDA (≈ $${fmt(tvl.tvlUsd)} at ${Number(tvl.kdaUsd.toFixed(6))} USD/KDA; USD is display only, the index uses KDA).`,'','| Protocol component | Chain | TVL (KDA) | ≈ USD | Share |','|---|---:|---:|---:|---:|',
   ...protocols.map(p=>`| ${p.name} | ${p.chain} | ${fmt(p.tvlKda)} | $${fmt(p.approxUsd)} | ${(p.share*100).toFixed(1)}% |`),'',`## New modules, ${weekFrom} to ${day} (7 days)`,'',`${counted} counted (the contracts input), ${modules.length-counted} excluded or under review.`,'','| UTC time | Chain | Module | Height | Request key | Counted |','|---|---:|---|---:|---|---|',
   ...modules.map(m=>`| ${m.blockTime} | ${m.chain} | ${m.name} | ${m.height} | ${m.requestKey} | ${m.status==='included'?'yes':m.status} |`),'','## Fixed baselines (29 June to 28 July 2026 = index level 50)','','| Input | Observed mean per day | Rule | Baseline per 7-day window |','|---|---:|---|---:|',
   ...calculation.components.map(c=>`| ${c.id} | ${fmt(c.baselineObservedDailyMean)} | ${c.baselineRule==='minimum'?`minimum ${c.baselineMinimumDailyMean} per day applied`:'observed'} | ${fmt(c.kind==='count'?7*c.baselineDailyMean:c.baselineDailyMean)}${c.kind==='count'?' (count)':' (average)'} |`)].join('\n')+'\n';
  await mkdir(dir,{recursive:true});
  await writeFile(resolve(dir,'day-report.json'),JSON.stringify({day,methodVersion:METHOD_VERSION,calculation,tvl:{registryVersion:registry.version,tvlKda:tvl.tvlKda,tvlUsd:tvl.tvlUsd,kdaUsd:tvl.kdaUsd,protocols},newModules:{fromDay:weekFrom,throughDay:day,counted,modules}},null,2)+'\n');
  await writeFile(resolve(dir,'day-report.md'),md);
  log({day,directory:dir,index:calculation.composite,protocols:protocols.length,newModules:modules.length,counted});
 }else throw new Error('Commands: migrate, index, github, compute, backfill, backfill-worker, daily, scheduler, status, create-key, revoke-key, import-tvl, stage-day, finish-initial-review, verify-sample, report, export');
}catch(error){if(error.name!=='AbortError'){log({error:error.name,message:error.message,code:error.code,details:error.details});process.exitCode=1}}
finally{await db.end()}
