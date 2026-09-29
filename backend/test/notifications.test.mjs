import {test} from 'node:test';
import assert from 'node:assert/strict';
import {randomBytes} from 'node:crypto';
import pg from 'pg';
import '../src/db.mjs'; // the app's DATE parsing
import {migrate} from '../src/migrate.mjs';
import {accountsConfig} from '../src/config.mjs';
import {createMailer} from '../src/mailer.mjs';
import {enqueueEmail} from '../src/outbox.mjs';
import {METHOD_VERSION} from '../src/scoring.mjs';
import {COLLECTION_START,addDays} from '../src/window.mjs';
import {processAlerts,processRenewalReminders,sendOutbox,crossed,ALERT_STATE_KEY,OUTBOX_BACKOFF_MS,OUTBOX_MAX_ATTEMPTS} from '../src/notifications.mjs';
import {formatDay} from '../src/emails.mjs';
const connection=process.env.TEST_DATABASE_URL;
async function isolated(t){
 const url=new URL(connection);if(!url.pathname.endsWith('_test'))throw new Error('Integration tests require a dedicated *_test database');
 // Small pools: the whole suite runs in parallel against one local server with few connection slots.
 const schema='notify_'+randomBytes(8).toString('hex'),admin=new pg.Pool({connectionString:connection,max:1});
 await admin.query(`CREATE SCHEMA ${schema}`);url.searchParams.set('options',`-c search_path=${schema}`);const db=new pg.Pool({connectionString:url.href,max:3,connectionTimeoutMillis:30000});
 t.after(async()=>{await db.end();try{await admin.query(`DROP SCHEMA ${schema} CASCADE`)}finally{await admin.end()}});
 await migrate(db);return db;
}
const MINUTE=60000,HOUR=60*MINUTE,DAY=24*HOUR,now=new Date('2026-10-01T12:00:00.000Z');
const cfg=accountsConfig({PUBLIC_SITE_URL:'https://adoption.kadena.ws',SUPPORT_EMAIL:'help@kadena.ws'});
const D=i=>addDays(COLLECTION_START,i);
async function publish(db,day,score,{methodVersion=METHOD_VERSION,baselineDay=COLLECTION_START}={}){
 await db.query("INSERT INTO daily_metrics(day,raw,coverage,registry_version,method_version) VALUES($1,'{}','{}','fixture',$2)",[day,METHOD_VERSION]);
 await db.query('INSERT INTO index_snapshots(day,score,payload) VALUES($1,$2,$3)',[day,score,{day,score,methodVersion,baselineDay,windowDays:7}]);
}
async function subscriber(db,email,expiresInDays){
 const id=Number((await db.query('INSERT INTO users(email) VALUES($1) RETURNING id',[email])).rows[0].id);
 if(expiresInDays!==null)await db.query('INSERT INTO subscriptions(user_id,plan,started_at,expires_at) VALUES($1,$2,$3,$4)',[id,'monthly',new Date(now.getTime()-60*DAY),new Date(now.getTime()+expiresInDays*DAY)]);
 return id;
}
const rule=async(db,userId,direction,threshold)=>Number((await db.query('INSERT INTO alert_rules(user_id,direction,threshold) VALUES($1,$2,$3) RETURNING id',[userId,direction,threshold])).rows[0].id);
const outbox=async db=>(await db.query('SELECT * FROM email_outbox ORDER BY id')).rows;
const state=async db=>(await db.query('SELECT value FROM worker_state WHERE key=$1',[ALERT_STATE_KEY])).rows[0]?.value??null;

test('crossing rule: above is prev < t <= cur, below is prev > t >= cur, compared in tenths',()=>{
 assert.equal(crossed('above',59.9,60,60),true);assert.equal(crossed('above',60,61,60),false,'already at the level');assert.equal(crossed('above',59.9,59.95,60),true,'59.95 rounds to 60.0');
 assert.equal(crossed('above',72.4,72.5,72.5),true);assert.equal(crossed('above',0.1+0.2,0.4,0.3),false,'0.30000000000000004 is 0.3');
 assert.equal(crossed('below',60.1,60,60),true);assert.equal(crossed('below',60,59,60),false);assert.equal(crossed('below',40,45,42),false);
 assert.equal(crossed('sideways',1,100,50),false);
});

test('processAlerts: nothing before the index exists; the first run records the latest day and sends nothing',{skip:!connection},async t=>{
 assert.deepEqual(await processAlerts({query(){throw new Error('no queries before the collection starts')}},{now:new Date(COLLECTION_START+'T12:00:00Z'),cfg}),{skipped:'no_window'});
 const db=await isolated(t),user=await subscriber(db,'pro@example.com',10);await rule(db,user,'above',60);
 assert.deepEqual(await processAlerts(db,{now,cfg}),{skipped:'no_index'});assert.equal(await state(db),null);
 await publish(db,D(0),50);await publish(db,D(1),55);await publish(db,D(2),61);
 assert.deepEqual(await processAlerts(db,{now,cfg}),{initialised:D(2),days:0,queued:0});
 assert.deepEqual(await state(db),{day:D(2)});assert.equal((await outbox(db)).length,0,'history before the first run never alerts');
 assert.deepEqual(await processAlerts(db,{now,cfg}),{throughDay:D(2),days:0,queued:0});
});

test('processAlerts: above and below crossings at the exact level, one email per rule and day',{skip:!connection},async t=>{
 const db=await isolated(t),user=await subscriber(db,'pro@example.com',10);
 const above60=await rule(db,user,'above',60),above599=await rule(db,user,'above',59.9),above601=await rule(db,user,'above',60.1),below60=await rule(db,user,'below',60),below599=await rule(db,user,'below',59.9);
 await publish(db,D(0),59.9);await processAlerts(db,{now,cfg});
 await publish(db,D(1),60);
 assert.deepEqual(await processAlerts(db,{now,cfg}),{throughDay:D(1),days:1,queued:1});
 await publish(db,D(2),59.9);await processAlerts(db,{now,cfg});
 await publish(db,D(3),61);await processAlerts(db,{now,cfg});
 const rows=await outbox(db);
 assert.deepEqual(rows.map(r=>r.dedupe_key),[`alert:${above60}:${D(1)}`,`alert:${below599}:${D(2)}`,`alert:${above60}:${D(3)}`,`alert:${above601}:${D(3)}`]);
 assert.ok(![above599,below60].some(id=>rows.some(r=>r.dedupe_key.startsWith(`alert:${id}:`))),'touching the level from it is not a crossing');
 const [first]=rows;
 assert.equal(first.kind,'alert_crossed');assert.equal(first.to_email,'pro@example.com');assert.equal(first.status,'queued');
 assert.equal(first.subject,'Index alert: the score rose above 60.0');assert.ok(first.text_body.includes(`rose from 59.9 to 60.0 on ${formatDay(D(1))}`));
 assert.ok(first.text_body.includes('https://adoption.kadena.ws/account')&&first.text_body.includes('help@kadena.ws'));
 assert.equal(rows[1].subject,'Index alert: the score fell below 59.9');
});

test('processAlerts: a catch-up run takes each published day in order, is deduplicated, and skips other methods',{skip:!connection},async t=>{
 const db=await isolated(t),user=await subscriber(db,'pro@example.com',10),up=await rule(db,user,'above',60),down=await rule(db,user,'below',59);
 await publish(db,D(0),50);await processAlerts(db,{now,cfg});
 for(const [i,score] of [[1,62],[2,58],[3,63],[4,64]])await publish(db,D(i),score);
 assert.deepEqual(await processAlerts(db,{now,cfg}),{throughDay:D(4),days:4,queued:3});
 assert.deepEqual((await outbox(db)).map(r=>r.dedupe_key),[`alert:${up}:${D(1)}`,`alert:${down}:${D(2)}`,`alert:${up}:${D(3)}`]);
 assert.ok((await outbox(db))[2].text_body.includes('from 58.0 to 63.0'),'each day is compared with the day before it');
 assert.deepEqual(await state(db),{day:D(4)});
 // Replaying the same days (e.g. after a crash before the state was saved) queues nothing twice.
 await db.query("UPDATE worker_state SET value=$2 WHERE key=$1",[ALERT_STATE_KEY,JSON.stringify({day:D(0)})]);
 assert.deepEqual(await processAlerts(db,{now,cfg}),{throughDay:D(4),days:4,queued:0});assert.equal((await outbox(db)).length,3);
 // A day stored under another method or baseline is not a published score.
 await publish(db,D(5),50,{methodVersion:'kce-v3-growing-90d-2026-09-27'});
 assert.deepEqual(await processAlerts(db,{now,cfg}),{throughDay:D(4),days:0,queued:0});
 await db.query('DELETE FROM index_snapshots WHERE day=$1',[D(5)]);await db.query('DELETE FROM daily_metrics WHERE day=$1',[D(5)]);
 await publish(db,D(5),50,{baselineDay:D(1)});
 assert.deepEqual(await processAlerts(db,{now,cfg}),{throughDay:D(4),days:0,queued:0});
 // A day that is not complete yet (relative to `now`) is outside the window.
 const early=new Date(D(4)+'T12:00:00Z');await db.query("UPDATE worker_state SET value=$2 WHERE key=$1",[ALERT_STATE_KEY,JSON.stringify({day:D(2)})]);
 assert.deepEqual(await processAlerts(db,{now:early,cfg}),{throughDay:D(3),days:1,queued:0});
});

test('processAlerts: only users with an active subscription are alerted',{skip:!connection},async t=>{
 const db=await isolated(t);
 const active=await subscriber(db,'active@example.com',3),lapsed=await subscriber(db,'lapsed@example.com',-1),never=await subscriber(db,'never@example.com',null);
 const ids=[await rule(db,active,'above',60),await rule(db,lapsed,'above',60),await rule(db,never,'above',60)];
 await publish(db,D(0),55);await processAlerts(db,{now,cfg});await publish(db,D(1),65);
 assert.equal((await processAlerts(db,{now,cfg})).queued,1);
 assert.deepEqual((await outbox(db)).map(r=>[r.dedupe_key,r.to_email]),[[`alert:${ids[0]}:${D(1)}`,'active@example.com']]);
 // Access that ends before the run: no alert either.
 await publish(db,D(2),55);await processAlerts(db,{now,cfg});await publish(db,D(3),65);
 assert.equal((await processAlerts(db,{now:new Date(now.getTime()+4*DAY),cfg})).queued,0);
});

test('renewal reminders: 7-day and 1-day windows, once per expiry',{skip:!connection},async t=>{
 const db=await isolated(t),at=offset=>new Date(now.getTime()+offset);
 const users={};
 for(const [name,offset] of Object.entries({week:7*DAY,sixAndHalf:6.5*DAY,day:DAY,half:DAY/2,tooEarly:7*DAY+1000,expired:-HOUR,justOverDay:DAY+1000})){
  users[name]=Number((await db.query('INSERT INTO users(email) VALUES($1) RETURNING id',[`${name.toLowerCase()}@example.com`])).rows[0].id);
  await db.query('INSERT INTO subscriptions(user_id,plan,started_at,expires_at) VALUES($1,$2,$3,$4)',[users[name],'monthly',at(-30*DAY),at(offset)]);
 }
 const key=(which,name,offset)=>`${which}:${users[name]}:${at(offset).toISOString()}`;
 assert.deepEqual(await processRenewalReminders(db,{now,cfg}),{due:5,queued:5});
 const rows=await outbox(db),keys=rows.map(r=>r.dedupe_key).sort();
 assert.deepEqual(keys,[key('renewal1','day',DAY),key('renewal1','half',DAY/2),key('renewal7','justOverDay',DAY+1000),key('renewal7','sixAndHalf',6.5*DAY),key('renewal7','week',7*DAY)].sort());
 const week=rows.find(r=>r.dedupe_key===key('renewal7','week',7*DAY)),half=rows.find(r=>r.dedupe_key===key('renewal1','half',DAY/2));
 assert.equal(week.kind,'renewal_reminder_7d');assert.equal(week.subject,'Your Pro access ends in 7 days');assert.equal(week.to_email,'week@example.com');
 assert.ok(week.text_body.includes('ends on 8 October 2026, 12:00 UTC')&&week.text_body.includes('https://adoption.kadena.ws/checkout'));
 assert.ok(week.text_body.includes('Nothing renews automatically')&&week.text_body.includes('non-refundable'));
 assert.equal(half.kind,'renewal_reminder_1d');assert.equal(half.subject,'Your Pro access ends within a day');
 assert.equal(rows.find(r=>r.dedupe_key===key('renewal7','justOverDay',DAY+1000)).subject,'Your Pro access ends in 2 days');
 assert.deepEqual(await processRenewalReminders(db,{now,cfg}),{due:5,queued:0},'at most once per expiry');
 // Six days on: the last-day reminders go out, and the one that was just too early now gets its 7-day reminder.
 const later=at(6*DAY);
 assert.deepEqual(await processRenewalReminders(db,{now:later,cfg}),{due:3,queued:3});
 assert.deepEqual((await outbox(db)).slice(5).map(r=>r.dedupe_key).sort(),[key('renewal1','week',7*DAY),key('renewal1','sixAndHalf',6.5*DAY),key('renewal7','tooEarly',7*DAY+1000)].sort());
 // A new expiry (renewal or admin extension) is a new reminder cycle; far away, no reminder.
 await db.query('UPDATE subscriptions SET expires_at=$2 WHERE user_id=$1',[users.week,new Date(later.getTime()+3*DAY)]);
 await db.query('UPDATE subscriptions SET expires_at=$2 WHERE user_id=$1',[users.sixAndHalf,new Date(later.getTime()+30*DAY)]);
 assert.deepEqual(await processRenewalReminders(db,{now:later,cfg}),{due:2,queued:1});
 assert.equal((await outbox(db)).at(-1).dedupe_key,`renewal7:${users.week}:${new Date(later.getTime()+3*DAY).toISOString()}`);
});

function recordingMailer({fail=()=>false,transport='resend'}={}){
 const mailer={transport,calls:[],async send(message){mailer.calls.push(message);if(fail(message))throw Object.assign(new Error('Resend rejected the message (HTTP 503, internal_server_error)'),{code:'mail_failed'});return {id:'re_'+mailer.calls.length}}};
 return mailer;
}
const message=n=>({subject:`Subject ${n}`,text:`secret text body ${n}`,html:`<p>secret html body ${n}</p>`});
async function queue(db,keys,due){for(const [i,key] of keys.entries())await enqueueEmail(db,{dedupeKey:key,kind:'test',to:key.startsWith('bad')?'bad@example.com':'good@example.com',message:message(i)});await db.query('UPDATE email_outbox SET next_attempt_at=$1',[due])}

test('sendOutbox: delivers with the dedupe key as idempotency key, backs off 1m/5m/30m/2h/6h and gives up after 6 attempts',{skip:!connection},async t=>{
 const db=await isolated(t),mailer=recordingMailer({fail:m=>m.to==='bad@example.com'});
 await queue(db,['good:1','bad:1'],now);
 assert.deepEqual(await sendOutbox(db,mailer,{now}),{sent:1,retrying:1,failed:0});
 assert.deepEqual(mailer.calls.map(c=>c.idempotencyKey),['good:1','bad:1']);
 assert.deepEqual(mailer.calls[0],{to:'good@example.com',subject:'Subject 0',text:'secret text body 0',html:'<p>secret html body 0</p>',idempotencyKey:'good:1'});
 let [good,bad]=await outbox(db);
 assert.equal(good.status,'sent');assert.equal(good.attempts,1);assert.equal(good.provider_id,'re_1');assert.equal(new Date(good.sent_at).getTime(),now.getTime());assert.equal(good.last_error,null);
 assert.equal(bad.status,'queued');assert.equal(bad.attempts,1);assert.equal(new Date(bad.next_attempt_at).getTime(),now.getTime()+MINUTE);
 assert.equal(bad.last_error,'mail_failed: Resend rejected the message (HTTP 503, internal_server_error)');
 assert.deepEqual(OUTBOX_BACKOFF_MS,[MINUTE,5*MINUTE,30*MINUTE,2*HOUR,6*HOUR]);assert.equal(OUTBOX_MAX_ATTEMPTS,6);
 // Not due yet: nothing is sent.
 assert.deepEqual(await sendOutbox(db,mailer,{now:new Date(now.getTime()+MINUTE-1)}),{sent:0,retrying:0,failed:0});assert.equal(mailer.calls.length,2);
 let at=now;
 for(let attempt=2;attempt<=6;attempt++){
  at=new Date(at.getTime()+OUTBOX_BACKOFF_MS[attempt-2]);
  await sendOutbox(db,mailer,{now:at});
  bad=(await outbox(db))[1];assert.equal(bad.attempts,attempt);
  if(attempt<6){assert.equal(bad.status,'queued');assert.equal(new Date(bad.next_attempt_at).getTime(),at.getTime()+OUTBOX_BACKOFF_MS[attempt-1],`wait after attempt ${attempt}`)}
  else assert.equal(bad.status,'failed');
 }
 assert.equal(mailer.calls.filter(c=>c.to==='bad@example.com').length,6);
 assert.deepEqual(await sendOutbox(db,mailer,{now:new Date(at.getTime()+30*DAY)}),{sent:0,retrying:0,failed:0});
 assert.equal((await outbox(db))[0].attempts,1,'a sent email is never sent again');
});

test('sendOutbox: transport none leaves everything queued; a mailer that turns out unconfigured releases its claims',{skip:!connection},async t=>{
 const db=await isolated(t);await queue(db,['a:1','a:2'],now);
 const none=createMailer(accountsConfig({MAIL_TRANSPORT:'none'}));assert.equal(none.transport,'none');
 assert.deepEqual(await sendOutbox(db,none,{now}),{skipped:'mail_not_configured'});
 assert.deepEqual(await sendOutbox(db,null,{now}),{skipped:'mail_not_configured'});
 assert.deepEqual((await outbox(db)).map(r=>[r.status,r.attempts,new Date(r.next_attempt_at).getTime()]),[['queued',0,now.getTime()],['queued',0,now.getTime()]]);
 const unconfigured={transport:'log',calls:0,async send(){unconfigured.calls++;throw Object.assign(new Error('Email is not configured (MAIL_TRANSPORT)'),{code:'mail_not_configured'})}};
 assert.deepEqual(await sendOutbox(db,unconfigured,{now}),{sent:0,retrying:0,failed:0,skipped:'mail_not_configured'});assert.equal(unconfigured.calls,1);
 assert.deepEqual((await outbox(db)).map(r=>[r.status,r.attempts,new Date(r.next_attempt_at).getTime()]),[['queued',0,now.getTime()],['queued',0,now.getTime()]]);
});

test('sendOutbox: the batch limit, one delivery per email across concurrent senders, and no bodies in logs',{skip:!connection},async t=>{
 const db=await isolated(t);await queue(db,['k:1','k:2','k:3'],now);
 const mailer=recordingMailer();
 assert.equal((await sendOutbox(db,mailer,{now,limit:2})).sent,2);assert.equal((await sendOutbox(db,mailer,{now,limit:2})).sent,1);
 await db.query('DELETE FROM email_outbox');await queue(db,Array.from({length:8},(_,i)=>`c:${i}`),now);
 const slow={transport:'resend',calls:[],async send(m){slow.calls.push(m.idempotencyKey);await new Promise(r=>setTimeout(r,5));return {id:'x'}}};
 const logs=['log','error','warn','info'].map(name=>t.mock.method(console,name,()=>{}));
 const results=await Promise.all([sendOutbox(db,slow,{now}),sendOutbox(db,slow,{now}),sendOutbox(db,slow,{now})]);
 assert.equal(results.reduce((n,r)=>n+r.sent,0),8);assert.equal(new Set(slow.calls).size,8);assert.equal(slow.calls.length,8);
 await db.query("UPDATE email_outbox SET status='queued'");
 await sendOutbox(db,recordingMailer({fail:()=>true}),{now:new Date(now.getTime()+HOUR)});
 const printed=logs.flatMap(m=>m.mock.calls.map(c=>c.arguments.join(' '))).join('\n');
 assert.ok(!printed.includes('secret'),'bodies never reach the process log');
 assert.ok((await outbox(db)).every(r=>!String(r.last_error??'').includes('secret')));
});
