import {test} from 'node:test';
import assert from 'node:assert/strict';
import {evaluateReceipt,paidPlan,checkPlan,assertPaymentsOpen,challengeMessage} from '../src/billing.mjs';
import {paymentView} from '../src/accounts.mjs';
import {billingConfig} from '../src/billing-http.mjs';
import {TRANSFER_TOPIC,addressTopic} from '../src/evm.mjs';
import {accountsConfig} from '../src/config.mjs';
const PAY='0x4274907ce85e100a5ebae1f7286deb5083a52e98',USDT='0x55d398326f99059ff775485246999027b3197955',USDC='0x8ac76a51cc950d9822d68b83fe1ad97b32cd580d';
const FAKE='0x'+'fa'.repeat(20),ALICE='0x'+'a1'.repeat(20),BOB='0x'+'b0'.repeat(20),E18=10n**18n;
const tokens=[{symbol:'USDT',address:USDT,decimals:18},{symbol:'USDC',address:USDC,decimals:18}];
const word=n=>'0x'+BigInt(n).toString(16).padStart(64,'0');
let index=0;
const transfer=({token=USDT,from=ALICE,to=PAY,value=9n*E18,data=word(value),topics}={})=>({address:token,topics:topics??[TRANSFER_TOPIC,addressTopic(from),addressTopic(to)],data,logIndex:index++});
const receipt=(logs,status='0x1')=>({status,blockNumber:100,blockHash:'0x'+'bb'.repeat(32),logs});
const evaluate=(logs,{linked=new Set([ALICE]),status}={})=>evaluateReceipt(receipt(logs,status),{payTo:PAY,tokens,linked});

test('a single accepted-token transfer from a linked wallet is ok',()=>{
 const result=evaluate([transfer()]);
 assert.equal(result.result,'ok');assert.equal(result.token.symbol,'USDT');assert.equal(result.from,ALICE);assert.equal(result.amount,9n*E18);
 assert.equal(evaluate([transfer({token:USDC,value:79n*E18})]).token.symbol,'USDC');
 // Upper-case hex from a provider still matches.
 assert.equal(evaluate([{...transfer(),address:USDT.toUpperCase().replace('0X','0x')}]).result,'ok');
});
test('failed: a reverted transaction, whatever its logs',()=>{
 assert.deepEqual(evaluate([transfer()],{status:'0x0'}),{result:'failed'});
 assert.deepEqual(evaluateReceipt(null,{payTo:PAY,tokens}),{result:'failed'});
});
test('wrong_token: another contract sent a Transfer to payTo; wrong_recipient: nothing reached payTo',()=>{
 assert.deepEqual(evaluate([transfer({token:FAKE})]),{result:'wrong_token'});
 // An NFT (4-topic) Transfer to payTo is also the wrong token.
 assert.deepEqual(evaluate([transfer({token:FAKE,topics:[TRANSFER_TOPIC,addressTopic(ALICE),addressTopic(PAY),word(7)],data:'0x'})]),{result:'wrong_token'});
 assert.deepEqual(evaluate([transfer({to:BOB})]),{result:'wrong_recipient'});
 assert.deepEqual(evaluate([]),{result:'wrong_recipient'});
 assert.deepEqual(evaluate([transfer({token:FAKE,to:BOB})]),{result:'wrong_recipient'});
});
test('unlinked_wallet: an accepted transfer to payTo from an address this user has not linked',()=>{
 assert.deepEqual(evaluate([transfer({from:BOB})]),{result:'unlinked_wallet',from:BOB});
 assert.deepEqual(evaluate([transfer()],{linked:new Set()}),{result:'unlinked_wallet',from:ALICE});
 // Without a linked set (the reconciler) the sender is returned for lookup.
 assert.equal(evaluateReceipt(receipt([transfer({from:BOB})]),{payTo:PAY,tokens}).from,BOB);
});
test('ambiguous: two accepted tokens, or two senders, in one transaction',()=>{
 assert.equal(evaluate([transfer(),transfer({token:USDC})]).result,'ambiguous');
 assert.equal(evaluate([transfer(),transfer({from:BOB})],{linked:new Set([ALICE,BOB])}).result,'ambiguous');
 assert.equal(evaluate([transfer(),transfer({from:BOB})]).result,'ambiguous');
 assert.equal(evaluate([transfer(),transfer({token:USDC})]).logs.length,2);
});
test('zero-value transfers are ignored everywhere (address poisoning)',()=>{
 // Anyone can emit transferFrom(victim, payTo, 0) on the real token contract.
 assert.deepEqual(evaluate([transfer({value:0n})]),{result:'wrong_recipient'});
 assert.deepEqual(evaluate([transfer({value:0n,from:BOB}),transfer({value:0n,token:USDC})]),{result:'wrong_recipient'});
 const alongside=evaluate([transfer({value:0n,from:BOB}),transfer({value:0n,token:USDC}),transfer()]);
 assert.equal(alongside.result,'ok');assert.equal(alongside.amount,9n*E18);assert.equal(alongside.logs.length,1);
 assert.deepEqual(evaluate([transfer({token:FAKE,value:0n})]),{result:'wrong_recipient'});
});
test('several same-token transfers from one sender are summed',()=>{
 const result=evaluate([transfer({value:4n*E18}),transfer({value:5n*E18}),transfer({value:1n})]);
 assert.equal(result.result,'ok');assert.equal(result.amount,9n*E18+1n);assert.equal(result.logs.length,3);
});
test('a non-accepted-token transfer alongside an accepted one is still ok, and other logs are ignored',()=>{
 const other={address:FAKE,topics:['0x'+'12'.repeat(32)],data:'0x',logIndex:index++};
 const outgoing=transfer({from:PAY,to:BOB,value:5n*E18});
 const result=evaluate([transfer({token:FAKE,value:1000n*E18}),other,outgoing,transfer()]);
 assert.equal(result.result,'ok');assert.equal(result.amount,9n*E18);
 // Malformed Transfer logs from the accepted token (extra data, missing topic) are not candidates.
 assert.equal(evaluate([transfer({data:word(9n*E18)+'00'.repeat(32)}),transfer({topics:[TRANSFER_TOPIC,addressTopic(ALICE)]})]).result,'wrong_recipient');
});
test('plan rules: inference, the admin-only test plan, and testnet admin-only checkout',()=>{
 assert.equal(paidPlan(79n*E18,18),'annual');assert.equal(paidPlan(79n*E18-1n,18),'monthly');assert.equal(paidPlan(9n*E18,18),'monthly');assert.equal(paidPlan(9n*E18-1n,18),null);assert.equal(paidPlan(1n,18),null);
 const base={PAYMENT_NETWORK:'bsc',PAYMENT_ADDRESS:'0x4274907CE85E100a5EbAe1f7286DeB5083a52e98',PUBLIC_SITE_URL:'http://127.0.0.1:5173'};
 const on=accountsConfig({...base,PAYMENT_TEST_PLAN:'1'}),off=accountsConfig(base),admin={isAdmin:true},user={isAdmin:false};
 assert.equal(checkPlan(on,admin,'test'),'test');assert.equal(checkPlan(on,user,'annual'),'annual');
 for(const [cfg,who,plan] of [[on,user,'test'],[off,admin,'test'],[on,admin,'weekly'],[on,admin,undefined],[on,admin,'__proto__'],[on,admin,'hasOwnProperty']])assert.throws(()=>checkPlan(cfg,who,plan),e=>e.status===400&&e.code==='invalid_plan');
 assert.throws(()=>assertPaymentsOpen(accountsConfig({PUBLIC_SITE_URL:'http://127.0.0.1:5173'}),admin),e=>e.status===503&&e.code==='payments_disabled');
 const testnet=accountsConfig({...base,PAYMENT_NETWORK:'bsc-testnet'});
 assert.throws(()=>assertPaymentsOpen(testnet,user),e=>e.status===403&&e.code==='payments_not_open');
 assert.equal(assertPaymentsOpen(testnet,admin).chainId,97);assert.equal(assertPaymentsOpen(on,user).chainId,56);
});
test('the challenge text names the site, the email, the EIP-55 address, the chain and the nonce',()=>{
 const text=challengeMessage({domain:'adoption.kadena.ws',email:'jürgen@example.de',address:'0x4274907CE85E100a5EbAe1f7286DeB5083a52e98',chainId:56,nonce:'ab'.repeat(16),issuedAt:'2026-10-01T12:00:00.000Z'});
 for(const part of ['adoption.kadena.ws','Link this wallet to jürgen@example.de for Kadena Community Edition Adoption Index payments. Signing is free and does not send a transaction.','Address: 0x4274907CE85E100a5EbAe1f7286DeB5083a52e98','Chain ID: 56','Nonce: '+'ab'.repeat(16),'Issued At: 2026-10-01T12:00:00.000Z'])assert.ok(text.includes(part),part);
});
test('billing config: disabled, mainnet and testnet',()=>{
 const disabled=billingConfig(accountsConfig({PUBLIC_SITE_URL:'http://127.0.0.1:5173'}));
 assert.deepEqual(disabled,{enabled:false,testnet:false,signinOpen:true,supportEmail:null,walletConnectProjectId:null});
 const env={PAYMENT_NETWORK:'bsc',PAYMENT_ADDRESS:PAY,PUBLIC_SITE_URL:'https://adoption.kadena.ws',MAIL_TRANSPORT:'none',ADMIN_EMAILS:'ops@example.com',PAYMENT_TEST_PLAN:'1',WALLETCONNECT_PROJECT_ID:'0123456789abcdef0123456789abcdef'};
 const mainnet=billingConfig(accountsConfig(env));
 assert.deepEqual(Object.keys(mainnet),['enabled','network','testnet','chainId','chainName','explorerUrl','addChainParams','payTo','tokens','signinOpen','supportEmail','walletConnectProjectId']);
 assert.equal(mainnet.enabled,true);assert.equal(mainnet.testnet,false);assert.equal(mainnet.chainId,56);assert.equal(mainnet.payTo,'0x4274907CE85E100a5EbAe1f7286DeB5083a52e98');
 assert.deepEqual(mainnet.tokens,[{symbol:'USDT',address:'0x55d398326f99059fF775485246999027B3197955',decimals:18},{symbol:'USDC',address:'0x8AC76a51cc950d9822D68b83fE1Ad97B32Cd580d',decimals:18}]);
 assert.equal(mainnet.addChainParams.chainId,'0x38');assert.equal(mainnet.signinOpen,false);assert.equal(mainnet.supportEmail,'ops@example.com');
 assert.equal(mainnet.walletConnectProjectId,'0123456789abcdef0123456789abcdef');
 const testnet=billingConfig(accountsConfig({...env,PAYMENT_NETWORK:'bsc-testnet'}));
 assert.equal(testnet.testnet,true);assert.equal(testnet.network,'bsc-testnet');assert.equal(testnet.chainId,97);
 assert.ok(!JSON.stringify(mainnet).includes('publicnode')&&!JSON.stringify(mainnet).includes('dataseed1'),'RPC URLs stay on the server');
});
test('paymentView (checkout, account and admin pages) shows token amounts, EIP-55 addresses, overpayment and the explorer link',()=>{
 const row={id:'7',rail:'evm',network:'bsc',chain:'56',tx_hash:'0x'+'ab'.repeat(32),status:'confirmed',failure_reason:null,plan:'monthly',token:'USDT',token_address:USDT,decimals:18,
  amount:(10n*E18).toString(),required_amount:(9n*E18).toString(),from_address:PAY,to_address:PAY,block_number:'123',source:'checkout',created_at:new Date('2026-10-01T00:00:00Z'),confirmed_at:null,period_start:null,period_end:null};
 const shown=paymentView(row);
 assert.deepEqual(Object.keys(shown),['id','rail','network','chain','txHash','token','decimals','amount','required','overpaid','plan','status','failureReason','from','to','source','createdAt','confirmedAt','periodStart','periodEnd','explorerUrl']);
 assert.equal(shown.id,7);assert.equal(shown.decimals,18);assert.equal(shown.amount,'10');assert.equal(shown.required,'9');assert.equal(shown.overpaid,true);
 assert.equal(shown.from,'0x4274907CE85E100a5EbAe1f7286DeB5083a52e98');assert.equal(shown.createdAt,'2026-10-01T00:00:00.000Z');assert.equal(shown.explorerUrl,'https://bscscan.com/tx/0x'+'ab'.repeat(32));
 const short=paymentView({...row,amount:(5n*E18).toString(),network:'bsc-testnet'});
 assert.equal(short.overpaid,false);assert.equal(short.explorerUrl,'https://testnet.bscscan.com/tx/0x'+'ab'.repeat(32));
});
