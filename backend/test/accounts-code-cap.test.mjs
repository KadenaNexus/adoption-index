import {test} from 'node:test';
import assert from 'node:assert/strict';
import {randomBytes} from 'node:crypto';
import pg from 'pg';
import '../src/db.mjs';
import {migrate} from '../src/migrate.mjs';
import {accountsConfig} from '../src/config.mjs';
import {requestLoginLink,verifyLoginCode,MAX_CODE_FAILURES_PER_DAY} from '../src/accounts.mjs';
const connection=process.env.TEST_DATABASE_URL;
async function isolated(t){
 const url=new URL(connection);if(!url.pathname.endsWith('_test'))throw new Error('Integration tests require a dedicated *_test database');
 const schema='codecap_'+randomBytes(8).toString('hex'),admin=new pg.Pool({connectionString:connection,max:1});
 await admin.query(`CREATE SCHEMA ${schema}`);url.searchParams.set('options',`-c search_path=${schema}`);const db=new pg.Pool({connectionString:url.href,max:2,connectionTimeoutMillis:30000});
 t.after(async()=>{await db.end();try{await admin.query(`DROP SCHEMA ${schema} CASCADE`)}finally{await admin.end()}});
 await migrate(db);return db;
}
test('wrong sign-in codes are capped per email per day, even when new links keep arriving',{skip:!connection},async t=>{
 const db=await isolated(t),cfg=accountsConfig({PUBLIC_SITE_URL:'http://127.0.0.1:5173',MAIL_TRANSPORT:'log'}),sent=[],mailer={transport:'log',async send(m){sent.push(m);return {id:'x'}}};
 const email='target@example.com',DAY=86400000;let now=new Date('2026-10-01T00:00:00Z'),misses=0;
 const code=()=>/^(\d{6})$/m.exec(sent.at(-1).text)[1],wrong=c=>String((Number(c)+1)%1e6).padStart(6,'0');
 while(misses<MAX_CODE_FAILURES_PER_DAY){
  await requestLoginLink(db,cfg,mailer,{email,clientIp:'198.51.100.'+misses,now});
  for(let i=0;i<4&&misses<MAX_CODE_FAILURES_PER_DAY;i++,misses++)await assert.rejects(verifyLoginCode(db,{email,code:wrong(code()),now}),e=>e.status===400);
  now=new Date(now.getTime()+16*60000);
 }
 await requestLoginLink(db,cfg,mailer,{email,clientIp:'198.51.100.99',now});
 await assert.rejects(verifyLoginCode(db,{email,code:code(),now}),e=>e.status===429&&e.code==='code_locked','even the right code is refused once the cap is reached');
 now=new Date(now.getTime()+DAY);
 await requestLoginLink(db,cfg,mailer,{email,clientIp:'198.51.100.100',now});
 const session=await verifyLoginCode(db,{email,code:code(),now});
 assert.match(session.sessionToken,/^[A-Za-z0-9_-]{43}$/,'the cap lifts after 24 hours');
});
