import {calculateSeries,METHOD_VERSION,WEIGHTS} from './scoring.mjs';
import {COLLECTION_START,INITIAL_HISTORY_DAYS,BASELINE_DAYS,BASELINE_LEVEL,BASELINE_THROUGH,MINIMUM_DAILY_BASELINE,NORMALIZATION,windowFor} from './window.mjs';
import {evidenceDigest} from './acceptance.mjs';

const INPUTS={
 addresses:{key:'addresses',kind:'average',unit:'accounts per chain'},
 contracts:{key:'contracts',kind:'count',unit:'new modules'},
 tvl:{key:'tvlKda',kind:'average',unit:'KDA'},
 hashrate:{key:'hashratePh',kind:'average',unit:'PH/s'},
 commits:{key:'commits',kind:'count',unit:'human commits'},
};
const sortDays=rows=>rows.toSorted((a,b)=>a.day.localeCompare(b.day));

/**
 * Independent arithmetic for one day, written separately from the scoring engine:
 * baseline means from the first 30 collected days, trailing window through `day`,
 * index = 50 × Σ weight × (current ÷ baseline). Throws if the result is not computable.
 */
export function independentDay(history,day){
 const rows=sortDays(history),base=rows.slice(0,BASELINE_DAYS);
 if(base.length!==BASELINE_DAYS||base[0].day!==COLLECTION_START||base.at(-1).day!==BASELINE_THROUGH)throw new Error('The independent calculation needs the complete 30-day baseline period');
 const upTo=rows.filter(row=>row.day<=day);
 if(upTo.at(-1)?.day!==day||upTo[0].day!==COLLECTION_START)throw new Error('The independent calculation needs every day from the collection start');
 const window=upTo.slice(-7),n=window.length;
 const components=Object.entries(WEIGHTS).map(([id,weight])=>{
  const {key,kind,unit}=INPUTS[id];
  const observed=base.reduce((sum,row)=>sum+row[key],0)/BASELINE_DAYS,minimum=kind==='count'?MINIMUM_DAILY_BASELINE[id]??0:0;
  const dailyMean=observed<minimum?minimum:observed;
  if(!(dailyMean>0))throw new Error(`The ${id} baseline is zero`);
  const total=window.reduce((sum,row)=>sum+row[key],0),current=kind==='count'?total:total/n,baselineValue=kind==='count'?n*dailyMean:dailyMean;
  const ratio=current/baselineValue,componentIndex=BASELINE_LEVEL*ratio;
  return {id,unit,kind,rawDailyValue:window.at(-1)[key],windowDays:n,currentValue:current,baselineObservedDailyMean:observed,baselineMinimumDailyMean:minimum,baselineRule:observed<minimum?'minimum':'observed',baselineDailyMean:dailyMean,baselineValue,ratio,componentIndex,weight,weightedContribution:componentIndex*weight};
 });
 const unrounded=components.reduce((sum,item)=>sum+item.weightedContribution,0);
 return {day,windowDays:n,components,unroundedComposite:unrounded,composite:Math.round((unrounded+Number.EPSILON)*10)/10};
}

/** Independent arithmetic worksheet; no score is published by this function. */
export function stagedReport(input,{day,baselineRows}={}){
 const rows=sortDays(input).filter(row=>row.day<=day),baselineSource=sortDays(baselineRows??input);
 const series=calculateSeries(rows,{throughDay:day,baselineRows:baselineSource}),snapshot=series.at(-1),window=windowFor(day);
 const independent=independentDay([...baselineSource.filter(row=>row.day>day),...rows],day);
 if(independent.composite!==snapshot.score)throw new Error('Independent staged composite does not match the scoring engine');
 const formula=`${BASELINE_LEVEL} × (${independent.components.map(c=>`${c.weight} × ${c.currentValue} ÷ ${c.baselineValue}`).join(' + ')})`;
 return {kind:'staged-real-day',generatedAt:new Date().toISOString(),day,collectionStart:COLLECTION_START,initialHistoryDays:INITIAL_HISTORY_DAYS,historyDays:window.days,stagedOnly:true,published:false,initialHistoryComplete:window.days>=INITIAL_HISTORY_DAYS,methodVersion:METHOD_VERSION,normalization:NORMALIZATION,baseline:snapshot.baseline,startupWindow:snapshot.startupWindow,windowDays:snapshot.windowDays,rawValues:rows.at(-1),rawSeries:rows,components:independent.components,unroundedComposite:independent.unroundedComposite,composite:independent.composite,publicDisplay:Math.round(independent.composite),proDisplay:independent.composite.toFixed(1),formula,rawSeriesSha256:evidenceDigest(rows),snapshotSha256:evidenceDigest(snapshot),independentCalculationPassed:true};
}
const number=value=>Number.isInteger(value)?String(value):Number(value.toFixed(4)).toString();
export function stagedMarkdown(report){
 const windowLabel=report.windowDays<7?`${report.windowDays}-day (startup window: fewer than 7 days exist yet)`:'7-day';
 const lines=['# Kadena Community Edition Adoption Index — day calculation','',`UTC day: **${report.day}**. Collection start: **${report.collectionStart}**. Baseline: **${report.baseline.fromDay} to ${report.baseline.throughDay}** (30 days) = index level **${report.baseline.level}**.`,'',`Current values use the ${windowLabel} window: averages for addresses, TVL and hashrate; counts for contracts and commits. Baselines are in the matching unit.`,'','| Input | Day\'s raw value | Unit | Current value | Baseline (matching unit) | Baseline rule | Ratio | Component index (50 × ratio) | Weight | Contribution |','|---|---:|---|---:|---:|---|---:|---:|---:|---:|'];
 for(const c of report.components)lines.push(`| ${c.id} | ${number(c.rawDailyValue)} | ${c.unit} | ${number(c.currentValue)} ${c.kind==='count'?'(count)':'(avg)'} | ${number(c.baselineValue)} | ${c.baselineRule==='minimum'?`minimum (observed ${number(c.baselineObservedDailyMean)}/day)`:'observed'} | ${number(c.ratio)} | ${number(c.componentIndex)} | ${c.weight} | ${number(c.weightedContribution)} |`);
 lines.push('',`Formula: index = ${report.formula} = ${number(report.unroundedComposite)}.`,`Index (one decimal): **${report.proDisplay}**. Public display (whole number): **${report.publicDisplay}**. Baseline activity = 50.`,'','A missing input stops the calculation. Weights are never redistributed. The baseline is fixed and never restated.','',`Method: ${report.methodVersion}. Raw series SHA-256: ${report.rawSeriesSha256}.`);
 return lines.join('\n')+'\n';
}

/** Private real-data artifact; deliberately separate from public publication. */
export async function writeStagedReview(db,{day,directory,onProgress=()=>{}}){
 const [{collectMetricRows},{saveEvidence},{mkdir,writeFile},{resolve}]=await Promise.all([import('./pipeline.mjs'),import('./ingest.mjs'),import('node:fs/promises'),import('node:path')]);
 const {auditGithubHistory}=await import('./github.mjs');
 const runs=(await db.query("SELECT payload FROM source_evidence WHERE source='github-complete-run' ORDER BY id")).rows;
 if(!runs.some(({payload})=>payload.days?.some(row=>row.day===day)))throw new Error('The staged day has no complete GitHub decision ledger');
 let prior=[];for(const {payload} of runs){auditGithubHistory(payload,prior);prior.push(...payload.commitLedger)}
 const [{transaction},{dailyChainMetrics}]=await Promise.all([import('./db.mjs'),import('./ingest.mjs')]);
 // A day inside the baseline period still needs the complete 30-day baseline.
 const through=day<BASELINE_THROUGH?BASELINE_THROUGH:day;
 const chainRows=await transaction(db,async tx=>{await tx.query('SET TRANSACTION ISOLATION LEVEL REPEATABLE READ, READ ONLY');return dailyChainMetrics(tx,through)});
 const rows=await collectMetricRows(db,{throughDay:through,onProgress,chainMetrics:async()=>chainRows}),report=stagedReport(rows,{day,baselineRows:rows});
 report.githubLedgerAuditPassed=true;
 report.sourceEvidence=(await db.query("SELECT source,day::text,digest FROM source_evidence WHERE (day>=$1::date AND day<=$2::date) OR (source='github-complete-run' AND payload->'days' @> jsonb_build_array(jsonb_build_object('day',$2::text))) ORDER BY source,day,digest",[COLLECTION_START,day])).rows;
 report.chainCoverage=(await db.query('SELECT chain,height,block_time,coverage_start,baseline_header,baseline_inventory FROM chain_checkpoints ORDER BY chain')).rows.map(({baseline_inventory,...row})=>({...row,baselineInventorySha256:evidenceDigest(baseline_inventory)}));
 report.dailyChainSummaries=(await db.query('SELECT day::text,chain,work::text,block_count::text,transaction_count::text,first_height::text,last_height::text,first_parent,last_header FROM daily_chain_stats WHERE day>=$1 AND day<=$2 ORDER BY day,chain',[COLLECTION_START,day])).rows;
 await saveEvidence(db,'staged-real-day',report,day);
 const dir=resolve(directory);await mkdir(dir,{recursive:true});
 await writeFile(resolve(dir,'staged-day.json'),JSON.stringify(report,null,2)+'\n');
 await writeFile(resolve(dir,'staged-day.md'),stagedMarkdown(report));
 return report;
}
