import {test} from 'node:test';
import assert from 'node:assert/strict';
import {randomBytes} from 'node:crypto';
import pg from 'pg';
import '../src/db.mjs'; // the app's DATE parsing
import {migrate} from '../src/migrate.mjs';
import {createServer} from '../src/server.mjs';
import {accountsConfig} from '../src/config.mjs';
import {hashToken,newToken} from '../src/auth.mjs';
import {calculateSeries,METHOD_VERSION} from '../src/scoring.mjs';
import {COLLECTION_START,addDays} from '../src/window.mjs';
import {exportCsv,csvCell,CSV_HEADER} from '../src/export.mjs';
const connection=process.env.TEST_DATABASE_URL;
async function isolated(t){
 const url=new URL(connection);if(!url.pathname.endsWith('_test'))throw new Error('Integration tests require a dedicated *_test database');
 // Small pools: the whole suite runs in parallel against one local server with few connection slots.
 const schema='export_'+randomBytes(8).toString('hex'),admin=new pg.Pool({connectionString:connection,max:1});
 await admin.query(`CREATE SCHEMA ${schema}`);url.searchParams.set('options',`-c search_path=${schema}`);const db=new pg.Pool({connectionString:url.href,max:3,connectionTimeoutMillis:30000});
 t.after(async()=>{await db.end();try{await admin.query(`DROP SCHEMA ${schema} CASCADE`)}finally{await admin.end()}});
 await migrate(db);return db;
}
const DAYS=35,rowFor=i=>({day:addDays(COLLECTION_START,i),addresses:100+i,contracts:i%3,tvlKda:50+i*1.5,tvlUsd:5,kdaUsd:.1,hashratePh:10+i/7,commits:2+i%4,registryVersion:'fixture',coverage:{addresses:true,contracts:true,tvl:true,hashrate:true,commits:true}});
// Published exactly as the pipeline stores them: raw rows in daily_metrics, calculateSeries output in index_snapshots.
async function publish(db){
 const rows=Array.from({length:DAYS},(_,i)=>rowFor(i)),snapshots=calculateSeries(rows,{throughDay:rows.at(-1).day});
 for(const [i,snapshot] of snapshots.entries()){
  await db.query('INSERT INTO daily_metrics(day,raw,coverage,registry_version,method_version) VALUES($1,$2,$3,$4,$5)',[rows[i].day,rows[i],rows[i].coverage,'fixture',METHOD_VERSION]);
  await db.query('INSERT INTO index_snapshots(day,score,payload) VALUES($1,$2,$3)',[snapshot.day,snapshot.score,snapshot]);
 }
 return snapshots;
}
const METRICS=['addresses','contracts','tvl','hashrate','commits'];

test('the CSV header lists the date, score, window and five columns per metric, then the method',()=>{
 assert.equal(CSV_HEADER.join(','),['date,score,window_days',...METRICS.map(id=>`${id}_value,${id}_baseline,${id}_ratio,${id}_index,${id}_contribution`),'method_version'].join(','));
 assert.equal(CSV_HEADER.length,3+5*5+1);
});
test('CSV cells are quoted per RFC 4180 and never start a spreadsheet formula',()=>{
 assert.equal(csvCell(null),'');assert.equal(csvCell(undefined),'');assert.equal(csvCell(Number.NaN),'');assert.equal(csvCell(Infinity),'');
 assert.equal(csvCell(12.5),'12.5');assert.equal(csvCell(-3),'-3');assert.equal(csvCell(0.1+0.2),'0.30000000000000004');assert.equal(csvCell(1e-18),'1e-18');
 assert.equal(csvCell('2026-06-29'),'2026-06-29');assert.equal(csvCell('a,b'),'"a,b"');assert.equal(csvCell('say "hi"'),'"say ""hi"""');assert.equal(csvCell('two\nlines'),'"two\nlines"');
 for(const value of ['=1+1','+1','-1','@SUM(A1)','\tx'])assert.ok(csvCell(value).startsWith("'"),value);
 assert.equal(csvCell('=HYPERLINK("x")'),`"'=HYPERLINK(""x"")"`);
});

test('exportCsv: one row per published day from real snapshot payloads, oldest first, with the same filter as the API',{skip:!connection},async t=>{
 const db=await isolated(t);
 await assert.rejects(exportCsv(db),error=>error.status===503&&error.code==='index_not_ready');
 const snapshots=await publish(db),lastDay=snapshots.at(-1).day;
 // Other methods and baselines are not published scores.
 for(const [offset,change] of [[DAYS,{methodVersion:'kce-v3-growing-90d-2026-09-27'}],[DAYS+1,{baselineDay:addDays(COLLECTION_START,1)}]]){
  const day=addDays(COLLECTION_START,offset);
  await db.query("INSERT INTO daily_metrics(day,raw,coverage,registry_version,method_version) VALUES($1,'{}','{}','fixture',$2)",[day,METHOD_VERSION]);
  await db.query('INSERT INTO index_snapshots(day,score,payload) VALUES($1,$2,$3)',[day,99,{...snapshots.at(-1),day,score:99,...change}]);
 }
 const {filename,csv,rows,throughDay}=await exportCsv(db);
 assert.equal(filename,`kce-adoption-index-${lastDay}.csv`);assert.equal(throughDay,lastDay);assert.equal(rows,DAYS);
 assert.ok(csv.endsWith('\r\n'));
 const lines=csv.slice(0,-2).split('\r\n');assert.equal(lines.length,DAYS+1);assert.equal(lines[0],CSV_HEADER.join(','));
 for(const [i,line] of lines.slice(1).entries()){
  const cells=line.split(','),p=snapshots[i];
  assert.equal(cells.length,CSV_HEADER.length);
  assert.equal(cells[0],p.day);assert.equal(Number(cells[1]),p.score);assert.equal(Number(cells[2]),p.windowDays);assert.equal(cells.at(-1),METHOD_VERSION);
  METRICS.forEach((id,m)=>{const c=p.components[id];assert.deepEqual(cells.slice(3+m*5,8+m*5).map(Number),[c.rawValue,c.baselineValue,c.ratio,c.index,c.contribution],`${p.day} ${id}`)});
 }
 // Spot-check the scoring relationship survives the export: score ≈ Σ contributions.
 const last=lines.at(-1).split(','),sum=METRICS.reduce((s,_,m)=>s+Number(last[7+m*5]),0);
 assert.ok(Math.abs(Math.round(sum*10)/10-Number(last[1]))<1e-9);
 assert.equal(lines[1].split(',')[2],'1','the first day discloses its one-day window');
});

test('GET /export.csv: subscribers download it through the site; others are refused, and a missing or ended session is session_required',{skip:!connection},async t=>{
 const db=await isolated(t),siteKey='k'.repeat(40),cfg=accountsConfig({SITE_API_KEY:siteKey,PUBLIC_SITE_URL:'http://127.0.0.1:5173',MAIL_TRANSPORT:'log'});
 const snapshots=await publish(db);
 const session=async(email,days)=>{const id=(await db.query('INSERT INTO users(email) VALUES($1) RETURNING id',[email])).rows[0].id,token=newToken();
  await db.query("INSERT INTO sessions(token_hash,user_id,expires_at) VALUES($1,$2,now()+interval '1 day')",[hashToken(token),id]);
  if(days)await db.query("INSERT INTO subscriptions(user_id,plan,started_at,expires_at) VALUES($1,'monthly',now()-interval '1 day',now()+make_interval(days=>$2))",[id,days]);return token};
 const pro=await session('pro@example.com',30),free=await session('free@example.com',0);
 const server=createServer(db,{cfg,mailer:{transport:'log',async send(){return {id:'x'}}}});
 await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));t.after(()=>new Promise(resolve=>server.close(resolve)));
 const get=headers=>fetch(`http://127.0.0.1:${server.address().port}/export.csv`,{headers});
 const ok=await get({'X-KCE-Site-Key':siteKey,'X-KCE-Session':pro,'X-KCE-Client-IP':'203.0.113.7'});
 assert.equal(ok.status,200);assert.equal(ok.headers.get('content-type'),'text/csv; charset=utf-8');
 assert.equal(ok.headers.get('content-disposition'),`attachment; filename="kce-adoption-index-${snapshots.at(-1).day}.csv"`);
 assert.equal(await ok.text(),(await exportCsv(db)).csv);
 const forbidden=await get({'X-KCE-Site-Key':siteKey,'X-KCE-Session':free});assert.equal(forbidden.status,403);assert.equal((await forbidden.json()).error,'subscription_required');
 const anonymous=await get({});assert.equal(anonymous.status,401);assert.equal((await anonymous.json()).error,'valid_api_key_required');
 // The site sends a subscriber whose session is missing, expired or revoked to sign in again; a lapsed subscription is 403.
 const expired=await session('expired@example.com',30),revoked=await session('revoked@example.com',30),lapsed=await session('lapsed@example.com',0);
 await db.query("UPDATE sessions SET expires_at=now()-interval '1 minute' WHERE token_hash=$1",[hashToken(expired)]);
 await db.query('UPDATE sessions SET revoked_at=now() WHERE token_hash=$1',[hashToken(revoked)]);
 await db.query("INSERT INTO subscriptions(user_id,plan,started_at,expires_at) SELECT id,'monthly',now()-interval '31 days',now()-interval '1 day' FROM users WHERE email='lapsed@example.com'");
 for(const path of ['/export.csv','/metrics/breakdown','/index/history']){
  const at=headers=>fetch(`http://127.0.0.1:${server.address().port}${path}`,{headers:{'X-KCE-Site-Key':siteKey,...headers}});
  for(const headers of [{},{'X-KCE-Session':expired},{'X-KCE-Session':revoked},{'X-KCE-Session':'not-a-token'}]){
   const r=await at(headers);assert.equal(r.status,401,`${path} ${JSON.stringify(headers)}`);assert.equal((await r.json()).error,'session_required');
  }
  const r=await at({'X-KCE-Session':lapsed});assert.equal(r.status,403,path);assert.equal((await r.json()).error,'subscription_required');
 }
});
