import {test} from 'node:test';
import assert from 'node:assert/strict';
import {randomBytes} from 'node:crypto';
import pg from 'pg';
import {transaction} from '../src/db.mjs';
import {migrate} from '../src/migrate.mjs';
import {createServer} from '../src/server.mjs';
import {accountsConfig} from '../src/config.mjs';
import {hashToken,newToken} from '../src/auth.mjs';
import {extendSubscription} from '../src/subscriptions.mjs';
const connection=process.env.TEST_DATABASE_URL;
async function isolated(t){
 const url=new URL(connection);if(!url.pathname.endsWith('_test'))throw new Error('Integration tests require a dedicated *_test database');
 // Small pools: the whole suite runs in parallel against one local server with few connection slots.
 const schema='admin_'+randomBytes(8).toString('hex'),admin=new pg.Pool({connectionString:connection,max:1});
 await admin.query(`CREATE SCHEMA ${schema}`);url.searchParams.set('options',`-c search_path=${schema}`);const db=new pg.Pool({connectionString:url.href,max:3,connectionTimeoutMillis:30000});
 t.after(async()=>{await db.end();try{await admin.query(`DROP SCHEMA ${schema} CASCADE`)}finally{await admin.end()}});
 await migrate(db);return db;
}
const siteKey='k'.repeat(40),DAY=86400000,now=new Date('2026-10-01T12:00:00.000Z'),payTo='0x4274907ce85e100a5ebae1f7286deb5083a52e98';
async function harness(t,env={}){
 const db=await isolated(t),cfg=accountsConfig({SITE_API_KEY:siteKey,ADMIN_EMAILS:'Boss@Example.com',PUBLIC_SITE_URL:'http://127.0.0.1:5173',MAIL_TRANSPORT:'log',PAYMENT_NETWORK:'bsc',PAYMENT_ADDRESS:'0x4274907CE85E100a5EbAe1f7286DeB5083a52e98',...env});
 const server=createServer(db,{cfg,mailer:{transport:'log',async send(){return {id:'x'}}},now:()=>now});
 await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));t.after(()=>new Promise(resolve=>server.close(resolve)));
 const base=`http://127.0.0.1:${server.address().port}`;
 async function call(route,{body,session}={}){
  const [method,path]=route.split(' ');
  const response=await fetch(base+path,{method,headers:{'X-KCE-Site-Key':siteKey,'X-KCE-Client-IP':'203.0.113.7',...(session?{'X-KCE-Session':session}:{}),...(body===undefined?{}:{'Content-Type':'application/json'})},body:body===undefined?undefined:JSON.stringify(body)});
  return {status:response.status,body:await response.json()};
 }
 async function user(email){
  const id=Number((await db.query('INSERT INTO users(email) VALUES($1) ON CONFLICT(email) DO UPDATE SET email=EXCLUDED.email RETURNING id',[email])).rows[0].id),token=newToken();
  await db.query('INSERT INTO sessions(token_hash,user_id,expires_at) VALUES($1,$2,$3)',[hashToken(token),id,new Date(now.getTime()+30*DAY)]);
  return {id,session:token};
 }
 return {db,cfg,call,user};
}
const units=n=>(BigInt(Math.round(n*100))*10n**16n).toString();
async function payment(db,userId,hash,{amount,required=9,status,reason=null,createdAt,network='bsc'}){
 await db.query(`INSERT INTO payments(rail,network,chain,tx_hash,user_id,from_address,to_address,token,token_address,decimals,amount,required_amount,plan,status,failure_reason,source,block_number,created_at)
  VALUES('evm',$1,'56',$2,$3,'0x2c7536e3605d9c16a7a3d7b1898e529396a65c23',$4,'USDT','0x55d398326f99059ff775485246999027b3197955',18,$5,$6,'monthly',$7,$8,'reconciler',123,$9)`,[network,hash,userId,payTo,units(amount),units(required),status,reason,createdAt]);
}
async function unmatched(db,hash,{logIndex=0,amount=9,note=null,seenAt,token='USDT'}){
 await db.query('INSERT INTO unmatched_transfers(network,tx_hash,log_index,from_address,token,amount,block_number,seen_at,resolved_note) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)',['bsc',hash,logIndex,'0x8894e0a0c962cb723c1976a4421c95949be2d4e3',token,units(amount),456,seenAt,note]);
}
const H=c=>'0x'+c.repeat(64);

test('admin routes answer 404 to signed-in non-admins and 401 without a session',{skip:!connection},async t=>{
 const h=await harness(t),plain=await h.user('plain@example.com');
 for(const [route,body] of [['GET /admin/overview'],['POST /admin/subscriptions/extend',{email:'x@example.com',days:5,note:'n'}],['POST /admin/unmatched/resolve',{network:'bsc',txHash:H('a'),logIndex:0,note:'n'}]]){
  const denied=await h.call(route,{body,session:plain.session});assert.equal(denied.status,404,route);assert.equal(denied.body.error,'not_found',route);
  assert.equal((await h.call(route,{body})).status,401,route);
 }
 assert.equal((await h.db.query('SELECT count(*)::int n FROM admin_actions')).rows[0].n,0);
 assert.equal((await h.db.query("SELECT count(*)::int n FROM users WHERE email='x@example.com'")).rows[0].n,0);
});

test('admin overview: payments with email and over/underpaid markers, unresolved transfers first, subscriptions and counts',{skip:!connection},async t=>{
 const h=await harness(t),boss=await h.user('boss@example.com'),a=await h.user('alice@example.com'),b=await h.user('bob@example.com');
 const at=days=>new Date(now.getTime()-days*DAY);
 await payment(h.db,a.id,H('1'),{amount:10,status:'confirmed',createdAt:at(3)});
 await payment(h.db,b.id,H('2'),{amount:5,status:'underpaid',createdAt:at(2)});
 await payment(h.db,b.id,H('3'),{amount:9,status:'failed',reason:'receipt_missing',createdAt:at(1)});
 await payment(h.db,a.id,H('4'),{amount:9,status:'pending',createdAt:at(0)});
 await unmatched(h.db,H('a'),{note:'refunded by hand',seenAt:at(1)});
 await unmatched(h.db,H('b'),{seenAt:at(5),amount:12.5});
 await unmatched(h.db,H('c'),{note:'processing_error: providers_unavailable',seenAt:at(4)});
 await unmatched(h.db,H('d'),{seenAt:at(2),token:'0x55d398326f99059ff775485246999027b3197955'});
 await h.db.query('INSERT INTO subscriptions(user_id,plan,started_at,expires_at) VALUES($1,$2,$3,$4),($5,$6,$7,$8)',[a.id,'monthly',at(10),new Date(now.getTime()+20*DAY),b.id,'annual',at(400),at(35)]);
 const {status,body}=await h.call('GET /admin/overview',{session:boss.session});
 assert.equal(status,200);
 assert.deepEqual(body.payments.map(p=>[p.txHash,p.email,p.status,p.amount,p.required,p.overpaid,p.failureReason]),[
  [H('4'),'alice@example.com','pending','9','9',false,null],[H('3'),'bob@example.com','failed','9','9',false,'receipt_missing'],
  [H('2'),'bob@example.com','underpaid','5','9',false,null],[H('1'),'alice@example.com','confirmed','10','9',true,null]]);
 const first=body.payments[3];
 assert.equal(first.userId,a.id);assert.equal(first.source,'reconciler');assert.equal(first.blockNumber,123);assert.equal(first.from,'0x2c7536E3605D9C16a7a3D7b1898e529396a65c23');
 assert.equal(first.to,'0x4274907CE85E100a5EbAe1f7286DeB5083a52e98');assert.equal(first.explorerUrl,`https://bscscan.com/tx/${H('1')}`);
 // Unresolved first (a processing error still needs attention), newest first within each group.
 assert.deepEqual(body.unmatched.map(u=>[u.txHash,u.resolved]),[[H('d'),false],[H('c'),false],[H('b'),false],[H('a'),true]]);
 const b12=body.unmatched.find(u=>u.txHash===H('b'));assert.equal(b12.amount,'12.5');assert.equal(b12.amountBaseUnits,units(12.5));assert.equal(b12.decimals,18);
 assert.equal(b12.from,'0x8894E0a0c962CB723c1976a4421c95949bE2D4E3');assert.equal(b12.explorerUrl,`https://bscscan.com/tx/${H('b')}`);
 assert.equal(body.unmatched.find(u=>u.txHash===H('d')).amount,'9','decimals found by token address too');
 assert.equal(body.unmatched.find(u=>u.txHash===H('a')).resolvedNote,'refunded by hand');
 assert.deepEqual(body.subscriptions.map(s=>[s.email,s.plan,s.active]),[['alice@example.com','monthly',true],['bob@example.com','annual',false]]);
 assert.equal(body.subscriptions[0].expiresAt,new Date(now.getTime()+20*DAY).toISOString());
 assert.deepEqual(body.counts,{users:3,activeSubscriptions:1,confirmedPayments:1,pendingPayments:1,unresolvedTransfers:3,queuedEmails:0,failedEmails:0});
 assert.equal(body.network,'bsc');assert.equal(body.testnet,false);assert.deepEqual(body.actions,[]);
});

test('admin extend: creates unknown users, extends from max(now, expiry), keeps the plan, validates input and audits',{skip:!connection},async t=>{
 const h=await harness(t),boss=await h.user('boss@example.com');
 const created=await h.call('POST /admin/subscriptions/extend',{session:boss.session,body:{email:' New@Example.com ',days:10,note:'  launch partner  '}});
 assert.equal(created.status,200);assert.equal(created.body.userCreated,true);
 assert.deepEqual(created.body.subscription,{plan:'manual',startedAt:now.toISOString(),expiresAt:new Date(now.getTime()+10*DAY).toISOString(),active:true});
 // While active, days are added to the current expiry.
 const again=await h.call('POST /admin/subscriptions/extend',{session:boss.session,body:{email:'new@example.com',days:'5',note:'goodwill'}});
 assert.equal(again.body.userCreated,false);assert.equal(again.body.subscription.expiresAt,new Date(now.getTime()+15*DAY).toISOString());assert.equal(again.body.subscription.startedAt,now.toISOString());
 // An expired subscription restarts from now and keeps its plan.
 const lapsed=await h.user('lapsed@example.com');
 await h.db.query('INSERT INTO subscriptions(user_id,plan,started_at,expires_at) VALUES($1,$2,$3,$4)',[lapsed.id,'annual',new Date(now.getTime()-400*DAY),new Date(now.getTime()-35*DAY)]);
 const restarted=(await h.call('POST /admin/subscriptions/extend',{session:boss.session,body:{email:'lapsed@example.com',days:400,note:'support case 12'}})).body.subscription;
 assert.deepEqual(restarted,{plan:'annual',startedAt:now.toISOString(),expiresAt:new Date(now.getTime()+400*DAY).toISOString(),active:true});
 // The same arithmetic as extendSubscription itself.
 await transaction(h.db,client=>extendSubscription(client,lapsed.id,{plan:'annual',days:1,now}));
 assert.equal(new Date((await h.db.query('SELECT expires_at FROM subscriptions WHERE user_id=$1',[lapsed.id])).rows[0].expires_at).getTime(),now.getTime()+401*DAY);
 for(const [body,error] of [[{email:'bad',days:5,note:'n'},'invalid_email'],[{email:'a@example.com',days:0,note:'n'},'invalid_days'],[{email:'a@example.com',days:401,note:'n'},'invalid_days'],
  [{email:'a@example.com',days:1.5,note:'n'},'invalid_days'],[{email:'a@example.com',days:'ten',note:'n'},'invalid_days'],[{email:'a@example.com',note:'n'},'invalid_days'],
  [{email:'a@example.com',days:5},'invalid_note'],[{email:'a@example.com',days:5,note:'   '},'invalid_note'],[{email:'a@example.com',days:5,note:'x'.repeat(501)},'invalid_note'],[{email:'a@example.com',days:5,note:42},'invalid_note']]){
  const r=await h.call('POST /admin/subscriptions/extend',{session:boss.session,body});assert.equal(r.status,400,JSON.stringify(body));assert.equal(r.body.error,error,JSON.stringify(body));
 }
 assert.equal((await h.db.query("SELECT count(*)::int n FROM users WHERE email='a@example.com'")).rows[0].n,0,'nothing created on invalid input');
 const actions=(await h.db.query('SELECT * FROM admin_actions ORDER BY id')).rows;
 assert.equal(actions.length,3);assert.ok(actions.every(a=>a.admin_email==='boss@example.com'&&a.action==='extend_subscription'));
 const newUser=Number((await h.db.query("SELECT id FROM users WHERE email='new@example.com'")).rows[0].id);
 assert.equal(Number(actions[0].user_id),newUser);assert.equal(new Date(actions[0].created_at).getTime(),now.getTime());
 assert.deepEqual(actions[0].details,{email:'new@example.com',days:10,note:'launch partner',plan:'manual',userCreated:true,previousExpiresAt:null,periodStart:now.toISOString(),periodEnd:new Date(now.getTime()+10*DAY).toISOString()});
 assert.equal(actions[1].details.previousExpiresAt,new Date(now.getTime()+10*DAY).toISOString());assert.equal(actions[1].details.periodStart,new Date(now.getTime()+10*DAY).toISOString());
 assert.equal(actions[2].details.plan,'annual');
 assert.equal((await h.call('GET /admin/overview',{session:boss.session})).body.actions.length,3);
});

test('admin resolve: records a note on an unmatched transfer, audited, and it moves below unresolved ones',{skip:!connection},async t=>{
 const h=await harness(t),boss=await h.user('boss@example.com');
 await unmatched(h.db,H('e'),{logIndex:3,seenAt:new Date(now.getTime()-DAY)});await unmatched(h.db,H('f'),{seenAt:new Date(now.getTime()-2*DAY)});
 const resolved=await h.call('POST /admin/unmatched/resolve',{session:boss.session,body:{network:'bsc',txHash:H('E'),logIndex:3,note:'Exchange withdrawal for alice@example.com; extended by hand'}});
 assert.equal(resolved.status,200);assert.equal(resolved.body.ok,true);
 assert.equal(resolved.body.unmatched.txHash,H('e'));assert.equal(resolved.body.unmatched.resolved,true);assert.equal(resolved.body.unmatched.resolvedNote,'Exchange withdrawal for alice@example.com; extended by hand');
 assert.equal((await h.db.query('SELECT resolved_note FROM unmatched_transfers WHERE tx_hash=$1',[H('e')])).rows[0].resolved_note,'Exchange withdrawal for alice@example.com; extended by hand');
 const action=(await h.db.query('SELECT * FROM admin_actions')).rows[0];
 assert.equal(action.action,'resolve_unmatched');assert.equal(action.admin_email,'boss@example.com');assert.equal(action.user_id,null);
 assert.deepEqual(action.details,{network:'bsc',txHash:H('e'),logIndex:3,note:'Exchange withdrawal for alice@example.com; extended by hand',previousNote:null});
 const overview=(await h.call('GET /admin/overview',{session:boss.session})).body;
 assert.deepEqual(overview.unmatched.map(u=>[u.txHash,u.resolved]),[[H('f'),false],[H('e'),true]]);assert.equal(overview.counts.unresolvedTransfers,1);
 // Correcting a note keeps the previous one in the audit trail.
 await h.call('POST /admin/unmatched/resolve',{session:boss.session,body:{network:'bsc',txHash:H('e'),logIndex:'3',note:'Corrected note'}});
 assert.equal((await h.db.query('SELECT details FROM admin_actions ORDER BY id DESC LIMIT 1')).rows[0].details.previousNote,'Exchange withdrawal for alice@example.com; extended by hand');
 for(const [body,status,error] of [[{network:'bsc',txHash:H('e'),logIndex:4,note:'n'},404,'not_found'],[{network:'bsc-testnet',txHash:H('e'),logIndex:3,note:'n'},404,'not_found'],
  [{network:'BSC!',txHash:H('e'),logIndex:3,note:'n'},400,'invalid_network'],[{network:'kadena-mainnet01',txHash:H('e'),logIndex:3,note:'n'},400,'invalid_network'],
  [{network:'bsc',txHash:'0x123',logIndex:3,note:'n'},400,'invalid_tx_hash'],[{network:'bsc',txHash:'Ab_-'.repeat(10)+'xyz',logIndex:3,note:'n'},400,'invalid_tx_hash'],
  [{network:'bsc',txHash:H('e').slice(2),logIndex:3,note:'n'},400,'invalid_tx_hash'],
  [{network:'bsc',txHash:H('e'),logIndex:-1,note:'n'},400,'invalid_log_index'],[{network:'bsc',txHash:H('e'),logIndex:3,note:''},400,'invalid_note']]){
  const r=await h.call('POST /admin/unmatched/resolve',{session:boss.session,body});assert.equal(r.status,status,JSON.stringify(body));assert.equal(r.body.error,error,JSON.stringify(body));
 }
 assert.equal((await h.db.query('SELECT count(*)::int n FROM admin_actions')).rows[0].n,2);
});

test('admin overview on testnet says so',{skip:!connection},async t=>{
 const h=await harness(t,{PAYMENT_NETWORK:'bsc-testnet'}),boss=await h.user('boss@example.com');
 const body=(await h.call('GET /admin/overview',{session:boss.session})).body;assert.equal(body.network,'bsc-testnet');assert.equal(body.testnet,true);
});
