import{test}from'node:test';import assert from'node:assert/strict';import{clientAddress,historyRange,createServer}from'../src/server.mjs';
test('only an explicitly trusted local proxy may supply the last appended real IP',()=>{const request=(ip,header)=>({socket:{remoteAddress:ip},headers:{'x-forwarded-for':header}});assert.equal(clientAddress(request('127.0.0.1','9.9.9.9, 1.2.3.4'),true),'1.2.3.4');assert.equal(clientAddress(request('127.0.0.1','9.9.9.9, 1.2.3.4'),false),'127.0.0.1');assert.equal(clientAddress(request('5.6.7.8','9.9.9.9'),true),'5.6.7.8');assert.equal(clientAddress(request('127.0.0.1','bad'),true),'127.0.0.1')});

import {windowFor,completedDay} from '../src/window.mjs';
import {METHOD_VERSION} from '../src/scoring.mjs';
test('history range cannot expose dates outside the fixed collection start',()=>{
 // Pinned to the initial 90-day history so the assertions do not depend on today's date.
 const window=windowFor('2026-09-26',{now:new Date('2026-09-27T12:00:00Z')});
 for(const range of ['90d','all'])assert.equal(historyRange(range,window.throughDay,window).fromDay,window.fromDay);
 assert.equal(historyRange('forever',window.throughDay,window),null);
 assert.equal(historyRange('1y',window.throughDay,window).unavailable,true);
 const growing={...window,throughDay:'2027-01-01'};assert.equal(historyRange('all',growing.throughDay,growing).fromDay,window.fromDay);assert.equal(historyRange('90d',growing.throughDay,growing).fromDay,'2026-10-04');
});
test('API excludes obsolete methods and old baselines before reading any score',async()=>{
 const calls=[],pool={query:async(sql,params)=>{calls.push({sql,params});return{rows:[]}}};
 const server=createServer(pool);await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
 try{
  const response=await fetch(`http://127.0.0.1:${server.address().port}/index/today`),body=await response.json();
  assert.equal(response.status,503);assert.equal(body.initialHistoryDays,90);assert.equal(body.error,'index_not_ready');
  const call=calls.find(call=>call.sql.includes('FROM index_snapshots'));
  assert.ok(call.sql.includes("payload->>'baselineDay'=$1::text"));
  assert.deepEqual(call.params,[windowFor().fromDay,completedDay(),METHOD_VERSION]);
 }finally{await new Promise(resolve=>server.close(resolve))}
});
