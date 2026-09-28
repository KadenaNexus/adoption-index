import http from 'node:http';
import {createHash,timingSafeEqual} from 'node:crypto';
import {pathToFileURL} from 'node:url';
import {readFile} from 'node:fs/promises';
import {isIP} from 'node:net';
import {database} from './db.mjs';
import {addDays,changes,completedDay,weekOverWeek,METHOD_VERSION} from './scoring.mjs';
import {windowFor,INITIAL_HISTORY_DAYS,COLLECTION_START,BASELINE_LEVEL} from './window.mjs';
export function historyRange(range,latestDay,window){
 const duration={'30d':30,'90d':90,'1y':365,all:null};
 if(!Object.hasOwn(duration,range))return null;
 const availableDays=Math.round((Date.parse(latestDay)-Date.parse(window.fromDay))/86400000)+1;
 if(range==='1y'&&availableDays<365)return {unavailable:true,requiredDays:365,availableDays};
 return {fromDay:duration[range]===null?window.fromDay:[window.fromDay,addDays(latestDay,1-duration[range])].sort().at(-1),availableDays};
}
const keyHash=key=>createHash('sha256').update(key).digest('hex');
export function clientAddress(request,trustLoopbackProxy=process.env.TRUST_LOOPBACK_PROXY==='1'){
 const peer=request.socket.remoteAddress??'unknown';
 if(trustLoopbackProxy&&['127.0.0.1','::1','::ffff:127.0.0.1'].includes(peer)){
  // Nginx appends the real peer last; never trust a client-supplied first entry.
  const value=request.headers['x-forwarded-for'];
  const last=typeof value==='string'?value.split(',').at(-1).trim():'';
  if(isIP(last))return last;
 }
 return peer;
}
export async function authorize(pool,request){
 const auth=request.headers.authorization;
 const key=request.headers['x-api-key']??(typeof auth==='string'&&auth.startsWith('Bearer ')?auth.slice(7):'');
 if(typeof key!=='string'||key.length<32||key.length>512)return false;
 const digest=keyHash(key);
 const row=(await pool.query('SELECT key_hash FROM api_keys WHERE key_hash=$1 AND revoked_at IS NULL',[digest])).rows[0];
 return !!row&&timingSafeEqual(Buffer.from(row.key_hash,'hex'),Buffer.from(digest,'hex'));
}
function send(response,status,body,extra={}){response.writeHead(status,{'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store','X-Content-Type-Options':'nosniff',...extra});response.end(JSON.stringify(body));}
/** Fixed baselines are methodology constants, not daily Pro data. */
export function publicBaseline(snapshot){
 const metrics=Object.fromEntries(Object.entries(snapshot.components??{}).map(([id,c])=>[id,{kind:c.kind,perWindow:c.kind==='count'?7*c.baselineDailyMean:c.baselineDailyMean,dailyMean:c.baselineDailyMean,observedDailyMean:c.observedBaselineDailyMean,rule:c.baselineRule}]));
 return {...snapshot.baseline,level:BASELINE_LEVEL,metrics};
}
export function createServer(pool){
 const origins=new Set((process.env.CORS_ORIGINS??'https://kadena.ws').split(',').map(s=>s.trim()));
 const rates=new Map();
 return http.createServer(async(request,response)=>{
  const origin=request.headers.origin;if(origin&&origins.has(origin)){response.setHeader('Access-Control-Allow-Origin',origin);response.setHeader('Vary','Origin');}
  if(request.method==='OPTIONS'){response.writeHead(204,{'Access-Control-Allow-Methods':'GET, OPTIONS','Access-Control-Allow-Headers':'Authorization, X-API-Key'});response.end();return;}
  const ip=clientAddress(request),now=Date.now();const rate=rates.get(ip);
  if(!rate||rate.end<=now)rates.set(ip,{end:now+60000,count:1});else if(++rate.count>120)return send(response,429,{error:'rate_limit'},{'Retry-After':'60'});
  if(rates.size>10000)for(const [key,value] of rates)if(value.end<=now)rates.delete(key);
  if(request.method!=='GET')return send(response,405,{error:'method_not_allowed'},{Allow:'GET, OPTIONS'});
  try{
   const url=new URL(request.url,'http://localhost'),window=windowFor(),bounds=[window.fromDay,window.throughDay,METHOD_VERSION];
   const filter="day>=$1::date AND day<=$2::date AND payload->>'methodVersion'=$3 AND payload->>'baselineDay'=$1::text";
   if(url.pathname==='/health'){
    await pool.query('SELECT 1');
    const last=(await pool.query(`SELECT day FROM index_snapshots WHERE ${filter} ORDER BY day DESC LIMIT 1`,bounds)).rows[0];
    const day=last?.day instanceof Date?last.day.toISOString().slice(0,10):last?.day??null;
    return send(response,200,{service:'ok',index:day===completedDay()?'current':day?'stale':'backfill_incomplete',throughDay:day,fromDay:window.fromDay,collectionStart:COLLECTION_START,initialHistoryDays:INITIAL_HISTORY_DAYS,summaryRetention:'permanent'});
   }
   if(url.pathname==='/protocols')return send(response,200,JSON.parse(await readFile(new URL('../config/protocol-registry.json',import.meta.url),'utf8')));
   if(!['/index/today','/index/history','/metrics/breakdown'].includes(url.pathname))return send(response,404,{error:'not_found'});
   if(url.pathname!=='/index/today'&&!await authorize(pool,request))return send(response,401,{error:'valid_api_key_required'},{'WWW-Authenticate':'Bearer'});
   const current=(await pool.query(`SELECT payload,updated_at FROM index_snapshots WHERE ${filter} ORDER BY day DESC LIMIT 1`,bounds)).rows[0];
   if(!current)return send(response,503,{error:'index_not_ready',message:'The initial 90-day dataset has not been validated and published.',fromDay:window.fromDay,throughDay:window.throughDay,collectionStart:COLLECTION_START,initialHistoryDays:INITIAL_HISTORY_DAYS,summaryRetention:'permanent'},{'Retry-After':'3600'});
   const latest=current.payload,metadata={methodVersion:latest.methodVersion,baselineDay:latest.baselineDay,collectionStart:COLLECTION_START,initialHistoryDays:INITIAL_HISTORY_DAYS,summaryRetention:'permanent',normalization:latest.normalization,historyDays:Math.round((Date.parse(latest.day)-Date.parse(COLLECTION_START))/86400000)+1};
   if(url.pathname==='/index/today'){
    const comparisons=(await pool.query(`SELECT payload FROM index_snapshots WHERE ${filter} AND day=ANY($4::date[])`,[...bounds,[addDays(latest.day,-7),addDays(latest.day,-30)]] )).rows.map(r=>r.payload);
    return send(response,200,{date:latest.day,score:Math.round(latest.score),scorePrecision:'whole-number',changes:changes(comparisons,latest),changeUnit:'index_points',state:latest.day===completedDay()?'current':'stale',updatedAt:current.updated_at,baseline:publicBaseline(latest),...metadata});
   }
   if(url.pathname==='/index/history'){
    const range=url.searchParams.get('range')??'30d',selected=historyRange(range,latest.day,window);
    if(!selected)return send(response,400,{error:'invalid_range',allowed:['30d','90d','1y','all']});
    if(selected.unavailable)return send(response,400,{error:'range_not_available',range,requiredDays:selected.requiredDays,availableDays:selected.availableDays});
    const rows=(await pool.query(`SELECT payload FROM index_snapshots WHERE ${filter} AND day>=$4 ORDER BY day`,[...bounds,selected.fromDay])).rows;
    return send(response,200,{range,fromDay:selected.fromDay,throughDay:latest.day,availableRanges:{'30d':true,'90d':true,all:true,'1y':selected.availableDays>=365},scorePrecision:'one-decimal',baselineLevel:BASELINE_LEVEL,series:rows.map(({payload:p})=>({date:p.day,score:p.score,windowDays:p.windowDays,startupWindow:p.startupWindow})),...metadata});
   }
   const prior=(await pool.query(`SELECT payload FROM index_snapshots WHERE ${filter} AND day=$4`,[...bounds,addDays(latest.day,-7)])).rows[0]?.payload;
   return send(response,200,{date:latest.day,score:latest.score,windowDays:latest.windowDays,baseline:publicBaseline(latest),metrics:Object.entries(latest.components).map(([id,c])=>({id,...c,weekOverWeek:weekOverWeek(c.rawValue,prior?.components[id]?.rawValue)})),tvlUsd:latest.tvlUsd,kdaUsd:latest.kdaUsd,registryVersion:latest.registryVersion,...metadata});
  }catch(error){console.error(JSON.stringify({event:'api_error',name:error.name}));send(response,503,{error:'temporarily_unavailable'});}
 });
}
// PM2 loads the script through its own container, so there argv[1] is PM2's file and pm_exec_path is this one.
export const isEntryPoint=(url,{argv=process.argv,env=process.env}={})=>[argv[1],env.pm_exec_path].some(path=>!!path&&url===pathToFileURL(path).href);
if(isEntryPoint(import.meta.url)){
 const pool=database(),server=createServer(pool);server.listen(Number(process.env.PORT??3001),process.env.HOST??'127.0.0.1',()=>console.log('KCE index API started'));
 for(const signal of ['SIGINT','SIGTERM'])process.on(signal,()=>server.close(async()=>{await pool.end();process.exit(0)}));
}
