import {randomBytes} from 'node:crypto';
import {PLANS,planAmount} from './config.mjs';
import {transaction} from './db.mjs';
import {HttpError} from './http.mjs';
import {isAdmin,subscriptionFor} from './auth.mjs';
import {settlePaymentTx} from './subscriptions.mjs';
import {formatUnits} from './payments-common.mjs';
import {paymentView} from './accounts.mjs';
import {TRANSFER_TOPIC,addressTopic,decodeTransferLog,isAddress,hasValidChecksum,toChecksum,recoverPersonalSigner} from './evm.mjs';
import {quorumReceipt,finalizedBlock,canonicalBlock,transferLogs} from './bsc.mjs';
// The BNB Smart Chain (EVM) payment rail. A payment counts for a user only when the token Transfer's `from` is a
// wallet that user linked by signature. Every confirmation goes through settlePaymentTx, which settles a row once.
const MINUTE=60000,HOUR=60*MINUTE,CHALLENGE_MS=10*MINUTE,INTENT_MS=24*HOUR,MISSING_MS=30*MINUTE;
const iso=value=>value==null?null:new Date(value).toISOString();
const saveState=(db,key,value,now)=>db.query('INSERT INTO worker_state(key,value,updated_at) VALUES($1,$2,$3) ON CONFLICT(key) DO UPDATE SET value=EXCLUDED.value,updated_at=EXCLUDED.updated_at',[key,value,now]);

/**
 * Classifies a (normalised) receipt against the payment address. Candidates are Transfer logs from an accepted token
 * to payTo with exactly 32 bytes of data and a value above zero; zero-value Transfers, which anyone can emit "from" any
 * address, are ignored everywhere. Returns {result:'ok',token,from,amount,logs} or failed | wrong_token | wrong_recipient
 * | ambiguous | unlinked_wallet{from} (the last only when `linked` is given).
 */
export function evaluateReceipt(receipt,{payTo,tokens,linked=null}){
 if(receipt?.status!=='0x1')return {result:'failed'};
 const to=String(payTo).toLowerCase(),payTopic=addressTopic(to),accepted=new Map(tokens.map(t=>[t.address.toLowerCase(),t]));
 const logs=Array.isArray(receipt.logs)?receipt.logs:[],decoded=logs.map(decodeTransferLog);
 const candidates=decoded.filter(l=>l&&accepted.has(l.address)&&l.to===to&&l.value>0n);
 if(!candidates.length){
  const otherToken=logs.some((l,i)=>typeof l?.address==='string'&&!accepted.has(l.address.toLowerCase())&&Array.isArray(l.topics)&&l.topics.length>=3
   &&String(l.topics[0]).toLowerCase()===TRANSFER_TOPIC&&String(l.topics[2]).toLowerCase()===payTopic&&decoded[i]?.value!==0n);
  return {result:otherToken?'wrong_token':'wrong_recipient'};
 }
 if(new Set(candidates.map(l=>l.address)).size>1||new Set(candidates.map(l=>l.from)).size>1)return {result:'ambiguous',logs:candidates};
 const from=candidates[0].from;
 if(linked&&!linked.has(from))return {result:'unlinked_wallet',from};
 return {result:'ok',token:accepted.get(candidates[0].address),from,amount:candidates.reduce((sum,l)=>sum+l.value,0n),logs:candidates};
}

const planAllowed=(cfg,plan,admin)=>typeof plan==='string'&&Object.hasOwn(PLANS,plan)&&(plan!=='test'||(!!cfg.payments?.testPlan&&!!admin));
/** A plan the user may buy; `test` only for admins while PAYMENT_TEST_PLAN=1. */
export function checkPlan(cfg,user,plan){if(!planAllowed(cfg,plan,user?.isAdmin))throw new HttpError(400,'invalid_plan');return plan}
/** Payments must be configured; on testnet only admins may use them, so faucet tokens never buy real access. */
export function assertPaymentsOpen(cfg,user){
 const p=cfg.payments;
 if(!p?.enabled)throw new HttpError(503,'payments_disabled');
 if(p.network==='bsc-testnet'&&!user?.isAdmin)throw new HttpError(403,'payments_not_open');
 return p;
}
const findToken=(p,value)=>typeof value==='string'&&value.trim()?p.tokens.find(t=>t.symbol===value.trim().toUpperCase()||t.address===value.trim().toLowerCase())??null:null;

/** The text the wallet signs: it names the site, the account email (so a victim of login CSRF notices) and the nonce. */
export function challengeMessage({domain,email,address,chainId,nonce,issuedAt}){
 return [`${domain} asks you to link this wallet.`,'',`Link this wallet to ${email} for Kadena Community Edition Adoption Index payments. Signing is free and does not send a transaction.`,'',
  `Address: ${address}`,`Chain ID: ${chainId}`,`Nonce: ${nonce}`,`Issued At: ${issuedAt}`].join('\n');
}
export async function createChallenge(db,cfg,user,{address}={},{now=new Date()}={}){
 const p=assertPaymentsOpen(cfg,user);
 if(!isAddress(address)||!hasValidChecksum(address))throw new HttpError(400,'invalid_address');
 if((await db.query('SELECT count(*)::int AS n FROM wallet_challenges WHERE user_id=$1 AND created_at>$2',[user.id,new Date(now.getTime()-HOUR)])).rows[0].n>=30)throw new HttpError(429,'rate_limit');
 const nonce=randomBytes(16).toString('hex'),expiresAt=new Date(now.getTime()+CHALLENGE_MS),checksum=toChecksum(address);
 const message=challengeMessage({domain:new URL(cfg.publicSiteUrl).host,email:user.email,address:checksum,chainId:p.chainId,nonce,issuedAt:now.toISOString()});
 await db.query('INSERT INTO wallet_challenges(nonce,user_id,address,message,created_at,expires_at) VALUES($1,$2,$3,$4,$5,$6)',[nonce,user.id,address.toLowerCase(),message,now,expiresAt]);
 await db.query('DELETE FROM wallet_challenges WHERE user_id=$1 AND expires_at<$2',[user.id,new Date(now.getTime()-24*HOUR)]);
 return {nonce,message,expiresAt:expiresAt.toISOString(),address:checksum,chainId:p.chainId};
}
/** Verifies the personal_sign signature over the challenge and links the address to this user only. */
export async function linkWallet(db,cfg,user,{nonce,signature}={},{now=new Date()}={}){
 assertPaymentsOpen(cfg,user);
 if(typeof nonce!=='string'||!/^[0-9a-f]{32}$/.test(nonce))throw new HttpError(400,'challenge_expired');
 const challenge=(await db.query('SELECT address,message,expires_at,used_at FROM wallet_challenges WHERE nonce=$1 AND user_id=$2',[nonce,user.id])).rows[0];
 if(!challenge)throw new HttpError(400,'challenge_expired');
 const own=async client=>(await client.query('SELECT address,user_id,linked_at FROM wallets WHERE address=$1',[challenge.address])).rows[0];
 const linked=wallet=>({address:toChecksum(wallet.address),linkedAt:iso(wallet.linked_at)});
 if(challenge.used_at){const wallet=await own(db);if(wallet&&Number(wallet.user_id)===user.id)return {...linked(wallet),alreadyLinked:true};throw new HttpError(400,'challenge_expired')}
 if(new Date(challenge.expires_at)<=now)throw new HttpError(400,'challenge_expired');
 let signer;try{signer=recoverPersonalSigner(challenge.message,signature)}catch{throw new HttpError(400,'invalid_signature')}
 if(signer!==challenge.address)throw new HttpError(400,'invalid_signature');
 return transaction(db,async client=>{
  if(!(await client.query('UPDATE wallet_challenges SET used_at=$3 WHERE nonce=$1 AND user_id=$2 AND used_at IS NULL AND expires_at>$3',[nonce,user.id,now])).rowCount)throw new HttpError(400,'challenge_expired');
  const inserted=(await client.query('INSERT INTO wallets(address,user_id,message,signature,linked_at) VALUES($1,$2,$3,$4,$5) ON CONFLICT(address) DO NOTHING RETURNING address,user_id,linked_at',[challenge.address,user.id,challenge.message,signature.toLowerCase(),now])).rows[0];
  const wallet=inserted??await own(client);
  if(Number(wallet.user_id)!==user.id)throw new HttpError(409,'wallet_linked_elsewhere');
  return {...linked(wallet),alreadyLinked:!inserted};
 });
}

/** A 24-hour quote for one plan in one token; the amount is exact (9 or 79 token units), so no price feed is involved. */
export async function createIntent(db,cfg,user,{plan,token}={},{now=new Date()}={}){
 const p=assertPaymentsOpen(cfg,user);
 checkPlan(cfg,user,plan);
 const t=findToken(p,token);if(!t)throw new HttpError(400,'invalid_token');
 if((await db.query("SELECT count(*)::int AS n FROM payment_intents WHERE user_id=$1 AND rail='evm' AND created_at>$2",[user.id,new Date(now.getTime()-HOUR)])).rows[0].n>=30)throw new HttpError(429,'rate_limit');
 const amount=planAmount(plan,t.decimals),expiresAt=new Date(now.getTime()+INTENT_MS);
 const id=(await db.query(`INSERT INTO payment_intents(user_id,rail,network,chain,plan,token,token_address,decimals,amount,pay_to,created_at,expires_at)
  VALUES($1,'evm',$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) RETURNING id`,[user.id,p.network,String(p.chainId),plan,t.symbol,t.address,t.decimals,amount.toString(),p.payTo,now,expiresAt])).rows[0].id;
 return {intentId:Number(id),plan,payTo:p.payToChecksum,tokenAddress:t.checksum,token:t.symbol,decimals:t.decimals,amount:amount.toString(),amountDisplay:formatUnits(amount,t.decimals),chainId:p.chainId,expiresAt:expiresAt.toISOString()};
}

const paymentByHash=async(db,network,hash)=>(await db.query('SELECT * FROM payments WHERE network=$1 AND tx_hash=$2',[network,hash])).rows[0]??null;
const paymentById=async(db,id)=>(await db.query('SELECT * FROM payments WHERE id=$1',[id])).rows[0];
const reopenable=row=>row.status==='pending'||(row.status==='failed'&&row.failure_reason==='receipt_missing');

/** The most valuable public plan the amount pays for in full, or null (the hidden test plan is never inferred). */
export const paidPlan=(amount,decimals)=>BigInt(amount)>=planAmount('annual',decimals)?'annual':BigInt(amount)>=planAmount('monthly',decimals)?'monthly':null;
// An unmatched transfer an admin already handled (refunded, or credited by hand) must never be credited again.
const ADMIN_RESOLVED="resolved_note IS NOT NULL AND resolved_note NOT LIKE 'processing_error:%' AND resolved_note NOT LIKE 'claimed by payment%'";
/**
 * Inserts the payment as pending with its plan, in one transaction that also claims the intent. An intentId (the
 * checkout's own send) is used when it is this user's, EVM, this network, the paid token, unclaimed and covered by the
 * amount; else the `plan` parameter decides. Otherwise (a pasted hash, the reconciler) the payment buys the most valuable
 * plan it pays for in full: the user's best open intent that fits, or the public plan the amount covers, whichever is
 * worth more, so an open monthly intent never turns a 79-token payment into 30 days. Returns null if the hash exists.
 */
async function recordPayment(db,cfg,{userId,admin,txHash,ev,receipt,source,intentId=null,plan=null,at,now}){
 const p=cfg.payments,allowed=Object.keys(PLANS).filter(id=>planAllowed(cfg,id,admin));
 return transaction(db,async client=>{
  const usable="user_id=$1 AND rail='evm' AND network=$2 AND token_address=$3 AND payment_id IS NULL AND amount<=$4::numeric AND plan=ANY($5::text[])";
  const args=[userId,p.network,ev.token.address,ev.amount.toString(),allowed];
  // Locked with the insert: two payments can never both claim one intent.
  if((await client.query(`SELECT 1 FROM unmatched_transfers WHERE network=$1 AND tx_hash=$2 AND ${ADMIN_RESOLVED} LIMIT 1 FOR UPDATE`,[p.network,txHash])).rowCount)throw new HttpError(409,'transfer_resolved');
  let intent=intentId?(await client.query(`SELECT id,plan FROM payment_intents WHERE id=$6 AND ${usable} FOR UPDATE`,[...args,intentId])).rows[0]:null,inferred=null;
  if(!intent&&!plan){
   const best=(await client.query(`SELECT id,plan,amount FROM payment_intents WHERE ${usable} AND expires_at>$6 ORDER BY amount DESC,created_at DESC,id DESC LIMIT 1 FOR UPDATE SKIP LOCKED`,[...args,at])).rows[0];
   inferred=paidPlan(ev.amount,ev.token.decimals);
   if(best&&(!inferred||BigInt(best.amount)>=planAmount(inferred,ev.token.decimals)))intent=best;
  }
  // Below every plan price: recorded against monthly, so it settles as underpaid.
  const chosen=intent?.plan??plan??inferred??'monthly';
  const row=(await client.query(`INSERT INTO payments(rail,network,chain,tx_hash,user_id,intent_id,from_address,to_address,token,token_address,decimals,amount,required_amount,plan,status,block_number,block_hash,source,created_at,updated_at)
   VALUES('evm',$1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,'pending',$14,$15,$16,$17,$17) ON CONFLICT(network,tx_hash) DO NOTHING RETURNING *`,
   [p.network,String(p.chainId),txHash,userId,intent?.id??null,ev.from,p.payTo,ev.token.symbol,ev.token.address,ev.token.decimals,ev.amount.toString(),planAmount(chosen,ev.token.decimals).toString(),chosen,receipt.blockNumber,receipt.blockHash,source,now])).rows[0];
  if(!row)return null;
  if(intent&&!(await client.query('UPDATE payment_intents SET payment_id=$2 WHERE id=$1 AND payment_id IS NULL RETURNING id',[intent.id,row.id])).rowCount)throw new Error('The payment intent was claimed concurrently');
  await client.query("UPDATE unmatched_transfers SET resolved_note=$3 WHERE network=$1 AND tx_hash=$2 AND (resolved_note IS NULL OR resolved_note LIKE 'processing_error:%')",[p.network,txHash,`claimed by payment ${row.id}`]);
  return row;
 });
}
const missingKey=id=>`receipt_missing:${id}`;
// Only consecutive not_found answers count towards the 30 minutes; an unavailable answer pauses the clock.
async function noteMissing(db,row,state,now){
 const key=missingKey(row.id),prev=(await db.query('SELECT value FROM worker_state WHERE key=$1',[key])).rows[0]?.value??null;
 if(state!=='not_found'){if(prev)await saveState(db,key,{...prev,lastState:state,lastAt:now.toISOString()},now);return}
 const missingMs=(Number(prev?.missingMs)||0)+(prev?.lastState==='not_found'?Math.max(0,now-Date.parse(prev.lastAt)):0);
 if(missingMs<MISSING_MS)return saveState(db,key,{missingMs,lastState:'not_found',lastAt:now.toISOString()},now);
 await db.query("UPDATE payments SET status='failed',failure_reason='receipt_missing',updated_at=$2 WHERE id=$1 AND status='pending'",[row.id,now]);
 await db.query('DELETE FROM worker_state WHERE key=$1',[key]);
}
/**
 * Moves one payment towards settlement, from the checkout re-POST, the worker or the reconciler alike: the receipt comes
 * from the quorum (re-fetched unless just fetched), its block must be at or below the finalized height and still carry
 * the receipt's hash on `quorum` providers, and the receipt is re-evaluated. Only then is the payment settled.
 */
async function confirmRow(db,cfg,row,{now,receipt=null,quorum=null,finalized,block=null,rpc}){
 const p=cfg.payments,found=quorum??(receipt?{state:'found',receipt}:await quorumReceipt(cfg,row.tx_hash,rpc));
 if(found.state!=='found'){if(row.status==='pending')await noteMissing(db,row,found.state,now);return paymentById(db,row.id)}
 await db.query('DELETE FROM worker_state WHERE key=$1',[missingKey(row.id)]);
 const r=found.receipt;
 if(row.status==='failed'){
  // The receipt is back after it went missing (a reorg, or lagging providers): the payment gets its second chance.
  row=(await db.query("UPDATE payments SET status='pending',failure_reason=NULL,updated_at=$2 WHERE id=$1 AND status='failed' AND failure_reason='receipt_missing' RETURNING *",[row.id,now])).rows[0]??await paymentById(db,row.id);
 }
 if(row.status!=='pending')return row;
 if(Number(row.block_number)!==r.blockNumber||row.block_hash!==r.blockHash)
  row=(await db.query("UPDATE payments SET block_number=$2,block_hash=$3,updated_at=$4 WHERE id=$1 AND status='pending' RETURNING *",[row.id,r.blockNumber,r.blockHash,now])).rows[0]??await paymentById(db,row.id);
 if(row.status!=='pending')return row;
 const height=finalized===undefined?await finalizedBlock(cfg,rpc).catch(()=>null):finalized;
 if(height===null||r.blockNumber>height)return row;
 const canonical=block??await canonicalBlock(cfg,r.blockNumber,r.blockHash,rpc);
 if(!canonical.canonical)return row;
 // Final from here on: failure and underpayment are decided on this receipt only.
 const ev=evaluateReceipt(r,{payTo:p.payTo,tokens:p.tokens});
 if(ev.result!=='ok'||ev.from!==row.from_address||ev.token.address!==row.token_address){
  const reason=ev.result==='failed'?'reverted':ev.result==='ok'?'transfer_changed':ev.result;
  return (await db.query("UPDATE payments SET status='failed',failure_reason=$2,updated_at=$3 WHERE id=$1 AND status='pending' RETURNING *",[row.id,reason,now])).rows[0]??paymentById(db,row.id);
 }
 if(ev.amount!==BigInt(row.amount))await db.query("UPDATE payments SET amount=$2,updated_at=$3 WHERE id=$1 AND status='pending'",[row.id,ev.amount.toString(),now]);
 await settlePaymentTx(db,cfg,row.id,{now,block:{number:r.blockNumber,hash:r.blockHash}});
 return paymentById(db,row.id);
}
function receiptError(ev){
 if(ev.result==='unlinked_wallet')return new HttpError(403,'unlinked_wallet',{from:toChecksum(ev.from)});
 return new HttpError(422,{failed:'tx_failed',wrong_token:'wrong_token',wrong_recipient:'wrong_recipient',ambiguous:'ambiguous_payment'}[ev.result]??'tx_failed');
}
async function outcome(db,row,now){return {status:row.status,payment:paymentView(row),subscription:await subscriptionFor(db,Number(row.user_id),now)}}
async function resubmit(db,cfg,user,row,{now,rpc}){
 if(Number(row.user_id)!==user.id)throw new HttpError(409,'tx_already_used');
 if(!reopenable(row))return row;
 // In parallel, so a re-POST answers within one RPC timeout plus the block-hash check.
 const [quorum,finalized]=await Promise.all([quorumReceipt(cfg,row.tx_hash,rpc),finalizedBlock(cfg,rpc).catch(()=>null)]);
 return confirmRow(db,cfg,row,{now,quorum,finalized,rpc});
}
/**
 * Checkout submission (and the site's 3-second re-POST). Idempotent per user: an existing row is re-checked, never
 * duplicated; another user's hash is 409. Nothing is stored unless the quorum returned the receipt and it pays payTo
 * from one of this user's wallets. Uses 4-second RPC timeouts so the answer fits the site's request timeout.
 */
export async function submitPayment(db,cfg,user,{txHash,intentId,plan}={},{now=new Date(),timeoutMs=4000,fetch,log}={}){
 const p=assertPaymentsOpen(cfg,user);
 const hash=typeof txHash==='string'&&/^0x[0-9a-fA-F]{64}$/.test(txHash.trim())?txHash.trim().toLowerCase():null;
 if(!hash)throw new HttpError(400,'invalid_tx_hash');
 const chosenPlan=plan===undefined||plan===null||plan===''?null:checkPlan(cfg,user,plan);
 const intent=(Number.isSafeInteger(intentId)||(typeof intentId==='string'&&/^\d{1,15}$/.test(intentId)))&&Number(intentId)>0?Number(intentId):null,rpc={timeoutMs,fetch,log};
 const existing=await paymentByHash(db,p.network,hash);
 if(existing)return outcome(db,await resubmit(db,cfg,user,existing,{now,rpc}),now);
 const [found,finalized]=await Promise.all([quorumReceipt(cfg,hash,rpc),finalizedBlock(cfg,rpc).catch(()=>null)]);
 // A receipt that fewer than `quorum` providers have seen yet is simply not there yet.
 if(found.state==='not_found'||(found.state==='unavailable'&&found.reason==='partial'))throw new HttpError(404,'tx_not_found',{retry:true});
 if(found.state!=='found')throw new HttpError(503,'providers_unavailable');
 const linked=new Set((await db.query('SELECT address FROM wallets WHERE user_id=$1',[user.id])).rows.map(r=>r.address));
 const receipt=found.receipt,ev=evaluateReceipt(receipt,{payTo:p.payTo,tokens:p.tokens,linked});
 if(ev.result!=='ok')throw receiptError(ev);
 const block=finalized!==null&&receipt.blockNumber<=finalized?await canonicalBlock(cfg,receipt.blockNumber,receipt.blockHash,rpc):null;
 const at=block?.canonical&&block.timestamp!==null?new Date(block.timestamp*1000):now;
 const row=await recordPayment(db,cfg,{userId:user.id,admin:user.isAdmin,txHash:hash,ev,receipt,source:'checkout',intentId:intent,plan:chosenPlan,at,now});
 if(!row)return outcome(db,await resubmit(db,cfg,user,await paymentByHash(db,p.network,hash),{now,rpc}),now);
 return outcome(db,await confirmRow(db,cfg,row,{now,receipt,finalized,block,rpc}),now);
}
/** Worker: re-checks every pending EVM payment on this network. One row's failure never stops the others. */
export async function confirmPending(db,cfg,{now=new Date(),timeoutMs=8000,fetch,log=()=>{},signal,limit=200}={}){
 if(!cfg.payments?.enabled)return {skipped:'payments_disabled'};
 const p=cfg.payments,rows=(await db.query("SELECT * FROM payments WHERE rail='evm' AND network=$1 AND status='pending' ORDER BY id LIMIT $2",[p.network,limit])).rows;
 const summary={checked:0,confirmed:0,underpaid:0,failed:0,pending:0,errors:0};
 if(!rows.length)return summary;
 const rpc={timeoutMs,fetch,log};
 const finalized=await finalizedBlock(cfg,rpc).catch(error=>{log({event:'payment_finality_unavailable',network:p.network,code:error.code??null,message:String(error.message).slice(0,200)});return null});
 for(const row of rows){
  if(signal?.aborted)break;
  try{const after=await confirmRow(db,cfg,row,{now,finalized,rpc});summary.checked++;summary[after.status]=(summary[after.status]??0)+1}
  catch(error){summary.errors++;log({event:'payment_confirm_failed',paymentId:Number(row.id),name:error.name,code:error.code??null,message:String(error.message).slice(0,200)})}
 }
 return summary;
}
const dustLimit=decimals=>10n**BigInt(Math.max(0,decimals-2));
// Transfers nobody can be credited for, for the admin page. Below 0.01 token they are address-poisoning noise.
async function recordUnmatched(db,cfg,logs,{note=null,now}){
 const p=cfg.payments;let recorded=0;
 for(const l of logs){
  const token=p.tokens.find(t=>t.address===l.address);
  if(!token||l.value<dustLimit(token.decimals)||!l.transactionHash||l.logIndex===null||l.blockNumber===null)continue;
  recorded+=(await db.query('INSERT INTO unmatched_transfers(network,tx_hash,log_index,from_address,token,amount,block_number,seen_at,resolved_note) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9) ON CONFLICT(network,tx_hash,log_index) DO NOTHING',
   [p.network,l.transactionHash,l.logIndex,l.from,token.symbol,l.value.toString(),l.blockNumber,now,note])).rowCount;
 }
 return recorded;
}
const transient=(message,code)=>Object.assign(new Error(message),{code,transient:true});
async function reconcileTx(db,cfg,hash,{now,finalized,rpc}){
 const p=cfg.payments,existing=await paymentByHash(db,p.network,hash);
 // Already recorded and settled: nothing to fetch, and never an unmatched row for a credited payment.
 if(existing&&!reopenable(existing))return 'existing';
 if(!existing&&(await db.query(`SELECT 1 FROM unmatched_transfers WHERE network=$1 AND tx_hash=$2 AND ${ADMIN_RESOLVED} LIMIT 1`,[p.network,hash])).rowCount)return 'ignored';
 const found=await quorumReceipt(cfg,hash,rpc);
 if(found.state!=='found')throw transient(`The receipt is ${found.state}${found.reason?` (${found.reason})`:''}`,found.state==='not_found'?'receipt_not_found':'providers_unavailable');
 const receipt=found.receipt,ev=evaluateReceipt(receipt,{payTo:p.payTo,tokens:p.tokens});
 if(existing){await confirmRow(db,cfg,existing,{now,receipt,finalized,rpc});return 'existing'}
 const located=(ev.logs??[]).map(l=>({...l,transactionHash:hash,blockNumber:receipt.blockNumber}));
 if(ev.result==='ambiguous')return await recordUnmatched(db,cfg,located,{now})?'unmatched':'ignored';
 if(ev.result!=='ok')return 'ignored';
 const owner=(await db.query('SELECT w.user_id,u.email FROM wallets w JOIN users u ON u.id=w.user_id WHERE w.address=$1',[ev.from])).rows[0];
 if(!owner)return await recordUnmatched(db,cfg,located,{now})?'unmatched':'ignored';
 const admin=isAdmin(owner.email,cfg);
 if(p.network==='bsc-testnet'&&!admin)return 'ignored';
 const block=await canonicalBlock(cfg,receipt.blockNumber,receipt.blockHash,rpc),at=block.timestamp!==null?new Date(block.timestamp*1000):now;
 const row=await recordPayment(db,cfg,{userId:Number(owner.user_id),admin,txHash:hash,ev,receipt,source:'reconciler',at,now})??await paymentByHash(db,p.network,hash);
 await confirmRow(db,cfg,row,{now,receipt,finalized,block,rpc});
 return 'credited';
}
/**
 * Backstop for payments whose checkout tab closed: scans finalized blocks for accepted-token Transfers to payTo.
 * The checkpoint `payment_scan_block:<network>` = {next (first unscanned block), chainId}; it advances only after a
 * whole chunk is processed. A transaction that keeps failing is recorded as a processing_error after `maxAttempts`
 * runs rather than holding the checkpoint back for ever.
 */
export async function reconcile(db,cfg,{now=new Date(),timeoutMs=8000,fetch,log=()=>{},signal,maxChunks=20,maxAttempts=3}={}){
 if(!cfg.payments?.enabled)return {skipped:'payments_disabled'};
 const p=cfg.payments,rpc={timeoutMs,fetch,log},key=`payment_scan_block:${p.network}`;
 const finalized=await finalizedBlock(cfg,rpc),stored=(await db.query('SELECT value FROM worker_state WHERE key=$1',[key])).rows[0]?.value;
 let state;
 if(!stored){state={next:p.scanStartBlock??finalized,chainId:p.chainId,attempts:0};log({event:'scan_checkpoint_seeded',network:p.network,next:state.next});await saveState(db,key,state,now)}
 else if(!Number.isSafeInteger(stored.next)||stored.next<0||stored.next>finalized+1000||stored.chainId!==p.chainId){
  // Another chain's checkpoint (testnet heights are millions of blocks above mainnet) or a corrupt one: restart at finalized.
  log({event:'scan_checkpoint_invalid',network:p.network,next:stored.next??null,chainId:stored.chainId??null,finalized});
  state={next:finalized,chainId:p.chainId,attempts:0};await saveState(db,key,state,now);
 }else state={next:stored.next,chainId:p.chainId,attempts:Number.isSafeInteger(stored.attempts)?stored.attempts:0};
 const summary={finalized,from:state.next,chunks:0,transactions:0,credited:0,existing:0,unmatched:0,ignored:0,errors:0,retrying:0};
 for(let chunk=0;chunk<maxChunks&&state.next<=finalized&&!signal?.aborted;chunk++){
  const fromBlock=state.next,toBlock=Math.min(finalized,fromBlock+p.logChunk-1),byTx=new Map();
  for(const l of await transferLogs(cfg,{fromBlock,toBlock,...rpc}))if(l.value>0n){if(!byTx.has(l.transactionHash))byTx.set(l.transactionHash,[]);byTx.get(l.transactionHash).push(l)}
  let retry=0;
  for(const [hash,logs] of byTx){
   if(signal?.aborted){summary.next=state.next;return summary}
   summary.transactions++;
   try{summary[await reconcileTx(db,cfg,hash,{now,finalized,rpc})]++}
   catch(error){
    const code=String(error.code??error.name??'error').replace(/[^\w.-]/g,'').slice(0,40)||'error';
    log({event:'reconcile_tx_failed',network:p.network,txHash:hash,code,transient:!!error.transient,message:String(error.message).slice(0,200)});
    if(error.transient&&state.attempts+1<maxAttempts){retry++;continue}
    summary.errors++;
    // A transaction that already has a payment is tracked there; an unmatched row would invite a second, manual credit.
    if(await paymentByHash(db,p.network,hash).catch(()=>null))continue;
    await recordUnmatched(db,cfg,logs,{note:`processing_error: ${code}`,now}).catch(e=>log({event:'reconcile_record_failed',network:p.network,txHash:hash,name:e.name,message:String(e.message).slice(0,200)}));
   }
  }
  if(retry){state={...state,attempts:state.attempts+1};await saveState(db,key,state,now);summary.retrying=retry;break}
  state={next:toBlock+1,chainId:p.chainId,attempts:0};await saveState(db,key,state,now);summary.chunks++;
 }
 summary.next=state.next;
 return summary;
}
