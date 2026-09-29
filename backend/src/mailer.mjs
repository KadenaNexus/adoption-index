import {appendFile,mkdir} from 'node:fs/promises';
import {dirname} from 'node:path';
import {randomUUID} from 'node:crypto';
/**
 * `resend` sends through the Resend HTTP API. `log` appends each message, bodies and sign-in links included, as
 * one JSON line to data/mail.log (owner-only): local testing and admin-only testing on the server; delete the file
 * afterwards. `none` sends nothing. Process logs never contain message bodies.
 */
export function createMailer(cfg,{fetch:fetchImpl=globalThis.fetch}={}){
 const mail=cfg.mail;
 if(mail.transport==='resend')return {transport:'resend',async send({to,subject,text,html,idempotencyKey}){
  const headers={Authorization:`Bearer ${mail.resendApiKey}`,'Content-Type':'application/json'};
  if(idempotencyKey)headers['Idempotency-Key']=String(idempotencyKey).slice(0,256);
  const message={from:mail.from,to:[to],subject,text,html,...(mail.supportEmail?{reply_to:mail.supportEmail}:{})};
  const response=await fetchImpl('https://api.resend.com/emails',{method:'POST',headers,body:JSON.stringify(message),signal:AbortSignal.timeout(10000)});
  const body=await response.json().catch(()=>({}));
  if(!response.ok)throw Object.assign(new Error(`Resend rejected the message (HTTP ${response.status}${typeof body?.name==='string'?`, ${body.name.slice(0,60)}`:''})`),{code:'mail_failed'});
  return {id:String(body?.id??'')};
 }};
 if(mail.transport==='none')return {transport:'none',async send(){throw Object.assign(new Error('Email is not configured (MAIL_TRANSPORT)'),{code:'mail_not_configured'})}};
 return {transport:'log',async send({to,subject,text,html}){
  await mkdir(dirname(mail.logFile),{recursive:true});
  const id='log-'+randomUUID();
  await appendFile(mail.logFile,JSON.stringify({id,at:new Date().toISOString(),from:mail.from,to,subject,text,html})+'\n',{mode:0o600});
  return {id};
 }};
}
/** mailer.send(message), rejected with code mail_timeout when it has not answered within `ms`. */
export function sendWithin(mailer,message,ms){
 let timer;
 const timeout=new Promise((_,reject)=>{timer=setTimeout(()=>reject(Object.assign(new Error(`No answer within ${ms} ms`),{code:'mail_timeout'})),ms)});
 return Promise.race([Promise.resolve().then(()=>mailer.send(message)),timeout]).finally(()=>clearTimeout(timer));
}
