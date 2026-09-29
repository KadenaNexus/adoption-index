import {TRANSFER_TOPIC,addressTopic,decodeTransferLog} from './evm.mjs';
// Read-only JSON-RPC against BNB Smart Chain. Receipts, finality and block hashes must agree across `quorum`
// independent providers; eth_getLogs (discovery only) uses the first log provider that answers.
const HASH=/^0x[0-9a-f]{64}$/,ADDRESS=/^0x[0-9a-f]{40}$/,DATA=/^0x([0-9a-f]{2})*$/;
const quantity=value=>typeof value==='string'&&/^0x[0-9a-fA-F]{1,16}$/.test(value)&&Number.isSafeInteger(Number(value))?Number(value):null;
const hex=n=>'0x'+Number(n).toString(16);
/** Keyed providers put their API key in the URL path or query, so a provider is only ever named by its host. */
export function providerHost(url){try{return new URL(url).host||'provider'}catch{return 'provider'}}
/** Log-safe text: every URL is cut to its host, control characters become spaces. */
export const safeMessage=(value,max=300)=>String(value??'').slice(0,10000).replace(/\b[a-z][a-z0-9+.-]*:\/\/[^\s"'<>]+/gi,match=>providerHost(match)).replace(/[\u0000-\u001f]/g,' ').slice(0,max);
// A provider's own error text can echo the request URL, or parts of it, so those are removed as well.
function redact(text,url){
 let out=String(text??'').slice(0,10000);
 try{const u=new URL(url);for(const part of [url,u.href,u.pathname+u.search,...u.pathname.split('/'),...u.searchParams.values(),...u.searchParams.keys()])if(part&&part.length>=4)out=out.split(part).join('…')}catch{}
 return safeMessage(out,160);
}
export class RpcError extends Error{
 constructor(message,{code='rpc_unavailable',provider=null}={}){super(message);this.name='RpcError';this.code=code;if(provider)this.provider=provider}
}
/** One JSON-RPC call. Errors name the provider by host and never carry the URL, the request or the raw cause. */
export async function rpcCall(url,method,params=[],{timeoutMs=8000,fetch:fetchImpl=globalThis.fetch}={}){
 const provider=providerHost(url),fail=(reason,code='rpc_unavailable')=>new RpcError(`${method} failed at ${provider}: ${reason}`,{code,provider});
 const timedOut=error=>error?.name==='TimeoutError'||error?.name==='AbortError';
 let response;
 try{response=await fetchImpl(url,{method:'POST',headers:{'Content-Type':'application/json',Accept:'application/json'},body:JSON.stringify({jsonrpc:'2.0',id:1,method,params}),signal:AbortSignal.timeout(timeoutMs)})}
 catch(error){const cause=typeof error?.cause?.code==='string'&&/^[A-Z0-9_]{1,40}$/.test(error.cause.code)?` (${error.cause.code})`:'';throw fail(timedOut(error)?`timeout after ${timeoutMs} ms`:`network error${cause}`)}
 if(!response.ok){await response.body?.cancel().catch(()=>{});throw fail(`HTTP ${response.status}`)}
 let body;try{body=await response.json()}catch(error){throw fail(timedOut(error)?`timeout after ${timeoutMs} ms`:'invalid JSON')}
 if(body?.error){const code=Number.isSafeInteger(body.error.code)?` ${body.error.code}`:'';throw fail(`RPC error${code}${body.error.message?': '+redact(body.error.message,url):''}`,'rpc_error')}
 if(!body||typeof body!=='object'||!Object.hasOwn(body,'result'))throw fail('no result');
 return body.result;
}
const providerLog=(log,method,error)=>log?.({event:'rpc_provider_error',method,provider:error?.provider??null,code:error?.code??null,message:String(error?.message??'').slice(0,200)});
// Canonical receipt: lowercase hex, numbers as integers, logs sorted by logIndex. Anything malformed is an error.
function normalizeReceipt(raw,txHash,provider){
 const bad=why=>new RpcError(`eth_getTransactionReceipt failed at ${provider}: malformed receipt (${why})`,{code:'malformed',provider});
 const lower=value=>typeof value==='string'?value.toLowerCase():value;
 if(!raw||typeof raw!=='object')throw bad('not an object');
 const status=quantity(raw.status),blockNumber=quantity(raw.blockNumber),blockHash=lower(raw.blockHash),to=raw.to==null?null:lower(raw.to);
 if(lower(raw.transactionHash)!==txHash)throw bad('transaction hash');
 if(status!==0&&status!==1)throw bad('status');
 if(blockNumber===null||!HASH.test(blockHash))throw bad('block');
 if(to!==null&&!ADDRESS.test(to))throw bad('to');
 if(!Array.isArray(raw.logs))throw bad('logs');
 const logs=raw.logs.map(l=>({address:lower(l?.address),topics:Array.isArray(l?.topics)?l.topics.map(lower):null,data:lower(l?.data),logIndex:quantity(l?.logIndex)}));
 if(logs.some(l=>!ADDRESS.test(l.address)||!l.topics||l.topics.length>4||l.topics.some(t=>!HASH.test(t))||typeof l.data!=='string'||!DATA.test(l.data)||l.logIndex===null))throw bad('log');
 logs.sort((a,b)=>a.logIndex-b.logIndex);
 if(logs.some((l,i)=>i&&l.logIndex===logs[i-1].logIndex))throw bad('duplicate log index');
 return {transactionHash:txHash,status:status?'0x1':'0x0',blockNumber,blockHash,from:typeof raw.from==='string'?raw.from.toLowerCase():null,to,logs};
}
const receiptKey=r=>JSON.stringify([r.status,r.blockNumber,r.blockHash,r.to,r.logs.map(l=>[l.address,l.topics,l.data,l.logIndex])]);
/**
 * The receipt as `quorum` providers see it, all queried in parallel.
 * found: exactly one receipt that at least `quorum` providers return identically.
 * not_found: at least `quorum` providers answered null and none returned a receipt.
 * unavailable otherwise, with `reason`: partial (a receipt seen by fewer than quorum), disagreement, or errors.
 */
export async function quorumReceipt(cfg,txHash,{timeoutMs=8000,fetch,log}={}){
 const {rpcUrls,quorum}=cfg.payments,hash=String(txHash).toLowerCase();
 const answers=await Promise.all(rpcUrls.map(url=>rpcCall(url,'eth_getTransactionReceipt',[hash],{timeoutMs,fetch})
  .then(raw=>raw===null?{empty:true}:{receipt:normalizeReceipt(raw,hash,providerHost(url))})
  .catch(error=>{providerLog(log,'eth_getTransactionReceipt',error);return {error:true}})));
 const groups=new Map();let empty=0;
 for(const answer of answers){
  if(answer.empty)empty++;
  else if(answer.receipt){const key=receiptKey(answer.receipt),group=groups.get(key);if(group)group.count++;else groups.set(key,{receipt:answer.receipt,count:1})}
 }
 const seen=[...groups.values()].reduce((n,g)=>n+g.count,0),agreed=[...groups.values()].filter(g=>g.count>=quorum);
 if(agreed.length===1)return {state:'found',receipt:agreed[0].receipt,seen};
 if(!seen&&empty>=quorum)return {state:'not_found',seen:0};
 return {state:'unavailable',reason:groups.size>1?'disagreement':seen?'partial':'errors',seen};
}
/** The highest block that at least `quorum` providers report as finalized; throws when fewer answer. */
export async function finalizedBlock(cfg,{timeoutMs=8000,fetch,log}={}){
 const {rpcUrls,quorum}=cfg.payments;
 const heights=(await Promise.all(rpcUrls.map(url=>rpcCall(url,'eth_getBlockByNumber',['finalized',false],{timeoutMs,fetch})
  .then(block=>{const n=quantity(block?.number);if(n===null)throw new RpcError(`eth_getBlockByNumber failed at ${providerHost(url)}: malformed block`,{code:'malformed',provider:providerHost(url)});return n})
  .catch(error=>{providerLog(log,'eth_getBlockByNumber',error);return null})))).filter(n=>n!==null).sort((a,b)=>b-a);
 if(heights.length<quorum)throw new RpcError(`Only ${heights.length} of ${rpcUrls.length} RPC providers reported the finalized block (${quorum} needed)`,{code:'providers_unavailable'});
 return heights[quorum-1];
}
/** Whether at least `quorum` providers have `hash` at height `number` (a reorged-out block fails), with its timestamp. */
export async function canonicalBlock(cfg,number,hash,{timeoutMs=8000,fetch,log}={}){
 const {rpcUrls,quorum}=cfg.payments;
 const blocks=await Promise.all(rpcUrls.map(url=>rpcCall(url,'eth_getBlockByNumber',[hex(number),false],{timeoutMs,fetch}).catch(error=>{providerLog(log,'eth_getBlockByNumber',error);return null})));
 const agreeing=blocks.filter(b=>typeof b?.hash==='string'&&b.hash.toLowerCase()===String(hash).toLowerCase()&&quantity(b.number)===number);
 const timestamp=agreeing.map(b=>quantity(b.timestamp)).find(t=>t!==null)??null;
 return {canonical:agreeing.length>=quorum,agreeing:agreeing.length,timestamp};
}
/** Accepted-token Transfer logs to payTo in [fromBlock, toBlock], decoded; tries each log provider in turn. */
export async function transferLogs(cfg,{fromBlock,toBlock,timeoutMs=8000,fetch,log}={}){
 const p=cfg.payments,tokens=p.tokens.map(t=>t.address);
 if(!Number.isSafeInteger(fromBlock)||!Number.isSafeInteger(toBlock)||fromBlock<0||toBlock<fromBlock)throw new Error('Invalid block range');
 const filter={fromBlock:hex(fromBlock),toBlock:hex(toBlock),address:tokens.length===1?tokens[0]:tokens,topics:[TRANSFER_TOPIC,null,addressTopic(p.payTo)]};
 for(const url of p.logRpcUrls){
  try{
   const result=await rpcCall(url,'eth_getLogs',[filter],{timeoutMs,fetch}),logs=[];
   if(!Array.isArray(result))throw new RpcError(`eth_getLogs failed at ${providerHost(url)}: malformed result`,{code:'malformed',provider:providerHost(url)});
   for(const raw of result){
    if(raw?.removed===true)continue;
    const entry=decodeTransferLog(raw);if(!entry)continue;
    // A provider that ignores the filter or the range is not trusted for this chunk.
    if(!tokens.includes(entry.address)||entry.to!==p.payTo||!entry.transactionHash||entry.logIndex===null||entry.blockNumber===null||entry.blockNumber<fromBlock||entry.blockNumber>toBlock)
     throw new RpcError(`eth_getLogs failed at ${providerHost(url)}: log outside the filter`,{code:'malformed',provider:providerHost(url)});
    logs.push(entry);
   }
   return logs.sort((a,b)=>a.blockNumber-b.blockNumber||a.logIndex-b.logIndex);
  }catch(error){providerLog(log,'eth_getLogs',error)}
 }
 throw new RpcError('No log provider answered eth_getLogs',{code:'providers_unavailable'});
}
