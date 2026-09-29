import {test} from 'node:test';
import assert from 'node:assert/strict';
import {randomBytes} from 'node:crypto';
import {setTimeout as sleep} from 'node:timers/promises';
import {database} from '../src/db.mjs';
import {migrate} from '../src/migrate.mjs';
import {accountsConfig} from '../src/config.mjs';
import {hashToken} from '../src/auth.mjs';
import {createServer} from '../src/server.mjs';
import {addressTopic,toChecksum} from '../src/evm.mjs';
import {rpcCall} from '../src/bsc.mjs';
// Optional, read-only against real BSC state: an anvil fork of BSC mainnet (chain 56), started separately with
//   anvil --fork-url https://bsc-rpc.publicnode.com
// and run with ANVIL_RPC_URL=http://127.0.0.1:8545 plus TEST_DATABASE_URL. Skipped otherwise. anvil reports
// finalized = latest - 64, so the payment stays pending until more blocks are mined.
const rpcUrl=process.env.ANVIL_RPC_URL,connection=process.env.TEST_DATABASE_URL;
const USDT='0x55d398326f99059fF775485246999027B3197955',HOLDER='0x8894E0a0c962CB723c1976a4421c95949bE2D4E3',E18=10n**18n,SITE='a'.repeat(40);
const rpc=(method,params=[])=>rpcCall(rpcUrl,method,params,{timeoutMs:30000});
// Calldata for ERC-20 transfer(to, amount): the selector, then both arguments as 32-byte words.
const encodeTransfer=(to,amount)=>'0xa9059cbb'+addressTopic(to).slice(2)+BigInt(amount).toString(16).padStart(64,'0');
async function isolated(t){
 const url=new URL(connection);if(!url.pathname.endsWith('_test'))throw new Error('Integration tests require a dedicated *_test database');
 const schema='anvil_'+randomBytes(8).toString('hex'),admin=database(connection);
 await admin.query(`CREATE SCHEMA ${schema}`);url.searchParams.set('options',`-c search_path=${schema}`);const db=database(url.href);
 t.after(async()=>{await db.end();try{await admin.query(`DROP SCHEMA ${schema} CASCADE`)}finally{await admin.end()}});
 await migrate(db);return db;
}
async function mined(hash){
 for(let i=0;i<50;i++){const receipt=await rpc('eth_getTransactionReceipt',[hash]);if(receipt)return receipt;await sleep(200)}
 throw new Error('transaction not mined');
}
test('anvil BSC fork: link a wallet by personal_sign, pay 9 USDT, pending until finalized, then Pro',{skip:!rpcUrl||!connection},async t=>{
 assert.equal(Number(await rpc('eth_chainId')),56,'ANVIL_RPC_URL must be a BSC mainnet fork');
 const db=await isolated(t),[payer]=await rpc('eth_accounts'),payTo=toChecksum('0x'+randomBytes(20).toString('hex'));
 // Fund anvil's first account with 9 USDT from a large holder.
 await rpc('anvil_setBalance',[HOLDER,'0x'+E18.toString(16)]);await rpc('anvil_impersonateAccount',[HOLDER]);
 const funding=await mined(await rpc('eth_sendTransaction',[{from:HOLDER,to:USDT,data:encodeTransfer(payer,9n*E18),gas:'0x30d40'}]));
 await rpc('anvil_stopImpersonatingAccount',[HOLDER]);assert.equal(funding.status,'0x1');
 const cfg=accountsConfig({SITE_API_KEY:SITE,PUBLIC_SITE_URL:'http://127.0.0.1:5173',PAYMENT_NETWORK:'bsc',PAYMENT_ADDRESS:payTo,BSC_RPC_URLS:rpcUrl,BSC_LOG_RPC_URLS:rpcUrl});
 const server=createServer(db,{cfg,mailer:{send:async()=>({id:'anvil'})}});
 await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));t.after(()=>{server.closeAllConnections();return new Promise(resolve=>server.close(resolve))});
 const token=randomBytes(32).toString('base64url'),userId=Number((await db.query("INSERT INTO users(email) VALUES('anvil@example.com') RETURNING id")).rows[0].id);
 await db.query("INSERT INTO sessions(token_hash,user_id,expires_at) VALUES($1,$2,now()+interval '1 day')",[hashToken(token),userId]);
 const api=async(path,body)=>{const r=await fetch(`http://127.0.0.1:${server.address().port}${path}`,{method:'POST',headers:{'X-KCE-Site-Key':SITE,'X-KCE-Session':token,'Content-Type':'application/json'},body:JSON.stringify(body)});return {status:r.status,data:await r.json()}};
 // The wallet signs the challenge itself (EIP-191 personal_sign), exactly as a browser wallet would.
 const challenge=await api('/wallets/challenge',{address:toChecksum(payer)});assert.equal(challenge.status,200);
 const signature=await rpc('personal_sign',['0x'+Buffer.from(challenge.data.message,'utf8').toString('hex'),payer]);
 const linked=await api('/wallets/link',{nonce:challenge.data.nonce,signature});assert.equal(linked.status,200,JSON.stringify(linked.data));
 const intent=await api('/billing/intents',{plan:'monthly',token:'USDT'});assert.equal(intent.status,200);assert.equal(intent.data.payTo,payTo);
 const hash=await rpc('eth_sendTransaction',[{from:payer,to:intent.data.tokenAddress,data:encodeTransfer(intent.data.payTo,intent.data.amount),gas:'0x30d40'}]);
 assert.equal((await mined(hash)).status,'0x1');
 const pending=await api('/billing/payments',{txHash:hash,intentId:intent.data.intentId});
 assert.equal(pending.status,200,JSON.stringify(pending.data));assert.equal(pending.data.status,'pending');
 await rpc('anvil_mine',['0x50']);
 const confirmed=await api('/billing/payments',{txHash:hash,intentId:intent.data.intentId});
 assert.equal(confirmed.data.status,'confirmed',JSON.stringify(confirmed.data));assert.equal(confirmed.data.payment.amount,'9');assert.equal(confirmed.data.subscription.active,true);
 assert.equal((await db.query('SELECT plan FROM subscriptions WHERE user_id=$1',[userId])).rows[0].plan,'monthly');
});
