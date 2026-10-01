import http from 'node:http';
import {createHash,timingSafeEqual} from 'node:crypto';
import {pathToFileURL} from 'node:url';
import {readFile} from 'node:fs/promises';
import {database} from './db.mjs';
import {addDays,changes,completedDay,weekOverWeek,METHOD_VERSION} from './scoring.mjs';
import {windowFor,INITIAL_HISTORY_DAYS,COLLECTION_START,BASELINE_LEVEL} from './window.mjs';
import {accountsConfig,disabledAccountsConfig} from './config.mjs';
import {resolveSession} from './auth.mjs';
import {HttpError,readJson,send,siteContext,ipGroup} from './http.mjs';
import {createMailer} from './mailer.mjs';
import {exportCsv} from './export.mjs';
import {routes as accountRoutes} from './accounts-http.mjs';
import {routes as billingRoutes} from './billing-http.mjs';
export function historyRange(range,latestDay,window){
 const duration={'30d':30,'90d':90,'1y':365,all:null};
 if(!Object.hasOwn(duration,range))return null;
 const availableDays=Math.round((Date.parse(latestDay)-Date.parse(window.fromDay))/86400000)+1;
 if(range==='1y'&&availableDays<365)return {unavailable:true,requiredDays:365,availableDays};
 return {fromDay:duration[range]===null?window.fromDay:[window.fromDay,addDays(latestDay,1-duration[range])].sort().at(-1),availableDays};
}
const keyHash=key=>createHash('sha256').update(key).digest('hex');
/** The direct visitor's rate-limit key (see ipGroup). */
export function clientAddress(request,trustLoopbackProxy=process.env.TRUST_LOOPBACK_PROXY==='1'){
 const peer=request.socket.remoteAddress??'unknown';
 if(trustLoopbackProxy&&['127.0.0.1','::1','::ffff:127.0.0.1'].includes(peer)){
  // Nginx appends the real peer last; never trust a client-supplied first entry.
  const value=request.headers['x-forwarded-for'];
  const last=ipGroup(typeof value==='string'?value.split(',').at(-1).trim():'');
  if(last)return last;
 }
 return ipGroup(peer)??peer;
}
export async function authorize(pool,request){
 const auth=request.headers.authorization;
 const key=request.headers['x-api-key']??(typeof auth==='string'&&auth.startsWith('Bearer ')?auth.slice(7):'');
 if(typeof key!=='string'||key.length<32||key.length>512)return false;
 const digest=keyHash(key);
 const row=(await pool.query('SELECT key_hash FROM api_keys WHERE key_hash=$1 AND revoked_at IS NULL',[digest])).rows[0];
 return !!row&&timingSafeEqual(Buffer.from(row.key_hash,'hex'),Buffer.from(digest,'hex'));
}
/** Fixed baselines are methodology constants, not daily Pro data. */
export function publicBaseline(snapshot){
 const metrics=Object.fromEntries(Object.entries(snapshot.components??{}).map(([id,c])=>[id,{kind:c.kind,perWindow:c.kind==='count'?7*c.baselineDailyMean:c.baselineDailyMean,dailyMean:c.baselineDailyMean,observedDailyMean:c.observedBaselineDailyMean,rule:c.baselineRule}]));
 return {...snapshot.baseline,level:BASELINE_LEVEL,metrics};
}
/** Pro data: an API key, or the website's key plus a session with an active subscription. */
const PRO_PATHS=['/index/history','/metrics/breakdown','/export.csv'];
/** Account routes that work without a session. Every other route needs one, and /admin/ routes need an admin. */
export const PUBLIC_ROUTES=new Set(['POST /auth/request-link','POST /auth/verify','POST /auth/verify-code','POST /auth/logout','GET /billing/config','POST /reports']);
export function createServer(pool,{cfg=accountsConfig(),mailer=createMailer(cfg),now=()=>new Date()}={}){
 const origins=new Set((process.env.CORS_ORIGINS??'https://kadena.ws').split(',').map(s=>s.trim()));
 const rates=new Map();
 const routes={...accountRoutes,...billingRoutes};
 return http.createServer(async(request,response)=>{
  const origin=request.headers.origin;if(origin&&origins.has(origin)){response.setHeader('Access-Control-Allow-Origin',origin);response.setHeader('Vary','Origin');}
  if(request.method==='OPTIONS'){response.writeHead(204,{'Access-Control-Allow-Methods':'GET, OPTIONS','Access-Control-Allow-Headers':'Authorization, X-API-Key'});response.end();return;}
  // Requests relayed by the website are limited per real visitor, not per loopback address.
  const site=siteContext(request,cfg),ip=site.clientIp??(site.siteOk?'site:':'')+clientAddress(request),at=Date.now();const rate=rates.get(ip);
  if(!rate||rate.end<=at)rates.set(ip,{end:at+60000,count:1});else if(++rate.count>120)return send(response,429,{error:'rate_limit'},{'Retry-After':'60'});
  if(rates.size>10000)for(const [key,value] of rates)if(value.end<=at)rates.delete(key);
  let url;try{url=new URL(request.url,'http://localhost')}catch{return send(response,400,{error:'bad_request'})}
  const route=`${request.method} ${url.pathname}`,handler=Object.hasOwn(routes,route)?routes[route]:null;
  if(handler){
   try{
    if(!cfg.siteKey)throw new HttpError(503,'accounts_disabled');
    if(!site.siteOk)throw new HttpError(401,'site_key_required');
    const body=request.method==='POST'?await readJson(request):undefined,time=now();
    // A report's session only lifts the daily cap for subscribers, so reading it must not record when it was used.
    const session=site.sessionToken?await resolveSession(pool,site.sessionToken,{cfg,now:time,touch:route!=='POST /reports'}):null;
    const requireSession=()=>{if(!session)throw new HttpError(401,'session_required');return session};
    const ctx={db:pool,cfg,request,url,body,clientIp:ip,session,mailer,now:time,requireSession,
     requireSubscriber(){const s=requireSession();if(!s.subscription?.active)throw new HttpError(403,'subscription_required');return s},
     requireAdmin(){const s=requireSession();if(!s.user.isAdmin)throw new HttpError(404,'not_found');return s}};
    if(!PUBLIC_ROUTES.has(route))requireSession();
    if(url.pathname.startsWith('/admin/'))ctx.requireAdmin();
    const result=await handler(ctx);
    return send(response,result?.status??200,result?.body??{},result?.headers);
   }catch(error){
    if(error instanceof HttpError)return send(response,error.status,{error:error.code,...error.extra});
    console.error(JSON.stringify({event:'api_error',route,name:error.name,code:error.code,message:String(error.message??'').slice(0,200)}));
    return send(response,500,{error:'internal_error'});
   }
  }
  if(request.method!=='GET')return send(response,405,{error:'method_not_allowed'},{Allow:'GET, OPTIONS'});
  try{
   const window=windowFor(),bounds=[window.fromDay,window.throughDay,METHOD_VERSION];
   const filter="day>=$1::date AND day<=$2::date AND payload->>'methodVersion'=$3 AND payload->>'baselineDay'=$1::text";
   if(url.pathname==='/health'){
    await pool.query('SELECT 1');
    const last=(await pool.query(`SELECT day FROM index_snapshots WHERE ${filter} ORDER BY day DESC LIMIT 1`,bounds)).rows[0];
    const day=last?.day instanceof Date?last.day.toISOString().slice(0,10):last?.day??null;
    return send(response,200,{service:'ok',index:day===completedDay()?'current':day?'stale':'backfill_incomplete',throughDay:day,fromDay:window.fromDay,collectionStart:COLLECTION_START,initialHistoryDays:INITIAL_HISTORY_DAYS,summaryRetention:'permanent'});
   }
   if(url.pathname==='/protocols')return send(response,200,JSON.parse(await readFile(new URL('../config/protocol-registry.json',import.meta.url),'utf8')));
   if(url.pathname!=='/index/today'&&!PRO_PATHS.includes(url.pathname))return send(response,404,{error:'not_found'});
   if(PRO_PATHS.includes(url.pathname)&&!await authorize(pool,request)){
    if(!site.siteOk)return send(response,401,{error:'valid_api_key_required'},{'WWW-Authenticate':'Bearer'});
    const session=site.sessionToken?await resolveSession(pool,site.sessionToken,{cfg,now:now()}):null;
    if(!session)return send(response,401,{error:'session_required'});
    if(!session.subscription?.active)return send(response,403,{error:'subscription_required'});
   }
   const current=(await pool.query(`SELECT payload,updated_at FROM index_snapshots WHERE ${filter} ORDER BY day DESC LIMIT 1`,bounds)).rows[0];
   if(!current)return send(response,503,{error:'index_not_ready',message:'The initial 90-day dataset has not been validated and published.',fromDay:window.fromDay,throughDay:window.throughDay,collectionStart:COLLECTION_START,initialHistoryDays:INITIAL_HISTORY_DAYS,summaryRetention:'permanent'},{'Retry-After':'3600'});
   if(url.pathname==='/export.csv'){
    const {filename,csv}=await exportCsv(pool);
    response.writeHead(200,{'Content-Type':'text/csv; charset=utf-8','Content-Disposition':`attachment; filename="${String(filename).replace(/[^A-Za-z0-9._-]/g,'')}"`,'Cache-Control':'no-store','X-Content-Type-Options':'nosniff'});
    return response.end(csv);
   }
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
 // A mistake in the account settings must not take the public index down: accounts stay off until it is fixed.
 let cfg;try{cfg=accountsConfig()}catch(error){console.error(JSON.stringify({event:'accounts_config_invalid',message:error.message}));cfg=disabledAccountsConfig()}
 const pool=database(),server=createServer(pool,{cfg});server.listen(Number(process.env.PORT??3001),process.env.HOST??'127.0.0.1',()=>console.log('KCE index API started'));
 for(const signal of ['SIGINT','SIGTERM'])process.on(signal,()=>server.close(async()=>{await pool.end();process.exit(0)}));
}
