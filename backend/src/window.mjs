import {readFileSync} from 'node:fs';
/** Fixed start of the initial 90 completed UTC days. Daily history grows permanently. */
const policy=JSON.parse(readFileSync(new URL('../config/collection-policy.json',import.meta.url),'utf8'));
export const INITIAL_HISTORY_DAYS=90;
export const COLLECTION_START=validateDay(policy.collectionStart);
export const NORMALIZATION='fixed-baseline-first-30-days';
/** One permanent baseline: the first 30 collected days. It never moves and is never restated. */
export const BASELINE_DAYS=30;
export const BASELINE_LEVEL=50;
export const BASELINE_THROUGH=addDays(COLLECTION_START,BASELINE_DAYS-1);
export const MINIMUM_DAILY_BASELINE=Object.freeze({...policy.minimumDailyBaseline});
/** Storage key of collected GitHub observations. Raw sources keep their key when the scoring method changes. */
export const GITHUB_OBSERVATION_VERSION='kce-v3-growing-90d-2026-09-27';
if(policy.initialHistoryDays!==INITIAL_HISTORY_DAYS||policy.normalization!==NORMALIZATION||policy.dailyHistory!=='permanent'||addDays(COLLECTION_START,INITIAL_HISTORY_DAYS-1)!==policy.initialThroughDay
 ||policy.baselineDays!==BASELINE_DAYS||policy.baselineLevel!==BASELINE_LEVEL||policy.baselineThroughDay!==BASELINE_THROUGH
 ||!policy.minimumDailyBaseline||Object.values(policy.minimumDailyBaseline).some(value=>typeof value!=='number'||!Number.isFinite(value)||value<0))throw new Error('Invalid immutable collection policy');
export function validateDay(day) {
 if (typeof day !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(day) || !Number.isFinite(Date.parse(day+'T00:00:00Z')) || new Date(day+'T00:00:00Z').toISOString().slice(0,10)!==day) throw new Error('Invalid UTC day');
 return day;
}
export function addDays(day,n){validateDay(day);if(!Number.isInteger(n))throw new Error('Invalid day offset');return new Date(Date.parse(day+'T00:00:00Z')+n*86400000).toISOString().slice(0,10)}
export const completedDay=(now=new Date())=>addDays(now.toISOString().slice(0,10),-1);
export function windowFor(throughDay=completedDay(),{now=new Date()}={}) {
 validateDay(throughDay);
 if(throughDay>completedDay(now))throw new Error('Collection must end on a completed UTC day');
 if(throughDay<COLLECTION_START)throw new Error('Requested day precedes the fixed collection start');
 return {fromDay:COLLECTION_START,throughDay,startTime:COLLECTION_START+'T00:00:00Z',cutoff:addDays(throughDay,1)+'T00:00:00Z',days:Math.round((Date.parse(throughDay)-Date.parse(COLLECTION_START))/86400000)+1};
}
