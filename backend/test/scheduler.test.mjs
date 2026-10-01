import {test} from 'node:test';
import assert from 'node:assert/strict';
import {runScheduler,SCHEDULE} from '../src/scheduler.mjs';
const MINUTE=60000,HOUR=60*MINUTE;
// A fake clock: sleeping moves it forward, so a day of scheduling runs in milliseconds. `outcomes` are the results of
// successive runs; a successful run publishes the day just completed.
async function simulate({start,published,outcomes=[],until,overshootMs=0}){
 let clock=Date.parse(start),day=published;
 const runs=[],events=[],stop=new AbortController();
 const now=()=>new Date(clock);
 const completed=()=>new Date(clock-86400000).toISOString().slice(0,10);
 await runScheduler({now,signal:stop.signal,log:entry=>events.push(entry),
  sleep:async ms=>{clock+=ms+(ms>1000?0:overshootMs);if(clock>=Date.parse(until))stop.abort()},
  latestPublishedDay:async()=>day,
  runDaily:async()=>{
   const at=now().toISOString().slice(11,16),outcome=outcomes[runs.length]??'succeeded';runs.push(at);
   if(outcome==='throws')throw new Error('Another publication job is active');
   if(outcome==='succeeded')day=completed();
   return {status:outcome};
  }});
 return {runs,events};
}

test('the 00:00 UTC run is the only one on a normal day',async()=>{
 const {runs,events}=await simulate({start:'2026-10-01T15:00:00Z',published:'2026-09-30',until:'2026-10-03T12:00:00Z'});
 assert.deepEqual(runs,['00:00','00:00']);
 assert.equal(events[0].event,'scheduler_ready');assert.equal(events[0].catchUpAt,undefined);
 assert.ok(!events.some(e=>e.event==='scheduler_retry'));
});

test('an unsuccessful run is retried after 30 minutes, then at doubling intervals up to 2 hours, until one succeeds',async()=>{
 const {runs,events}=await simulate({start:'2026-10-01T15:00:00Z',published:'2026-09-30',outcomes:['incomplete','incomplete','throws','incomplete','incomplete','succeeded'],until:'2026-10-02T23:00:00Z'});
 assert.deepEqual(runs,['00:00','00:30','01:30','03:30','05:30','07:30']);
 assert.deepEqual([SCHEDULE.retryMs,SCHEDULE.maxRetryMs],[30*MINUTE,2*HOUR]);
 assert.equal(events.filter(e=>e.event==='scheduler_retry').length,5);
 assert.ok(events.some(e=>e.event==='scheduler_failure'&&/Another publication job/.test(e.message)),'a run that throws is logged and retried too');
});

test('retries give way to the next midnight run, which starts the intervals again',async()=>{
 const outcomes=Array(20).fill('incomplete');
 const {runs}=await simulate({start:'2026-10-01T15:00:00Z',published:'2026-09-30',outcomes,until:'2026-10-03T01:00:00Z'});
 assert.deepEqual(runs.slice(0,4),['00:00','00:30','01:30','03:30']);
 const next=runs.indexOf('00:00',1);
 assert.ok(next>0,'the next midnight still runs');
 assert.deepEqual(runs.slice(next,next+2),['00:00','00:30'],'and retries restart at 30 minutes');
 assert.ok(runs.slice(4,next).every(at=>at!=='00:00'&&at>='03:30'),'two-hour retries in between');
});

test('a scheduler started while the latest completed day is unpublished catches up 10 minutes later',async()=>{
 const {runs,events}=await simulate({start:'2026-10-01T20:03:00Z',published:'2026-09-29',until:'2026-10-02T12:00:00Z'});
 assert.deepEqual(runs,['20:13','00:00']);
 assert.equal(events[0].catchUpAt,'2026-10-01T20:13:00.000Z');
 assert.equal(SCHEDULE.startupDelayMs,10*MINUTE);
});

test('a restart just after midnight no longer loses that day: the catch-up runs it',async()=>{
 const {runs}=await simulate({start:'2026-10-01T00:05:00Z',published:'2026-09-29',until:'2026-10-01T23:00:00Z'});
 assert.deepEqual(runs,['00:15']);
});

test('a database still being filled (nothing published yet) is not caught up; the midnight run still happens',async()=>{
 const {runs,events}=await simulate({start:'2026-10-01T15:00:00Z',published:null,until:'2026-10-02T12:00:00Z'});
 assert.deepEqual(runs,['00:00']);
 assert.equal(events[0].catchUpAt,undefined);
});

test('a midnight noticed late still runs, flagged as missed, instead of waiting another day',async()=>{
 const {runs,events}=await simulate({start:'2026-10-01T23:59:59Z',published:'2026-09-30',overshootMs:5*MINUTE,until:'2026-10-02T03:00:00Z'});
 assert.equal(runs.length,1);
 assert.ok(runs[0]>='00:05','it ran when the scheduler woke');
 assert.ok(events.some(e=>e.event==='missed_midnight'&&e.scheduled==='2026-10-02T00:00:00.000Z'));
});

test('no retry once the day is published by another run (a manual catch-up, say)',async()=>{
 let clock=Date.parse('2026-10-01T23:00:00Z'),day='2026-09-30';const runs=[],stop=new AbortController();
 await runScheduler({now:()=>new Date(clock),signal:stop.signal,
  sleep:async ms=>{clock+=ms;if(clock>=Date.parse('2026-10-02T06:00:00Z'))stop.abort()},
  latestPublishedDay:async()=>day,
  runDaily:async()=>{runs.push(new Date(clock).toISOString().slice(11,16));day='2026-10-01';return {status:'incomplete'}}});
 assert.deepEqual(runs,['00:00']);
});

test('an unreadable database counts as behind, so the scheduler tries again later',async()=>{
 let clock=Date.parse('2026-10-01T15:00:00Z');const runs=[],events=[],stop=new AbortController();
 await runScheduler({now:()=>new Date(clock),signal:stop.signal,log:e=>events.push(e),
  sleep:async ms=>{clock+=ms;if(clock>=Date.parse('2026-10-01T16:00:00Z'))stop.abort()},
  latestPublishedDay:async()=>{throw new Error('connection refused')},
  runDaily:async()=>{runs.push(new Date(clock).toISOString().slice(11,16));return {status:'incomplete'}}});
 assert.deepEqual(runs,['15:10','15:40']);
 assert.ok(events.some(e=>e.event==='scheduler_check_failed'&&e.message==='connection refused'));
});

test('stopping the process ends the loop, even mid-sleep',async()=>{
 const stop=new AbortController();let runs=0;
 const done=runScheduler({signal:stop.signal,latestPublishedDay:async()=>null,runDaily:async()=>{runs++;return {status:'succeeded'}}});
 setTimeout(()=>stop.abort(),20);
 await done;
 assert.equal(runs,0);
});
