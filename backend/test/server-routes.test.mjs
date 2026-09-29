import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createServer,PUBLIC_ROUTES} from '../src/server.mjs';
import {accountsConfig} from '../src/config.mjs';
import {hashToken} from '../src/auth.mjs';
import {routes as accountRoutes} from '../src/accounts-http.mjs';
import {routes as billingRoutes} from '../src/billing-http.mjs';
const siteKey='s'.repeat(40),userToken='u'.repeat(43),adminToken='a'.repeat(43);
const cfg=accountsConfig({SITE_API_KEY:siteKey,ADMIN_EMAILS:'admin@example.com',PUBLIC_SITE_URL:'http://127.0.0.1:5173'});
// Sessions only: any other query means a handler ran, which these checks must prevent.
const pool={async query(sql,params){
 if(sql.includes('FROM sessions s JOIN users u')){const email={[hashToken(userToken)]:'user@example.com',[hashToken(adminToken)]:'admin@example.com'}[params[0]];return {rows:email?[{user_id:email.startsWith('admin')?2:1,last_seen_at:new Date(),email}]:[]}}
 if(sql.includes('FROM subscriptions WHERE user_id'))return {rows:[]};
 throw new Error('handler reached the database');
}};
async function withServer(fn){const server=createServer(pool,{cfg,mailer:{send:async()=>({id:'x'})}});await new Promise(r=>server.listen(0,'127.0.0.1',r));try{return await fn(`http://127.0.0.1:${server.address().port}`)}finally{await new Promise(r=>server.close(r))}}
const call=(base,route,headers={})=>{const [method,path]=route.split(' ');return fetch(base+path,{method,headers:{'X-KCE-Site-Key':siteKey,...(method==='POST'?{'Content-Type':'application/json'}:{}),...headers},body:method==='POST'?'{}':undefined})};
test('every account route needs a session unless listed as public, and /admin/ routes answer 404 to non-admins',async()=>{
 const all=Object.keys({...accountRoutes,...billingRoutes});
 await withServer(async base=>{
  for(const route of all.filter(r=>!PUBLIC_ROUTES.has(r))){const response=await call(base,route);assert.equal(response.status,401,route);assert.equal((await response.json()).error,'session_required',route)}
  for(const route of all.filter(r=>r.split(' ')[1].startsWith('/admin/'))){const response=await call(base,route,{'X-KCE-Session':userToken});assert.equal(response.status,404,route)}
  const noKey=await fetch(base+'/account');assert.ok([401,404].includes(noKey.status));
 });
});
test('account routes refuse requests without the site key, and a body-less POST is accepted',async()=>{
 await withServer(async base=>{
  const routes={...accountRoutes,...billingRoutes};
  for(const route of Object.keys(routes)){const [method,path]=route.split(' ');const response=await fetch(base+path,{method,headers:method==='POST'?{'Content-Type':'application/json'}:{},body:method==='POST'?'{}':undefined});assert.equal(response.status,401,route);assert.equal((await response.json()).error,'site_key_required',route)}
  const empty=await fetch(base+'/does-not-exist',{method:'POST',headers:{'X-KCE-Site-Key':siteKey}});assert.equal(empty.status,405);
 });
});
