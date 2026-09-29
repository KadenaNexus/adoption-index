import {setTimeout as sleep} from 'node:timers/promises';
import {confirmPending,reconcile} from './billing.mjs';
import {processAlerts,processRenewalReminders,sendOutbox} from './notifications.mjs';
import {safeMessage} from './bsc.mjs';
const defaultLog=entry=>console.log(JSON.stringify(entry));
// RPC keys live in URL paths and queries: whatever a step logs, its message leaves with URLs cut to their host.
const scrubbed=log=>entry=>log(typeof entry?.message==='string'?{...entry,message:safeMessage(entry.message)}:entry);
/** One worker pass, in this order. Each step gets `now()` at its own start, since RPC-bound steps take a while. */
export const WORKER_STEPS=Object.freeze([
 ['confirmPending',(db,cfg,o)=>confirmPending(db,cfg,{now:o.now(),log:o.log,fetch:o.fetch,signal:o.signal})],
 ['reconcile',(db,cfg,o)=>reconcile(db,cfg,{now:o.now(),log:o.log,fetch:o.fetch,signal:o.signal})],
 ['processAlerts',(db,cfg,o)=>processAlerts(db,{now:o.now(),cfg})],
 ['processRenewalReminders',(db,cfg,o)=>processRenewalReminders(db,{now:o.now(),cfg})],
 ['sendOutbox',(db,cfg,o)=>sendOutbox(db,o.mailer,{now:o.now(),limit:20})],
]);
/** Runs every step once; a step that throws is logged and the next one still runs. */
export async function runWorkerOnce(db,cfg,{steps=WORKER_STEPS,log=defaultLog,signal,...options}={}){
 const results={},context={...options,log:scrubbed(log),signal,now:options.now??(()=>new Date())};
 for(const [name,step] of steps){
  if(signal?.aborted)break;
  try{results[name]=await step(db,cfg,context)??null}
  catch(error){results[name]={failed:true};log({event:'worker_step_failed',step:name,name:error?.name??'Error',code:typeof error?.code==='string'?error.code.slice(0,40):null,message:safeMessage(error?.message)})}
 }
 return results;
}
const QUIET=new Set(['finalized','from','next','chunks']);
export const eventful=results=>Object.values(results).some(r=>r&&typeof r==='object'&&Object.entries(r).some(([k,v])=>k==='failed'?v===true:!QUIET.has(k)&&typeof v==='number'&&v>0));
/**
 * The payment and notification loop (PM2 kce-worker). One instance works at a time: it holds a session advisory lock on
 * a dedicated connection, and a second instance waits for it. Returns once `signal` aborts, releasing the lock.
 */
export async function runWorker(db,cfg,{mailer,signal,intervalMs=cfg?.workerIntervalMs??60000,log=defaultLog,fetch,now,steps=WORKER_STEPS,lockKey='kce-worker'}={}){
 let client=null,onError=null,waiting=false;
 const drop=error=>{const c=client;client=null;if(!c)return;c.removeListener('error',onError);try{c.release(error)}catch{}};
 try{
  while(!signal?.aborted){
   // A session lock lasts as long as its connection; if the connection is gone, so is the lock.
   if(client)try{await client.query('SELECT 1')}catch(error){log({event:'worker_lock_lost',name:error.name,message:safeMessage(error.message)});drop(error)}
   if(!client){
    let c=null;
    try{
     c=await db.connect();
     const handler=error=>log({event:'worker_connection_error',name:error.name,message:safeMessage(error.message)});c.on('error',handler);
     if((await c.query('SELECT pg_try_advisory_lock(hashtext($1)) AS locked',[lockKey])).rows[0]?.locked===true){client=c;onError=handler;waiting=false;log({event:'worker_started',intervalMs})}
     else{c.removeListener('error',handler);c.release();if(!waiting)log({event:'worker_lock_busy',lock:lockKey});waiting=true}
    }catch(error){log({event:'worker_lock_failed',name:error.name,message:safeMessage(error.message)});if(c&&c!==client)try{c.release(error)}catch{}}
   }
   if(client&&!signal?.aborted){
    const started=Date.now(),results=await runWorkerOnce(db,cfg,{steps,log,signal,mailer,fetch,now});
    if(eventful(results))log({event:'worker_run',ms:Date.now()-started,results});
   }
   try{await sleep(intervalMs,undefined,{signal})}catch{break}
  }
 }finally{
  if(client){let error;try{await client.query('SELECT pg_advisory_unlock(hashtext($1))',[lockKey])}catch(e){error=e}drop(error)}
  log({event:'worker_stopped'});
 }
}
