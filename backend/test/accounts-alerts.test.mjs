import {test} from 'node:test';
import assert from 'node:assert/strict';
import {randomBytes} from 'node:crypto';
import pg from 'pg';
import '../src/db.mjs'; // the app's DATE parsing
import {migrate} from '../src/migrate.mjs';
import {createServer} from '../src/server.mjs';
import {accountsConfig} from '../src/config.mjs';
import {hashToken,newToken} from '../src/auth.mjs';
import {parseThreshold,MAX_ALERTS} from '../src/accounts.mjs';
const connection=process.env.TEST_DATABASE_URL;
async function isolated(t){
 const url=new URL(connection);if(!url.pathname.endsWith('_test'))throw new Error('Integration tests require a dedicated *_test database');
 // Small pools: the whole suite runs in parallel against one local server with few connection slots.
 const schema='alerts_'+randomBytes(8).toString('hex'),admin=new pg.Pool({connectionString:connection,max:1});
 await admin.query(`CREATE SCHEMA ${schema}`);url.searchParams.set('options',`-c search_path=${schema}`);const db=new pg.Pool({connectionString:url.href,max:3,connectionTimeoutMillis:30000});
 t.after(async()=>{await db.end();try{await admin.query(`DROP SCHEMA ${schema} CASCADE`)}finally{await admin.end()}});
 await migrate(db);return db;
}
const siteKey='k'.repeat(40),DAY=86400000,now=new Date('2026-10-01T12:00:00.000Z');
async function harness(t){
 const db=await isolated(t),cfg=accountsConfig({SITE_API_KEY:siteKey,PUBLIC_SITE_URL:'http://127.0.0.1:5173',MAIL_TRANSPORT:'log'});
 const server=createServer(db,{cfg,mailer:{transport:'log',async send(){return {id:'x'}}},now:()=>now});
 await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));t.after(()=>new Promise(resolve=>server.close(resolve)));
 const base=`http://127.0.0.1:${server.address().port}`;
 async function call(route,{body,session}={}){
  const [method,path]=route.split(' ');
  const response=await fetch(base+path,{method,headers:{'X-KCE-Site-Key':siteKey,'X-KCE-Client-IP':'203.0.113.7',...(session?{'X-KCE-Session':session}:{}),...(body===undefined?{}:{'Content-Type':'application/json'})},body:body===undefined?undefined:JSON.stringify(body)});
  return {status:response.status,body:await response.json()};
 }
 // Signed-in users straight in the database; the sign-in flow has its own tests.
 async function user(email,{expiresInDays}={}){
  const id=Number((await db.query('INSERT INTO users(email) VALUES($1) RETURNING id',[email])).rows[0].id),token=newToken();
  await db.query('INSERT INTO sessions(token_hash,user_id,expires_at) VALUES($1,$2,$3)',[hashToken(token),id,new Date(now.getTime()+30*DAY)]);
  if(expiresInDays!==undefined)await db.query('INSERT INTO subscriptions(user_id,plan,started_at,expires_at) VALUES($1,$2,$3,$4)',[id,'monthly',new Date(now.getTime()-40*DAY),new Date(now.getTime()+expiresInDays*DAY)]);
  return {id,session:token};
 }
 return {db,call,user};
}

test('alerts need an active subscription; a subscriber can keep up to 5 distinct rules',{skip:!connection},async t=>{
 const h=await harness(t),free=await h.user('free@example.com'),lapsed=await h.user('lapsed@example.com',{expiresInDays:-1}),pro=await h.user('pro@example.com',{expiresInDays:10});
 assert.equal((await h.call('POST /account/alerts',{body:{direction:'above',threshold:60}})).body.error,'session_required');
 for(const who of [free,lapsed]){const r=await h.call('POST /account/alerts',{session:who.session,body:{direction:'above',threshold:60}});assert.equal(r.status,403);assert.equal(r.body.error,'subscription_required')}
 assert.equal(MAX_ALERTS,5);
 const ids=[];
 for(const [direction,threshold] of [['above',60],['above','72.5'],['below',40],['below',0],['above',100000]]){
  const r=await h.call('POST /account/alerts',{session:pro.session,body:{direction,threshold}});assert.equal(r.status,201,`${direction} ${threshold}`);assert.ok(Number.isSafeInteger(r.body.id));ids.push(r.body.id);
 }
 const sixth=await h.call('POST /account/alerts',{session:pro.session,body:{direction:'below',threshold:30}});assert.equal(sixth.status,409);assert.equal(sixth.body.error,'too_many_alerts');
 // The same rule again, also written differently, is a duplicate (checked before the count).
 for(const threshold of [60,'60.0',60.04])assert.equal((await h.call('POST /account/alerts',{session:pro.session,body:{direction:'above',threshold}})).body.error,threshold===60.04?'invalid_alert':'duplicate_alert',String(threshold));
 const account=(await h.call('GET /account',{session:pro.session})).body;
 assert.deepEqual(account.alerts.map(({direction,threshold})=>[direction,threshold]),[['above',60],['above',72.5],['above',100000],['below',0],['below',40]]);
 assert.ok(account.alerts.every(a=>ids.includes(a.id)));
 // Deleting one frees a slot.
 assert.deepEqual((await h.call('POST /account/alerts/delete',{session:pro.session,body:{id:ids[0]}})).body,{ok:true});
 assert.equal((await h.call('POST /account/alerts',{session:pro.session,body:{direction:'below',threshold:30}})).status,201);
 assert.equal((await h.db.query('SELECT count(*)::int n FROM alert_rules WHERE user_id=$1',[pro.id])).rows[0].n,5);
});

test('alert input validation: direction, range and one decimal',{skip:!connection},async t=>{
 const h=await harness(t),pro=await h.user('pro@example.com',{expiresInDays:10});
 for(const body of [{direction:'sideways',threshold:50},{threshold:50},{direction:'above'},{direction:'above',threshold:-1},{direction:'above',threshold:100000.1},
  {direction:'above',threshold:1.25},{direction:'above',threshold:'abc'},{direction:'above',threshold:null},{direction:'above',threshold:'1e3'},{direction:'above',threshold:[5]},{direction:'ABOVE',threshold:5}]){
  const r=await h.call('POST /account/alerts',{session:pro.session,body});assert.equal(r.status,400,JSON.stringify(body));assert.equal(r.body.error,'invalid_alert');
 }
 assert.equal((await h.db.query('SELECT count(*)::int n FROM alert_rules')).rows[0].n,0);
 assert.equal(parseThreshold(0.1+0.2),0.3);assert.equal(parseThreshold('  12.5 '),12.5);assert.equal(parseThreshold(Number.NaN),null);assert.equal(parseThreshold(Infinity),null);
});

test('rules can only be deleted by their owner, including after the subscription ends',{skip:!connection},async t=>{
 const h=await harness(t),a=await h.user('a@example.com',{expiresInDays:10}),b=await h.user('b@example.com',{expiresInDays:10});
 const id=(await h.call('POST /account/alerts',{session:a.session,body:{direction:'above',threshold:55.5}})).body.id;
 const theirs=await h.call('POST /account/alerts/delete',{session:b.session,body:{id}});assert.equal(theirs.status,404);assert.equal(theirs.body.error,'not_found');
 assert.equal((await h.db.query('SELECT count(*)::int n FROM alert_rules')).rows[0].n,1,'still there');
 for(const bad of [undefined,0,-1,1.5,'x','',null,{}])assert.equal((await h.call('POST /account/alerts/delete',{session:a.session,body:{id:bad}})).body.error,'invalid_alert',String(bad));
 assert.equal((await h.call('POST /account/alerts/delete',{session:a.session,body:{id:id+1000}})).status,404);
 await h.db.query('UPDATE subscriptions SET expires_at=$2 WHERE user_id=$1',[a.id,new Date(now.getTime()-DAY)]);
 assert.equal((await h.call('POST /account/alerts/delete',{session:a.session,body:{id:String(id)}})).status,200);
 assert.equal((await h.db.query('SELECT count(*)::int n FROM alert_rules')).rows[0].n,0);
 assert.equal((await h.call('POST /account/alerts/delete',{body:{id}})).body.error,'session_required');
});

test('the 5-rule limit holds under concurrent requests',{skip:!connection},async t=>{
 const h=await harness(t),pro=await h.user('pro@example.com',{expiresInDays:10});
 const results=await Promise.all(Array.from({length:8},(_,i)=>h.call('POST /account/alerts',{session:pro.session,body:{direction:'above',threshold:10+i}})));
 assert.equal(results.filter(r=>r.status===201).length,5);assert.equal(results.filter(r=>r.body.error==='too_many_alerts').length,3);
});
