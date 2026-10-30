import {test} from 'node:test';
import assert from 'node:assert/strict';
import {randomBytes} from 'node:crypto';
import pg from 'pg';
import '../src/db.mjs'; // the app's DATE parsing
import {migrate} from '../src/migrate.mjs';
import {createServer} from '../src/server.mjs';
import {accountsConfig} from '../src/config.mjs';
import {hashToken,newToken} from '../src/auth.mjs';
import {REPORT_LIMITS,cleanDescription,cleanEvidence,evidenceUrl,reportInput} from '../src/reports.mjs';
const connection=process.env.TEST_DATABASE_URL;
async function isolated(t){
 const url=new URL(connection);if(!url.pathname.endsWith('_test'))throw new Error('Integration tests require a dedicated *_test database');
 // Small pools: the whole suite runs in parallel against one local server with few connection slots.
 const schema='reports_'+randomBytes(8).toString('hex'),admin=new pg.Pool({connectionString:connection,max:1});
 await admin.query(`CREATE SCHEMA ${schema}`);url.searchParams.set('options',`-c search_path=${schema}`);const db=new pg.Pool({connectionString:url.href,max:3,connectionTimeoutMillis:30000});
 t.after(async()=>{await db.end();try{await admin.query(`DROP SCHEMA ${schema} CASCADE`)}finally{await admin.end()}});
 await migrate(db);return db;
}
const siteKey='k'.repeat(40),MINUTE=60000,HOUR=60*MINUTE,DAY=24*HOUR;
const baseEnv={SITE_API_KEY:siteKey,ADMIN_EMAILS:'boss@example.com',PUBLIC_SITE_URL:'http://127.0.0.1:5173',MAIL_TRANSPORT:'log',SUPPORT_EMAIL:'help@example.com'};
async function harness(t,{env=baseEnv}={}){
 const db=await isolated(t),cfg=accountsConfig(env),clock={now:new Date('2026-10-01T12:00:00.000Z')},sent=[];
 const server=createServer(db,{cfg,mailer:{transport:'log',async send(message){sent.push(message);return {id:'x'}}},now:()=>clock.now});
 await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));t.after(()=>new Promise(resolve=>server.close(resolve)));
 const base=`http://127.0.0.1:${server.address().port}`;
 async function call(route,{body,session,ip='203.0.113.7'}={}){
  const [method,path]=route.split(' ');
  const response=await fetch(base+path,{method,headers:{'X-KCE-Site-Key':siteKey,...(ip?{'X-KCE-Client-IP':ip}:{}),...(session?{'X-KCE-Session':session}:{}),...(body===undefined?{}:{'Content-Type':'application/json'})},body:body===undefined?undefined:JSON.stringify(body)});
  const text=await response.text();return {status:response.status,body:text?JSON.parse(text):null};
 }
 async function user(email,{subscribed=false}={}){
  const id=Number((await db.query('INSERT INTO users(email) VALUES($1) RETURNING id',[email])).rows[0].id),token=newToken();
  await db.query('INSERT INTO sessions(token_hash,user_id,expires_at) VALUES($1,$2,$3)',[hashToken(token),id,new Date(clock.now.getTime()+30*DAY)]);
  if(subscribed)await db.query('INSERT INTO subscriptions(user_id,plan,started_at,expires_at) VALUES($1,$2,$3,$4)',[id,'monthly',new Date(clock.now.getTime()-DAY),new Date(clock.now.getTime()+29*DAY)]);
  return {id,session:token};
 }
 const advance=ms=>{clock.now=new Date(clock.now.getTime()+ms)};
 return {db,cfg,clock,call,user,advance,sent};
}
const valid={indicator:'tvl',description:'The TVL card shows 13M KDA but BroDEX alone holds more.',evidence:'https://explorer.example/tx/abc'};
const report=(h,body={},options={})=>h.call('POST /reports',{body:{...valid,...body},...options});
const count=async(db,sql,params=[])=>(await db.query(sql,params)).rows[0].n;
const filler=(db,n,at)=>db.query("INSERT INTO data_reports(indicator,description,evidence,ip_hash,created_at) SELECT 'other','Filler report text','ref',md5(g::text),$2 FROM generate_series(1,$1::int) g",[n,at]);

test('a report needs no session: it is stored cleaned, without the visitor address, and each admin gets one notice',{skip:!connection},async t=>{
 const h=await harness(t,{env:{...baseEnv,ADMIN_EMAILS:'boss@example.com,Second@Example.com'}});
 const response=await report(h,{description:'  First line\r\nsecond <b>line</b>\u0000\u0007\u202e\u200b\r\n\tindented \u0085 ',evidence:'  https://explorer.example/tx/abc\u200b\n',email:'  Reader@Example.COM '});
 assert.deepEqual([response.status,response.body],[202,{ok:true}]);
 const row=(await h.db.query('SELECT * FROM data_reports')).rows[0];
 assert.equal(row.indicator,'tvl');
 assert.equal(row.description,'First line\nsecond <b>line</b>\n\tindented','CRLF becomes LF; NUL, controls and invisible or direction characters go; tabs stay');
 assert.equal(row.evidence,'https://explorer.example/tx/abc');
 assert.equal(row.email,'reader@example.com');
 assert.match(row.ip_hash,/^[0-9a-f]{64}$/);
 assert.ok(!JSON.stringify(row).includes('203.0.113'),'no address is stored');
 assert.equal(new Date(row.created_at).getTime(),h.clock.now.getTime());
 assert.deepEqual([row.resolved_at,row.resolved_by,row.resolved_note],[null,null,null]);
 // Queued for the worker, never sent from the request; to the admins, never to the reporter.
 assert.equal(h.sent.length,0);
 const mail=(await h.db.query('SELECT * FROM email_outbox ORDER BY to_email')).rows;
 assert.deepEqual(mail.map(m=>[m.kind,m.to_email,m.dedupe_key,m.status]),[['data_report','boss@example.com',`report:${row.id}:boss@example.com`,'queued'],['data_report','second@example.com',`report:${row.id}:second@example.com`,'queued']]);
 assert.equal(mail[0].subject,`Data issue report #${row.id}: TVL (total value locked)`);
 assert.ok(mail[0].text_body.includes('> First line\n> second <b>line</b>\n> \tindented'),'the text email quotes the report, line breaks kept');
 assert.ok(mail[0].html_body.includes('second &lt;b&gt;line&lt;/b&gt;')&&!mail[0].html_body.includes('<b>line'),'the HTML email escapes the visitor text');
 assert.ok(mail[0].text_body.includes('reader@example.com')&&mail[0].text_body.includes('http://127.0.0.1:5173/signin?next=/admin%23reports'));
 assert.ok(mail[0].html_body.includes('href="https://explorer.example/tx/abc"'),'an https evidence link is clickable');
});

test('the email is optional and must be a plain address; a reference that is not a link is kept as written',{skip:!connection},async t=>{
 const h=await harness(t);
 for(const [i,email] of [undefined,null,'','   '].entries())assert.equal((await report(h,{email},{ip:`198.51.100.${i}`})).status,202,String(email));
 assert.deepEqual((await h.db.query('SELECT DISTINCT email FROM data_reports')).rows,[{email:null}]);
 assert.ok((await h.db.query('SELECT text_body FROM email_outbox ORDER BY id LIMIT 1')).rows[0].text_body.includes('Follow-up email: None given'));
 // These pass the sign-in check but could hide text or add mailto: headers.
 for(const email of ['x@evil.example?cc=boss%40example.com','a\u200b@b.co','saudi.kda@kadena.io\u202e','a&b@example.com','ok@exämple.com']){
  const response=await report(h,{email},{ip:'198.51.100.9'});assert.deepEqual([response.status,response.body],[400,{error:'invalid_email'}],JSON.stringify(email));
 }
 assert.equal((await report(h,{email:'First.Last+tag@Sub.Example.co.uk'},{ip:'198.51.100.9'})).status,202);
 assert.equal((await h.db.query('SELECT email FROM data_reports ORDER BY id DESC LIMIT 1')).rows[0].email,'first.last+tag@sub.example.co.uk');
 assert.equal((await report(h,{evidence:'Request key  kL9x_aB2-QW \u200d on chain 3'},{ip:'198.51.100.10'})).status,202);
 assert.equal((await h.db.query('SELECT evidence FROM data_reports ORDER BY id DESC LIMIT 1')).rows[0].evidence,'Request key kL9x_aB2-QW on chain 3','whitespace runs become one space');
 assert.ok(!(await h.db.query('SELECT html_body FROM email_outbox ORDER BY id DESC LIMIT 1')).rows[0].html_body.includes('href="Request'),'plain text evidence has no link');
});

test('invalid reports get a field code and store nothing',{skip:!connection},async t=>{
 const h=await harness(t);
 const cases=[
  [{indicator:undefined},'invalid_indicator'],[{indicator:'price'},'invalid_indicator'],[{indicator:'__proto__'},'invalid_indicator'],[{indicator:'constructor'},'invalid_indicator'],[{indicator:['tvl']},'invalid_indicator'],
  [{description:'too short'},'invalid_description'],[{description:'   \n\n\u0000 \u200b\u202e  '},'invalid_description'],[{description:'x'.repeat(2001)},'invalid_description'],[{description:42},'invalid_description'],
  [{evidence:undefined},'invalid_evidence'],[{evidence:'  \n\t\u200b '},'invalid_evidence'],[{evidence:'y'.repeat(501)},'invalid_evidence'],[{evidence:{url:'https://x.example'}},'invalid_evidence'],
  [{email:'not-an-email'},'invalid_email'],[{email:'a@b'},'invalid_email'],[{email:42},'invalid_email'],[{email:'x@example.com\nBcc: y@example.com'},'invalid_email'],
 ];
 for(const [body,error] of cases){const response=await report(h,body);assert.deepEqual([response.status,response.body],[400,{error}],JSON.stringify(body))}
 assert.equal(await count(h.db,'SELECT count(*)::int AS n FROM data_reports'),0);
 assert.equal(await count(h.db,'SELECT count(*)::int AS n FROM email_outbox'),0);
 // The longest accepted values fit the table's constraints.
 assert.equal((await report(h,{description:'é'.repeat(2000),evidence:'z'.repeat(500)})).status,202);
});

test('limits: 5 an hour and 10 a day per visitor; 100 a day across everyone (its own code), which never stops a subscriber',{skip:!connection},async t=>{
 const h=await harness(t);
 assert.deepEqual(REPORT_LIMITS,{perIpPerHour:5,perIpPerDay:10,perDay:100,noticesPerDay:10});
 for(let i=0;i<5;i++)assert.equal((await report(h)).status,202,`report ${i+1}`);
 assert.deepEqual(await report(h),{status:429,body:{error:'rate_limit'}});
 assert.equal((await report(h,{},{ip:'198.51.100.1'})).status,202,'another visitor is not held back');
 h.advance(HOUR+1);
 for(let i=0;i<5;i++)assert.equal((await report(h)).status,202,`next hour, report ${i+1}`);
 h.advance(HOUR+1);
 assert.deepEqual(await report(h),{status:429,body:{error:'rate_limit'}},'10 a day per visitor, even in a fresh hour');
 assert.equal(await count(h.db,'SELECT count(*)::int AS n FROM data_reports'),11);
 // The daily cap counts everyone's reports.
 await filler(h.db,89,h.clock.now);
 assert.deepEqual(await report(h,{},{ip:'198.51.100.2'}),{status:429,body:{error:'reports_busy'}});
 assert.equal(await count(h.db,'SELECT count(*)::int AS n FROM data_reports'),100);
 const paying=await h.user('paying@example.com',{subscribed:true}),lapsed=await h.user('lapsed@example.com');
 assert.equal((await report(h,{},{ip:'198.51.100.3',session:paying.session})).status,202,'an active subscriber is never held back by the daily cap');
 assert.deepEqual(await report(h,{},{ip:'198.51.100.4',session:lapsed.session}),{status:429,body:{error:'reports_busy'}},'a session without a subscription is not enough');
 assert.deepEqual((await report(h,{},{ip:'203.0.113.7',session:paying.session})).body,{error:'rate_limit'},'the per-visitor limit still applies to subscribers');
 h.advance(DAY);
 assert.equal((await report(h,{},{ip:'198.51.100.2'})).status,202,'the next day the form works again');
});

test('only the first 10 reports in 24 hours are emailed; the 10th says so',{skip:!connection},async t=>{
 const h=await harness(t);
 for(let i=0;i<12;i++)assert.equal((await report(h,{},{ip:`198.51.100.${i}`})).status,202);
 const mail=(await h.db.query("SELECT text_body FROM email_outbox WHERE kind='data_report' ORDER BY id")).rows;
 assert.equal(mail.length,10);
 assert.ok(mail[9].text_body.includes('That makes 10 reports in 24 hours.')&&!mail[8].text_body.includes('That makes'));
 assert.equal(await count(h.db,'SELECT count(*)::int AS n FROM data_reports'),12,'every report is still stored');
 h.advance(DAY);
 assert.equal((await report(h,{},{ip:'198.51.100.99'})).status,202);
 assert.equal(await count(h.db,"SELECT count(*)::int AS n FROM email_outbox WHERE kind='data_report'"),11,'emails resume once the day has passed');
});

test('concurrent reports from one visitor cannot pass the limit together',{skip:!connection},async t=>{
 const h=await harness(t);
 const results=await Promise.all(Array.from({length:8},()=>report(h)));
 assert.deepEqual(results.map(r=>r.status).sort(),[202,202,202,202,202,429,429,429]);
 assert.equal(await count(h.db,'SELECT count(*)::int AS n FROM data_reports'),5);
});

test('the address hash tells visitors apart, keeps no address and is cleared after two days',{skip:!connection},async t=>{
 const h=await harness(t);
 assert.equal((await report(h)).status,202);
 assert.equal((await report(h)).status,202);
 assert.equal((await report(h,{},{ip:'198.51.100.3'})).status,202);
 const hashes=(await h.db.query('SELECT ip_hash FROM data_reports ORDER BY id')).rows.map(r=>r.ip_hash);
 assert.ok(hashes[0]===hashes[1]&&hashes[1]!==hashes[2],'the same visitor, the same hash');
 h.advance(2*DAY-MINUTE);
 assert.equal((await report(h,{},{ip:'198.51.100.4'})).status,202);
 assert.equal(await count(h.db,'SELECT count(*)::int AS n FROM data_reports WHERE ip_hash IS NULL'),0);
 h.advance(2*MINUTE);
 assert.equal((await report(h,{},{ip:'198.51.100.5'})).status,202);
 assert.deepEqual((await h.db.query('SELECT ip_hash IS NULL AS cleared FROM data_reports ORDER BY id')).rows.map(r=>r.cleared),[true,true,true,false,false]);
});

test('without admins the support address gets the notice; with neither, the report is stored and nothing is queued',{skip:!connection},async t=>{
 const support=await harness(t,{env:{...baseEnv,ADMIN_EMAILS:''}});
 assert.equal((await report(support)).status,202);
 assert.deepEqual((await support.db.query('SELECT to_email FROM email_outbox')).rows,[{to_email:'help@example.com'}]);
 const none=await harness(t,{env:{...baseEnv,ADMIN_EMAILS:'',SUPPORT_EMAIL:''}});
 assert.equal(none.cfg.mail.supportEmail,null);
 assert.equal((await report(none)).status,202);
 assert.equal(await count(none.db,'SELECT count(*)::int AS n FROM data_reports'),1);
 assert.equal(await count(none.db,'SELECT count(*)::int AS n FROM email_outbox'),0);
});

test('a signed-in reporter is not linked to the report, not even by when the session was last used',{skip:!connection},async t=>{
 const h=await harness(t),reader=await h.user('reader@example.com',{subscribed:true});
 const seen=new Date(h.clock.now.getTime()-6*MINUTE);
 await h.db.query('UPDATE sessions SET last_seen_at=$1',[seen]);
 assert.equal((await report(h,{},{session:reader.session})).status,202);
 const row=(await h.db.query('SELECT * FROM data_reports')).rows[0];
 assert.equal(row.email,null,'only an email typed into the form is kept');
 assert.ok(!Object.keys(row).some(column=>/user|session/.test(column)));
 const lastSeen=async()=>(await h.db.query('SELECT last_seen_at FROM sessions')).rows[0].last_seen_at.getTime();
 assert.equal(await lastSeen(),seen.getTime(),'reading the session for a report does not record its use');
 assert.equal((await h.call('GET /account',{session:reader.session})).status,200);
 assert.equal(await lastSeen(),h.clock.now.getTime(),'any other route still records it');
});

test('a report waits for a migration holding the outbox instead of deadlocking with it',{skip:!connection},async t=>{
 const h=await harness(t),c=await h.db.connect();
 try{
  // What a re-run of schema.sql does: lock email_outbox (its index), then data_reports (its indexes), until COMMIT.
  await c.query('BEGIN');await c.query("SET LOCAL lock_timeout='5s'");
  await c.query('LOCK TABLE email_outbox IN SHARE MODE');
  const pending=report(h);
  for(let i=0;i<250&&!(await h.db.query("SELECT 1 FROM pg_locks WHERE NOT granted AND relation='email_outbox'::regclass")).rowCount;i++)await new Promise(resolve=>setTimeout(resolve,20));
  await c.query('LOCK TABLE data_reports IN SHARE MODE');
  await c.query('COMMIT');
  assert.equal((await pending).status,202);
 }finally{c.release()}
 assert.equal(await count(h.db,"SELECT count(*)::int AS n FROM email_outbox WHERE kind='data_report'"),1);
});

test('admins see reports open first without the address hash, and resolve each once with an audited note',{skip:!connection},async t=>{
 const h=await harness(t),boss=await h.user('boss@example.com'),plain=await h.user('plain@example.com');
 const at=hours=>new Date(h.clock.now.getTime()-hours*HOUR);
 const ids=[];
 for(const [indicator,evidence,hours,email] of [['tvl','https://explorer.example/tx/1',5,'a@example.com'],['commits','https://user:pw@evil.example/x',3,null],['index','http://plain.example/x',2,null],['other','tx 0xabc',1,null]])
  ids.push(Number((await h.db.query('INSERT INTO data_reports(indicator,description,evidence,email,ip_hash,created_at) VALUES($1,$2,$3,$4,$5,$6) RETURNING id',[indicator,'Description text',evidence,email,'f'.repeat(64),at(hours)])).rows[0].id));
 const denied=await h.call('POST /admin/reports/resolve',{body:{id:ids[0],note:'x'},session:plain.session});
 assert.deepEqual([denied.status,denied.body],[404,{error:'not_found'}],'non-admins get a 404');
 assert.equal((await h.call('POST /admin/reports/resolve',{body:{id:ids[0],note:'x'}})).status,401);
 const done=await h.call('POST /admin/reports/resolve',{body:{id:String(ids[0]),note:'  Checked: the registry misses a pool, fixed in v5.  '},session:boss.session});
 assert.equal(done.status,200);assert.equal(done.body.ok,true);
 assert.deepEqual([done.body.report.id,done.body.report.resolved,done.body.report.resolvedBy,done.body.report.resolvedNote],[ids[0],true,'boss@example.com','Checked: the registry misses a pool, fixed in v5.']);
 const action=(await h.db.query('SELECT admin_email,action,user_id,details FROM admin_actions')).rows;
 assert.deepEqual(action,[{admin_email:'boss@example.com',action:'resolve_report',user_id:null,details:{reportId:ids[0],indicator:'tvl',note:'Checked: the registry misses a pool, fixed in v5.'}}]);
 assert.deepEqual(await h.call('POST /admin/reports/resolve',{body:{id:ids[0],note:'again'},session:boss.session}),{status:409,body:{error:'already_resolved'}});
 for(const [body,expected] of [[{id:999999,note:'x'},[404,'not_found']],[{id:'abc',note:'x'},[400,'invalid_id']],[{id:0,note:'x'},[400,'invalid_id']],[{id:-1,note:'x'},[400,'invalid_id']],[{id:ids[1],note:'  '},[400,'invalid_note']],[{id:ids[1],note:'n'.repeat(501)},[400,'invalid_note']]]){
  const response=await h.call('POST /admin/reports/resolve',{body,session:boss.session});assert.deepEqual([response.status,response.body.error],expected,JSON.stringify(body));
 }
 const {status,body}=await h.call('GET /admin/overview',{session:boss.session});
 assert.equal(status,200);
 assert.deepEqual(body.reports.map(r=>[r.id,r.resolved]),[[ids[3],false],[ids[2],false],[ids[1],false],[ids[0],true]],'open first, newest first');
 assert.equal(body.counts.openReports,3);
 assert.deepEqual(body.reports.map(r=>r.evidenceUrl),[null,null,null,'https://explorer.example/tx/1'],'only https links without credentials are links');
 assert.ok(!JSON.stringify(body.reports).includes('f'.repeat(64))&&!body.reports.some(r=>'ipHash' in r||'ip_hash' in r),'the address hash never reaches the admin page');
 const first=body.reports[3];
 assert.deepEqual([first.indicator,first.description,first.evidence,first.email,first.createdAt],['tvl','Description text','https://explorer.example/tx/1','a@example.com',at(5).toISOString()]);
});

test('reportInput, the cleaners and evidenceUrl, without a database',()=>{
 assert.deepEqual(reportInput({...valid,email:' A@Example.com '}),{...valid,email:'a@example.com'});
 assert.throws(()=>reportInput(),error=>error.code==='invalid_indicator');
 assert.equal(cleanDescription('a\u200c\u200db 👨\u200d👩\u200d👧'),'a\u200c\u200db 👨\u200d👩\u200d👧','joiners stay in the description');
 assert.equal(cleanEvidence('ab\u200c\u200dcd'),'abcd','and go from the evidence');
 assert.equal(evidenceUrl('https://bscscan.com/tx/0x'+'a'.repeat(64)),'https://bscscan.com/tx/0x'+'a'.repeat(64));
 assert.equal(evidenceUrl('HTTPS://Example.com/a b'),null,'one URL with no spaces');
 for(const value of ['http://example.com/x','javascript:alert(1)','https://u:p@example.com/','https://','tx abc',null,42])assert.equal(evidenceUrl(value),null,String(value));
 assert.equal(evidenceUrl('https://bsc\u0455can.com/tx/1'),'https://xn--bsccan-kvf.com/tx/1','a look-alike host shows as punycode');
});
