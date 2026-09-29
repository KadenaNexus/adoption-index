import {test} from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import {rpcCall,quorumReceipt,finalizedBlock,canonicalBlock,transferLogs,providerHost,RpcError} from '../src/bsc.mjs';
import {TRANSFER_TOPIC,addressTopic} from '../src/evm.mjs';
import {accountsConfig} from '../src/config.mjs';
// Keyed providers carry secrets in the path and query; none of these may reach an error or a log line.
const SECRETS=['PATHSECRETabc123','QUERYSECRETdef456'];
const PAY='0x4274907ce85e100a5ebae1f7286deb5083a52e98',USDT='0x55d398326f99059ff775485246999027b3197955',USDC='0x8ac76a51cc950d9822d68b83fe1ad97b32cd580d',FROM='0x'+'11'.repeat(20);
const TX='0x'+'aa'.repeat(32),BH='0x'+'bb'.repeat(32),word=n=>'0x'+BigInt(n).toString(16).padStart(64,'0'),hex=n=>'0x'+n.toString(16);
const transferLog=(over={})=>({address:USDT,topics:[TRANSFER_TOPIC,addressTopic(FROM),addressTopic(PAY)],data:word(9n*10n**18n),logIndex:'0x0',transactionHash:TX,blockNumber:'0x64',blockHash:BH,...over});
const receipt=(over={})=>({transactionHash:TX,status:'0x1',blockNumber:'0x64',blockHash:BH,from:FROM,to:USDT,logs:[transferLog()],...over});
/** A JSON-RPC provider on port 0; `handle(method, params)` returns a result, {error}, {http}, {raw} or 'hang'. */
async function provider(t,handle){
 const calls=[],sockets=new Set();
 const server=http.createServer(async(request,response)=>{
  let text='';for await(const chunk of request)text+=chunk;
  const {id,method,params}=JSON.parse(text);calls.push({method,params,url:request.url});
  const answer=await handle(method,params);
  if(answer==='hang')return;
  if(answer?.http){response.writeHead(answer.http);return response.end(answer.body??'')}
  if(answer?.raw!==undefined){response.writeHead(200,{'Content-Type':'application/json'});return response.end(answer.raw)}
  response.writeHead(200,{'Content-Type':'application/json'});
  response.end(JSON.stringify(answer?.error?{jsonrpc:'2.0',id,error:answer.error}:{jsonrpc:'2.0',id,result:answer===undefined?null:answer}));
 });
 server.on('connection',socket=>{sockets.add(socket);socket.on('close',()=>sockets.delete(socket))});
 await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
 t.after(()=>{for(const socket of sockets)socket.destroy();return new Promise(resolve=>server.close(resolve))});
 const port=server.address().port;
 return {calls,port,host:`127.0.0.1:${port}`,url:`http://127.0.0.1:${port}/v2/${SECRETS[0]}?apikey=${SECRETS[1]}`};
}
const leaks=text=>SECRETS.some(secret=>String(text).includes(secret));
const cfgFor=(urls,{quorum=Math.min(2,urls.length),logUrls=urls}={})=>({payments:{rpcUrls:urls,quorum,logRpcUrls:logUrls,payTo:PAY,tokens:[{symbol:'USDT',address:USDT,decimals:18},{symbol:'USDC',address:USDC,decimals:18}]}});
const standard=over=>(method,params)=>{
 if(method==='eth_getTransactionReceipt')return over?.receipt!==undefined?over.receipt:receipt();
 if(method==='eth_getBlockByNumber')return params[0]==='finalized'?{number:hex(over?.finalized??100),hash:BH}:{number:params[0],hash:params[0]==='0x64'?over?.blockHash??BH:'0x'+'99'.repeat(32),timestamp:'0x6700'};
 if(method==='eth_getLogs')return over?.logs??[transferLog()];
 return null;
};

test('rpcCall posts JSON-RPC and returns the result',async t=>{
 const p=await provider(t,(method,params)=>({method,params}));
 assert.deepEqual(await rpcCall(p.url,'eth_chainId',[1,'x']),{method:'eth_chainId',params:[1,'x']});
 assert.equal(p.calls[0].url,`/v2/${SECRETS[0]}?apikey=${SECRETS[1]}`);
 assert.equal(providerHost(p.url),p.host);assert.equal(providerHost('not a url'),'provider');
});
test('RPC failures name the provider by host only: HTTP errors, RPC errors echoing the URL, bad JSON, timeouts and refused connections',async t=>{
 const echo=await provider(t,()=>({error:{code:-32005,message:`limit exceeded for http://127.0.0.1/v2/${SECRETS[0]}?apikey=${SECRETS[1]} key ${SECRETS[0]} (${SECRETS[1]})`}}));
 const broken=await provider(t,()=>({http:500,body:`internal ${SECRETS[0]}`})),garbled=await provider(t,()=>({raw:`{not json ${SECRETS[1]}`})),slow=await provider(t,()=>'hang');
 const cases=[[echo,/RPC error -32005: limit exceeded/],[broken,/HTTP 500/],[garbled,/invalid JSON/],[slow,/timeout after 150 ms/]];
 for(const [p,pattern] of cases){
  const error=await rpcCall(p.url,'eth_getLogs',[{}],{timeoutMs:150}).then(()=>null,e=>e);
  assert.ok(error instanceof RpcError,p.host);assert.match(error.message,pattern);assert.ok(error.message.includes(p.host));
  assert.equal(error.provider,p.host);assert.ok(!leaks(error.message)&&!leaks(error.stack)&&!leaks(JSON.stringify(error)),error.message);
 }
 // A provider that is gone entirely.
 const gone=`http://127.0.0.1:1/rpc/${SECRETS[0]}`;
 const error=await rpcCall(gone,'eth_chainId',[],{timeoutMs:1000}).then(()=>null,e=>e);
 assert.match(error.message,/eth_chainId failed at 127\.0\.0\.1:1: network error/);assert.ok(!leaks(error.message)&&!leaks(error.stack));
});
test('provider errors in quorum, finality and log calls are logged by host, never by URL',async t=>{
 const a=await provider(t,()=>({error:{code:-32000,message:`denied ${SECRETS[0]}`}})),b=await provider(t,()=>({http:429})),c=await provider(t,standard());
 const logs=[],log=entry=>logs.push(entry),cfg=cfgFor([a.url,b.url,c.url],{logUrls:[a.url,b.url,c.url]});
 await quorumReceipt(cfg,TX,{log});await finalizedBlock(cfg,{log}).catch(()=>{});await transferLogs(cfg,{fromBlock:1,toBlock:100,log});await canonicalBlock(cfg,100,BH,{log});
 assert.ok(logs.length>=8);
 for(const entry of logs){assert.equal(entry.event,'rpc_provider_error');assert.ok([a.host,b.host].includes(entry.provider));assert.ok(!leaks(JSON.stringify(entry)),JSON.stringify(entry))}
 const thrown=await finalizedBlock(cfgFor([a.url,b.url]),{log}).then(()=>null,e=>e);
 assert.equal(thrown.code,'providers_unavailable');assert.ok(!leaks(thrown.message)&&!leaks(thrown.stack));
});
test('the configured RPC URLs may carry a key path, and it stays out of every message',async t=>{
 const p=await provider(t,()=>({http:503}));
 const cfg=accountsConfig({PAYMENT_NETWORK:'bsc',PAYMENT_ADDRESS:'0x4274907CE85E100a5EbAe1f7286DeB5083a52e98',BSC_RPC_URLS:p.url,PUBLIC_SITE_URL:'http://127.0.0.1:5173'});
 assert.ok(cfg.payments.rpcUrls[0].includes(SECRETS[0]));assert.equal(cfg.payments.quorum,1);
 const logs=[];assert.equal((await quorumReceipt(cfg,TX,{log:e=>logs.push(e)})).state,'unavailable');
 const error=await transferLogs(cfg,{fromBlock:1,toBlock:2,log:e=>logs.push(e)}).then(()=>null,e=>e);
 assert.equal(error.code,'providers_unavailable');assert.ok(!leaks(JSON.stringify(logs))&&!leaks(error.message)&&!leaks(error.stack));
});
test('quorumReceipt: found when quorum providers agree, after normalising case and log order',async t=>{
 const upper=receipt({blockHash:BH.toUpperCase().replace('0X','0x'),logs:[transferLog({logIndex:'0x2',address:USDC.toUpperCase().replace('0X','0x')}),transferLog({logIndex:'0x1'})]});
 const sorted=receipt({logs:[transferLog({logIndex:'0x1'}),transferLog({logIndex:'0x2',address:USDC})]});
 const a=await provider(t,standard({receipt:upper})),b=await provider(t,standard({receipt:sorted})),c=await provider(t,standard({receipt:null}));
 const result=await quorumReceipt(cfgFor([a.url,b.url,c.url]),TX.toUpperCase().replace('0X','0x'));
 assert.equal(result.state,'found');assert.equal(result.receipt.blockHash,BH);assert.equal(result.receipt.blockNumber,100);assert.equal(result.receipt.status,'0x1');
 assert.deepEqual(result.receipt.logs.map(l=>[l.logIndex,l.address]),[[1,USDT],[2,USDC]]);
});
test('quorumReceipt: not_found, unavailable, disagreement and a receipt seen by only one provider',async t=>{
 const nul=await provider(t,standard({receipt:null})),nul2=await provider(t,standard({receipt:null})),down=await provider(t,()=>({http:502}));
 const ok=await provider(t,standard()),other=await provider(t,standard({receipt:receipt({blockHash:'0x'+'cc'.repeat(32)})}));
 const malformed=await provider(t,standard({receipt:receipt({transactionHash:'0x'+'dd'.repeat(32)})}));
 const state=async(urls,quorum)=>quorumReceipt(cfgFor(urls,{quorum}),TX);
 assert.deepEqual(await state([nul.url,nul2.url]),{state:'not_found',seen:0});
 assert.equal((await state([nul.url,nul2.url,down.url])).state,'not_found');
 assert.deepEqual(await state([nul.url,down.url]),{state:'unavailable',reason:'errors',seen:0});
 assert.deepEqual(await state([down.url,down.url]),{state:'unavailable',reason:'errors',seen:0});
 // One provider has the receipt, the other has not seen it yet: not enough to act on, and not a "not found" either.
 assert.deepEqual(await state([ok.url,nul.url]),{state:'unavailable',reason:'partial',seen:1});
 assert.deepEqual(await state([ok.url,nul.url,nul2.url]),{state:'unavailable',reason:'partial',seen:1});
 assert.deepEqual(await state([ok.url,other.url]),{state:'unavailable',reason:'disagreement',seen:2});
 // Quorum 1 with two different answers is still a disagreement, never a coin toss.
 assert.equal((await state([ok.url,other.url],1)).reason,'disagreement');
 assert.equal((await state([ok.url,nul.url],1)).state,'found');
 assert.equal((await state([ok.url,ok.url,other.url])).state,'found');
 // A receipt for another transaction counts as a provider error.
 assert.deepEqual(await state([malformed.url,nul.url]),{state:'unavailable',reason:'errors',seen:0});
 for(const bad of [receipt({status:'0x2'}),receipt({blockHash:'0x12'}),receipt({logs:'x'}),receipt({logs:[transferLog({logIndex:null})]}),receipt({logs:[transferLog(),transferLog()]}),receipt({to:'0x12'}),'receipt'])
  assert.equal((await quorumReceipt(cfgFor([(await provider(t,standard({receipt:bad}))).url],{quorum:1}),TX)).reason,'errors');
 assert.equal((await quorumReceipt(cfgFor([(await provider(t,standard({receipt:receipt({status:'0x0',logs:[]})}))).url],{quorum:1}),TX)).receipt.status,'0x0');
});
test('finalizedBlock is the highest block quorum providers have finalized',async t=>{
 const at=async n=>(await provider(t,standard({finalized:n}))).url,down=(await provider(t,()=>({http:500}))).url,junk=(await provider(t,()=>({number:'soon'}))).url;
 const [u90,u100,u110]=[await at(90),await at(100),await at(110)];
 assert.equal(await finalizedBlock(cfgFor([u90,u100,u110])),100);
 assert.equal(await finalizedBlock(cfgFor([u90,u100,u110],{quorum:3})),90);
 assert.equal(await finalizedBlock(cfgFor([u90,u110,down])),90);
 await assert.rejects(finalizedBlock(cfgFor([u100,down,junk])),e=>e.code==='providers_unavailable');
});
test('canonicalBlock needs quorum providers to report the receipt block hash at that height',async t=>{
 const good=(await provider(t,standard())).url,reorged=(await provider(t,standard({blockHash:'0x'+'ee'.repeat(32)}))).url,down=(await provider(t,()=>({http:500}))).url;
 assert.deepEqual(await canonicalBlock(cfgFor([good,good,reorged]),100,BH),{canonical:true,agreeing:2,timestamp:0x6700});
 assert.equal((await canonicalBlock(cfgFor([good,reorged,down]),100,BH)).canonical,false);
 assert.equal((await canonicalBlock(cfgFor([good,good]),100,BH.toUpperCase().replace('0X','0x'))).canonical,true);
 assert.equal((await canonicalBlock(cfgFor([good,good]),101,BH)).canonical,false);
});
test('transferLogs filters by the accepted tokens, topic and payTo, falls back across log providers and rejects out-of-range answers',async t=>{
 const outside=await provider(t,standard({logs:[transferLog({blockNumber:'0x3e8'})]})),down=await provider(t,()=>({http:500}));
 const zero=transferLog({data:word(0),logIndex:'0x5',transactionHash:'0x'+'cd'.repeat(32)}),removed={...transferLog({logIndex:'0x6'}),removed:true},erc721={...transferLog({logIndex:'0x7'}),topics:[...transferLog().topics,word(1)]};
 const good=await provider(t,standard({logs:[transferLog({blockNumber:'0x65',logIndex:'0x3'}),zero,removed,erc721,transferLog({logIndex:'0x1'})]}));
 const logs=await transferLogs(cfgFor([],{logUrls:[down.url,outside.url,good.url]}),{fromBlock:100,toBlock:101});
 assert.deepEqual(logs.map(l=>[l.blockNumber,l.logIndex,l.value]),[[100,1,9n*10n**18n],[100,5,0n],[101,3,9n*10n**18n]]);
 assert.deepEqual(good.calls[0].params[0],{fromBlock:'0x64',toBlock:'0x65',address:[USDT,USDC],topics:[TRANSFER_TOPIC,null,addressTopic(PAY)]});
 assert.equal(down.calls.length,1);assert.equal(outside.calls.length,1);
 await assert.rejects(transferLogs(cfgFor([],{logUrls:[down.url]}),{fromBlock:1,toBlock:2}),e=>e.code==='providers_unavailable');
 await assert.rejects(transferLogs(cfgFor([],{logUrls:[good.url]}),{fromBlock:5,toBlock:4}),/Invalid block range/);
});
