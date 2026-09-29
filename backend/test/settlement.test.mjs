import {test} from 'node:test';
import assert from 'node:assert/strict';
import {randomBytes} from 'node:crypto';
import {database} from '../src/db.mjs';
import {migrate} from '../src/migrate.mjs';
import {accountsConfig} from '../src/config.mjs';
import {extendSubscription,settlePaymentTx} from '../src/subscriptions.mjs';
import {transaction} from '../src/db.mjs';
const connection=process.env.TEST_DATABASE_URL;
async function isolated(t){
 const url=new URL(connection);if(!url.pathname.endsWith('_test'))throw new Error('Integration tests require a dedicated *_test database');
 const schema='settle_'+randomBytes(8).toString('hex'),admin=database(connection);
 await admin.query(`CREATE SCHEMA ${schema}`);url.searchParams.set('options',`-c search_path=${schema}`);const db=database(url.href);
 t.after(async()=>{await db.end();try{await admin.query(`DROP SCHEMA ${schema} CASCADE`)}finally{await admin.end()}});
 await migrate(db);return db;
}
const cfg=accountsConfig({PUBLIC_SITE_URL:'http://127.0.0.1:5173'}),DAY=86400000,now=new Date('2026-10-01T12:00:00Z');
async function user(db,email='payer@example.com'){return Number((await db.query('INSERT INTO users(email) VALUES($1) RETURNING id',[email])).rows[0].id)}
async function payment(db,userId,{amount=9n*10n**18n,required=9n*10n**18n,plan='monthly',hash='0x'+'a'.repeat(64)}={}){
 return Number((await db.query(`INSERT INTO payments(rail,network,chain,tx_hash,user_id,from_address,to_address,token,token_address,decimals,amount,required_amount,plan,status,source)
  VALUES('evm','bsc','56',$1,$2,'0x'||repeat('1',40),'0x'||repeat('2',40),'USDT','0x'||repeat('3',40),18,$3,$4,$5,'pending','checkout') RETURNING id`,[hash,userId,amount.toString(),required.toString(),plan])).rows[0].id);
}
test('settling one payment from two places at once extends access exactly once and queues one email',{skip:!connection},async t=>{
 const db=await isolated(t),u=await user(db),p=await payment(db,u);
 const results=await Promise.all([settlePaymentTx(db,cfg,p,{now}),settlePaymentTx(db,cfg,p,{now}),settlePaymentTx(db,cfg,p,{now})]);
 assert.equal(results.filter(r=>r.changed).length,1);
 const sub=(await db.query('SELECT expires_at FROM subscriptions WHERE user_id=$1',[u])).rows[0];
 assert.equal(new Date(sub.expires_at).getTime(),now.getTime()+30*DAY);
 assert.equal((await db.query('SELECT count(*)::int n FROM email_outbox')).rows[0].n,1);
 assert.equal((await db.query('SELECT status FROM payments WHERE id=$1',[p])).rows[0].status,'confirmed');
});
test('a renewal while active extends from the current expiry; after expiry it starts again from now',{skip:!connection},async t=>{
 const db=await isolated(t),u=await user(db);
 await settlePaymentTx(db,cfg,await payment(db,u,{hash:'0x'+'b'.repeat(64)}),{now});
 await settlePaymentTx(db,cfg,await payment(db,u,{hash:'0x'+'c'.repeat(64),plan:'annual',amount:79n*10n**18n,required:79n*10n**18n}),{now:new Date(now.getTime()+10*DAY)});
 let sub=(await db.query('SELECT plan,started_at,expires_at FROM subscriptions WHERE user_id=$1',[u])).rows[0];
 assert.equal(sub.plan,'annual');assert.equal(new Date(sub.started_at).getTime(),now.getTime());
 assert.equal(new Date(sub.expires_at).getTime(),now.getTime()+(30+365)*DAY);
 const later=new Date(now.getTime()+500*DAY);
 await transaction(db,client=>extendSubscription(client,u,{plan:'monthly',days:30,now:later}));
 sub=(await db.query('SELECT started_at,expires_at FROM subscriptions WHERE user_id=$1',[u])).rows[0];
 assert.equal(new Date(sub.started_at).getTime(),later.getTime());assert.equal(new Date(sub.expires_at).getTime(),later.getTime()+30*DAY);
});
test('an underpaid payment gives no access, is final and sends the underpaid notice',{skip:!connection},async t=>{
 const db=await isolated(t),u=await user(db),p=await payment(db,u,{amount:5n*10n**18n});
 const first=await settlePaymentTx(db,cfg,p,{now,block:{number:123,hash:'0x'+'d'.repeat(64)}});
 assert.equal(first.outcome,'underpaid');
 assert.equal((await db.query('SELECT count(*)::int n FROM subscriptions')).rows[0].n,0);
 assert.deepEqual((await db.query('SELECT kind FROM email_outbox')).rows,[{kind:'payment_underpaid'}]);
 const again=await settlePaymentTx(db,cfg,p,{now});assert.equal(again.changed,false);
});
