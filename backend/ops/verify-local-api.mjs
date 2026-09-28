import assert from 'node:assert/strict';
import {createHash,randomBytes} from 'node:crypto';
import {writeFile} from 'node:fs/promises';
import {database} from '../src/db.mjs';
import {COLLECTION_START} from '../src/window.mjs';

const db=database(),origin='http://127.0.0.1:3001',responses={};let keyId;
try{
 const latest=(await db.query('SELECT payload FROM index_snapshots ORDER BY day DESC LIMIT 1')).rows[0]?.payload;
 assert.ok(latest,'A published dataset is required');
 async function get(path,expected,key){
  const response=await fetch(origin+path,{headers:key?{'X-API-Key':key}:{},signal:AbortSignal.timeout(15000)}),body=await response.json();
  assert.equal(response.status,expected,path);responses[path+(key?' (authorized)':'')]={status:response.status,body};return body;
 }
 const health=await get('/health',200);assert.equal(health.index,'current');assert.equal(health.throughDay,latest.day);
 const today=await get('/index/today',200);assert.equal(today.score,Math.round(latest.score));assert.equal(today.date,latest.day);assert.equal(today.collectionStart,COLLECTION_START);assert.equal(today.summaryRetention,'permanent');assert.equal(today.state,'current');
 await get('/index/history?range=all',401);await get('/metrics/breakdown',401);
 const key=randomBytes(32).toString('base64url'),keyHash=createHash('sha256').update(key).digest('hex');
 keyId=(await db.query('INSERT INTO api_keys(label,key_hash) VALUES($1,$2) RETURNING id',['local-review-verification',keyHash])).rows[0].id;
 for(const [range,count] of [['30d',30],['90d',90],['all',today.historyDays]]){
  const history=await get('/index/history?range='+range,200,key);assert.equal(history.series.length,count);assert.equal(history.series.at(-1).score,latest.score);assert.equal(history.scorePrecision,'one-decimal');assert.equal(history.availableRanges['1y'],false);
 }
 const year=await get('/index/history?range=1y',400,key);assert.equal(year.error,'range_not_available');
 const breakdown=await get('/metrics/breakdown',200,key);assert.equal(breakdown.metrics.length,5);
 for(const metric of breakdown.metrics){const {id,weekOverWeek,...component}=metric;assert.deepEqual(component,latest.components[id]);}
 await get('/index/history?range=invalid',400,key);await get('/missing-review-route',404);
 await db.query('UPDATE api_keys SET revoked_at=now() WHERE id=$1',[keyId]);keyId=null;
 await writeFile('../output/KCE-Pipeline-Review/api-verification.json',JSON.stringify({checkedAt:new Date().toISOString(),passed:true,throughDay:latest.day,publicScore:today.score,storedComposite:latest.score,temporaryKeyRevokedOnExit:true,responses},null,2)+'\n');
 console.log(JSON.stringify({passed:true,throughDay:latest.day,publicScore:today.score,storedComposite:latest.score,checks:Object.keys(responses).length}));
}finally{
 try{if(keyId)await db.query('UPDATE api_keys SET revoked_at=now() WHERE id=$1',[keyId])}finally{await db.end()}
}
