import {HttpError} from './http.mjs';
import {METHOD_VERSION} from './scoring.mjs';
import {windowFor,completedDay} from './window.mjs';
export const CSV_METRICS=Object.freeze(['addresses','contracts','tvl','hashrate','commits']);
const FIELDS=[['value','rawValue'],['baseline','baselineValue'],['ratio','ratio'],['index','index'],['contribution','contribution']];
export const CSV_HEADER=Object.freeze(['date','score','window_days',...CSV_METRICS.flatMap(id=>FIELDS.map(([name])=>`${id}_${name}`)),'method_version']);
/** RFC 4180 quoting; a text cell never starts with a spreadsheet formula character. Numbers keep full precision. */
export function csvCell(value){
 if(value===null||value===undefined)return '';
 if(typeof value==='number')return Number.isFinite(value)?String(value):'';
 const text=/^[=+\-@\t\r]/.test(String(value))?`'${value}`:String(value);
 return /[",\r\n]/.test(text)?`"${text.replaceAll('"','""')}"`:text;
}
/** The subscriber CSV: every published day of the current method and fixed baseline, oldest first. */
export async function exportCsv(db,{now=new Date()}={}){
 const window=windowFor(completedDay(now),{now});
 const payloads=(await db.query(`SELECT payload FROM index_snapshots WHERE day>=$1::date AND day<=$2::date AND payload->>'methodVersion'=$3 AND payload->>'baselineDay'=$1::text ORDER BY day`,
  [window.fromDay,window.throughDay,METHOD_VERSION])).rows.map(row=>row.payload);
 if(!payloads.length)throw new HttpError(503,'index_not_ready');
 const lines=payloads.map(p=>[p.day,p.score,p.windowDays,...CSV_METRICS.flatMap(id=>FIELDS.map(([,key])=>p.components?.[id]?.[key])),p.methodVersion].map(csvCell).join(','));
 const throughDay=payloads.at(-1).day;
 return {filename:`kce-adoption-index-${throughDay}.csv`,csv:[CSV_HEADER.join(','),...lines].join('\r\n')+'\r\n',rows:payloads.length,throughDay};
}
