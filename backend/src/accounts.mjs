import {randomInt,timingSafeEqual} from 'node:crypto';
import {transaction} from './db.mjs';
import {HttpError} from './http.mjs';
import {TOKEN_PATTERN,newToken,hashToken,normalizeEmail,safeNextPath,isAdmin} from './auth.mjs';
import {isAddress,toChecksum} from './evm-address.mjs';
import {explorerTxUrl,formatUnits} from './payments-common.mjs';
import {loginLink} from './emails.mjs';
import {sendWithin} from './mailer.mjs';
const MINUTE=60000,HOUR=60*MINUTE,DAY=24*HOUR;
export const LOGIN_TTL_MS=15*MINUTE,SESSION_TTL_MS=30*DAY,MAX_CODE_ATTEMPTS=5,MAX_CODE_FAILURES_PER_DAY=10,MAX_ALERTS=5,MAIL_TIMEOUT_MS=10000;
/**
 * Sign-in emails: per address, per visitor IP, and to addresses without an account across everyone (protects the
 * sender's quota and reputation). Existing accounts are never held back by that last one.
 */
export const LOGIN_LIMITS=Object.freeze({perEmail:{max:3,ms:15*MINUTE},perIp:{max:10,ms:HOUR},global:{max:100,ms:HOUR}});
const iso=value=>value==null?null:new Date(value).toISOString();
const ago=(now,ms)=>new Date(now.getTime()-ms);

/** Stores a single-use login token (link) with its 6-digit code, then emails both. Nothing secret is logged. */
export async function requestLoginLink(db,cfg,mailer,{email:input,next,clientIp,now=new Date(),mailTimeoutMs=MAIL_TIMEOUT_MS}={}){
 const email=normalizeEmail(input);
 if(!email)throw new HttpError(400,'invalid_email');
 if(cfg.mail.transport==='none'||mailer?.transport==='none')throw new HttpError(503,'mail_not_configured');
 // Until email really goes out (log transport on the public site), only admins can test sign-in.
 if(!cfg.mail.open&&!isAdmin(email,cfg))throw new HttpError(503,'signin_not_open');
 const token=newToken(),code=String(randomInt(0,1000000)).padStart(6,'0'),ip=String(clientIp??'unknown').slice(0,100),{perEmail,perIp,global}=LOGIN_LIMITS;
 const allowed=await transaction(db,async c=>{
  // One request at a time, so concurrent requests cannot all pass the same count.
  await c.query("SELECT pg_advisory_xact_lock(hashtext('kce-login-request'))");
  await c.query('DELETE FROM login_tokens WHERE created_at<$1',[ago(now,2*DAY)]);
  const known=(await c.query('SELECT 1 FROM users WHERE email=$1',[email])).rowCount>0;
  const n=(await c.query(`SELECT count(*) FILTER (WHERE email=$1 AND created_at>$2)::int AS email,count(*) FILTER (WHERE request_ip=$3 AND created_at>$4)::int AS ip,
   count(*) FILTER (WHERE created_at>$5 AND NOT EXISTS (SELECT 1 FROM users u WHERE u.email=t.email))::int AS total FROM login_tokens t WHERE created_at>$6`,
   [email,ago(now,perEmail.ms),ip,ago(now,perIp.ms),ago(now,global.ms),ago(now,Math.max(perEmail.ms,perIp.ms,global.ms))])).rows[0];
  if(n.email>=perEmail.max||n.ip>=perIp.max||(!known&&n.total>=global.max))return false;
  await c.query('INSERT INTO login_tokens(token_hash,email,code_hash,next_path,request_ip,created_at,expires_at) VALUES($1,$2,$3,$4,$5,$6,$7)',
   [hashToken(token),email,hashToken(`${email}:${code}`),safeNextPath(next),ip,now,new Date(now.getTime()+LOGIN_TTL_MS)]);
  return true;
 });
 if(!allowed)throw new HttpError(429,'rate_limit');
 // The token sits in the fragment, so it never reaches server logs or Referer headers.
 const message=loginLink({url:`${cfg.publicSiteUrl}/signin/verify#token=${token}`,code,supportEmail:cfg.mail.supportEmail});
 try{await sendWithin(mailer,{to:email,...message},mailTimeoutMs)}
 catch(error){
  const detail=String(error?.message??'').replaceAll(token,'[token]').replaceAll(code,'[code]').slice(0,200);
  console.error(JSON.stringify({event:'login_mail_failed',code:error?.code??null,name:error?.name??null,message:detail}));
  if(error?.code==='mail_not_configured')throw new HttpError(503,'mail_not_configured');
  throw new HttpError(502,'mail_failed');
 }
 return {ok:true};
}
async function startSession(c,email,nextPath,now){
 const user=(await c.query('INSERT INTO users(email,last_login_at) VALUES($1,$2) ON CONFLICT(email) DO UPDATE SET last_login_at=EXCLUDED.last_login_at RETURNING id',[email,now])).rows[0];
 await c.query('DELETE FROM sessions WHERE user_id=$1 AND (expires_at<$2 OR revoked_at<$3)',[user.id,now,ago(now,SESSION_TTL_MS)]);
 const sessionToken=newToken(),expiresAt=new Date(now.getTime()+SESSION_TTL_MS);
 await c.query('INSERT INTO sessions(token_hash,user_id,created_at,expires_at,last_seen_at) VALUES($1,$2,$3,$4,$3)',[hashToken(sessionToken),user.id,now,expiresAt]);
 return {sessionToken,expiresAt:expiresAt.toISOString(),next:safeNextPath(nextPath)};
}
/** POST /auth/verify: consumes the link token atomically and starts a 30-day session. */
export async function verifyLinkToken(db,{token,now=new Date()}={}){
 if(typeof token!=='string'||!TOKEN_PATTERN.test(token))throw new HttpError(400,'invalid_or_expired');
 const result=await transaction(db,async c=>{
  const row=(await c.query('UPDATE login_tokens SET used_at=$2 WHERE token_hash=$1 AND used_at IS NULL AND expires_at>$2 RETURNING email,next_path',[hashToken(token),now])).rows[0];
  return row?startSession(c,row.email,row.next_path,now):null;
 });
 if(!result)throw new HttpError(400,'invalid_or_expired');
 return result;
}
/**
 * POST /auth/verify-code: the code may belong to any of the address's open tokens. A match consumes that token like
 * a link; a miss counts one attempt against every open token, and a token stops accepting codes after 5 misses.
 */
export async function verifyLoginCode(db,{email:input,code,now=new Date()}={}){
 const email=normalizeEmail(input);
 if(!email)throw new HttpError(400,'invalid_email');
 const digits=typeof code==='string'?code.replace(/\s+/g,''):'';
 if(!/^\d{6}$/.test(digits))throw new HttpError(400,'invalid_or_expired');
 const expected=Buffer.from(hashToken(`${email}:${digits}`),'hex');
 const result=await transaction(db,async c=>{
  // Per-email daily cap across all codes: new links reset per-token attempts, this does not.
  await c.query("SELECT pg_advisory_xact_lock(hashtext('kce-login-code:'||$1))",[email]);
  await c.query("DELETE FROM login_code_failures WHERE at<$1::timestamptz-interval '2 days'",[now]);
  if((await c.query("SELECT count(*)::int AS n FROM login_code_failures WHERE email=$1 AND at>$2::timestamptz-interval '24 hours'",[email,now])).rows[0].n>=MAX_CODE_FAILURES_PER_DAY)return {limited:true};
  const rows=(await c.query('SELECT token_hash,code_hash,next_path FROM login_tokens WHERE email=$1 AND used_at IS NULL AND expires_at>$2 AND attempts<$3 AND code_hash IS NOT NULL ORDER BY created_at,token_hash FOR UPDATE',[email,now,MAX_CODE_ATTEMPTS])).rows;
  let match=null;
  for(const row of rows){const stored=Buffer.from(row.code_hash,'hex');if(stored.length===expected.length&&timingSafeEqual(stored,expected))match??=row}
  if(match){await c.query('UPDATE login_tokens SET used_at=$2 WHERE token_hash=$1',[match.token_hash,now]);return startSession(c,email,match.next_path,now)}
  // Committed before the error answer, so misses always count.
  if(rows.length){await c.query('UPDATE login_tokens SET attempts=attempts+1 WHERE token_hash=ANY($1)',[rows.map(row=>row.token_hash)]);await c.query('INSERT INTO login_code_failures(email,at) VALUES($1,$2)',[email,now])}
  return null;
 });
 // A distinct code: the site tells the user to use the emailed link, which this cap does not affect.
 if(result?.limited)throw new HttpError(429,'code_locked');
 if(!result)throw new HttpError(400,'invalid_or_expired');
 return result;
}
export async function revokeSession(db,sessionHash,now=new Date()){
 return (await db.query('UPDATE sessions SET revoked_at=$2 WHERE token_hash=$1 AND revoked_at IS NULL',[sessionHash,now])).rowCount===1;
}
/** A stored payment as the checkout, the account page and the admin page see it; amounts are token units ("9", "9.5"). */
export function paymentView(row){
 const amount=BigInt(row.amount),required=BigInt(row.required_amount),address=value=>isAddress(value)?toChecksum(value):value;
 return {id:Number(row.id),rail:row.rail,network:row.network,chain:row.chain,txHash:row.tx_hash,token:row.token,decimals:Number(row.decimals),
  amount:formatUnits(amount,row.decimals),required:formatUnits(required,row.decimals),overpaid:amount>required,plan:row.plan,status:row.status,failureReason:row.failure_reason??null,
  from:address(row.from_address),to:address(row.to_address),source:row.source,createdAt:iso(row.created_at),confirmedAt:iso(row.confirmed_at),
  periodStart:iso(row.period_start),periodEnd:iso(row.period_end),explorerUrl:explorerTxUrl(row)};
}
/** GET /account. */
export async function accountView(db,cfg,session){
 const id=session.user.id;
 // Sequential on purpose: the API pool is small and shared with every visitor.
 const wallets=await db.query('SELECT address,linked_at FROM wallets WHERE user_id=$1 ORDER BY linked_at,address',[id]);
 const alerts=await db.query('SELECT id,direction,threshold::float8 AS threshold FROM alert_rules WHERE user_id=$1 ORDER BY direction,threshold,id',[id]);
 const payments=await db.query('SELECT * FROM payments WHERE user_id=$1 ORDER BY created_at DESC,id DESC LIMIT 20',[id]);
 const enabled=!!cfg.payments?.enabled;
 return {email:session.user.email,isAdmin:session.user.isAdmin,subscription:session.subscription??null,
  wallets:wallets.rows.map(row=>({address:toChecksum(row.address),linkedAt:iso(row.linked_at)})),
  alerts:alerts.rows.map(row=>({id:Number(row.id),direction:row.direction,threshold:row.threshold})),
  payments:payments.rows.map(paymentView),
  testPlanAvailable:session.user.isAdmin&&enabled&&!!cfg.payments.testPlan,
  // Named `billing` because `payments` is the history above.
  billing:{enabled,testnet:cfg.payments?.network==='bsc-testnet'},
  supportEmail:cfg.mail?.supportEmail??null,signinOpen:!!cfg.mail?.open};
}
/** 0–100000 with at most one decimal, as a number or a decimal string; null otherwise. */
export function parseThreshold(value){
 const n=typeof value==='number'?value:typeof value==='string'&&/^\s*\d{1,6}(\.\d)?\s*$/.test(value)?Number(value):NaN;
 if(!Number.isFinite(n)||n<0||n>100000)return null;
 const tenths=Math.round(n*10);
 return Math.abs(tenths-n*10)<1e-6?tenths/10:null;
}
const positiveId=value=>{const n=typeof value==='number'?value:typeof value==='string'&&/^\d{1,15}$/.test(value)?Number(value):NaN;return Number.isSafeInteger(n)&&n>0?n:null};
/** POST /account/alerts (the caller checks the subscription). */
export async function addAlert(db,userId,{direction,threshold}={}){
 const level=parseThreshold(threshold);
 if(!['above','below'].includes(direction)||level===null)throw new HttpError(400,'invalid_alert');
 const result=await transaction(db,async c=>{
  await c.query("SELECT pg_advisory_xact_lock(hashtext('kce-alerts:'||$1::text))",[userId]);
  const rules=(await c.query('SELECT direction,threshold::float8 AS threshold FROM alert_rules WHERE user_id=$1',[userId])).rows;
  if(rules.some(rule=>rule.direction===direction&&Math.round(rule.threshold*10)===Math.round(level*10)))return {error:'duplicate_alert'};
  if(rules.length>=MAX_ALERTS)return {error:'too_many_alerts'};
  return {id:Number((await c.query('INSERT INTO alert_rules(user_id,direction,threshold) VALUES($1,$2,$3) RETURNING id',[userId,direction,level.toFixed(1)])).rows[0].id)};
 });
 if(result.error)throw new HttpError(409,result.error);
 return result;
}
/** POST /account/alerts/delete: only the user's own rule; allowed after the subscription ends, to tidy up. */
export async function deleteAlert(db,userId,{id}={}){
 const ruleId=positiveId(id);
 if(!ruleId)throw new HttpError(400,'invalid_alert');
 if(!(await db.query('DELETE FROM alert_rules WHERE id=$1 AND user_id=$2',[ruleId,userId])).rowCount)throw new HttpError(404,'not_found');
 return {ok:true};
}
