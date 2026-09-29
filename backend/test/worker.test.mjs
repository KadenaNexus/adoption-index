import {test} from 'node:test';
import assert from 'node:assert/strict';
import {randomBytes} from 'node:crypto';
import {setTimeout as sleep} from 'node:timers/promises';
import {database} from '../src/db.mjs';
import {migrate} from '../src/migrate.mjs';
import {accountsConfig} from '../src/config.mjs';
import {runWorker,runWorkerOnce,WORKER_STEPS} from '../src/worker.mjs';
import {safeMessage} from '../src/bsc.mjs';
const connection=process.env.TEST_DATABASE_URL;
async function isolated(t){
 const url=new URL(connection);if(!url.pathname.endsWith('_test'))throw new Error('Integration tests require a dedicated *_test database');
 const schema='worker_'+randomBytes(8).toString('hex'),admin=database(connection);
 await admin.query(`CREATE SCHEMA ${schema}`);url.searchParams.set('options',`-c search_path=${schema}`);const db=database(url.href);
 t.after(async()=>{await db.end();try{await admin.query(`DROP SCHEMA ${schema} CASCADE`)}finally{await admin.end()}});
 await migrate(db);return db;
}
// A pool stand-in for the loop tests that need no database: it records the lock queries.
function fakePool({locked=true}={}){
 const calls=[],client={async query(sql){calls.push(sql.includes('pg_try_advisory_lock')?'lock':sql.includes('pg_advisory_unlock')?'unlock':sql);return {rows:[{locked}]}},on(){},removeListener(){},release(error){calls.push(error?'destroy':'release')}};
 return {calls,async connect(){calls.push('connect');return client}};
}
const cfg=accountsConfig({PUBLIC_SITE_URL:'http://127.0.0.1:5173'});
const until=async(check,ms=5000)=>{const end=Date.now()+ms;while(!check()){if(Date.now()>end)throw new Error('timed out');await sleep(10)}};

test('the worker order is confirmPending, reconcile, processAlerts, processRenewalReminders, sendOutbox',()=>{
 assert.deepEqual(WORKER_STEPS.map(([name])=>name),['confirmPending','reconcile','processAlerts','processRenewalReminders','sendOutbox']);
});
test('every step is guarded: a throwing step is logged without its URL key and the next step still runs',async()=>{
 const ran=[],logs=[],steps=['one','two','three'].map(name=>[name,async(db,c,o)=>{ran.push([name,o.now() instanceof Date,typeof o.log,o.mailer?.id]);if(name==='one')o.log({event:'step_note',message:'retrying https://rpc.example/v1/SECRETKEY123'});if(name==='two')throw Object.assign(new Error('eth_call to https://bsc.example.com/v1/SECRETKEY123?key=Q9 failed\nnext'),{code:'rpc_error'});return name==='three'?undefined:{done:1}}]);
 const results=await runWorkerOnce({},cfg,{steps,log:e=>logs.push(e),mailer:{id:'m'}});
 assert.deepEqual(ran,[['one',true,'function','m'],['two',true,'function','m'],['three',true,'function','m']]);
 assert.deepEqual(results,{one:{done:1},two:{failed:true},three:null});
 assert.deepEqual(logs,[{event:'step_note',message:'retrying rpc.example'},{event:'worker_step_failed',step:'two',name:'Error',code:'rpc_error',message:'eth_call to bsc.example.com failed next'}]);
 assert.equal(safeMessage('see http://127.0.0.1:8545/path/KEY and wss://node.example/ws?apikey=K'),'see 127.0.0.1:8545 and node.example');
 assert.equal(safeMessage('x'.repeat(5000)).length,300);assert.equal(safeMessage(undefined),'');
});
test('runWorker holds the lock, repeats on the interval, logs only eventful runs, and exits cleanly on abort',async()=>{
 const pool=fakePool(),stop=new AbortController(),logs=[];let runs=0;
 const steps=[['count',async()=>({processed:++runs%2})]];
 const done=runWorker(pool,cfg,{steps,signal:stop.signal,intervalMs:20,log:e=>logs.push(e)});
 await until(()=>runs>=4);stop.abort();await done;
 assert.equal(pool.calls.filter(c=>c==='lock').length,1,'the lock is taken once and kept');
 assert.deepEqual(pool.calls.slice(-2),['unlock','release']);
 const events=logs.map(e=>e.event);
 assert.equal(events[0],'worker_started');assert.equal(events.at(-1),'worker_stopped');
 assert.equal(events.filter(e=>e==='worker_run').length,Math.ceil(runs/2));
});
test('runWorker returns at once when already aborted, and an abort mid-run skips the remaining steps',async()=>{
 const pool=fakePool();
 await runWorker(pool,cfg,{signal:AbortSignal.abort(),log:()=>{}});assert.deepEqual(pool.calls,[]);
 const stop=new AbortController(),ran=[];
 const steps=[['first',async()=>{ran.push('first');stop.abort()}],['second',async()=>{ran.push('second')}]];
 const started=Date.now();await runWorker(fakePool(),cfg,{steps,signal:stop.signal,intervalMs:60000,log:()=>{}});
 assert.deepEqual(ran,['first']);assert.ok(Date.now()-started<2000,'no wait for the 60 s interval');
});
test('a worker that cannot get the lock logs once, runs nothing, and keeps waiting',async()=>{
 const pool=fakePool({locked:false}),stop=new AbortController(),logs=[];let ran=0;
 const done=runWorker(pool,cfg,{steps:[['x',async()=>{ran++}]],signal:stop.signal,intervalMs:10,log:e=>logs.push(e)});
 await until(()=>pool.calls.filter(c=>c==='lock').length>=3);stop.abort();await done;
 assert.equal(ran,0);assert.deepEqual(logs.map(e=>e.event),['worker_lock_busy','worker_stopped']);assert.ok(!pool.calls.includes('unlock'));
 // A database that is down is logged and retried, not fatal.
 const down={async connect(){throw Object.assign(new Error('connect ECONNREFUSED'),{code:'ECONNREFUSED'})}},seen=[],halt=new AbortController();
 const loop=runWorker(down,cfg,{steps:[],signal:halt.signal,intervalMs:10,log:e=>seen.push(e.event)});
 await until(()=>seen.filter(e=>e==='worker_lock_failed').length>=2);halt.abort();await loop;
});
test('PostgreSQL: one worker at a time holds the advisory lock; the second takes over when the first stops',{skip:!connection},async t=>{
 const db=await isolated(t),lockKey='kce-worker-test-'+randomBytes(6).toString('hex'),ran={a:0,b:0},logs={a:[],b:[]};
 const stopA=new AbortController(),stopB=new AbortController();
 const a=runWorker(db,cfg,{steps:[['s',async()=>{ran.a++}]],signal:stopA.signal,intervalMs:20,lockKey,log:e=>logs.a.push(e.event)});
 await until(()=>ran.a>=1);
 const b=runWorker(db,cfg,{steps:[['s',async()=>{ran.b++}]],signal:stopB.signal,intervalMs:20,lockKey,log:e=>logs.b.push(e.event)});
 await until(()=>logs.b.includes('worker_lock_busy'));await sleep(100);
 assert.equal(ran.b,0);assert.equal(logs.b.filter(e=>e==='worker_lock_busy').length,1);
 stopA.abort();await a;
 await until(()=>ran.b>=1);stopB.abort();await b;
 assert.deepEqual(logs.b.slice(0,2),['worker_lock_busy','worker_started']);
 const held=(await db.query("SELECT count(*)::int AS n FROM pg_locks WHERE locktype='advisory' AND objid::bigint=(hashtext($1)::bigint & 4294967295)",[lockKey])).rows[0].n;
 assert.equal(held,0,'the lock is released on exit');
});
test('PostgreSQL: when the lock connection dies the worker notices and takes the lock again',{skip:!connection},async t=>{
 const db=await isolated(t),lockKey='kce-worker-test-'+randomBytes(6).toString('hex'),logs=[],stop=new AbortController();let ran=0;
 const done=runWorker(db,cfg,{steps:[['s',async()=>{ran++}]],signal:stop.signal,intervalMs:20,lockKey,log:e=>logs.push(e.event)});
 await until(()=>ran>=1);
 const pid=(await db.query("SELECT pid FROM pg_locks WHERE locktype='advisory' AND granted AND objid::bigint=(hashtext($1)::bigint & 4294967295)",[lockKey])).rows[0].pid;
 await db.query('SELECT pg_terminate_backend($1)',[pid]);
 await until(()=>logs.filter(e=>e==='worker_started').length>=2);
 const before=ran;await until(()=>ran>before);stop.abort();await done;
 assert.ok(logs.includes('worker_lock_lost'));
});
test('PostgreSQL: the real steps run in one pass with payments disabled',{skip:!connection},async t=>{
 const db=await isolated(t),logs=[];
 const results=await runWorkerOnce(db,cfg,{log:e=>logs.push(e),mailer:{async send(){return {id:'x'}}}});
 assert.deepEqual(Object.keys(results),WORKER_STEPS.map(([name])=>name));
 assert.deepEqual(results.confirmPending,{skipped:'payments_disabled'});assert.deepEqual(results.reconcile,{skipped:'payments_disabled'});
 assert.deepEqual(logs.filter(e=>e.event==='worker_step_failed'&&['confirmPending','reconcile'].includes(e.step)),[]);
});
