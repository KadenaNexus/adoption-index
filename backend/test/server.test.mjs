import{test}from'node:test';import assert from'node:assert/strict';import{clientAddress,historyRange,createServer,isEntryPoint}from'../src/server.mjs';import{ipGroup}from'../src/http.mjs';
test('only an explicitly trusted local proxy may supply the last appended real IP',()=>{const request=(ip,header)=>({socket:{remoteAddress:ip},headers:{'x-forwarded-for':header}});assert.equal(clientAddress(request('127.0.0.1','9.9.9.9, 1.2.3.4'),true),'1.2.3.4');assert.equal(clientAddress(request('127.0.0.1','9.9.9.9, 1.2.3.4'),false),'127.0.0.1');assert.equal(clientAddress(request('5.6.7.8','9.9.9.9'),true),'5.6.7.8');assert.equal(clientAddress(request('127.0.0.1','bad'),true),'127.0.0.1')});
test('rate-limit keys: IPv4 as is, IPv4-mapped IPv6 as IPv4, other IPv6 by its /64',()=>{
 for(const [ip,key] of [['203.0.113.7','203.0.113.7'],['2001:db8:1:2::1','2001:db8:1:2::/64'],['2001:DB8:1:2:ffff:ffff:ffff:ffff','2001:db8:1:2::/64'],['2001:db8::1','2001:db8:0:0::/64'],
  ['2001:0db8:0001:0002:0003:0004:0005:0006','2001:db8:1:2::/64'],['::1','0:0:0:0::/64'],['fe80::1%eth0','fe80:0:0:0::/64'],['::ffff:203.0.113.7','203.0.113.7'],['::ffff:cb00:7107','203.0.113.7'],
  ['0:0:0:0:0:ffff:203.0.113.7','203.0.113.7'],['64:ff9b::203.0.113.7','64:ff9b:0:0::/64']])assert.equal(ipGroup(ip),key,ip);
 for(const bad of ['bad','',undefined,null,42,'1.2.3.4.5','2001:db8::1::2'])assert.equal(ipGroup(bad),null,String(bad));
 const request=(ip,header)=>({socket:{remoteAddress:ip},headers:{'x-forwarded-for':header}});
 assert.equal(clientAddress(request('2001:db8:1:2:3:4:5:6')),'2001:db8:1:2::/64');assert.equal(clientAddress(request('::ffff:198.51.100.4')),'198.51.100.4');
 assert.equal(clientAddress(request('::1','9.9.9.9, 2001:db8:5:6::9'),true),'2001:db8:5:6::/64');assert.equal(clientAddress(request('::1','bad'),true),'0:0:0:0::/64');
 assert.equal(clientAddress({socket:{},headers:{}}),'unknown');
});

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
test('the API starts both from node and under PM2, but not when imported',()=>{
 const url='file:///srv/kce/backend/src/server.mjs',script='/srv/kce/backend/src/server.mjs';
 assert.equal(isEntryPoint(url,{argv:['node',script],env:{}}),true,'node src/server.mjs');
 assert.equal(isEntryPoint(url,{argv:['node','/pm2/lib/ProcessContainerFork.js'],env:{pm_exec_path:script}}),true,'PM2 fork mode');
 assert.equal(isEntryPoint(url,{argv:['node','/srv/kce/backend/test/server.test.mjs'],env:{}}),false,'imported by a test');
 assert.equal(isEntryPoint(url,{argv:['node','/pm2/lib/ProcessContainerFork.js'],env:{pm_exec_path:'/srv/kce/backend/src/cli.mjs'}}),false,'imported by another PM2 app');
});
