import {test} from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import {randomBytes,createHash,randomInt} from 'node:crypto';
import {secp256k1} from '@noble/curves/secp256k1.js';
import {keccak_256} from '@noble/hashes/sha3.js';
import {database} from '../src/db.mjs';
import {migrate} from '../src/migrate.mjs';
import {accountsConfig} from '../src/config.mjs';
import {hashToken} from '../src/auth.mjs';
import {createServer} from '../src/server.mjs';
import {personalHash,addressTopic,toChecksum,TRANSFER_TOPIC} from '../src/evm.mjs';
import {confirmPending,reconcile} from '../src/billing.mjs';
import {paymentView} from '../src/accounts.mjs';
// End-to-end checkout and reconciler tests: the real server and database, and a simulated BNB Smart Chain served by
// three local JSON-RPC providers whose behaviour each test can switch (down, answering null, lagging, reorged).
const connection=process.env.TEST_DATABASE_URL,skip=!connection;
async function isolated(t){
 const url=new URL(connection);if(!url.pathname.endsWith('_test'))throw new Error('Integration tests require a dedicated *_test database');
 const schema='billing_'+randomBytes(8).toString('hex'),admin=database(connection);
 await admin.query(`CREATE SCHEMA ${schema}`);url.searchParams.set('options',`-c search_path=${schema}`);const db=database(url.href);
 t.after(async()=>{await db.end();try{await admin.query(`DROP SCHEMA ${schema} CASCADE`)}finally{await admin.end()}});
 await migrate(db);return db;
}
const SITE='k'.repeat(40),SECRET='RPCKEYs3cr3tPath',E18=10n**18n,DAY=86400000,MIN=60000;
const PAY='0x4274907CE85E100a5EbAe1f7286DeB5083a52e98',USDT='0x55d398326f99059ff775485246999027b3197955',USDC='0x8ac76a51cc950d9822d68b83fe1ad97b32cd580d',FAKE='0x'+'fa'.repeat(20);
const T0=new Date('2026-10-01T12:00:00Z'),BASE_TS=Math.floor(T0.getTime()/1000)-200;
const hex=n=>'0x'+BigInt(n).toString(16),word=n=>'0x'+BigInt(n).toString(16).padStart(64,'0'),digest=text=>'0x'+createHash('sha256').update(text).digest('hex');
const later=ms=>new Date(T0.getTime()+ms);

async function simulatedChain(t){
 const state={finalized:100,receipts:new Map(),blocks:new Map(),logs:[]},nodes=[];
 const blockHash=n=>state.blocks.get(n)??digest(`block:${n}`);
 for(let i=0;i<3;i++){
  // mode: ok | down (HTTP 503) | null (has not seen any receipt) | hang (never answers); receipt/block: per-provider overrides.
  const node={mode:'ok',receipt:null,block:null},sockets=new Set();
  const server=http.createServer(async(request,response)=>{
   let text='';for await(const chunk of request)text+=chunk;
   const {id,method,params}=JSON.parse(text),send=result=>{response.writeHead(200,{'Content-Type':'application/json'});response.end(JSON.stringify({jsonrpc:'2.0',id,result}))};
   if(node.mode==='hang')return;
   if(node.mode==='down'){response.writeHead(503);return response.end('unavailable')}
   if(method==='eth_getTransactionReceipt')return send(node.mode==='null'?null:node.receipt?.(params[0])??state.receipts.get(params[0])??null);
   if(method==='eth_getBlockByNumber'){const n=params[0]==='finalized'?state.finalized:Number(params[0]);return send({number:hex(n),hash:node.block?.(n)??blockHash(n),timestamp:hex(BASE_TS+n)})}
   if(method==='eth_getLogs'){const f=params[0],from=Number(f.fromBlock),to=Number(f.toBlock),tokens=[f.address].flat();return send(state.logs.filter(l=>Number(l.blockNumber)>=from&&Number(l.blockNumber)<=to&&tokens.includes(l.address)&&l.topics[2]===f.topics[2]))}
   send(null);
  });
  server.on('connection',s=>{sockets.add(s);s.on('close',()=>sockets.delete(s))});
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  t.after(()=>{for(const s of sockets)s.destroy();return new Promise(resolve=>server.close(resolve))});
  node.url=`http://127.0.0.1:${server.address().port}/v1/${SECRET}`;nodes.push(node);
 }
 let count=0;
 /** Mines (or re-mines) a transaction whose transfers all go to payTo unless `to` says otherwise. */
 function tx({hash=digest(`tx:${++count}:${randomBytes(4).toString('hex')}`),block=101,from,token=USDT,value=9n*E18,to=PAY,status=1,transfers=[{token,from,to,value}]}={}){
  state.logs=state.logs.filter(l=>l.transactionHash!==hash);
  const logs=transfers.map((x,i)=>({address:(x.token??token).toLowerCase(),topics:[TRANSFER_TOPIC,addressTopic(x.from),addressTopic(x.to??PAY)],data:word(x.value??value),logIndex:hex(i),transactionHash:hash,blockNumber:hex(block),blockHash:blockHash(block),removed:false}));
  state.receipts.set(hash,{transactionHash:hash,status:hex(status),blockNumber:hex(block),blockHash:blockHash(block),from:transfers[0].from,to:transfers[0].token??token,logs:status?logs:[]});
  if(status)state.logs.push(...logs);
  return hash;
 }
 const drop=hash=>{state.receipts.delete(hash);state.logs=state.logs.filter(l=>l.transactionHash!==hash)};
 return {state,nodes,tx,drop,blockHash,urls:nodes.map(n=>n.url),mode:(...modes)=>modes.forEach((m,i)=>{nodes[i].mode=m})};
}
function wallet(seed){
 const key=createHash('sha256').update('wallet:'+seed).digest(),address='0x'+Buffer.from(keccak_256(secp256k1.getPublicKey(key,false).subarray(1)).slice(-20)).toString('hex');
 return {key,address,checksum:toChecksum(address)};
}
// What a wallet returns for personal_sign: r‖s‖v with v = 27 or 28.
function sign(message,key){const sig=secp256k1.sign(personalHash(message),key,{prehash:false,format:'recovered'});return '0x'+Buffer.from(sig.subarray(1)).toString('hex')+(sig[0]+27).toString(16)}

async function app(t,env={}){
 const db=await isolated(t),chain=await simulatedChain(t),clock={now:new Date(T0)};
 const cfg=accountsConfig({SITE_API_KEY:SITE,ADMIN_EMAILS:'admin@example.com',PUBLIC_SITE_URL:'http://127.0.0.1:5173',PAYMENT_NETWORK:'bsc',PAYMENT_ADDRESS:PAY,
  BSC_RPC_URLS:chain.urls.join(','),BSC_LOG_RPC_URLS:chain.urls[0],PAYMENT_TEST_PLAN:'1',...env});
 const server=createServer(db,{cfg,mailer:{send:async()=>({id:'test'})},now:()=>clock.now});
 await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
 t.after(()=>{server.closeAllConnections();return new Promise(resolve=>server.close(resolve))});
 const base=`http://127.0.0.1:${server.address().port}`;
 // Request-path RPC errors go to console.error; capture them (once per test) to prove no URL key is ever logged.
 if(!t.kceErrors){t.kceErrors=[];t.mock.method(console,'error',(...args)=>t.kceErrors.push(args.join(' ')))}
 const errors=t.kceErrors;
 // Random ids keep the per-user poll limit of one test away from the next.
 async function user(email){
  const id=randomInt(1e6,2**31-1),token=randomBytes(32).toString('base64url');
  await db.query('INSERT INTO users(id,email) VALUES($1,$2)',[id,email]);
  await db.query('INSERT INTO sessions(token_hash,user_id,expires_at) VALUES($1,$2,$3)',[hashToken(token),id,later(90*DAY)]);
  return {id,email,token,isAdmin:cfg.adminEmails.has(email)};
 }
 async function api(path,{token,body}={}){
  const response=await fetch(base+path,{method:body===undefined?'GET':'POST',headers:{'X-KCE-Site-Key':SITE,'X-KCE-Client-IP':'203.0.113.9',...(token?{'X-KCE-Session':token}:{}),...(body===undefined?{}:{'Content-Type':'application/json'})},body:body===undefined?undefined:JSON.stringify(body)});
  return {status:response.status,data:await response.json()};
 }
 async function link(u,w,key=w.key){
  const challenge=await api('/wallets/challenge',{token:u.token,body:{address:w.checksum}});assert.equal(challenge.status,200,JSON.stringify(challenge.data));
  return api('/wallets/link',{token:u.token,body:{nonce:challenge.data.nonce,signature:sign(challenge.data.message,key)}});
 }
 const pay=(u,body)=>api('/billing/payments',{token:u.token,body});
 const intent=async(u,plan,token='USDT')=>(await api('/billing/intents',{token:u.token,body:{plan,token}})).data;
 const row=async hash=>(await db.query('SELECT * FROM payments WHERE tx_hash=$1',[hash])).rows[0];
 const expires=async u=>{const r=(await db.query('SELECT expires_at FROM subscriptions WHERE user_id=$1',[u.id])).rows[0];return r?new Date(r.expires_at).getTime():null};
 const emails=async()=>(await db.query('SELECT kind,to_email,dedupe_key FROM email_outbox ORDER BY id')).rows;
 return {db,chain,cfg,clock,api,user,link,pay,intent,row,expires,emails,errors};
}
const noSecrets=a=>assert.ok(!a.errors.some(line=>line.includes(SECRET)),'an RPC URL key reached a log line');

test('wallet linking: challenge, signature, idempotent relink, another account, bad signatures and expiry',{skip},async t=>{
 const a=await app(t),alice=await a.user('alice@example.com'),bob=await a.user('bob@example.com'),w=wallet('alice'),other=wallet('other');
 const challenge=await a.api('/wallets/challenge',{token:alice.token,body:{address:w.checksum}});
 assert.equal(challenge.status,200);assert.match(challenge.data.nonce,/^[0-9a-f]{32}$/);assert.equal(challenge.data.expiresAt,later(10*MIN).toISOString());
 for(const part of ['127.0.0.1:5173','Link this wallet to alice@example.com for Kadena Community Edition Adoption Index payments. Signing is free and does not send a transaction.',`Address: ${w.checksum}`,'Chain ID: 56',`Nonce: ${challenge.data.nonce}`,`Issued At: ${T0.toISOString()}`])assert.ok(challenge.data.message.includes(part),part);
 const signature=sign(challenge.data.message,w.key);
 // Wrong key, tampered and malformed signatures are refused and leave the nonce usable.
 for(const bad of [sign(challenge.data.message,other.key),signature.slice(0,10)+(signature[10]==='0'?'1':'0')+signature.slice(11),signature.slice(0,-2),'0x1234',42])
  assert.deepEqual(await a.api('/wallets/link',{token:alice.token,body:{nonce:challenge.data.nonce,signature:bad}}),{status:400,data:{error:'invalid_signature'}});
 // Someone else's nonce is not yours to use.
 assert.deepEqual(await a.api('/wallets/link',{token:bob.token,body:{nonce:challenge.data.nonce,signature}}),{status:400,data:{error:'challenge_expired'}});
 const linked=await a.api('/wallets/link',{token:alice.token,body:{nonce:challenge.data.nonce,signature}});
 assert.equal(linked.status,200);assert.deepEqual(linked.data,{address:w.checksum,linkedAt:T0.toISOString(),alreadyLinked:false});
 // A repeated request (double click) and a fresh challenge for the same wallet are both idempotent.
 assert.equal((await a.api('/wallets/link',{token:alice.token,body:{nonce:challenge.data.nonce,signature}})).data.alreadyLinked,true);
 assert.deepEqual((await a.link(alice,w)).data,{address:w.checksum,linkedAt:T0.toISOString(),alreadyLinked:true});
 // The same wallet cannot join a second account.
 assert.deepEqual(await a.link(bob,w),{status:409,data:{error:'wallet_linked_elsewhere'}});
 assert.deepEqual((await a.db.query('SELECT address,user_id::int FROM wallets')).rows,[{address:w.address,user_id:alice.id}]);
 // Ten minutes to sign.
 const late=await a.api('/wallets/challenge',{token:bob.token,body:{address:other.checksum}});a.clock.now=later(10*MIN+1);
 assert.deepEqual(await a.api('/wallets/link',{token:bob.token,body:{nonce:late.data.nonce,signature:sign(late.data.message,other.key)}}),{status:400,data:{error:'challenge_expired'}});
 for(const nonce of ['x',undefined,'f'.repeat(32)])assert.deepEqual(await a.api('/wallets/link',{token:bob.token,body:{nonce,signature}}),{status:400,data:{error:'challenge_expired'}});
 for(const address of [undefined,'0x1234',w.checksum.replace(/[a-f]/,c=>c.toUpperCase()),42])assert.deepEqual(await a.api('/wallets/challenge',{token:bob.token,body:{address}}),{status:400,data:{error:'invalid_address'}});
 assert.equal((await a.api('/wallets/challenge',{token:bob.token,body:{address:other.address}})).status,200,'all-lowercase addresses carry no checksum and are accepted');
 assert.equal((await a.api('/wallets/challenge',{body:{address:w.checksum}})).status,401);
});
test('a non-ASCII email signs and links (UTF-8 byte length in the EIP-191 prefix)',{skip},async t=>{
 const a=await app(t),u=await a.user('jürgen@exämple.de'),w=wallet('jurgen');
 const r=await a.link(u,w);assert.equal(r.status,200,JSON.stringify(r.data));
 assert.ok((await a.db.query('SELECT message FROM wallets')).rows[0].message.includes('jürgen@exämple.de'));
});
test('intents: plan prices in token base units, the admin-only test plan, invalid plans and tokens',{skip},async t=>{
 const a=await app(t),alice=await a.user('alice@example.com'),admin=await a.user('admin@example.com');
 const monthly=await a.api('/billing/intents',{token:alice.token,body:{plan:'monthly',token:'USDT'}});
 assert.equal(monthly.status,200);
 assert.deepEqual({...monthly.data,intentId:0},{intentId:0,plan:'monthly',payTo:PAY,tokenAddress:'0x55d398326f99059fF775485246999027B3197955',token:'USDT',decimals:18,amount:(9n*E18).toString(),amountDisplay:'9',chainId:56,expiresAt:later(DAY).toISOString()});
 const annual=await a.api('/billing/intents',{token:alice.token,body:{plan:'annual',token:USDC}});
 assert.equal(annual.data.token,'USDC');assert.equal(annual.data.amount,(79n*E18).toString());assert.equal(annual.data.amountDisplay,'79');
 assert.deepEqual(await a.api('/billing/intents',{token:alice.token,body:{plan:'test',token:'USDT'}}),{status:400,data:{error:'invalid_plan'}});
 const test1=await a.api('/billing/intents',{token:admin.token,body:{plan:'test',token:'usdt'}});assert.equal(test1.status,200);assert.equal(test1.data.amount,E18.toString());
 for(const plan of ['weekly',undefined,'toString',7])assert.deepEqual(await a.api('/billing/intents',{token:alice.token,body:{plan,token:'USDT'}}),{status:400,data:{error:'invalid_plan'}});
 for(const token of ['DAI',FAKE,undefined,''])assert.deepEqual(await a.api('/billing/intents',{token:alice.token,body:{plan:'monthly',token}}),{status:400,data:{error:'invalid_token'}});
 const row=(await a.db.query('SELECT rail,network,chain,token_address,decimals,amount::text,pay_to,payment_id FROM payment_intents WHERE id=$1',[monthly.data.intentId])).rows[0];
 assert.deepEqual(row,{rail:'evm',network:'bsc',chain:'56',token_address:USDT,decimals:18,amount:(9n*E18).toString(),pay_to:PAY.toLowerCase(),payment_id:null});
});
test('payment polls are limited to 60 a minute per user, counted before the hash is read',{skip},async t=>{
 const a=await app(t),alice=await a.user('alice@example.com'),bob=await a.user('bob@example.com');
 for(let i=0;i<60;i++)assert.deepEqual(await a.pay(alice,{txHash:'0x1'}),{status:400,data:{error:'invalid_tx_hash'}},String(i));
 assert.deepEqual(await a.pay(alice,{txHash:'0x1'}),{status:429,data:{error:'rate_limit'}});
 assert.deepEqual(await a.pay(bob,{txHash:'0x1'}),{status:400,data:{error:'invalid_tx_hash'}},'another user is not affected');
});
test('wallet challenges and payment intents are limited to 30 an hour per user',{skip},async t=>{
 const a=await app(t),alice=await a.user('alice@example.com'),bob=await a.user('bob@example.com'),w=wallet('alice');
 const challenge=u=>a.api('/wallets/challenge',{token:u.token,body:{address:w.checksum}}),quote=u=>a.api('/billing/intents',{token:u.token,body:{plan:'monthly',token:'USDT'}});
 for(let i=0;i<30;i++)assert.equal((await challenge(alice)).status,200,String(i));
 assert.deepEqual(await challenge(alice),{status:429,data:{error:'rate_limit'}});
 for(let i=0;i<30;i++)assert.equal((await quote(alice)).status,200,String(i));
 assert.deepEqual(await quote(alice),{status:429,data:{error:'rate_limit'}});
 assert.equal((await challenge(bob)).status,200);assert.equal((await quote(bob)).status,200);
 a.clock.now=later(60*MIN+1);
 assert.equal((await challenge(alice)).status,200);assert.equal((await quote(alice)).status,200);
});
test('without PAYMENT_TEST_PLAN the test plan is refused even for admins; with payments off every route says so',{skip},async t=>{
 const a=await app(t,{PAYMENT_TEST_PLAN:''}),admin=await a.user('admin@example.com');
 assert.deepEqual(await a.api('/billing/intents',{token:admin.token,body:{plan:'test',token:'USDT'}}),{status:400,data:{error:'invalid_plan'}});
 const off=await app(t,{PAYMENT_NETWORK:''}),u=await off.user('u@example.com');
 assert.deepEqual((await off.api('/billing/config')).data,{enabled:false,testnet:false,signinOpen:true,supportEmail:null,walletConnectProjectId:null},'no SUPPORT_EMAIL, so no contact, and never the admin address');
 for(const [path,body] of [['/wallets/challenge',{address:PAY}],['/wallets/link',{nonce:'a'.repeat(32),signature:'0x'}],['/billing/intents',{plan:'monthly',token:'USDT'}],['/billing/payments',{txHash:'0x'+'1'.repeat(64)}]])
  assert.deepEqual(await off.api(path,{token:u.token,body}),{status:503,data:{error:'payments_disabled'}},path);
});
test('a payment is pending until its block is finalized, then confirmed once, with the intent claimed and one receipt email',{skip},async t=>{
 const a=await app(t),alice=await a.user('alice@example.com'),w=wallet('alice');await a.link(alice,w);
 const quote=await a.intent(alice,'monthly'),hash=a.chain.tx({block:101,from:w.address});
 let r=await a.pay(alice,{txHash:hash.replace('0x','0X').toUpperCase().replace('0X','0x'),intentId:quote.intentId});
 assert.equal(r.status,200,JSON.stringify(r.data));assert.equal(r.data.status,'pending');assert.equal(r.data.subscription,null);
 assert.equal(r.data.payment.txHash,hash);assert.equal(r.data.payment.plan,'monthly');assert.equal(r.data.payment.amount,'9');assert.equal(r.data.payment.from,w.checksum);
 assert.equal(r.data.payment.explorerUrl,`https://bscscan.com/tx/${hash}`);assert.equal(r.data.payment.source,'checkout');
 // The same view of the payment as GET /account.
 assert.deepEqual(r.data.payment,paymentView(await a.row(hash)));
 const id=r.data.payment.id;
 assert.equal(Number((await a.db.query('SELECT payment_id FROM payment_intents WHERE id=$1',[quote.intentId])).rows[0].payment_id),id);
 assert.equal((await a.pay(alice,{txHash:hash})).data.status,'pending');
 a.chain.state.finalized=101;a.clock.now=later(MIN);
 r=await a.pay(alice,{txHash:hash,intentId:quote.intentId});
 assert.equal(r.data.status,'confirmed');assert.equal(r.data.subscription.active,true);assert.equal(r.data.subscription.plan,'monthly');
 assert.equal(r.data.subscription.expiresAt,later(MIN+30*DAY).toISOString());assert.equal(r.data.payment.periodEnd,later(MIN+30*DAY).toISOString());assert.equal(Number((await a.row(hash)).block_number),101);
 a.clock.now=later(2*MIN);
 r=await a.pay(alice,{txHash:hash});assert.equal(r.data.status,'confirmed');assert.equal(r.data.subscription.expiresAt,later(MIN+30*DAY).toISOString());
 assert.deepEqual(await a.emails(),[{kind:'payment_confirmed',to_email:'alice@example.com',dedupe_key:`payment:${id}`}]);
 assert.equal((await a.db.query('SELECT count(*)::int n FROM payments')).rows[0].n,1);
 noSecrets(a);
});
test('underpaid gives no access and sends the notice; overpaid confirms and shows it; 79 or more infers annual',{skip},async t=>{
 const a=await app(t),alice=await a.user('alice@example.com'),w=wallet('alice');await a.link(alice,w);a.chain.state.finalized=200;
 // 5 USDT against a 9 USDT intent: the intent does not cover it, so the amount decides (monthly, underpaid).
 const quote=await a.intent(alice,'monthly'),short=a.chain.tx({from:w.address,value:5n*E18});
 let r=await a.pay(alice,{txHash:short,intentId:quote.intentId});
 assert.equal(r.data.status,'underpaid');assert.equal(r.data.payment.amount,'5');assert.equal(r.data.payment.required,'9');assert.equal(r.data.subscription,null);
 assert.equal((await a.db.query('SELECT payment_id FROM payment_intents WHERE id=$1',[quote.intentId])).rows[0].payment_id,null);
 assert.deepEqual((await a.emails()).map(e=>e.kind),['payment_underpaid']);
 const over=a.chain.tx({from:w.address,value:10n*E18});
 r=await a.pay(alice,{txHash:over,intentId:quote.intentId});
 assert.equal(r.data.status,'confirmed');assert.equal(r.data.payment.overpaid,true);assert.equal(r.data.payment.amount,'10');assert.equal(r.data.payment.plan,'monthly');
 assert.equal(await a.expires(alice),later(30*DAY).getTime());
 // No intent and no plan: 79 buys annual, extending the active period.
 r=await a.pay(alice,{txHash:a.chain.tx({from:w.address,value:79n*E18})});
 assert.equal(r.data.payment.plan,'annual');assert.equal(await a.expires(alice),later((30+365)*DAY).getTime());
 // An explicit plan decides over inference: paying 9 for annual is underpaid.
 r=await a.pay(alice,{txHash:a.chain.tx({from:w.address,value:9n*E18}),plan:'annual'});
 assert.equal(r.data.status,'underpaid');assert.equal(r.data.payment.required,'79');
 assert.deepEqual((await a.emails()).map(e=>e.kind),['payment_underpaid','payment_confirmed','payment_confirmed','payment_underpaid']);
});
test('submission errors store nothing: bad hash, not found, a receipt only one provider has, providers down or disagreeing, failed, wrong token or recipient, ambiguous',{skip},async t=>{
 const a=await app(t),alice=await a.user('alice@example.com'),w=wallet('alice');await a.link(alice,w);a.chain.state.finalized=200;
 for(const txHash of ['abc','0x'+'1'.repeat(63),'0x'+'g'.repeat(64),42,undefined])assert.deepEqual(await a.pay(alice,{txHash}),{status:400,data:{error:'invalid_tx_hash'}});
 assert.deepEqual(await a.pay(alice,{txHash:'0x'+'1'.repeat(64)}),{status:404,data:{error:'tx_not_found',retry:true}});
 const hash=a.chain.tx({from:w.address});
 a.chain.mode('ok','null','null');assert.deepEqual(await a.pay(alice,{txHash:hash}),{status:404,data:{error:'tx_not_found',retry:true}});
 a.chain.mode('ok','down','down');assert.deepEqual(await a.pay(alice,{txHash:hash}),{status:404,data:{error:'tx_not_found',retry:true}});
 a.chain.mode('down','down','down');assert.deepEqual(await a.pay(alice,{txHash:hash}),{status:503,data:{error:'providers_unavailable'}});
 a.chain.mode('ok','ok','null');a.chain.nodes[1].receipt=h=>({...a.chain.state.receipts.get(h),blockHash:'0x'+'ee'.repeat(32)});
 assert.deepEqual(await a.pay(alice,{txHash:hash}),{status:503,data:{error:'providers_unavailable'}});
 a.chain.mode('ok','ok','ok');a.chain.nodes[1].receipt=null;
 assert.equal((await a.db.query('SELECT count(*)::int n FROM payments')).rows[0].n,0);
 assert.deepEqual(await a.pay(alice,{txHash:a.chain.tx({from:w.address,status:0})}),{status:422,data:{error:'tx_failed'}});
 assert.deepEqual(await a.pay(alice,{txHash:a.chain.tx({from:w.address,token:FAKE})}),{status:422,data:{error:'wrong_token'}});
 assert.deepEqual(await a.pay(alice,{txHash:a.chain.tx({from:w.address,to:'0x'+'99'.repeat(20)})}),{status:422,data:{error:'wrong_recipient'}});
 assert.deepEqual(await a.pay(alice,{txHash:a.chain.tx({from:w.address,value:0n})}),{status:422,data:{error:'wrong_recipient'}});
 assert.deepEqual(await a.pay(alice,{txHash:a.chain.tx({transfers:[{token:USDT,from:w.address,value:9n*E18},{token:USDC,from:w.address,value:9n*E18}]})}),{status:422,data:{error:'ambiguous_payment'}});
 assert.deepEqual(await a.pay(alice,{txHash:hash,plan:'test'}),{status:400,data:{error:'invalid_plan'}});
 assert.equal((await a.db.query('SELECT count(*)::int n FROM payments')).rows[0].n,0);
 assert.equal((await a.pay(alice,{txHash:hash})).data.status,'confirmed');
 assert.ok(a.errors.some(line=>line.includes('rpc_provider_error')));noSecrets(a);
});
test('the request path uses 4-second RPC timeouts in parallel: a provider that never answers still lets 2 of 3 confirm in time',{skip},async t=>{
 const a=await app(t),alice=await a.user('alice@example.com'),w=wallet('alice');await a.link(alice,w);a.chain.state.finalized=200;
 a.chain.mode('ok','ok','hang');
 const started=Date.now(),r=await a.pay(alice,{txHash:a.chain.tx({from:w.address})}),elapsed=Date.now()-started;
 assert.equal(r.data.status,'confirmed');
 // Receipts and finality together (one timeout), then the block-hash check (another): about 8 s, where 8 s timeouts would take 16.
 assert.ok(elapsed>=3900&&elapsed<12000,`took ${elapsed} ms`);
 assert.ok(a.errors.some(line=>line.includes('timeout after 4000 ms')));noSecrets(a);
});
test('an unlinked sender is refused with its address, nothing is stored, and linking then resubmitting works',{skip},async t=>{
 const a=await app(t),alice=await a.user('alice@example.com'),w=wallet('alice');a.chain.state.finalized=200;
 const hash=a.chain.tx({from:w.address});
 assert.deepEqual(await a.pay(alice,{txHash:hash}),{status:403,data:{error:'unlinked_wallet',from:w.checksum}});
 assert.equal((await a.db.query('SELECT count(*)::int n FROM payments')).rows[0].n,0);
 assert.equal((await a.link(alice,w)).status,200);
 const r=await a.pay(alice,{txHash:hash});assert.equal(r.data.status,'confirmed');assert.equal(r.data.subscription.active,true);
});
test('a hash already claimed by another user is 409; the same user gets the stored status without a second extension',{skip},async t=>{
 const a=await app(t),alice=await a.user('alice@example.com'),bob=await a.user('bob@example.com'),w=wallet('alice');await a.link(alice,w);await a.link(bob,wallet('bob'));a.chain.state.finalized=200;
 const hash=a.chain.tx({from:w.address});
 assert.equal((await a.pay(alice,{txHash:hash})).data.status,'confirmed');
 assert.deepEqual(await a.pay(bob,{txHash:hash}),{status:409,data:{error:'tx_already_used'}});
 a.clock.now=later(5*DAY);
 const again=await a.pay(alice,{txHash:hash});assert.equal(again.data.status,'confirmed');assert.equal(again.data.subscription.expiresAt,later(30*DAY).toISOString());
 assert.equal((await a.emails()).length,1);
});
test('intent rules: another token, a claimed intent and another user\'s intent fall through; the test plan comes from an admin\'s open intent',{skip},async t=>{
 const a=await app(t),alice=await a.user('alice@example.com'),bob=await a.user('bob@example.com'),admin=await a.user('admin@example.com');a.chain.state.finalized=200;
 const w=wallet('alice'),d=wallet('admin');await a.link(alice,w);await a.link(admin,d);
 // Two transactions sent against one quote (a wallet retry): the second one falls through to inference instead of failing.
 const quote=await a.intent(alice,'monthly');
 const first=await a.pay(alice,{txHash:a.chain.tx({from:w.address}),intentId:quote.intentId}),second=await a.pay(alice,{txHash:a.chain.tx({from:w.address}),intentId:quote.intentId});
 assert.equal(Number((await a.row(first.data.payment.txHash)).intent_id),quote.intentId);assert.equal((await a.row(second.data.payment.txHash)).intent_id,null);
 assert.equal(second.data.status,'confirmed');
 // A USDT quote does not apply to a USDC payment.
 const usdtQuote=await a.intent(alice,'monthly','USDT');
 let r=await a.pay(alice,{txHash:a.chain.tx({from:w.address,token:USDC}),intentId:usdtQuote.intentId});
 assert.equal(r.data.status,'confirmed');assert.equal((await a.row(r.data.payment.txHash)).intent_id,null);
 // Without an intent id or plan, the latest open quote the payment covers is used (as the reconciler would).
 r=await a.pay(alice,{txHash:a.chain.tx({from:w.address})});assert.equal(Number((await a.row(r.data.payment.txHash)).intent_id),usdtQuote.intentId);
 // Bob's quote is not Alice's.
 const bobQuote=await a.intent(bob,'annual');
 r=await a.pay(alice,{txHash:a.chain.tx({from:w.address,value:79n*E18}),intentId:bobQuote.intentId});
 assert.equal(r.data.payment.plan,'annual');assert.equal((await a.row(r.data.payment.txHash)).intent_id,null);
 // An admin's 1 USDT test payment: by intent id, and found as the latest open intent when the id is missing.
 const testQuote=await a.intent(admin,'test');
 r=await a.pay(admin,{txHash:a.chain.tx({from:d.address,value:E18}),intentId:testQuote.intentId});
 assert.equal(r.data.status,'confirmed');assert.equal(r.data.payment.plan,'test');assert.equal(r.data.subscription.expiresAt,later(DAY).toISOString());
 await a.intent(admin,'test');
 r=await a.pay(admin,{txHash:a.chain.tx({from:d.address,value:E18})});assert.equal(r.data.payment.plan,'test');assert.equal(r.data.status,'confirmed');
 // Without an open test intent, 1 USDT is an underpaid monthly payment.
 r=await a.pay(admin,{txHash:a.chain.tx({from:d.address,value:E18})});assert.equal(r.data.status,'underpaid');assert.equal(r.data.payment.plan,'monthly');
});
test('receipt_missing: a vanished receipt fails after 30 minutes of not_found (provider outages pause the clock), and comes back when it reappears',{skip},async t=>{
 const a=await app(t),alice=await a.user('alice@example.com'),w=wallet('alice');await a.link(alice,w);
 const hash=a.chain.tx({block:101,from:w.address});
 assert.equal((await a.pay(alice,{txHash:hash})).data.status,'pending');
 a.chain.drop(hash);
 const check=async minutes=>{await confirmPending(a.db,a.cfg,{now:later(minutes*MIN)});return (await a.row(hash)).status};
 assert.equal(await check(0),'pending');
 a.chain.mode('down','down','down');assert.equal(await check(10),'pending');a.chain.mode('ok','ok','ok');
 assert.equal(await check(20),'pending');
 assert.equal(await check(45),'pending','only 25 minutes of not_found so far');
 assert.equal(await check(52),'failed');
 assert.equal((await a.row(hash)).failure_reason,'receipt_missing');
 a.clock.now=later(60*MIN);
 let r=await a.pay(alice,{txHash:hash});assert.equal(r.data.status,'failed');assert.equal(r.data.payment.failureReason,'receipt_missing');
 // Re-included in a later block and finalized: the same user resubmitting gets it confirmed, once.
 a.chain.tx({hash,block:105,from:w.address});a.chain.state.finalized=110;
 r=await a.pay(alice,{txHash:hash});assert.equal(r.data.status,'confirmed');assert.equal(Number((await a.row(hash)).block_number),105);assert.equal(r.data.payment.failureReason,null);
 assert.equal(await a.expires(alice),later(60*MIN+30*DAY).getTime());
 assert.equal((await a.pay(alice,{txHash:hash})).data.status,'confirmed');assert.equal(await a.expires(alice),later(60*MIN+30*DAY).getTime());
 assert.equal((await a.db.query("SELECT count(*)::int n FROM worker_state WHERE key LIKE 'receipt_missing:%'")).rows[0].n,0);
});
test('a transaction reorged into another block is confirmed on its new block; a receipt whose block hash is not canonical never confirms',{skip},async t=>{
 const a=await app(t),alice=await a.user('alice@example.com'),w=wallet('alice');await a.link(alice,w);
 const hash=a.chain.tx({block:101,from:w.address});
 assert.equal((await a.pay(alice,{txHash:hash})).data.status,'pending');
 a.chain.state.blocks.set(101,digest('reorged:101'));a.chain.tx({hash,block:102,from:w.address});
 assert.equal((await a.pay(alice,{txHash:hash})).data.status,'pending');
 assert.equal(Number((await a.row(hash)).block_number),102);
 a.chain.state.finalized=102;
 const r=await a.pay(alice,{txHash:hash});assert.equal(r.data.status,'confirmed');
 const stored=await a.row(hash);assert.equal(Number(stored.block_number),102);assert.equal(stored.block_hash,a.chain.blockHash(102));
 // Finalized by height, but the providers hold a different block at that height: stays pending.
 const stale=a.chain.tx({block:103,from:w.address});a.chain.state.finalized=110;
 for(const node of a.chain.nodes)node.block=n=>n===103?digest('other:103'):null;
 assert.equal((await a.pay(alice,{txHash:stale})).data.status,'pending');
 await confirmPending(a.db,a.cfg,{now:later(MIN)});assert.equal((await a.row(stale)).status,'pending');
 for(const node of a.chain.nodes)node.block=null;
 await confirmPending(a.db,a.cfg,{now:later(2*MIN)});assert.equal((await a.row(stale)).status,'confirmed');
});
test('a final receipt that now reverts or changed is failed, not credited',{skip},async t=>{
 const a=await app(t),alice=await a.user('alice@example.com'),w=wallet('alice');await a.link(alice,w);
 const reverted=a.chain.tx({block:101,from:w.address}),changed=a.chain.tx({block:101,from:w.address});
 assert.equal((await a.pay(alice,{txHash:reverted})).data.status,'pending');assert.equal((await a.pay(alice,{txHash:changed})).data.status,'pending');
 a.chain.tx({hash:reverted,block:102,from:w.address,status:0});a.chain.tx({hash:changed,block:102,from:wallet('mallory').address});a.chain.state.finalized=102;
 await confirmPending(a.db,a.cfg,{now:later(MIN)});
 assert.deepEqual([(await a.row(reverted)).failure_reason,(await a.row(changed)).failure_reason],['reverted','transfer_changed']);
 assert.equal(await a.expires(alice),null);
});
test('concurrent re-POSTs and worker runs confirm one payment exactly once',{skip},async t=>{
 const a=await app(t),alice=await a.user('alice@example.com'),w=wallet('alice');await a.link(alice,w);
 const hash=a.chain.tx({block:101,from:w.address});
 assert.equal((await a.pay(alice,{txHash:hash})).data.status,'pending');
 a.chain.state.finalized=101;
 const results=await Promise.all([a.pay(alice,{txHash:hash}),a.pay(alice,{txHash:hash}),a.pay(alice,{txHash:hash}),confirmPending(a.db,a.cfg,{now:T0}),confirmPending(a.db,a.cfg,{now:T0})]);
 for(const r of results.slice(0,3))assert.equal(r.data.status,'confirmed');
 assert.equal(await a.expires(alice),later(30*DAY).getTime());
 assert.equal((await a.emails()).length,1);
 // Two first submissions racing store one row.
 const fresh=a.chain.tx({block:101,from:w.address});
 const both=await Promise.all([a.pay(alice,{txHash:fresh}),a.pay(alice,{txHash:fresh})]);
 assert.deepEqual(both.map(r=>r.data.status),['confirmed','confirmed']);assert.equal(await a.expires(alice),later(60*DAY).getTime());
});
test('testnet is admin-only: other accounts get payments_not_open and the reconciler ignores them',{skip},async t=>{
 const a=await app(t,{PAYMENT_NETWORK:'bsc-testnet'}),alice=await a.user('alice@example.com'),admin=await a.user('admin@example.com'),w=wallet('alice'),d=wallet('admin');
 const usdt=a.cfg.payments.tokens.find(x=>x.symbol==='USDT').address;
 for(const [path,body] of [['/wallets/challenge',{address:w.checksum}],['/wallets/link',{nonce:'a'.repeat(32),signature:'0x'}],['/billing/intents',{plan:'monthly',token:'USDT'}],['/billing/payments',{txHash:'0x'+'1'.repeat(64)}]])
  assert.deepEqual(await a.api(path,{token:alice.token,body}),{status:403,data:{error:'payments_not_open'}},path);
 const config=await a.api('/billing/config',{token:alice.token});assert.equal(config.data.testnet,true);assert.equal(config.data.chainId,97);
 assert.equal((await a.link(admin,d)).status,200);
 assert.ok((await a.db.query('SELECT message FROM wallets')).rows[0].message.includes('Chain ID: 97'));
 // A wallet Alice linked earlier (for example before the switch) still earns nothing on testnet.
 await a.db.query("INSERT INTO wallets(address,user_id,message,signature) VALUES($1,$2,'m','s')",[w.address,alice.id]);
 const aliceTx=a.chain.tx({block:100,from:w.address,token:usdt}),adminTx=a.chain.tx({block:100,from:d.address,token:usdt,value:E18});
 await a.db.query("INSERT INTO worker_state(key,value) VALUES('payment_scan_block:bsc-testnet',$1)",[{next:100,chainId:97}]);
 const summary=await reconcile(a.db,a.cfg,{now:T0});
 assert.equal(summary.credited,1);assert.equal(summary.ignored,1);
 assert.equal(await a.row(aliceTx),undefined);assert.equal((await a.row(adminTx)).status,'underpaid');
 assert.equal((await a.db.query('SELECT count(*)::int n FROM unmatched_transfers')).rows[0].n,0);
});

// Reconciler
const checkpoint=async(a,network='bsc')=>(await a.db.query('SELECT value FROM worker_state WHERE key=$1',[`payment_scan_block:${network}`])).rows[0]?.value??null;
test('reconciler credits linked senders: the plan comes from a covering open intent, else from the amount',{skip},async t=>{
 const a=await app(t,{PAYMENT_SCAN_START_BLOCK:'101'}),alice=await a.user('alice@example.com'),admin=await a.user('admin@example.com'),w=wallet('alice'),d=wallet('admin');
 await a.link(alice,w);await a.link(admin,d);a.chain.state.finalized=110;
 const annualQuote=await a.intent(alice,'annual'),usdcQuote=await a.intent(alice,'monthly','USDC'),testQuote=await a.intent(admin,'test');
 const annual=a.chain.tx({block:101,from:w.address,value:79n*E18}),short=a.chain.tx({block:102,from:w.address,value:5n*E18});
 const byIntent=a.chain.tx({block:103,from:w.address,token:USDC,value:9n*E18}),test1=a.chain.tx({block:104,from:d.address,value:E18});
 const logs=[];const summary=await reconcile(a.db,a.cfg,{now:T0,log:e=>logs.push(e)});
 assert.deepEqual(logs.map(e=>e.event),['scan_checkpoint_seeded']);assert.equal(logs[0].next,101);
 assert.equal(summary.credited,4);assert.equal(summary.chunks,1);assert.deepEqual(await checkpoint(a),{next:111,chainId:56,attempts:0});
 const rows=Object.fromEntries(await Promise.all([annual,short,byIntent,test1].map(async h=>[h,await a.row(h)])));
 // The open annual intent is taken for the 79 USDT payment (latest open intent that the amount covers).
 assert.deepEqual([rows[annual].plan,rows[annual].status,rows[annual].source,Number(rows[annual].intent_id)],['annual','confirmed','reconciler',annualQuote.intentId]);
 // 5 USDT covers no intent: inferred monthly, underpaid.
 assert.deepEqual([rows[short].plan,rows[short].status,rows[short].intent_id],['monthly','underpaid',null]);
 assert.deepEqual([rows[byIntent].plan,rows[byIntent].status,Number(rows[byIntent].intent_id)],['monthly','confirmed',usdcQuote.intentId]);
 assert.deepEqual([rows[test1].plan,rows[test1].status,Number(rows[test1].intent_id)],['test','confirmed',testQuote.intentId]);
 assert.equal(await a.expires(alice),later((365+30)*DAY).getTime());assert.equal(await a.expires(admin),later(DAY).getTime());
 assert.equal((await reconcile(a.db,a.cfg,{now:T0})).transactions,0,'nothing new below the finalized block');
 assert.equal((await a.emails()).length,4);noSecrets(a);
});
test('reconciler: unlinked senders from 0.01 token are unmatched, dust and zero-value spoofs are ignored, and a later claim resolves the row',{skip},async t=>{
 const a=await app(t,{PAYMENT_SCAN_START_BLOCK:'101'}),alice=await a.user('alice@example.com'),eve=await a.user('eve@example.com'),w=wallet('alice'),e=wallet('eve');
 await a.link(alice,w);a.chain.state.finalized=110;
 const withdrawal=a.chain.tx({block:101,from:e.address,value:E18/2n}),dust=a.chain.tx({block:102,from:e.address,value:E18/100n-1n});
 const edge=a.chain.tx({block:102,from:e.address,token:USDC,value:E18/100n}),spoof=a.chain.tx({block:103,from:w.address,value:0n});
 const batch=a.chain.tx({block:104,transfers:[{token:USDT,from:w.address,value:9n*E18},{token:USDT,from:e.address,value:2n*E18}]});
 const summary=await reconcile(a.db,a.cfg,{now:T0});
 assert.equal(summary.credited,0);assert.equal(summary.unmatched,3);
 const unmatched=(await a.db.query('SELECT tx_hash,log_index,from_address,token,amount::text,resolved_note FROM unmatched_transfers ORDER BY block_number,log_index')).rows;
 assert.deepEqual(unmatched,[{tx_hash:withdrawal,log_index:0,from_address:e.address,token:'USDT',amount:(E18/2n).toString(),resolved_note:null},
  {tx_hash:edge,log_index:0,from_address:e.address,token:'USDC',amount:(E18/100n).toString(),resolved_note:null},
  {tx_hash:batch,log_index:0,from_address:w.address,token:'USDT',amount:(9n*E18).toString(),resolved_note:null},{tx_hash:batch,log_index:1,from_address:e.address,token:'USDT',amount:(2n*E18).toString(),resolved_note:null}]);
 assert.ok(!unmatched.some(r=>r.tx_hash===dust||r.tx_hash===spoof));
 assert.equal((await a.db.query('SELECT count(*)::int n FROM payments')).rows[0].n,0);assert.deepEqual(await a.emails(),[]);
 // Eve links the wallet and submits her withdrawal: it becomes her (underpaid) payment and the admin row is marked claimed.
 await a.link(eve,e);
 const r=await a.pay(eve,{txHash:withdrawal});assert.equal(r.data.status,'underpaid');
 assert.equal((await a.db.query('SELECT resolved_note FROM unmatched_transfers WHERE tx_hash=$1',[withdrawal])).rows[0].resolved_note,`claimed by payment ${r.data.payment.id}`);
});
test('reconciler checkpoints are per network: a testnet position never blocks mainnet, and a bad checkpoint is re-seeded',{skip},async t=>{
 const a=await app(t),logs=[],log=e=>logs.push(e);
 await a.db.query("INSERT INTO worker_state(key,value) VALUES('payment_scan_block:bsc-testnet',$1)",[{next:133800000,chainId:97}]);
 a.chain.state.finalized=5000;
 await reconcile(a.db,a.cfg,{now:T0,log});
 assert.equal(logs[0].event,'scan_checkpoint_seeded');assert.deepEqual(await checkpoint(a),{next:5001,chainId:56,attempts:0});
 assert.deepEqual(await checkpoint(a,'bsc-testnet'),{next:133800000,chainId:97});
 for(const bad of [{next:133800000,chainId:56},{next:5100,chainId:97},{next:'5100',chainId:56},{next:-1,chainId:56}]){
  await a.db.query("UPDATE worker_state SET value=$1 WHERE key='payment_scan_block:bsc'",[bad]);logs.length=0;a.chain.state.finalized+=10;
  await reconcile(a.db,a.cfg,{now:T0,log});
  assert.equal(logs[0]?.event,'scan_checkpoint_invalid',JSON.stringify(bad));assert.equal((await checkpoint(a)).next,a.chain.state.finalized+1);
 }
 // Up to 1000 blocks ahead is only waiting for finality, not invalid.
 await a.db.query("UPDATE worker_state SET value=$1 WHERE key='payment_scan_block:bsc'",[{next:a.chain.state.finalized+1000,chainId:56}]);logs.length=0;
 const waiting=await reconcile(a.db,a.cfg,{now:T0,log});assert.deepEqual(logs,[]);assert.equal(waiting.chunks,0);
 // PAYMENT_SCAN_START_BLOCK seeds only a missing checkpoint.
 const seeded=await app(t,{PAYMENT_SCAN_START_BLOCK:'90'});seeded.chain.state.finalized=100;
 await seeded.db.query("INSERT INTO worker_state(key,value) VALUES('payment_scan_block:bsc',$1)",[{next:95,chainId:56}]);
 assert.equal((await reconcile(seeded.db,seeded.cfg,{now:T0})).from,95);
});
test('reconciler scans in chunks of BSC_LOG_CHUNK, at most 20 per run, and a log-provider failure leaves the checkpoint alone',{skip},async t=>{
 const a=await app(t,{BSC_LOG_CHUNK:'2',PAYMENT_SCAN_START_BLOCK:'1'}),alice=await a.user('alice@example.com'),w=wallet('alice');await a.link(alice,w);
 const hash=a.chain.tx({block:60,from:w.address});
 let s=await reconcile(a.db,a.cfg,{now:T0});assert.equal(s.chunks,20);assert.equal(s.next,41);assert.equal(await a.row(hash),undefined);
 a.chain.mode('down','ok','ok');
 await assert.rejects(reconcile(a.db,a.cfg,{now:T0}),e=>e.code==='providers_unavailable');assert.equal((await checkpoint(a)).next,41);
 a.chain.mode('ok','ok','ok');
 s=await reconcile(a.db,a.cfg,{now:T0});assert.equal(s.next,81);assert.equal(s.credited,1);assert.equal((await a.row(hash)).status,'confirmed');
 s=await reconcile(a.db,a.cfg,{now:T0});assert.equal(s.next,101);assert.equal(s.chunks,10);
});
test('one transaction\'s error never blocks the checkpoint: it becomes a processing_error row while the others are credited',{skip},async t=>{
 const a=await app(t,{PAYMENT_SCAN_START_BLOCK:'101'}),alice=await a.user('alice@example.com'),bob=await a.user('bob@example.com'),w=wallet('alice'),b=wallet('bob');
 await a.link(alice,w);await a.link(bob,b);a.chain.state.finalized=110;
 const good=a.chain.tx({block:101,from:w.address}),broken=a.chain.tx({block:101,from:b.address,value:2n*E18});
 // A database fault for one sender only.
 const flaky={connect:()=>a.db.connect(),query:(sql,params)=>sql.includes('FROM wallets w JOIN users')&&params?.[0]===b.address?Promise.reject(Object.assign(new Error('simulated fault'),{code:'XX000'})):a.db.query(sql,params)};
 const logs=[];const s=await reconcile(flaky,a.cfg,{now:T0,log:e=>logs.push(e)});
 assert.equal(s.credited,1);assert.equal(s.errors,1);assert.equal((await checkpoint(a)).next,111);assert.equal((await a.row(good)).status,'confirmed');
 assert.deepEqual((await a.db.query('SELECT tx_hash,resolved_note FROM unmatched_transfers')).rows,[{tx_hash:broken,resolved_note:'processing_error: XX000'}]);
 assert.ok(logs.some(e=>e.event==='reconcile_tx_failed'&&e.txHash===broken&&e.code==='XX000'));
});
test('a receipt the providers cannot return is retried for three runs, then recorded as a processing_error and passed',{skip},async t=>{
 const a=await app(t,{PAYMENT_SCAN_START_BLOCK:'101'}),alice=await a.user('alice@example.com'),w=wallet('alice');await a.link(alice,w);a.chain.state.finalized=110;
 const good=a.chain.tx({block:101,from:w.address}),ghost=a.chain.tx({block:102,from:w.address,value:3n*E18});
 a.chain.state.receipts.delete(ghost);
 let s=await reconcile(a.db,a.cfg,{now:T0});
 assert.equal(s.retrying,1);assert.equal(s.credited,1);assert.deepEqual(await checkpoint(a),{next:101,chainId:56,attempts:1});assert.equal((await a.row(good)).status,'confirmed');
 s=await reconcile(a.db,a.cfg,{now:T0});assert.equal(s.retrying,1);assert.equal(s.existing,1);assert.equal((await checkpoint(a)).attempts,2);
 s=await reconcile(a.db,a.cfg,{now:T0});assert.equal(s.errors,1);assert.deepEqual(await checkpoint(a),{next:111,chainId:56,attempts:0});
 assert.deepEqual((await a.db.query('SELECT tx_hash,resolved_note FROM unmatched_transfers')).rows,[{tx_hash:ghost,resolved_note:'processing_error: receipt_not_found'}]);
 assert.equal(await a.expires(alice),later(30*DAY).getTime());
});
test('the reconciler confirms a pending checkout payment and revives one that failed as receipt_missing',{skip},async t=>{
 const a=await app(t,{PAYMENT_SCAN_START_BLOCK:'101'}),alice=await a.user('alice@example.com'),w=wallet('alice');await a.link(alice,w);
 const pending=a.chain.tx({block:101,from:w.address}),missing=a.chain.tx({block:102,from:w.address});
 assert.equal((await a.pay(alice,{txHash:pending})).data.status,'pending');assert.equal((await a.pay(alice,{txHash:missing})).data.status,'pending');
 await a.db.query("UPDATE payments SET status='failed',failure_reason='receipt_missing' WHERE tx_hash=$1",[missing]);
 a.chain.state.finalized=110;
 const s=await reconcile(a.db,a.cfg,{now:T0});assert.equal(s.existing,2);
 assert.deepEqual([(await a.row(pending)).status,(await a.row(pending)).source,(await a.row(missing)).status],['confirmed','checkout','confirmed']);
 assert.equal(await a.expires(alice),later(60*DAY).getTime());
});
test('a pasted hash with no intent buys the most valuable plan it pays for: an open monthly intent never turns 79 into 30 days',{skip},async t=>{
 const a=await app(t),alice=await a.user('alice@example.com'),w=wallet('alice');await a.link(alice,w);a.chain.state.finalized=110;
 // The checkout page defaulted to Monthly, so a monthly intent is open; the wallet actually sent 79 USDT.
 const monthly=await a.intent(alice,'monthly');
 const big=a.chain.tx({block:101,from:w.address,value:79n*E18});
 const r=await a.pay(alice,{txHash:big});
 assert.deepEqual([r.data.status,r.data.payment.plan,(await a.row(big)).intent_id],['confirmed','annual',null]);
 assert.equal(await a.expires(alice),later(365*DAY).getTime());
 // An open annual intent does not make 9 USDT underpaid: without an intent tied to the hash, 9 buys Monthly.
 const bob=await a.user('bob@example.com'),b=wallet('bob');await a.link(bob,b);await a.intent(bob,'annual');
 const small=a.chain.tx({block:102,from:b.address,value:9n*E18});
 const s=await a.pay(bob,{txHash:small});assert.deepEqual([s.data.status,s.data.payment.plan],['confirmed','monthly']);
 // The checkout's own send still pairs with its intent.
 const carol=await a.user('carol@example.com'),c=wallet('carol');await a.link(carol,c);const quote=await a.intent(carol,'monthly');
 const own=a.chain.tx({block:103,from:c.address,value:9n*E18});
 const o=await a.pay(carol,{txHash:own,intentId:quote.intentId});assert.deepEqual([o.data.status,Number((await a.row(own)).intent_id)],['confirmed',quote.intentId]);
 assert.ok(monthly.intentId);
});
test('an unmatched transfer an admin already resolved (refunded or credited by hand) is never credited again',{skip},async t=>{
 const a=await app(t,{PAYMENT_SCAN_START_BLOCK:'101'}),eve=await a.user('eve@example.com'),e=wallet('eve');a.chain.state.finalized=110;
 const hash=a.chain.tx({block:101,from:e.address,value:9n*E18});
 assert.equal((await reconcile(a.db,a.cfg,{now:T0})).unmatched,1);
 await a.db.query("UPDATE unmatched_transfers SET resolved_note='refunded to sender' WHERE tx_hash=$1",[hash]);
 await a.link(eve,e);
 assert.deepEqual(await a.pay(eve,{txHash:hash}),{status:409,data:{error:'transfer_resolved'}});
 assert.equal(await a.expires(eve),null);assert.equal((await a.db.query('SELECT count(*)::int n FROM payments')).rows[0].n,0);
 assert.equal((await a.db.query('SELECT resolved_note FROM unmatched_transfers WHERE tx_hash=$1',[hash])).rows[0].resolved_note,'refunded to sender');
});
test('the reconciler never files an already-credited payment as unmatched when receipts are briefly unavailable',{skip},async t=>{
 const a=await app(t,{PAYMENT_SCAN_START_BLOCK:'101'}),alice=await a.user('alice@example.com'),w=wallet('alice');await a.link(alice,w);a.chain.state.finalized=110;
 const hash=a.chain.tx({block:101,from:w.address,value:9n*E18});
 assert.equal((await a.pay(alice,{txHash:hash})).data.status,'confirmed');
 // Every provider now answers null for receipts (logs still come back) for more runs than the retry budget.
 a.chain.mode('null','null','null');
 for(let i=0;i<4;i++)await reconcile(a.db,a.cfg,{now:T0});
 assert.equal((await a.db.query('SELECT count(*)::int n FROM unmatched_transfers')).rows[0].n,0);
 assert.equal((await a.row(hash)).status,'confirmed');
});
