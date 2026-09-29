import {test} from 'node:test';
import assert from 'node:assert/strict';
import {randomBytes} from 'node:crypto';
import pg from 'pg';
import '../src/db.mjs'; // the app's DATE parsing
import {migrate} from '../src/migrate.mjs';
import {createServer} from '../src/server.mjs';
import {accountsConfig} from '../src/config.mjs';
import {hashToken} from '../src/auth.mjs';
import {requestLoginLink,LOGIN_LIMITS} from '../src/accounts.mjs';
const connection=process.env.TEST_DATABASE_URL;
async function isolated(t){
 const url=new URL(connection);if(!url.pathname.endsWith('_test'))throw new Error('Integration tests require a dedicated *_test database');
 // Small pools: the whole suite runs in parallel against one local server with few connection slots.
 const schema='accounts_'+randomBytes(8).toString('hex'),admin=new pg.Pool({connectionString:connection,max:1});
 await admin.query(`CREATE SCHEMA ${schema}`);url.searchParams.set('options',`-c search_path=${schema}`);const db=new pg.Pool({connectionString:url.href,max:3,connectionTimeoutMillis:30000});
 t.after(async()=>{await db.end();try{await admin.query(`DROP SCHEMA ${schema} CASCADE`)}finally{await admin.end()}});
 await migrate(db);return db;
}
const siteKey='k'.repeat(40),MINUTE=60000,DAY=86400000;
const baseEnv={SITE_API_KEY:siteKey,ADMIN_EMAILS:'admin@example.com',PUBLIC_SITE_URL:'http://127.0.0.1:5173',MAIL_TRANSPORT:'log',SUPPORT_EMAIL:'help@example.com'};
function fakeMailer({fail=false,transport='log'}={}){
 const mailer={transport,sent:[],fail,async send(message){mailer.sent.push(message);if(mailer.fail)throw Object.assign(new Error('Resend rejected the message (HTTP 500)'),{code:'mail_failed'});return {id:'fake-'+mailer.sent.length}}};
 return mailer;
}
async function harness(t,{env={},mailer=fakeMailer(),start='2026-10-01T12:00:00.000Z'}={}){
 const db=await isolated(t),cfg=accountsConfig({...baseEnv,...env}),clock={now:new Date(start)};
 const server=createServer(db,{cfg,mailer,now:()=>clock.now});
 await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));t.after(()=>new Promise(resolve=>server.close(resolve)));
 const base=`http://127.0.0.1:${server.address().port}`;
 async function call(route,{body,session,ip='203.0.113.7',headers={}}={}){
  const [method,path]=route.split(' ');
  const response=await fetch(base+path,{method,headers:{'X-KCE-Site-Key':siteKey,...(ip?{'X-KCE-Client-IP':ip}:{}),...(session?{'X-KCE-Session':session}:{}),...(body===undefined?{}:{'Content-Type':'application/json'}),...headers},body:body===undefined?undefined:JSON.stringify(body)});
  const text=await response.text();return {status:response.status,body:text?JSON.parse(text):null};
 }
 const advance=ms=>{clock.now=new Date(clock.now.getTime()+ms)};
 return {db,cfg,mailer,clock,call,advance,base};
}
const linkToken=message=>/\/signin\/verify#token=([A-Za-z0-9_-]{43})\n/.exec(message.text)?.[1];
const loginCode=message=>/^(\d{6})$/m.exec(message.text)?.[1];
async function requestLink(h,email,options={}){const response=await h.call('POST /auth/request-link',{body:{email,...options.body},ip:options.ip});return {response,message:h.mailer.sent.at(-1)}}
async function signIn(h,email){const {message}=await requestLink(h,email);const verified=await h.call('POST /auth/verify',{body:{token:linkToken(message)}});assert.equal(verified.status,200);return verified.body.sessionToken}
const count=async(db,sql,params=[])=>(await db.query(sql,params)).rows[0].n;

test('sign-in by link: the email carries a fragment link and a code, verify starts a 30-day session, then GET /account',{skip:!connection},async t=>{
 const h=await harness(t);
 const {response,message}=await requestLink(h,'  Reader@Example.COM ',{body:{next:'/account?tab=alerts'}});
 assert.equal(response.status,202);assert.deepEqual(response.body,{ok:true});
 assert.equal(h.mailer.sent.length,1);assert.equal(message.to,'reader@example.com');
 assert.equal(message.subject,'Sign in to the Kadena Community Edition Adoption Index');
 const token=linkToken(message),code=loginCode(message);
 assert.ok(token&&code,'link and code present');assert.ok(message.text.includes(`http://127.0.0.1:5173/signin/verify#token=${token}`));
 assert.ok(!message.text.includes('?token=')&&!message.html.includes('?token='),'the token is never in a query string');
 assert.ok(message.html.includes(`#token=${token}`)&&message.html.includes(code));assert.ok(message.text.includes('help@example.com'));
 // Only hashes are stored.
 const stored=(await h.db.query('SELECT * FROM login_tokens')).rows[0];
 assert.equal(stored.token_hash,hashToken(token));assert.equal(stored.code_hash,hashToken(`reader@example.com:${code}`));
 assert.equal(stored.email,'reader@example.com');assert.equal(stored.next_path,'/account?tab=alerts');assert.equal(stored.request_ip,'203.0.113.7');
 assert.equal(new Date(stored.expires_at).getTime(),h.clock.now.getTime()+15*MINUTE);assert.equal(stored.used_at,null);assert.equal(stored.attempts,0);
 const verified=await h.call('POST /auth/verify',{body:{token}});
 assert.equal(verified.status,200);assert.deepEqual(Object.keys(verified.body).sort(),['expiresAt','next','sessionToken']);
 assert.match(verified.body.sessionToken,/^[A-Za-z0-9_-]{43}$/);assert.equal(verified.body.next,'/account?tab=alerts');
 assert.equal(verified.body.expiresAt,new Date(h.clock.now.getTime()+30*DAY).toISOString());
 const session=(await h.db.query('SELECT * FROM sessions')).rows[0];assert.equal(session.token_hash,hashToken(verified.body.sessionToken));assert.equal(session.revoked_at,null);
 const user=(await h.db.query('SELECT * FROM users')).rows[0];assert.equal(user.email,'reader@example.com');assert.equal(new Date(user.last_login_at).getTime(),h.clock.now.getTime());
 const account=await h.call('GET /account',{session:verified.body.sessionToken});
 assert.equal(account.status,200);
 assert.deepEqual(account.body,{email:'reader@example.com',isAdmin:false,subscription:null,wallets:[],alerts:[],payments:[],testPlanAvailable:false,
  billing:{enabled:false,testnet:false},supportEmail:'help@example.com',signinOpen:true});
 assert.equal((await h.call('GET /account')).status,401);
 // The session lasts 30 days.
 h.advance(30*DAY-1000);assert.equal((await h.call('GET /account',{session:verified.body.sessionToken})).status,200);
 h.advance(2000);const expired=await h.call('GET /account',{session:verified.body.sessionToken});assert.equal(expired.status,401);assert.equal(expired.body.error,'session_required');
});

test('sign-in by code: the 6-digit code signs in with the same rules and consumes its token',{skip:!connection},async t=>{
 const h=await harness(t);
 const {message}=await requestLink(h,'phone@example.com',{body:{next:'/checkout?plan=annual'}});
 const verified=await h.call('POST /auth/verify-code',{body:{email:'Phone@Example.com',code:` ${loginCode(message)} `}});
 assert.equal(verified.status,200);assert.equal(verified.body.next,'/checkout?plan=annual');
 assert.equal((await h.call('GET /account',{session:verified.body.sessionToken})).body.email,'phone@example.com');
 // The code consumed the token, so its link no longer works, and neither does the code again.
 assert.equal((await h.call('POST /auth/verify',{body:{token:linkToken(message)}})).body.error,'invalid_or_expired');
 assert.equal((await h.call('POST /auth/verify-code',{body:{email:'phone@example.com',code:loginCode(message)}})).status,400);
 // Signing in again reuses the user.
 const again=await requestLink(h,'phone@example.com');
 assert.equal((await h.call('POST /auth/verify-code',{body:{email:'phone@example.com',code:loginCode(again.message)}})).status,200);
 assert.equal(await count(h.db,'SELECT count(*)::int n FROM users'),1);assert.equal(await count(h.db,'SELECT count(*)::int n FROM sessions'),2);
});

test('verify-code: a wrong code counts against every open token, and five misses lock them',{skip:!connection},async t=>{
 const h=await harness(t);
 const first=(await requestLink(h,'guess@example.com')).message,second=(await requestLink(h,'guess@example.com')).message;
 const wrong=code=>String((Number(code)+1)%1000000).padStart(6,'0');
 const codes=[loginCode(first),loginCode(second)],bad=['000000','999999','123456','654321'].find(c=>!codes.includes(c))??wrong(codes[0]);
 // Either open token's code works; first, four misses.
 for(let i=0;i<4;i++){const r=await h.call('POST /auth/verify-code',{body:{email:'guess@example.com',code:bad}});assert.equal(r.status,400);assert.equal(r.body.error,'invalid_or_expired')}
 assert.deepEqual((await h.db.query('SELECT attempts FROM login_tokens ORDER BY created_at')).rows.map(r=>r.attempts),[4,4]);
 // A fifth miss exhausts both tokens: even the right codes fail now, and the link is unaffected by attempts.
 assert.equal((await h.call('POST /auth/verify-code',{body:{email:'guess@example.com',code:bad}})).status,400);
 for(const code of codes)assert.equal((await h.call('POST /auth/verify-code',{body:{email:'guess@example.com',code}})).status,400);
 assert.deepEqual((await h.db.query('SELECT attempts FROM login_tokens ORDER BY created_at')).rows.map(r=>r.attempts),[5,5],'no further counting once locked');
 assert.equal((await h.call('POST /auth/verify',{body:{token:linkToken(second)}})).status,200);
 // A fresh token accepts its code after earlier misses on others.
 const third=(await requestLink(h,'guess@example.com')).message;
 assert.equal((await h.call('POST /auth/verify-code',{body:{email:'guess@example.com',code:wrong(loginCode(third))}})).status,400);
 assert.equal((await h.call('POST /auth/verify-code',{body:{email:'guess@example.com',code:loginCode(third)}})).status,200);
 // Malformed codes and another address's code are refused without touching the counters.
 const other=(await requestLink(h,'other@example.com')).message;
 for(const code of ['12345','1234567','abcdef',123456,null])assert.equal((await h.call('POST /auth/verify-code',{body:{email:'other@example.com',code}})).status,400,String(code));
 assert.equal((await h.call('POST /auth/verify-code',{body:{email:'guess@example.com',code:loginCode(other)}})).status,400);
 assert.equal((await h.db.query("SELECT attempts FROM login_tokens WHERE email='other@example.com'")).rows[0].attempts,0);
 assert.equal((await h.call('POST /auth/verify-code',{body:{email:'not-an-email',code:'123456'}})).body.error,'invalid_email');
});

test('links and codes are single-use and expire after 15 minutes',{skip:!connection},async t=>{
 const h=await harness(t);
 const {message}=await requestLink(h,'once@example.com'),token=linkToken(message);
 assert.equal((await h.call('POST /auth/verify',{body:{token}})).status,200);
 const reused=await h.call('POST /auth/verify',{body:{token}});assert.equal(reused.status,400);assert.equal(reused.body.error,'invalid_or_expired');
 assert.equal((await h.call('POST /auth/verify-code',{body:{email:'once@example.com',code:loginCode(message)}})).status,400,'the code went with the link');
 // Concurrent use: exactly one wins.
 const race=(await requestLink(h,'race@example.com')).message;
 const results=await Promise.all([1,2,3].map(()=>h.call('POST /auth/verify',{body:{token:linkToken(race)}})));
 assert.deepEqual(results.map(r=>r.status).sort(),[200,400,400]);
 // Expiry: valid until 15 minutes, then refused by link and by code.
 const late=(await requestLink(h,'late@example.com')).message,early=(await requestLink(h,'early@example.com')).message;
 h.advance(15*MINUTE-1);assert.equal((await h.call('POST /auth/verify-code',{body:{email:'early@example.com',code:loginCode(early)}})).status,200);
 h.advance(1);
 assert.equal((await h.call('POST /auth/verify',{body:{token:linkToken(late)}})).body.error,'invalid_or_expired');
 assert.equal((await h.call('POST /auth/verify-code',{body:{email:'late@example.com',code:loginCode(late)}})).body.error,'invalid_or_expired');
 for(const token of [undefined,'',42,'short','x'.repeat(44),'a'.repeat(43)])assert.equal((await h.call('POST /auth/verify',{body:{token}})).body.error,'invalid_or_expired',String(token));
});

test('request-link limits: 3 per email per 15 minutes, 10 per visitor IP per hour, 100 to new addresses per hour',{skip:!connection},async t=>{
 const h=await harness(t);
 assert.deepEqual(LOGIN_LIMITS,{perEmail:{max:3,ms:15*MINUTE},perIp:{max:10,ms:60*MINUTE},global:{max:100,ms:60*MINUTE}});
 for(let i=0;i<3;i++)assert.equal((await requestLink(h,'busy@example.com',{ip:`198.51.100.${i+1}`})).response.status,202);
 const limited=await requestLink(h,'busy@example.com',{ip:'198.51.100.9'});
 assert.equal(limited.response.status,429);assert.equal(limited.response.body.error,'rate_limit');assert.equal(h.mailer.sent.length,3,'no email when limited');
 h.advance(15*MINUTE);assert.equal((await requestLink(h,'busy@example.com',{ip:'198.51.100.9'})).response.status,202,'the window slides');
 // Per visitor IP: ten different addresses, then refused; another IP still works.
 for(let i=0;i<10;i++)assert.equal((await requestLink(h,`visitor${i}@example.com`,{ip:'192.0.2.50'})).response.status,202);
 assert.equal((await requestLink(h,'visitor10@example.com',{ip:'192.0.2.50'})).response.status,429);
 assert.equal((await requestLink(h,'visitor10@example.com',{ip:'192.0.2.51'})).response.status,202);
 h.advance(60*MINUTE);assert.equal((await requestLink(h,'visitor11@example.com',{ip:'192.0.2.50'})).response.status,202);
 // Global: 100 sign-in emails to addresses without an account in the last hour stop new addresses until the hour moves on.
 await h.db.query("DELETE FROM login_tokens");
 const bulk=(label,n,at)=>h.db.query("INSERT INTO login_tokens(token_hash,email,request_ip,created_at,expires_at) SELECT md5($1||i),$1||i||'@example.com','10.0.'||(i/250)||'.'||(i%250),$2::timestamptz,$2::timestamptz+interval '15 minutes' FROM generate_series(1,$3::int) i",[label,at,n]);
 await bulk('bulk',100,new Date(h.clock.now.getTime()-30*MINUTE));
 const capped=await requestLink(h,'fresh@example.com',{ip:'203.0.113.99'});assert.equal(capped.response.status,429);assert.equal(capped.response.body.error,'rate_limit');
 // An existing account still gets its link, and its links never use up the bucket.
 await h.db.query("INSERT INTO users(email) VALUES('member@example.com')");
 assert.equal((await requestLink(h,'member@example.com',{ip:'203.0.113.98'})).response.status,202);
 h.advance(30*MINUTE+1);assert.equal((await requestLink(h,'fresh@example.com',{ip:'203.0.113.99'})).response.status,202);
 assert.equal((await h.db.query("SELECT request_ip FROM login_tokens WHERE email='fresh@example.com'")).rows[0].request_ip,'203.0.113.99');
 // A relayed request without a client IP is limited in the site's own bucket, never as one visitor's IP.
 assert.equal((await requestLink(h,'noip@example.com',{ip:null})).response.status,202);
 assert.match((await h.db.query("SELECT request_ip FROM login_tokens WHERE email='noip@example.com'")).rows[0].request_ip,/^site:/);
 // With fresh and noip, 99 new addresses in the last hour; the member's link would make it 100.
 await bulk('late',97,h.clock.now);
 assert.equal((await requestLink(h,'new1@example.com',{ip:'203.0.113.97'})).response.status,202,'the member link is not counted');
 assert.equal((await requestLink(h,'new2@example.com',{ip:'203.0.113.97'})).response.status,429);
});

test('IPv6 visitors are limited per /64, which is also the address login_tokens stores',{skip:!connection},async t=>{
 const h=await harness(t);
 for(let i=1;i<=10;i++)assert.equal((await requestLink(h,`six${i}@example.com`,{ip:`2001:db8:1:2::${i.toString(16)}`})).response.status,202);
 assert.equal((await requestLink(h,'six11@example.com',{ip:'2001:DB8:1:2:ffff:ffff:ffff:ffff'})).response.status,429,'another address in the same /64');
 assert.equal((await requestLink(h,'six12@example.com',{ip:'2001:db8:1:3::1'})).response.status,202,'the next /64 is another visitor');
 assert.deepEqual((await h.db.query('SELECT DISTINCT request_ip FROM login_tokens ORDER BY 1')).rows.map(r=>r.request_ip),['2001:db8:1:2::/64','2001:db8:1:3::/64']);
});

test('concurrent sign-in requests cannot pass the per-email limit together',{skip:!connection},async t=>{
 const h=await harness(t);
 const results=await Promise.all(Array.from({length:6},(_,i)=>h.call('POST /auth/request-link',{body:{email:'burst@example.com'},ip:`198.18.0.${i+1}`})));
 assert.deepEqual(results.map(r=>r.status).sort(),[202,202,202,429,429,429]);
 assert.equal(await count(h.db,'SELECT count(*)::int n FROM login_tokens'),3);
});

test('sign-in is limited to admins until email really goes out, and transport none refuses everyone',{skip:!connection},async t=>{
 // The log transport on the public site: only the operator's own tests reach data/mail.log.
 const closed=await harness(t,{env:{PUBLIC_SITE_URL:'https://adoption.kadena.ws'}});
 assert.equal(closed.cfg.mail.open,false);
 const refused=await requestLink(closed,'visitor@example.com');
 assert.equal(refused.response.status,503);assert.equal(refused.response.body.error,'signin_not_open');
 assert.equal(closed.mailer.sent.length,0);assert.equal(await count(closed.db,'SELECT count(*)::int n FROM login_tokens'),0);
 const adminLink=await requestLink(closed,'Admin@Example.com');assert.equal(adminLink.response.status,202);
 assert.ok(adminLink.message.text.includes('https://adoption.kadena.ws/signin/verify#token='));
 const session=(await closed.call('POST /auth/verify',{body:{token:linkToken(adminLink.message)}})).body.sessionToken;
 const account=(await closed.call('GET /account',{session})).body;assert.equal(account.isAdmin,true);assert.equal(account.signinOpen,false);
 for(const env of [{MAIL_TRANSPORT:'none'},{MAIL_TRANSPORT:'',NODE_ENV:'production'}]){
  const none=await harness(t,{env});assert.equal(none.cfg.mail.transport,'none');
  for(const email of ['visitor@example.com','admin@example.com']){
   const r=await requestLink(none,email);assert.equal(r.response.status,503);assert.equal(r.response.body.error,'mail_not_configured');
  }
  assert.equal(none.mailer.sent.length,0);assert.equal(await count(none.db,'SELECT count(*)::int n FROM login_tokens'),0);
 }
 // A mailer whose transport is none is refused the same way even if the settings say otherwise.
 const mismatch=await harness(t,{mailer:fakeMailer({transport:'none'})});
 assert.equal((await requestLink(mismatch,'visitor@example.com')).response.body.error,'mail_not_configured');
});

test('a failed or slow email answers mail_failed, keeps the token unused, and logs neither link nor code',{skip:!connection},async t=>{
 const h=await harness(t,{mailer:fakeMailer({fail:true})});
 const errors=t.mock.method(console,'error',()=>{});
 const {response,message}=await requestLink(h,'unlucky@example.com');
 assert.equal(response.status,502);assert.equal(response.body.error,'mail_failed');
 const row=(await h.db.query('SELECT used_at FROM login_tokens')).rows[0];assert.equal(row.used_at,null);
 const logged=errors.mock.calls.map(call=>call.arguments.join(' ')).join('\n');
 assert.match(logged,/login_mail_failed/);assert.ok(!logged.includes(linkToken(message))&&!logged.includes(loginCode(message))&&!logged.includes('unlucky@example.com'));
 // Direct: a mailer that never answers times out; one reporting mail_not_configured maps to 503.
 const cfg=h.cfg,slow={transport:'log',send:()=>new Promise(()=>{})};
 await assert.rejects(requestLoginLink(h.db,cfg,slow,{email:'slow@example.com',clientIp:'203.0.113.1',now:h.clock.now,mailTimeoutMs:30}),error=>error.status===502&&error.code==='mail_failed');
 const notConfigured={transport:'log',async send(){throw Object.assign(new Error('Email is not configured (MAIL_TRANSPORT)'),{code:'mail_not_configured'})}};
 await assert.rejects(requestLoginLink(h.db,cfg,notConfigured,{email:'none@example.com',clientIp:'203.0.113.1',now:h.clock.now}),error=>error.status===503&&error.code==='mail_not_configured');
 assert.equal(await count(h.db,"SELECT count(*)::int n FROM login_tokens WHERE email IN ('slow@example.com','none@example.com') AND used_at IS NULL"),2);
});

test('logout revokes the session, needs no body, and is harmless without a session',{skip:!connection},async t=>{
 const h=await harness(t),session=await signIn(h,'leaving@example.com'),other=await signIn(h,'leaving@example.com');
 assert.equal((await h.call('GET /account',{session})).status,200);
 // No body and no Content-Type, as the site sends it.
 const out=await h.call('POST /auth/logout',{session});assert.equal(out.status,200);assert.deepEqual(out.body,{ok:true});
 assert.equal(new Date((await h.db.query('SELECT revoked_at FROM sessions WHERE token_hash=$1',[hashToken(session)])).rows[0].revoked_at).getTime(),h.clock.now.getTime());
 const after=await h.call('GET /account',{session});assert.equal(after.status,401);assert.equal(after.body.error,'session_required');
 assert.equal((await h.call('GET /account',{session:other})).status,200,'other sessions stay signed in');
 assert.deepEqual((await h.call('POST /auth/logout',{session})).body,{ok:true},'again: nothing to revoke');
 assert.deepEqual((await h.call('POST /auth/logout')).body,{ok:true});
 assert.deepEqual((await h.call('POST /auth/logout',{body:{}})).body,{ok:true});
 assert.equal((await h.call('POST /auth/logout',{session:'z'.repeat(43)})).status,200);
});

test('next paths: only same-site paths survive sign-in',{skip:!connection},async t=>{
 const h=await harness(t);
 const cases=[['/account',"/account"],['/checkout?plan=monthly','/checkout?plan=monthly'],['//evil.example','null'],['/.//evil.example','null'],['/..//evil.example','null'],
  ['/x/../..//evil.example','null'],['https://evil.example','null'],['/\\evil.example','null'],['/%2f%2fevil.example','null'],['/%5cevil','null'],['javascript:alert(1)','null'],
  ['account','null'],[42,'null'],[null,'null'],['/'+'a'.repeat(600),'null']];
 for(const [i,[next,expected]] of cases.entries()){
  const {message}=await requestLink(h,`next${i}@example.com`,{body:{next},ip:`198.51.100.${i+1}`});
  const verified=await h.call('POST /auth/verify',{body:{token:linkToken(message)}});
  assert.equal(String(verified.body.next),expected,String(next));
 }
 // A path stored before a stricter rule is still re-checked on the way out.
 const {message}=await requestLink(h,'legacy@example.com',{ip:'198.51.100.200'});
 await h.db.query("UPDATE login_tokens SET next_path='//evil.example' WHERE email='legacy@example.com'");
 assert.equal((await h.call('POST /auth/verify',{body:{token:linkToken(message)}})).body.next,null);
});

test('request-link input: invalid email, missing body and the site key',{skip:!connection},async t=>{
 const h=await harness(t);
 for(const email of [undefined,'','plainaddress','a@b','x'.repeat(250)+'@example.com',['a@example.com'],'a@example.com\n'+'b'])
  assert.equal((await h.call('POST /auth/request-link',{body:{email}})).body.error,'invalid_email',String(email));
 assert.equal((await h.call('POST /auth/request-link')).body.error,'invalid_email');
 const noKey=await fetch(h.base+'/auth/request-link',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({email:'a@example.com'})});
 assert.equal(noKey.status,401);assert.equal((await noKey.json()).error,'site_key_required');
 assert.equal(h.mailer.sent.length,0);
});

test('GET /account: wallets in EIP-55, payments with explorer links, failure reasons, overpayment and the admin test plan',{skip:!connection},async t=>{
 const env={PAYMENT_NETWORK:'bsc',PAYMENT_ADDRESS:'0x4274907CE85E100a5EbAe1f7286DeB5083a52e98',PAYMENT_TEST_PLAN:'1'};
 const h=await harness(t,{env}),userSession=await signIn(h,'payer@example.com'),adminSession=await signIn(h,'admin@example.com');
 const userId=Number((await h.db.query("SELECT id FROM users WHERE email='payer@example.com'")).rows[0].id);
 await h.db.query("INSERT INTO wallets(address,user_id,message,signature) VALUES('0x2c7536e3605d9c16a7a3d7b1898e529396a65c23',$1,'m','0x')",[userId]);
 const insert=(hash,fields)=>h.db.query(`INSERT INTO payments(rail,network,chain,tx_hash,user_id,from_address,to_address,token,token_address,decimals,amount,required_amount,plan,status,failure_reason,source,period_start,period_end,created_at)
  VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,'checkout',$16,$17,$18)`,['evm',fields.network??'bsc',fields.chain??'56',hash,userId,'0x2c7536e3605d9c16a7a3d7b1898e529396a65c23','0x4274907ce85e100a5ebae1f7286deb5083a52e98',
  fields.token??'USDT',fields.tokenAddress??'0x55d398326f99059ff775485246999027b3197955',18,fields.amount,(9n*10n**18n).toString(),fields.plan??'monthly',fields.status,fields.reason??null,fields.periodStart??null,fields.periodEnd??null,fields.createdAt]);
 const at=days=>new Date(h.clock.now.getTime()-days*DAY);
 await insert('0x'+'1'.repeat(64),{amount:(10n*10n**18n).toString(),status:'confirmed',periodStart:at(5),periodEnd:new Date(at(5).getTime()+30*DAY),createdAt:at(5)});
 await insert('0x'+'2'.repeat(64),{amount:(5n*10n**18n).toString(),status:'underpaid',createdAt:at(4)});
 await insert('0x'+'3'.repeat(64),{amount:(9n*10n**18n).toString(),status:'failed',reason:'receipt_missing',createdAt:at(3)});
 await insert('0x'+'4'.repeat(64),{network:'bsc-testnet',chain:'97',token:'USDC',tokenAddress:'0x64544969ed7ebf5f083679233325356ebe738930',amount:(95n*10n**17n).toString(),status:'pending',createdAt:at(1)});
 const account=(await h.call('GET /account',{session:userSession})).body;
 assert.deepEqual(account.wallets,[{address:'0x2c7536E3605D9C16a7a3D7b1898e529396a65c23',linkedAt:account.wallets[0].linkedAt}]);
 assert.deepEqual(account.payments.map(p=>[p.txHash,p.status,p.amount,p.overpaid,p.failureReason]),[
  ['0x'+'4'.repeat(64),'pending','9.5',true,null],['0x'+'3'.repeat(64),'failed','9',false,'receipt_missing'],['0x'+'2'.repeat(64),'underpaid','5',false,null],['0x'+'1'.repeat(64),'confirmed','10',true,null]]);
 const [pending,,,confirmed]=account.payments;
 assert.equal(pending.rail,'evm');assert.equal(pending.network,'bsc-testnet');assert.equal(pending.chain,'97');assert.equal(pending.token,'USDC');assert.equal(pending.required,'9');
 assert.equal(pending.explorerUrl,'https://testnet.bscscan.com/tx/0x'+'4'.repeat(64));
 assert.equal(confirmed.explorerUrl,'https://bscscan.com/tx/0x'+'1'.repeat(64));assert.equal(confirmed.required,'9');assert.equal(confirmed.decimals,18);
 assert.equal(confirmed.from,'0x2c7536E3605D9C16a7a3D7b1898e529396a65c23');assert.equal(confirmed.periodEnd,new Date(at(5).getTime()+30*DAY).toISOString());
 assert.equal(confirmed.plan,'monthly');assert.equal(confirmed.createdAt,at(5).toISOString());
 assert.equal(account.testPlanAvailable,false);assert.deepEqual(account.billing,{enabled:true,testnet:false});
 const adminAccount=(await h.call('GET /account',{session:adminSession})).body;assert.equal(adminAccount.isAdmin,true);assert.equal(adminAccount.testPlanAvailable,true);assert.deepEqual(adminAccount.payments,[]);
 // Only the latest 20 payments.
 for(let i=0;i<25;i++)await insert('0x'+i.toString(16).padStart(64,'f'),{amount:(9n*10n**18n).toString(),status:'confirmed',createdAt:at(10+i)});
 assert.equal((await h.call('GET /account',{session:userSession})).body.payments.length,20);
});
