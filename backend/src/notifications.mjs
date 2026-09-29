import {enqueueEmail} from './outbox.mjs';
import {alertCrossed,renewalReminder} from './emails.mjs';
import {METHOD_VERSION} from './scoring.mjs';
import {windowFor,completedDay} from './window.mjs';
import {sendWithin} from './mailer.mjs';
const MINUTE=60000,DAY=86400000;
export const ALERT_STATE_KEY='alerts_through_day';
/** Waits after failed attempts 1–5; the 6th failure is final. */
export const OUTBOX_BACKOFF_MS=Object.freeze([MINUTE,5*MINUTE,30*MINUTE,2*60*MINUTE,6*60*MINUTE]);
export const OUTBOX_MAX_ATTEMPTS=6;
// A claimed row is skipped by other senders for this long; a crash mid-send retries it afterwards.
const OUTBOX_LEASE_MS=10*MINUTE,SEND_TIMEOUT_MS=30000;
// The same published-score filter as the API: this method and this fixed baseline only.
const FILTER="day>=$1::date AND day<=$2::date AND payload->>'methodVersion'=$3 AND payload->>'baselineDay'=$1::text";
const tenths=value=>Math.round(Number(value)*10);
/** Scores and thresholds have one decimal; compare them as whole tenths. */
export function crossed(direction,previous,current,threshold){
 const p=tenths(previous),c=tenths(current),t=tenths(threshold);
 return direction==='above'?p<t&&c>=t:direction==='below'?p>t&&c<=t:false;
}
const saveState=(db,key,value,now)=>db.query('INSERT INTO worker_state(key,value,updated_at) VALUES($1,$2,$3) ON CONFLICT(key) DO UPDATE SET value=EXCLUDED.value,updated_at=EXCLUDED.updated_at',[key,JSON.stringify(value),now]);
/**
 * Emails subscribers whose alert level the published score crossed. The first run only records the latest
 * published day; later runs take each newly published day in order against the day before it.
 */
export async function processAlerts(db,{now=new Date(),cfg}={}){
 let window;try{window=windowFor(completedDay(now),{now})}catch{return {skipped:'no_window'}}
 const bounds=[window.fromDay,window.throughDay,METHOD_VERSION];
 const latest=(await db.query(`SELECT day::text AS day FROM index_snapshots WHERE ${FILTER} ORDER BY day DESC LIMIT 1`,bounds)).rows[0]?.day;
 if(!latest)return {skipped:'no_index'};
 const state=(await db.query('SELECT value FROM worker_state WHERE key=$1',[ALERT_STATE_KEY])).rows[0]?.value,through=typeof state?.day==='string'?state.day:null;
 if(!through){await saveState(db,ALERT_STATE_KEY,{day:latest},now);return {initialised:latest,days:0,queued:0}}
 if(through>=latest)return {throughDay:through,days:0,queued:0};
 const before=await db.query(`SELECT day::text AS day,score::float8 AS score FROM index_snapshots WHERE ${FILTER} AND day<=$4::date ORDER BY day DESC LIMIT 1`,[...bounds,through]);
 const days=await db.query(`SELECT day::text AS day,score::float8 AS score FROM index_snapshots WHERE ${FILTER} AND day>$4::date ORDER BY day`,[...bounds,through]);
 const rules=await db.query('SELECT r.id,r.direction,r.threshold::float8 AS threshold,u.email FROM alert_rules r JOIN users u ON u.id=r.user_id JOIN subscriptions s ON s.user_id=r.user_id WHERE s.expires_at>$1 ORDER BY r.id',[now]);
 let previous=before.rows[0]??null,queued=0;
 for(const day of days.rows){
  if(previous)for(const rule of rules.rows){
   if(!crossed(rule.direction,previous.score,day.score,rule.threshold))continue;
   const message=alertCrossed({direction:rule.direction,threshold:rule.threshold,day:day.day,score:day.score,prevScore:previous.score,publicSiteUrl:cfg?.publicSiteUrl,supportEmail:cfg?.mail?.supportEmail});
   if(await enqueueEmail(db,{dedupeKey:`alert:${rule.id}:${day.day}`,kind:'alert_crossed',to:rule.email,message}))queued++;
  }
  // Per day, so a crash resumes after the last finished day; the dedupe key covers a half-finished one.
  await saveState(db,ALERT_STATE_KEY,{day:day.day},now);previous=day;
 }
 return {throughDay:days.rows.at(-1)?.day??through,days:days.rows.length,queued};
}
/** One reminder when 7 days or less remain and another in the last day, each at most once per expiry. */
export async function processRenewalReminders(db,{now=new Date(),cfg}={}){
 const rows=(await db.query('SELECT s.user_id,s.expires_at,u.email FROM subscriptions s JOIN users u ON u.id=s.user_id WHERE s.expires_at>$1 AND s.expires_at<=$2 ORDER BY s.expires_at,s.user_id',[now,new Date(now.getTime()+7*DAY)])).rows;
 let queued=0;
 for(const row of rows){
  const expires=new Date(row.expires_at),left=expires-now,which=left>DAY?'renewal7':'renewal1';
  const message=renewalReminder({daysLeft:Math.max(1,Math.ceil(left/DAY)),expiresAt:expires.toISOString(),publicSiteUrl:cfg?.publicSiteUrl,supportEmail:cfg?.mail?.supportEmail});
  if(await enqueueEmail(db,{dedupeKey:`${which}:${row.user_id}:${expires.toISOString()}`,kind:which==='renewal7'?'renewal_reminder_7d':'renewal_reminder_1d',to:row.email,message}))queued++;
 }
 return {due:rows.length,queued};
}
// Stored and returned errors carry the provider's status, never a message body.
const describe=error=>`${error?.code??error?.name??'Error'}: ${String(error?.message??'').replace(/\s+/g,' ')}`.slice(0,300);
/**
 * Delivers due outbox emails. Transport `none` sends nothing and leaves every email queued. The dedupe key is the
 * provider's idempotency key, so a retry after an unknown outcome is not delivered twice.
 */
export async function sendOutbox(db,mailer,{now=new Date(),limit=20}={}){
 if(!mailer||mailer.transport==='none')return {skipped:'mail_not_configured'};
 const rows=(await db.query(`UPDATE email_outbox SET next_attempt_at=$3 WHERE id IN (SELECT id FROM email_outbox WHERE status='queued' AND next_attempt_at<=$1 ORDER BY next_attempt_at,id LIMIT $2 FOR UPDATE SKIP LOCKED) RETURNING *`,
  [now,Math.max(1,Math.min(Number(limit)||20,500)),new Date(now.getTime()+OUTBOX_LEASE_MS)])).rows.sort((a,b)=>Number(a.id)-Number(b.id));
 const result={sent:0,retrying:0,failed:0};
 for(const [i,row] of rows.entries()){
  try{
   const sent=await sendWithin(mailer,{to:row.to_email,subject:row.subject,text:row.text_body,html:row.html_body,idempotencyKey:row.dedupe_key},SEND_TIMEOUT_MS);
   await db.query("UPDATE email_outbox SET status='sent',attempts=attempts+1,sent_at=$2,provider_id=$3,last_error=NULL WHERE id=$1",[row.id,now,String(sent?.id??'').slice(0,200)||null]);
   result.sent++;
  }catch(error){
   if(error?.code==='mail_not_configured'){
    // Not the message's fault: release this and the remaining leases without counting an attempt.
    await db.query('UPDATE email_outbox SET next_attempt_at=$2 WHERE id=ANY($1)',[rows.slice(i).map(r=>r.id),now]);
    return {...result,skipped:'mail_not_configured'};
   }
   const attempts=row.attempts+1,final=attempts>=OUTBOX_MAX_ATTEMPTS;
   await db.query('UPDATE email_outbox SET attempts=$2,status=$3,last_error=$4,next_attempt_at=$5 WHERE id=$1',[row.id,attempts,final?'failed':'queued',describe(error),final?now:new Date(now.getTime()+OUTBOX_BACKOFF_MS[attempts-1])]);
   result[final?'failed':'retrying']++;
  }
 }
 return result;
}
