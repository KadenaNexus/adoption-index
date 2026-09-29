import {PLANS} from './config.mjs';
import {transaction} from './db.mjs';
import {enqueueEmail} from './outbox.mjs';
import {paymentConfirmed,paymentUnderpaid} from './emails.mjs';
import {explorerTxUrl,formatUnits} from './payments-common.mjs';
const DAY=86400000;
/**
 * Starts or extends a subscription inside the caller's transaction. While access is active the new period
 * starts at the current expiry, otherwise now. Serialised per user, so two confirmations cannot both read
 * the old expiry.
 */
export async function extendSubscription(client,userId,{plan,days,now=new Date()}){
 if(!Number.isSafeInteger(days)||days<1)throw new Error('Invalid subscription length');
 await client.query("SELECT pg_advisory_xact_lock(hashtext('kce-subscription:'||$1::text))",[userId]);
 const row=(await client.query('SELECT expires_at FROM subscriptions WHERE user_id=$1 FOR UPDATE',[userId])).rows[0];
 const active=!!row&&new Date(row.expires_at)>now,periodStart=active?new Date(row.expires_at):now,periodEnd=new Date(periodStart.getTime()+days*DAY);
 if(!row)await client.query('INSERT INTO subscriptions(user_id,plan,started_at,expires_at,updated_at) VALUES($1,$2,$3,$4,$3)',[userId,plan,now,periodEnd]);
 else await client.query('UPDATE subscriptions SET plan=$2,expires_at=$3,started_at=CASE WHEN $4 THEN started_at ELSE $5 END,updated_at=$5 WHERE user_id=$1',[userId,plan,periodEnd,active,now]);
 return {periodStart,periodEnd};
}
/**
 * Settles a pending payment inside the caller's transaction, once its transaction is final on-chain:
 * underpaid (no access) or confirmed (access extended). Queues the matching email. Idempotent: a row that is
 * no longer pending is returned unchanged. `block` records where the payment was included.
 */
export async function settlePayment(client,cfg,paymentId,{now=new Date(),block=null}={}){
 const payment=(await client.query('SELECT p.*,u.email FROM payments p JOIN users u ON u.id=p.user_id WHERE p.id=$1 FOR UPDATE OF p',[paymentId])).rows[0];
 if(!payment)throw new Error('Unknown payment');
 if(payment.status!=='pending')return {payment,outcome:payment.status,changed:false};
 const plan=PLANS[payment.plan];
 if(!plan)throw new Error('Unknown plan on payment');
 const blockNumber=block?.number??payment.block_number,blockHash=block?.hash??payment.block_hash;
 const amount=formatUnits(payment.amount,payment.decimals),required=formatUnits(payment.required_amount,payment.decimals),explorerUrl=explorerTxUrl(payment);
 if(BigInt(payment.amount)<BigInt(payment.required_amount)){
  const updated=(await client.query("UPDATE payments SET status='underpaid',block_number=$2,block_hash=$3,confirmed_at=$4,updated_at=$4 WHERE id=$1 RETURNING *",[payment.id,blockNumber,blockHash,now])).rows[0];
  await enqueueEmail(client,{dedupeKey:`payment:${payment.id}`,kind:'payment_underpaid',to:payment.email,message:paymentUnderpaid({amount,required,token:payment.token,txHash:payment.tx_hash,explorerUrl,publicSiteUrl:cfg.publicSiteUrl,supportEmail:cfg.mail?.supportEmail})});
  return {payment:updated,outcome:'underpaid',changed:true};
 }
 const {periodStart,periodEnd}=await extendSubscription(client,payment.user_id,{plan:payment.plan,days:plan.days,now});
 const updated=(await client.query("UPDATE payments SET status='confirmed',block_number=$2,block_hash=$3,period_start=$4,period_end=$5,confirmed_at=$6,updated_at=$6 WHERE id=$1 RETURNING *",[payment.id,blockNumber,blockHash,periodStart,periodEnd,now])).rows[0];
 if(payment.intent_id)await client.query('UPDATE payment_intents SET payment_id=$2 WHERE id=$1 AND payment_id IS NULL',[payment.intent_id,payment.id]);
 await enqueueEmail(client,{dedupeKey:`payment:${payment.id}`,kind:'payment_confirmed',to:payment.email,message:paymentConfirmed({plan:payment.plan,days:plan.days,amount,token:payment.token,periodEnd:periodEnd.toISOString(),txHash:payment.tx_hash,explorerUrl,publicSiteUrl:cfg.publicSiteUrl,supportEmail:cfg.mail?.supportEmail})});
 return {payment:updated,outcome:'confirmed',changed:true,periodStart,periodEnd};
}
/** settlePayment in its own transaction. Its row lock only holds inside a transaction, so pool callers use this. */
export const settlePaymentTx=(pool,cfg,paymentId,options)=>transaction(pool,client=>settlePayment(client,cfg,paymentId,options));
