import {createHmac} from 'node:crypto';
import {transaction} from './db.mjs';
import {HttpError} from './http.mjs';
import {normalizeEmail} from './auth.mjs';
import {enqueueEmail} from './outbox.mjs';
import {dataReport} from './emails.mjs';
const HOUR=3600000,DAY=24*HOUR;
/** What a report can be about: the composite index, one of the five inputs, or something else (site/lib/report.ts lists the same). */
export const REPORT_INDICATORS=Object.freeze({index:'Index score',addresses:'Active addresses',contracts:'New contracts deployed',tvl:'TVL (total value locked)',
 hashrate:'Network hashrate',commits:'GitHub commits (developer activity)',other:'Something else'});
export const DESCRIPTION_LENGTH=Object.freeze({min:10,max:2000}),EVIDENCE_MAX=500;
/**
 * The form is public. A visitor (an IP address, or an IPv6 /64) may send 5 an hour and 10 a day, so no single address can
 * fill the cap of 100 a day across everyone, which never holds back an active subscriber. Only the first 10 reports in
 * 24 hours are emailed, so a flood cannot use up the mail quota that sign-in links depend on.
 */
export const REPORT_LIMITS=Object.freeze({perIpPerHour:5,perIpPerDay:10,perDay:100,noticesPerDay:10});
const IP_KEPT_MS=2*DAY;
const ago=(now,ms)=>new Date(now.getTime()-ms);
const iso=value=>value==null?null:new Date(value).toISOString();
// Typed text as stored. Control characters go (PostgreSQL refuses NUL), and so do the invisible and direction-changing
// characters that can make text read differently from what it is. The description keeps line breaks and tabs, and the
// joiners some scripts and emoji need; the evidence becomes one plain line.
export const cleanDescription=value=>typeof value==='string'?value.replace(/\r\n?/g,'\n').replace(/[\u0000-\u0008\u000b-\u001f\u007f-\u009f\u061c\u200b\u200e\u200f\u202a-\u202e\u2060-\u2064\u2066-\u2069\ufeff]/g,'').trim():'';
export const cleanEvidence=value=>typeof value==='string'?value.replace(/[\u061c\u200b-\u200f\u202a-\u202e\u2060-\u2064\u2066-\u2069\ufeff]/g,'').replace(/[\u0000-\u001f\u007f-\u009f\s]+/g,' ').trim():'';
// A plain address only, so it is safe in a mailto: link anywhere: `?`, `&`, `=` or `%` could add recipients or headers.
const PLAIN_EMAIL=/^[a-z0-9._+-]+@[a-z0-9-]+(\.[a-z0-9-]+)*\.[a-z]{2,63}$/;
/** The evidence as a link when it is one https URL without credentials, in its normalised form (a look-alike host shows as punycode). */
export function evidenceUrl(evidence){
 if(typeof evidence!=='string'||!/^https:\/\/\S+$/i.test(evidence))return null;
 try{const url=new URL(evidence);return url.protocol==='https:'&&!url.username&&!url.password?url.href:null}catch{return null}
}
export function reportInput(body={}){
 const indicator=typeof body.indicator==='string'&&Object.hasOwn(REPORT_INDICATORS,body.indicator)?body.indicator:null;
 if(!indicator)throw new HttpError(400,'invalid_indicator');
 const description=cleanDescription(body.description);
 if(description.length<DESCRIPTION_LENGTH.min||description.length>DESCRIPTION_LENGTH.max)throw new HttpError(400,'invalid_description');
 const evidence=cleanEvidence(body.evidence);
 if(!evidence||evidence.length>EVIDENCE_MAX)throw new HttpError(400,'invalid_evidence');
 // Optional: blank means no follow-up.
 const given=typeof body.email==='string'?body.email.trim():body.email??'';
 const email=given===''?null:normalizeEmail(given);
 if(given!==''&&!(email&&PLAIN_EMAIL.test(email)))throw new HttpError(400,'invalid_email');
 return {indicator,description,evidence,email};
}
/** A stored report as the admin page sees it. Nothing about the visitor's address is part of it. */
export const reportView=row=>({id:Number(row.id),indicator:row.indicator,description:row.description,evidence:row.evidence,evidenceUrl:evidenceUrl(row.evidence),
 email:row.email??null,createdAt:iso(row.created_at),resolved:row.resolved_at!=null,resolvedAt:iso(row.resolved_at),resolvedBy:row.resolved_by??null,resolvedNote:row.resolved_note??null});
// The rate limit only compares addresses, so a keyed hash (the site key is the secret) stands in for them.
const ipHash=(key,ip)=>createHmac('sha256',String(key??'')).update(`report-ip:${ip}`).digest('hex');
/** The admins, who can resolve reports on /admin; the support address when there are none. */
const noticeRecipients=cfg=>cfg.adminEmails?.size?[...cfg.adminEmails]:cfg.mail?.supportEmail?[cfg.mail.supportEmail]:[];
/**
 * POST /reports: stores one report from the public form and queues a notice for the admins. Nothing is ever sent to the
 * reporter's address, so the form cannot be used to make the site email someone. `subscriber` lifts only the daily cap.
 */
export async function submitReport(db,cfg,body,{clientIp,subscriber=false,now=new Date()}={}){
 const input=reportInput(body),hash=ipHash(cfg.siteKey,String(clientIp??'unknown')),limits=REPORT_LIMITS;
 const stored=await transaction(db,async c=>{
  // One report at a time, so concurrent requests cannot all pass the same count.
  await c.query("SELECT pg_advisory_xact_lock(hashtext('kce-data-report'))");
  await c.query('UPDATE data_reports SET ip_hash=NULL WHERE ip_hash IS NOT NULL AND created_at<$1',[ago(now,IP_KEPT_MS)]);
  const n=(await c.query('SELECT count(*) FILTER (WHERE ip_hash=$1 AND created_at>$2)::int AS hour,count(*) FILTER (WHERE ip_hash=$1)::int AS day,count(*)::int AS total FROM data_reports WHERE created_at>$3',
   [hash,ago(now,HOUR),ago(now,DAY)])).rows[0];
  if(n.hour>=limits.perIpPerHour||n.day>=limits.perIpPerDay)return {limited:'rate_limit'};
  // A distinct code for the cap across everyone: the site then says to try tomorrow rather than later.
  if(!subscriber&&n.total>=limits.perDay)return {limited:'reports_busy'};
  const row=(await c.query('INSERT INTO data_reports(indicator,description,evidence,email,ip_hash,created_at) VALUES($1,$2,$3,$4,$5,$6) RETURNING *',
   [input.indicator,input.description,input.evidence,input.email,hash,now])).rows[0];
  if(n.total<limits.noticesPerDay){
   const message=dataReport({...reportView(row),indicator:REPORT_INDICATORS[row.indicator],publicSiteUrl:cfg.publicSiteUrl,lastNotice:n.total===limits.noticesPerDay-1});
   for(const to of noticeRecipients(cfg))await enqueueEmail(c,{dedupeKey:`report:${row.id}:${to}`,kind:'data_report',to,message});
  }
  return {id:Number(row.id)};
 });
 if(stored.limited)throw new HttpError(429,stored.limited);
 return {ok:true};
}
