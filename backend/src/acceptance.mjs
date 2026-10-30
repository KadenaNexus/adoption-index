import {addDays,completedDay,METHOD_VERSION} from './scoring.mjs';
import {windowFor,INITIAL_HISTORY_DAYS,COLLECTION_START,NORMALIZATION} from './window.mjs';
import {createHash} from 'node:crypto';
import {ACCOUNT_EXTRACTION_VERSION} from './account-extraction.mjs';
import {moduleArtifactPolicyReport} from './module-policy.mjs';
// PostgreSQL jsonb may reorder object keys. Hash logical JSON consistently
// before and after persistence while preserving meaningful array order.
export const evidenceDigest=value=>createHash('sha256').update(JSON.stringify(value,(_key,item)=>
 item&&typeof item==='object'&&!Array.isArray(item)
  ?Object.fromEntries(Object.keys(item).sort().map(key=>[key,item[key]]))
  :item)).digest('hex');
export function sampleStillMatches(sample,rows,snapshot){
 return sample?.passed===true&&sample.methodVersion===METHOD_VERSION&&snapshot?.methodVersion===METHOD_VERSION&&sample.baselineDay===snapshot.baselineDay&&rows[0]?.day===snapshot.baselineDay&&sample.day===snapshot.day&&sample.stored===snapshot.score&&sample.rawSeriesSha256===evidenceDigest(rows)&&sample.snapshotSha256===evidenceDigest(snapshot);
}
const dateOnly=value=>value instanceof Date?value.toISOString().slice(0,10):value;
/** Only actual midnight scheduled executions count; replaying historical dates cannot qualify. */
export function sevenDayAcceptance(runs,now=new Date()){
 const today=now.toISOString().slice(0,10),qualified=new Set();
 for(const r of runs){
  const start=new Date(r.started_at),end=new Date(r.completed_at),day=Number.isFinite(+start)?start.toISOString().slice(0,10):null;
  if(r.kind!=='daily'||r.trigger!=='scheduler'||r.status!=='succeeded'||!r.completed_at||!day||end>now||end<start)continue;
  if(start.getUTCHours()!==0||start.getUTCMinutes()>1||dateOnly(r.through_day)!==addDays(day,-1))continue;
  qualified.add(day);
 }
 // Today's completed midnight run may be the seventh; an in-progress run isn't counted.
 const last=qualified.has(today)?today:completedDay(now),expected=Array.from({length:7},(_,i)=>addDays(last,i-6));
 const missing=expected.filter(day=>!qualified.has(day));
 return{requiredConsecutiveDays:7,windowStart:expected[0],windowEnd:expected.at(-1),passed:missing.length===0,missingDays:missing};
}
export async function acceptanceReport(db,now=new Date()){
 const window=windowFor(completedDay(now));
 const [runs,coverage,moduleArtifactPolicy,sample,identities,accounts,stage]=await Promise.all([
  db.query("SELECT kind,trigger,status,started_at,completed_at,through_day FROM job_runs WHERE started_at >= $1",[new Date(now.getTime()-9*86400000).toISOString()]),
  db.query("SELECT day FROM index_snapshots WHERE day>=$1::date AND day<=$2::date AND payload->>'methodVersion'=$3 AND payload->>'baselineDay'=$1::text ORDER BY day",[window.fromDay,window.throughDay,METHOD_VERSION]),
  moduleArtifactPolicyReport(db,window.cutoff),
  db.query("SELECT payload FROM source_evidence WHERE source='manual-score-reproduction' AND day>=$1 AND day<=$2 ORDER BY fetched_at DESC LIMIT 1",[window.fromDay,window.throughDay]),
  db.query('SELECT count(*)::int AS count FROM module_identity_reviews WHERE block_time>=$1 AND block_time<$2',[window.startTime,window.cutoff]),
  db.query('SELECT version,status FROM account_extraction_state WHERE singleton=true'),
  db.query("SELECT payload FROM source_evidence WHERE source='staged-real-day' ORDER BY fetched_at DESC LIMIT 1")
 ]);
 const days=new Set(coverage.rows.map(r=>dateOnly(r.day))),missing=[];
 for(let day=window.fromDay;day<=window.throughDay;day=addDays(day,1))if(!days.has(day))missing.push(day);
 const unattended=sevenDayAcceptance(runs.rows,now),sampleReproduction=sample.rows[0]?.payload??null;
 let sampleCurrent=false;
 if(sampleReproduction?.baselineDay===window.fromDay&&sampleReproduction.day>=window.fromDay&&sampleReproduction.day<=window.throughDay){
  const [raw,snapshot]=await Promise.all([db.query('SELECT raw FROM daily_metrics WHERE day>=$1 AND day<=$2 ORDER BY day',[window.fromDay,sampleReproduction.day]),db.query('SELECT payload FROM index_snapshots WHERE day=$1',[sampleReproduction.day])]);
  sampleCurrent=sampleStillMatches(sampleReproduction,raw.rows.map(r=>r.raw),snapshot.rows[0]?.payload);
 }
 const accountExtraction=accounts.rows[0]??{version:null,status:'missing'},accountExtractionReady=accountExtraction.version===ACCOUNT_EXTRACTION_VERSION&&accountExtraction.status==='ready';
 const stagedRun=stage.rows[0]?.payload??null,stagedRunReady=stagedRun?.methodVersion===METHOD_VERSION&&stagedRun?.collectionStart===COLLECTION_START&&stagedRun?.independentCalculationPassed===true&&stagedRun?.githubLedgerAuditPassed===true&&stagedRun?.components?.length===5&&Array.isArray(stagedRun.rawSeries)&&stagedRun.rawSeriesSha256===evidenceDigest(stagedRun.rawSeries);
 const localDataReady=window.days>=INITIAL_HISTORY_DAYS&&missing.length===0&&moduleArtifactPolicy.passed&&identities.rows[0].count===0&&accountExtractionReady&&sampleCurrent;
 return{milestoneComplete:false,repositoryDelivery:'KadenaSaudi/Kadena-NEXUS, branch adoption-index',historyScope:'Saudi.KDA approved 90 initial days, permanent growing summaries and fixed collection baseline; full fork backfill optional',collectionStart:COLLECTION_START,initialHistoryDays:INITIAL_HISTORY_DAYS,historyDays:window.days,summaryRetention:'permanent',baselineDay:window.fromDay,throughDay:window.throughDay,normalization:NORMALIZATION,localDataReady,dataAcceptancePassed:localDataReady&&unattended.passed,stagedRunRequired:true,stagedRunReady,stagedRun,readyForPipelineReview:localDataReady&&stagedRunReady,operationalAcceptance:'Seven-day run requirement from original offer remains unverified; newer request adds staged real-day review',missingBackfillDays:missing,contractsAwaitingReview:moduleArtifactPolicy.awaitingReview,moduleArtifactPolicy,moduleIdentitiesAwaitingReview:identities.rows[0].count,accountExtraction,sampleReproduction,sampleCurrent,unattended};
}
