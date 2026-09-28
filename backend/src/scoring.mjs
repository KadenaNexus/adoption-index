import {addDays,completedDay,COLLECTION_START,INITIAL_HISTORY_DAYS,NORMALIZATION,BASELINE_DAYS,BASELINE_LEVEL,BASELINE_THROUGH,MINIMUM_DAILY_BASELINE,validateDay} from './window.mjs';
export {addDays,completedDay,COLLECTION_START,INITIAL_HISTORY_DAYS,NORMALIZATION,BASELINE_DAYS,BASELINE_LEVEL,BASELINE_THROUGH} from './window.mjs';
export const METHOD_VERSION='kce-v4-fixed-baseline-2026-09-28';
// Historical network identifiers are metadata only, never a collection start.
export const FORK_HEIGHT=6335858;
export const FORK_DAY='2025-11-08';
export const WEIGHTS={addresses:.30,contracts:.25,tvl:.20,hashrate:.15,commits:.10};
/** Addresses, TVL and hashrate use trailing averages; contracts and commits use trailing counts. */
export const METRICS={
 addresses:{source:'addresses',kind:'average'},
 contracts:{source:'contracts',kind:'count'},
 tvl:{source:'tvlKda',kind:'average'},
 hashrate:{source:'hashratePh',kind:'average'},
 commits:{source:'commits',kind:'count'},
};
const finite=(value,name)=>{if(typeof value!=='number'||!Number.isFinite(value)||value<0)throw new Error(`Invalid ${name}`);return value};
function validateRows(input,{firstDay,throughDay}){
 validateDay(firstDay);validateDay(throughDay);
 if(firstDay>throughDay)throw new Error('Collection start must not follow the final day');
 if(!input.length)throw new Error('A complete collection history is required');
 const rows=input.toSorted((a,b)=>a.day.localeCompare(b.day));
 if(rows[0].day!==firstDay||rows.at(-1).day!==throughDay)throw new Error('History must include the fixed collection start through the declared final day');
 rows.forEach((row,i)=>{
  if(row.day!==addDays(firstDay,i))throw new Error('Missing or duplicate date');
  if(row.day>completedDay())throw new Error('An incomplete UTC day cannot be published');
  for(const k of ['addresses','contracts','tvlKda','tvlUsd','hashratePh','commits'])finite(row[k],k);
  for(const k of ['addresses','contracts','commits'])if(!Number.isSafeInteger(row[k]))throw new Error(`Invalid integer ${k}`);
  if(!(row.kdaUsd>0&&Number.isFinite(row.kdaUsd)))throw new Error('Invalid KDA price');
  if(!row.coverage||Object.keys(WEIGHTS).some(k=>row.coverage[k]!==true))throw new Error('Incomplete source coverage');
 });
 return rows;
}
/**
 * The permanent baseline: each metric's mean daily value over the first 30 collected days.
 * Count metrics below the documented minimum daily rate use that minimum (flagged, never silent).
 * A zero average-based baseline cannot be divided by and stops publication.
 */
export function computeBaseline(input,{firstDay=COLLECTION_START,minimums=MINIMUM_DAILY_BASELINE}={}){
 const period=input.toSorted((a,b)=>a.day.localeCompare(b.day)).slice(0,BASELINE_DAYS);
 if(period.length!==BASELINE_DAYS)throw Object.assign(new Error(`The fixed baseline needs the first ${BASELINE_DAYS} collected days`),{code:'BASELINE_INCOMPLETE'});
 const rows=validateRows(period,{firstDay,throughDay:addDays(firstDay,BASELINE_DAYS-1)});
 const metrics={};
 for(const [id,{source,kind}] of Object.entries(METRICS)){
  const observedDailyMean=rows.reduce((sum,row)=>sum+row[source],0)/BASELINE_DAYS,minimum=kind==='count'?minimums[id]??0:0;
  const dailyMean=Math.max(observedDailyMean,minimum),rule=observedDailyMean<minimum?'minimum':'observed';
  if(!(dailyMean>0))throw Object.assign(new Error(`The ${id} baseline is zero; publication needs a documented non-zero baseline`),{code:'BASELINE_ZERO',details:{metric:id}});
  metrics[id]={kind,observedDailyMean,minimumDailyMean:minimum,dailyMean,rule};
 }
 return {fromDay:firstDay,throughDay:addDays(firstDay,BASELINE_DAYS-1),days:BASELINE_DAYS,level:BASELINE_LEVEL,metrics};
}
/**
 * index = 50 × Σ weight × (current value ÷ fixed baseline). No ceiling, no peak normalization:
 * later days never change the baseline or restate an earlier score.
 */
export function calculateSeries(input,{throughDay=completedDay(),firstDay=COLLECTION_START,baselineRows}={}){
 const rows=validateRows(input,{firstDay,throughDay});
 const baseline=computeBaseline(baselineRows??rows,{firstDay});
 return rows.map((row,i)=>{
  // The first six days disclose shorter windows; they are never presented as full weeks.
  const window=rows.slice(Math.max(0,i-6),i+1),n=window.length;
  const components={};let composite=0;
  for(const [id,weight] of Object.entries(WEIGHTS)){
   const {source,kind}=METRICS[id],base=baseline.metrics[id],total=window.reduce((sum,r)=>sum+r[source],0);
   const rawValue=kind==='count'?total:total/n,baselineValue=kind==='count'?n*base.dailyMean:base.dailyMean;
   const ratio=rawValue/baselineValue,index=BASELINE_LEVEL*ratio;
   components[id]={kind,rawValue,windowDays:n,dailyValue:row[source],baselineValue,baselineDailyMean:base.dailyMean,observedBaselineDailyMean:base.observedDailyMean,baselineRule:base.rule,ratio,index,weight,contribution:index*weight};
   composite+=index*weight;
  }
  const score=Math.round((composite+Number.EPSILON)*10)/10;
  return {day:row.day,score,windowDays:n,startupWindow:n<7,partialForkDay:false,baselineDay:firstDay,collectionStart:firstDay,initialHistoryDays:INITIAL_HISTORY_DAYS,normalization:NORMALIZATION,baseline:{fromDay:baseline.fromDay,throughDay:baseline.throughDay,days:baseline.days,level:baseline.level},methodVersion:METHOD_VERSION,registryVersion:row.registryVersion,components,tvlUsd:row.tvlUsd,kdaUsd:row.kdaUsd};
 });
}
export function changes(series,current){const lookup=new Map(series.map(s=>[s.day,s]));const delta=n=>{const prior=lookup.get(addDays(current.day,-n));return prior?Math.round((current.score-prior.score)*10)/10:null};return{sevenDay:delta(7),thirtyDay:delta(30)}}
export function weekOverWeek(current,previous){return {absolute:previous===undefined?null:current-previous,percent:previous===undefined||previous===0?null:(current-previous)/previous*100}}
