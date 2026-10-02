import {transaction} from './db.mjs';
import {assertAccountExtractionReady} from './account-extraction.mjs';
import {assertModuleArtifactPolicyCurrent} from './module-policy.mjs';
import {indexBlocks,dailyChainMetrics,saveEvidence,assertModuleIdentitiesReviewed,assertCollectionState,pruneRetention} from './ingest.mjs';
import {collectGithub,auditGithubHistory} from './github.mjs';
import {collectTvl,loadRegistry} from './tvl.mjs';
import {getCut} from './chainweb.mjs';
import {calculateSeries,METHOD_VERSION,completedDay,addDays} from './scoring.mjs';
import {windowFor,INITIAL_HISTORY_DAYS,COLLECTION_START,GITHUB_OBSERVATION_VERSION} from './window.mjs';
import {isDeepStrictEqual} from 'node:util';
import {pruneSourceCaches} from './source-cache.mjs';
import {fileURLToPath} from 'node:url';
import {setTimeout as sleep} from 'node:timers/promises';

const dateOnly=value=>value instanceof Date?value.toISOString().slice(0,10):value;
// Node reports a network failure as "fetch failed"; its cause names the host and the reason (a reset, DNS, a timeout).
// URLs in it are cut to their origin, so a path or query never reaches the job record or the logs.
const causeOf=error=>{
 const cause=error?.cause;if(!cause||typeof cause!=='object')return undefined;
 const message=String(cause.message??'').replace(/\b[a-z][a-z0-9+.-]*:\/\/[^\s"'<>]+/gi,url=>{try{return new URL(url).origin}catch{return '[url]'}}).replace(/[\x00-\x1f]/g,' ').slice(0,300);
 return {name:cause.name,code:cause.code,message};
};
async function assertCollectionCoverage(tx,window){
 await assertCollectionState(tx);
 // The immutable start and canonical cutoff must agree with every chain.
 const checkpoints=(await tx.query('SELECT chain,coverage_start,block_time FROM chain_checkpoints')).rows;
 const chains=new Set(checkpoints.map(row=>Number(row.chain)));
 if(checkpoints.length!==20||Array.from({length:20},(_,chain)=>chain).some(chain=>!chains.has(chain))||checkpoints.some(row=>dateOnly(row.coverage_start)!==window.fromDay||!Number.isFinite(Date.parse(row.block_time))||Date.parse(row.block_time)<Date.parse(window.cutoff)))throw Object.assign(new Error('Fixed collection coverage changed or is incomplete; verify collection policy and all chains'),{code:'COLLECTION_COVERAGE_CHANGED'});
}
export async function putObservation(db,source,day,version,payload){
 const inserted=await db.query('INSERT INTO source_observations(source,day,version,payload) VALUES($1,$2,$3,$4) ON CONFLICT(source,day,version) DO NOTHING RETURNING day',[source,day,version,payload]);
 if(inserted.rowCount===0){
  const existing=(await db.query('SELECT payload FROM source_observations WHERE source=$1 AND day=$2 AND version=$3',[source,day,version])).rows[0];
  // Repository heads, request URLs and collection ranges may differ during a
  // retry. Keep the first proof and reject changed metric/identity decisions,
  // not harmless acquisition metadata. The complete SHA ledger is checked in
  // the same transaction before GitHub observations reach this function.
  const equivalent=source==='github'&&existing?existing.payload.day===payload.day&&existing.payload.commits===payload.commits&&existing.payload.collectionStart===payload.collectionStart&&(!existing.payload.commitLedgerDigest||!payload.commitLedgerDigest||existing.payload.commitLedgerDigest===payload.commitLedgerDigest):existing&&isDeepStrictEqual(existing.payload,payload);
  if(!equivalent)throw Object.assign(new Error('A stored source observation is immutable; investigate changed historical evidence before proceeding'),{code:'HISTORICAL_SOURCE_CHANGED',details:{source,day,version}});
 }
}
export function compactTvlObservation(value){
 const {evidence,protocols,...totals}=value;
 return {...totals,protocols:protocols?.map(({id,chain,tvlKda})=>({id,chain,tvlKda})),
  evidence:{reads:evidence.reads.map(({chain,header,metadata})=>({chain,header,metadata}))}};
}
export function validateTvlObservation(value,row,registry){
 if(value.registryVersion!==registry.version||!value.evidence?.reads?.length)throw new Error('TVL registry or evidence is missing');
 for(const read of value.evidence.reads){
  const canonical=row.headers[String(read.chain)];
  if(!canonical||read.header.hash!==canonical.hash||read.header.height!==canonical.height||read.metadata?.prevBlockHash!==canonical.hash||read.metadata?.blockHeight!==canonical.height+1||read.metadata?.blockTime!==canonical.creationTime)throw new Error('TVL observation does not match the indexed canonical UTC boundary');
 }
 for(const chain of new Set(registry.protocols.map(protocol=>String(protocol.chain))))if(!value.evidence.reads.some(read=>String(read.chain)===chain))throw new Error('TVL protocol-chain coverage is incomplete');
 return value;
}
/** Publication is one transaction, after every day and every source validates. */
export async function publishIndex(db,rows,{throughDay=completedDay()}={}){
 const window=windowFor(throughDay);
 if(window.days<INITIAL_HISTORY_DAYS)throw new Error('Public publication requires the initial 90 completed days; use a staged sample for a shorter prefix');
 const snapshots=calculateSeries(rows,{throughDay});
 await transaction(db,async tx=>{
  await tx.query("SELECT pg_advisory_xact_lock(hashtext('kce-snapshot-publication'))");
  await assertCollectionCoverage(tx,window);
  await assertAccountExtractionReady(tx);
  await assertModuleIdentitiesReviewed(tx,window.cutoff);
  // Wait for in-flight classifications and prevent them changing between the
  // final policy check and commit. Direct publication callers use this gate too.
  await tx.query('LOCK TABLE module_deployments IN SHARE MODE');
  await assertModuleArtifactPolicyCurrent(tx,window.cutoff);
  // Reconciliation may have completed after aggregation. Even if every stored
  // classification now agrees, previously computed contract counts are stale.
  const contracts=(await tx.query(`SELECT (block_time AT TIME ZONE 'UTC')::date::text AS day,count(*)::int AS n
   FROM module_deployments WHERE kind='new' AND artifact_status='included' AND block_time>=$1 AND block_time<$2 GROUP BY 1`,
   [window.startTime,window.cutoff])).rows;
  const currentContracts=new Map(contracts.map(row=>[row.day,row.n]));
  const changed=rows.filter(row=>row.contracts!==(currentContracts.get(row.day)??0));
  if(changed.length)throw Object.assign(new Error('Module contract counts changed before publication; recompute history'),
   {code:'MODULE_CONTRACT_COUNTS_CHANGED',details:{days:changed.map(row=>({day:row.day,supplied:row.contracts,current:currentContracts.get(row.day)??0}))}});
  const latest=(await tx.query('SELECT max(day)::text AS day FROM index_snapshots')).rows[0]?.day;
  if(latest&&latest>throughDay)throw new Error('Cannot replace only a prefix of published history; recompute through the latest published day');
  const previousRows=(await tx.query('SELECT day,raw,method_version FROM daily_metrics WHERE day>=$1 AND day<=$2',[window.fromDay,throughDay])).rows;
  const previousSnapshots=(await tx.query('SELECT day,payload FROM index_snapshots WHERE day>=$1 AND day<=$2',[window.fromDay,throughDay])).rows;
  const rawByDay=new Map(previousRows.map(row=>[dateOnly(row.day),row]));
  const publishedByDay=new Map(previousSnapshots.map(row=>[dateOnly(row.day),row.payload]));
  for(let i=0;i<rows.length;i++){
   const row=rows[i],snapshot=snapshots[i],stored=rawByDay.get(row.day),published=publishedByDay.get(row.day);
   if((stored&&(stored.method_version!==METHOD_VERSION||!isDeepStrictEqual(stored.raw,row)))||(published&&!isDeepStrictEqual(published,snapshot)))throw Object.assign(new Error('Published history is immutable; changed source or methodology requires an explicit reviewed correction'),{code:'PUBLISHED_HISTORY_CHANGED',details:{day:row.day}});
   if(!stored)await tx.query('INSERT INTO daily_metrics(day,raw,coverage,registry_version,method_version) VALUES($1,$2,$3,$4,$5)',[row.day,row,row.coverage,row.registryVersion,METHOD_VERSION]);
   if(!published)await tx.query('INSERT INTO index_snapshots(day,score,payload) VALUES($1,$2,$3)',[snapshot.day,snapshot.score,snapshot]);
  }
 });
 return {days:snapshots.length,fromDay:snapshots[0].day,throughDay:snapshots.at(-1).day,score:snapshots.at(-1).score};
}
export async function collectGithubHistory(db,{throughDay=completedDay(),collector=collectGithub,...options}={}){
 const window=windowFor(throughDay);
 // Freeze historical daily observations. Future runs request only the missing
 // suffix, so moving default branches cannot silently revise past scores.
 const existing=(await db.query("SELECT day FROM source_observations WHERE source='github' AND version=$1 AND day>=$2 AND day<=$3 ORDER BY day",[GITHUB_OBSERVATION_VERSION,COLLECTION_START,throughDay])).rows.map(row=>dateOnly(row.day));
 if(existing.some((day,i)=>day!==addDays(COLLECTION_START,i)))throw Object.assign(new Error('GitHub observations contain a historical gap; do not overwrite permanent history'),{code:'GITHUB_HISTORY_GAP'});
 const fromDay=existing.length?addDays(existing.at(-1),1):COLLECTION_START;
 if(fromDay>throughDay)return {days:0,existingDays:existing.length,fromDay:COLLECTION_START,throughDay,upToDate:true};
 const expectedDays=window.days-existing.length;
 const result=await collector({...options,fromDay,throughDay,fromTimestamp:fromDay+'T00:00:00Z'});
 if(result.days.length!==expectedDays||result.days.some((row,i)=>row.day!==addDays(fromDay,i)))throw new Error('GitHub collection did not cover the complete requested collection suffix');
 const requestProofs=result.evidence.map(({rawBody,...page})=>page);
 await transaction(db,async tx=>{
  await tx.query("SELECT pg_advisory_xact_lock(hashtext('kce-snapshot-publication'))");
  await assertCollectionState(tx);
  const starts=(await tx.query('SELECT DISTINCT coverage_start::text AS from_day FROM chain_checkpoints')).rows;
  if(starts.some(row=>row.from_day!==COLLECTION_START))throw Object.assign(new Error('Chain collection baseline does not match fixed source baseline'),{code:'COLLECTION_COVERAGE_CHANGED'});
  const previousProofs=(await tx.query("SELECT payload FROM source_evidence WHERE source='github-complete-run' ORDER BY id")).rows;
  const alreadyCovered=(await tx.query("SELECT day FROM source_observations WHERE source='github' AND version=$1 AND day>=$2 AND day<=$3",[GITHUB_OBSERVATION_VERSION,fromDay,throughDay])).rows.map(row=>dateOnly(row.day));
  const digests=auditGithubHistory(result,previousProofs.flatMap(row=>row.payload.commitLedger??[]),alreadyCovered);
  for(const row of result.days)await putObservation(tx,'github',row.day,GITHUB_OBSERVATION_VERSION,{...row,commitLedgerDigest:digests[row.day],collectionStart:COLLECTION_START,fromDay,throughDay,repositories:result.repositories.map(r=>({id:r.id,name:r.name,head:r.collection?.headSha})),sourceRefs:result.sourceRefs});
  // The in-scope commit decision ledger and response hashes are permanent audit
  // evidence. Temporary REST bodies are removed after successful persistence.
  await saveEvidence(tx,'github-complete-run',{...result,evidence:requestProofs},throughDay);
 });
 if(result.collection.cache?.directory)await pruneSourceCaches({directory:options.cacheDir||process.env.GITHUB_CACHE_DIR||fileURLToPath(new URL('../data/github-cache/',import.meta.url)),keepRunId:null});
 return {days:result.days.length,existingDays:existing.length,repositories:result.repositories.length,fromDay,collectionStart:COLLECTION_START,throughDay};
}
export async function collectGithubWithWait(db,{waitForQuota=false,signal,onProgress=()=>{},maxWaitMs=8*3600000,...options}={}){
 const deadline=Date.now()+maxWaitMs;
 for(;;){
  signal?.throwIfAborted();
  try{return await collectGithubHistory(db,options)}catch(error){
   const reset=Date.parse(error.details?.resetAt);
   if(!waitForQuota||!['GITHUB_RATE_LIMIT','GITHUB_AUTH_REQUIRED'].includes(error.code)||!Number.isFinite(reset)||reset>=deadline)throw error;
   const until=Math.max(reset+2000,Date.now()+60000);
   onProgress({event:'github_waiting_for_quota',resumeAt:new Date(until).toISOString(),throughDay:options.throughDay});
   while(Date.now()<until){signal?.throwIfAborted();await sleep(Math.min(30000,until-Date.now()),undefined,{signal})}
  }
 }
}
export async function collectMetricRows(db,{throughDay=completedDay(),tvlCollector=collectTvl,chainMetrics=dailyChainMetrics,cutProvider=getCut,onProgress=()=>{}}={}){
 const window=windowFor(throughDay);
 const chainRows=await chainMetrics(db,throughDay),registry=await loadRegistry();
 if(chainRows.length!==window.days||chainRows.some((row,i)=>row.day!==addDays(window.fromDay,i)))throw new Error('Chain history must contain every day since the fixed collection start');
 const gitRows=(await db.query('SELECT day,payload FROM source_observations WHERE source=$1 AND version=$2 AND day>=$3 AND day<=$4',['github',GITHUB_OBSERVATION_VERSION,window.fromDay,throughDay])).rows;
 const git=new Map(gitRows.map(r=>[dateOnly(r.day),r.payload]));
 if(chainRows.some(row=>!git.has(row.day)))throw new Error('GitHub REST history is incomplete; run the GitHub collector');
 const cut=await cutProvider(),rows=[];
 for(const row of chainRows){
  const stored=(await db.query('SELECT payload FROM source_observations WHERE source=$1 AND day=$2 AND version=$3',['tvl',row.day,registry.version])).rows[0];
  let tvl=stored?.payload;
  if(tvl){try{validateTvlObservation(tvl,row,registry)}catch{tvl=null}}
  if(!tvl){
   tvl=await tvlCollector({day:row.day,cut,headers:row.headers});validateTvlObservation(tvl,row,registry);
   await transaction(db,async tx=>{
    await tx.query("SELECT pg_advisory_xact_lock(hashtext('kce-snapshot-publication'))");
    await assertCollectionCoverage(tx,window);
    await putObservation(tx,'tvl',row.day,registry.version,compactTvlObservation(tvl));
    await saveEvidence(tx,'pact-tvl',tvl.evidence,row.day);
   });
  }
  const {headers,...raw}=row;
  rows.push({...raw,commits:git.get(row.day).commits,tvlKda:tvl.tvlKda,tvlUsd:tvl.tvlUsd,kdaUsd:tvl.kdaUsd,registryVersion:registry.version,coverage:{addresses:true,contracts:true,tvl:true,hashrate:true,commits:true}});
  onProgress({event:'source_day_complete',day:row.day});
 }
 return rows;
}
export async function computeIndex(db,options={}){
 const rows=await collectMetricRows(db,options);
 return publishIndex(db,rows,{throughDay:options.throughDay??completedDay()});
}
export async function runJob(db,{kind='backfill',trigger='manual',maxBlocks=2000,throughDay=completedDay(),githubOptions={},onProgress=()=>{},indexer=indexBlocks,compute=computeIndex,boundaryWaitMs=kind==='daily'?90*60000:0,signal}={}){
 if(!['backfill','daily'].includes(kind)||!['manual','scheduler'].includes(trigger))throw new Error('Invalid job invocation');
 const lock=await db.connect();
 let locked=false,id,detail={},status='incomplete';
 try{
  locked=(await lock.query("SELECT pg_try_advisory_lock(hashtext('kce-publication-job')) AS locked")).rows[0].locked;
  if(!locked)throw new Error('Another publication job is active');
  id=(await db.query('INSERT INTO job_runs(kind,trigger,through_day) VALUES($1,$2,$3) RETURNING id',[kind,trigger,throughDay])).rows[0].id;
  try{
  const deadline=Date.now()+boundaryWaitMs;
  for(;;){
   signal?.throwIfAborted();
   detail.indexer=await indexer(db,{maxBlocks,onProgress,signal,throughDay});
   await pruneRetention(db,throughDay);
   // At midnight, wait for the new day's boundary blocks to pass finality.
   try{await dailyChainMetrics(db,throughDay);break}catch(error){
    if(!error.message.startsWith('All 20 chains')||Date.now()>=deadline)throw error;
    onProgress({event:'waiting_for_chain_boundary',throughDay});await sleep(30000,undefined,{signal});
   }
  }
  detail.github=await collectGithubWithWait(db,{throughDay,waitForQuota:kind==='daily',signal,onProgress,...githubOptions});
  detail.publication=await compute(db,{throughDay,onProgress});status='succeeded';
  return {id,status,...detail};
  }catch(error){const cause=causeOf(error);detail.error={name:error.name,message:error.message,code:error.code??cause?.code,details:error.details,...(cause?{cause}:{})};onProgress({event:'job_incomplete',...detail.error});return{id,status,...detail}}
  finally{await db.query('UPDATE job_runs SET completed_at=now(),status=$2,details=$3 WHERE id=$1',[id,status,detail])}
 }finally{try{if(locked)await lock.query("SELECT pg_advisory_unlock(hashtext('kce-publication-job'))")}finally{lock.release()}}
}
