import {transaction} from './db.mjs';
import {HttpError} from './http.mjs';
import {normalizeEmail,subscriptionFor} from './auth.mjs';
import {EVM_NETWORKS} from './config.mjs';
import {isAddress,toChecksum} from './evm-address.mjs';
import {explorerTxUrl,formatUnits} from './payments-common.mjs';
import {extendSubscription} from './subscriptions.mjs';
import {paymentView} from './accounts.mjs';
import {reportView} from './reports.mjs';
const iso=value=>value==null?null:new Date(value).toISOString();
// The reconciler records rows it could not process as 'processing_error: …'; those still need an admin.
const RESOLVED="(resolved_note IS NOT NULL AND resolved_note NOT LIKE 'processing_error:%')";
const isResolved=note=>typeof note==='string'&&!note.startsWith('processing_error:');
const cleanNote=value=>{const note=typeof value==='string'?value.trim():'';if(!note||note.length>500)throw new HttpError(400,'invalid_note');return note};
const wholeNumber=value=>typeof value==='number'?value:typeof value==='string'&&/^\d{1,9}$/.test(value.trim())?Number(value):NaN;
function tokenDecimals(cfg,network,token){
 const key=String(token??'').toLowerCase(),match=list=>list?.find(t=>t.symbol.toLowerCase()===key||t.address===key);
 const configured=cfg.payments?.network===network?match(cfg.payments.tokens):null;
 if(configured)return configured.decimals;
 const known=EVM_NETWORKS[network]?.tokens.map(([symbol,address,decimals])=>({symbol,address:address.toLowerCase(),decimals}));
 return match(known)?.decimals??null;
}
function unmatchedView(row,cfg){
 const decimals=tokenDecimals(cfg,row.network,row.token);
 return {network:row.network,txHash:row.tx_hash,logIndex:Number(row.log_index),from:isAddress(row.from_address)?toChecksum(row.from_address):row.from_address,token:row.token,
  amount:decimals==null?String(row.amount):formatUnits(row.amount,decimals),amountBaseUnits:String(row.amount),decimals,blockNumber:Number(row.block_number),
  seenAt:iso(row.seen_at),resolvedNote:row.resolved_note??null,resolved:isResolved(row.resolved_note),explorerUrl:explorerTxUrl(row)};
}
/** GET /admin/overview: recent payments, transfers nobody could be matched to (unresolved first), subscriptions, data issue reports (open first) and counts. */
export async function adminOverview(db,cfg,{now=new Date()}={}){
 // One query at a time: the API pool is small and shared with every visitor.
 const payments=await db.query('SELECT p.*,u.email FROM payments p JOIN users u ON u.id=p.user_id ORDER BY p.created_at DESC,p.id DESC LIMIT 200');
 const unmatched=await db.query(`SELECT * FROM unmatched_transfers ORDER BY ${RESOLVED},seen_at DESC,block_number DESC,log_index LIMIT 100`);
 const subscriptions=await db.query('SELECT s.user_id,s.plan,s.started_at,s.expires_at,u.email FROM subscriptions s JOIN users u ON u.id=s.user_id ORDER BY s.expires_at DESC,s.user_id');
 const counts=await db.query(`SELECT (SELECT count(*) FROM users)::int AS users,(SELECT count(*) FROM subscriptions WHERE expires_at>$1)::int AS "activeSubscriptions",
  (SELECT count(*) FROM payments WHERE status='confirmed')::int AS "confirmedPayments",(SELECT count(*) FROM payments WHERE status='pending')::int AS "pendingPayments",
  (SELECT count(*) FROM unmatched_transfers WHERE NOT ${RESOLVED})::int AS "unresolvedTransfers",
  (SELECT count(*) FROM email_outbox WHERE status='queued')::int AS "queuedEmails",(SELECT count(*) FROM email_outbox WHERE status='failed')::int AS "failedEmails",
  (SELECT count(*) FROM data_reports WHERE resolved_at IS NULL)::int AS "openReports"`,[now]);
 const actions=await db.query('SELECT id,admin_email,action,user_id,details,created_at FROM admin_actions ORDER BY id DESC LIMIT 50');
 const reports=await db.query('SELECT id,indicator,description,evidence,email,created_at,resolved_at,resolved_by,resolved_note FROM data_reports ORDER BY resolved_at IS NOT NULL,created_at DESC,id DESC LIMIT 100');
 return {
  network:cfg.payments?.enabled?cfg.payments.network:null,testnet:cfg.payments?.network==='bsc-testnet',
  payments:payments.rows.map(row=>({...paymentView(row),userId:Number(row.user_id),email:row.email,intentId:row.intent_id==null?null:Number(row.intent_id),blockNumber:row.block_number==null?null:Number(row.block_number)})),
  unmatched:unmatched.rows.map(row=>unmatchedView(row,cfg)),
  subscriptions:subscriptions.rows.map(row=>({userId:Number(row.user_id),email:row.email,plan:row.plan,startedAt:iso(row.started_at),expiresAt:iso(row.expires_at),active:new Date(row.expires_at)>now})),
  counts:counts.rows[0],
  actions:actions.rows.map(row=>({id:Number(row.id),adminEmail:row.admin_email,action:row.action,userId:row.user_id==null?null:Number(row.user_id),details:row.details,createdAt:iso(row.created_at)})),
  reports:reports.rows.map(reportView)};
}
/**
 * POST /admin/subscriptions/extend: grants `days` of access (expires = max(now, expires) + days), keeping the current
 * plan or 'manual'. An unknown email gets an account. Audited in admin_actions.
 */
export async function adminExtend(db,adminEmail,{email:input,days:rawDays,note:rawNote}={},{now=new Date()}={}){
 const email=normalizeEmail(input);
 if(!email)throw new HttpError(400,'invalid_email');
 const days=wholeNumber(rawDays);
 if(!Number.isSafeInteger(days)||days<1||days>400)throw new HttpError(400,'invalid_days');
 const note=cleanNote(rawNote);
 return transaction(db,async c=>{
  const created=(await c.query('INSERT INTO users(email) VALUES($1) ON CONFLICT(email) DO NOTHING RETURNING id',[email])).rows[0];
  const userId=Number(created?.id??(await c.query('SELECT id FROM users WHERE email=$1',[email])).rows[0].id);
  const before=(await c.query('SELECT plan,expires_at FROM subscriptions WHERE user_id=$1',[userId])).rows[0];
  const plan=before?.plan??'manual',{periodStart,periodEnd}=await extendSubscription(c,userId,{plan,days,now});
  await c.query('INSERT INTO admin_actions(admin_email,action,user_id,details,created_at) VALUES($1,$2,$3,$4,$5)',[adminEmail,'extend_subscription',userId,
   JSON.stringify({email,days,note,plan,userCreated:!!created,previousExpiresAt:iso(before?.expires_at),periodStart:periodStart.toISOString(),periodEnd:periodEnd.toISOString()}),now]);
  return {subscription:await subscriptionFor(c,userId,now),userCreated:!!created};
 });
}
/** POST /admin/unmatched/resolve: records what happened to a transfer that matched no account. Audited in admin_actions. */
export async function resolveUnmatched(db,cfg,adminEmail,{network,txHash,logIndex,note:rawNote}={},{now=new Date()}={}){
 if(typeof network!=='string'||!Object.hasOwn(EVM_NETWORKS,network))throw new HttpError(400,'invalid_network');
 if(typeof txHash!=='string'||!/^0x[0-9a-fA-F]{64}$/.test(txHash))throw new HttpError(400,'invalid_tx_hash');
 const hash=txHash.toLowerCase();
 const index=wholeNumber(logIndex);
 if(!Number.isSafeInteger(index)||index<0)throw new HttpError(400,'invalid_log_index');
 const note=cleanNote(rawNote);
 return transaction(db,async c=>{
  const previous=(await c.query('SELECT resolved_note FROM unmatched_transfers WHERE network=$1 AND tx_hash=$2 AND log_index=$3 FOR UPDATE',[network,hash,index])).rows[0];
  if(!previous)throw new HttpError(404,'not_found');
  const row=(await c.query('UPDATE unmatched_transfers SET resolved_note=$4 WHERE network=$1 AND tx_hash=$2 AND log_index=$3 RETURNING *',[network,hash,index,note])).rows[0];
  await c.query('INSERT INTO admin_actions(admin_email,action,user_id,details,created_at) VALUES($1,$2,NULL,$3,$4)',[adminEmail,'resolve_unmatched',
   JSON.stringify({network,txHash:hash,logIndex:index,note,previousNote:previous.resolved_note??null}),now]);
  return {ok:true,unmatched:unmatchedView(row,cfg)};
 });
}
/** POST /admin/reports/resolve: closes a data issue report with the admin's note. Audited in admin_actions. */
export async function resolveReport(db,adminEmail,{id,note:rawNote}={},{now=new Date()}={}){
 const reportId=wholeNumber(id);
 if(!Number.isSafeInteger(reportId)||reportId<1)throw new HttpError(400,'invalid_id');
 const note=cleanNote(rawNote);
 return transaction(db,async c=>{
  const previous=(await c.query('SELECT resolved_at FROM data_reports WHERE id=$1 FOR UPDATE',[reportId])).rows[0];
  if(!previous)throw new HttpError(404,'not_found');
  if(previous.resolved_at)throw new HttpError(409,'already_resolved');
  const row=(await c.query('UPDATE data_reports SET resolved_at=$2,resolved_by=$3,resolved_note=$4 WHERE id=$1 RETURNING *',[reportId,now,adminEmail,note])).rows[0];
  await c.query('INSERT INTO admin_actions(admin_email,action,user_id,details,created_at) VALUES($1,$2,NULL,$3,$4)',[adminEmail,'resolve_report',JSON.stringify({reportId,indicator:row.indicator,note}),now]);
  return {ok:true,report:reportView(row)};
 });
}
