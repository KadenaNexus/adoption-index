// Email templates: each returns {subject,text,html}. Every value is HTML-escaped; the footer carries the manage link
// and, when configured, the support contact. `supportEmail` is optional on every template (callers pass cfg.mail.supportEmail).
const PRODUCT='Kadena Community Edition Adoption Index',DEFAULT_SITE='https://adoption.kadena.ws';
const REFUND='Payments are non-refundable except where required by law.',NO_RENEWAL='Nothing renews automatically.';
const MONTHS=['January','February','March','April','May','June','July','August','September','October','November','December'];
const PLAN_LABELS={monthly:'Monthly',annual:'Annual',test:'Test',manual:'Manual'};
const esc=value=>String(value??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'})[c]);
const oneLine=value=>String(value??'').replace(/[\r\n]+/g,' ').trim();
const site=url=>String(url||DEFAULT_SITE).replace(/\/+$/,'');
const originOf=url=>{try{return new URL(url).origin}catch{return DEFAULT_SITE}};
export function formatDay(value){const d=new Date(value);return Number.isFinite(d.getTime())?`${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]} ${d.getUTCFullYear()}`:String(value??'')}
export function formatDateTime(value){const d=new Date(value);if(!Number.isFinite(d.getTime()))return String(value??'');const two=n=>String(n).padStart(2,'0');return `${formatDay(d)}, ${two(d.getUTCHours())}:${two(d.getUTCMinutes())} UTC`}
const score=value=>Number.isFinite(Number(value))?Number(value).toFixed(1):String(value??'');
const planLabel=plan=>PLAN_LABELS[plan]??String(plan??'');
/**
 * Blocks: a string is a paragraph; {link,label,copy?} a button (copy adds the raw link under it); {code} a large one-time code; {rows:[[label,value,href?]]}
 * a details table; {note} small print. The text version renders the same blocks in order.
 */
function render({subject,heading,blocks,publicSiteUrl,supportEmail,notes=[]}){
 const base=site(publicSiteUrl),manage=`${base}/account`;
 const footer=[...notes,`Manage your account: ${manage}`,...(supportEmail?[`Questions? Contact ${supportEmail}`]:[])];
 const text=[heading,...blocks.map(block=>typeof block==='string'?block:block.link?`${block.label}:\n${block.link}`:block.code?`Your code:\n${block.code}`
  :block.rows?block.rows.map(([label,value,href])=>`${label}: ${value}${href?`\n${href}`:''}`).join('\n'):block.note),`--\n${PRODUCT}\n${footer.join('\n')}`].join('\n\n')+'\n';
 const p='margin:0 0 16px;font-size:15px;line-height:1.6;color:#111111';
 const body=blocks.map(block=>{
  if(typeof block==='string')return `<p style="${p}">${esc(block)}</p>`;
  if(block.link)return `<p style="margin:0 0 20px"><a href="${esc(block.link)}" style="display:inline-block;background:#b04856;color:#ffffff;padding:12px 22px;border-radius:6px;font-size:15px;font-weight:700;text-decoration:none">${esc(block.label)}</a></p>${block.copy?`<p style="margin:0 0 16px;font-size:13px;line-height:1.5;color:#6b7280">Or copy this link into your browser:<br><a href="${esc(block.link)}" style="color:#a3404e;word-break:break-all">${esc(block.link)}</a></p>`:''}`;
  if(block.code)return `<p style="margin:0 0 6px;font-size:13px;color:#6b7280">Your code</p><p style="margin:0 0 20px;font-family:Menlo,Consolas,'Courier New',monospace;font-size:28px;font-weight:700;letter-spacing:6px;color:#111111">${esc(block.code)}</p>`;
  if(block.rows)return `<table role="presentation" cellpadding="0" cellspacing="0" style="margin:0 0 16px;border-collapse:collapse;font-size:14px;line-height:1.5">${block.rows.map(([label,value,href])=>`<tr><td style="padding:4px 16px 4px 0;color:#6b7280;vertical-align:top;white-space:nowrap">${esc(label)}</td><td style="padding:4px 0;color:#111111;word-break:break-all">${href?`<a href="${esc(href)}" style="color:#a3404e">${esc(value)}</a>`:esc(value)}</td></tr>`).join('')}</table>`;
  return `<p style="margin:0 0 16px;font-size:13px;line-height:1.5;color:#6b7280">${esc(block.note)}</p>`;
 }).join('');
 const html=`<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${esc(subject)}</title></head>`
  +`<body style="margin:0;padding:24px 12px;background:#fafafa;font-family:Arial,'Helvetica Neue',Helvetica,sans-serif"><div style="max-width:560px;margin:0 auto;background:#ffffff;border:1px solid #e6e6e6;border-radius:8px;padding:28px 24px">`
  +`<p style="margin:0 0 18px;font-size:12px;font-weight:700;letter-spacing:.08em;text-transform:uppercase;color:#a3404e">${esc(PRODUCT)}</p><h1 style="margin:0 0 18px;font-size:21px;line-height:1.3;color:#111111">${esc(heading)}</h1>${body}`
  +`<div style="margin-top:24px;padding-top:16px;border-top:1px solid #e6e6e6;font-size:12px;line-height:1.6;color:#6b7280">${notes.length?`<p style="margin:0 0 8px">${notes.map(esc).join(' ')}</p>`:''}`
  +`<p style="margin:0">${esc(PRODUCT)} · <a href="${esc(manage)}" style="color:#a3404e">Manage your account</a>${supportEmail?` · Questions? <a href="mailto:${esc(supportEmail)}" style="color:#a3404e">${esc(supportEmail)}</a>`:''}</p></div></div></body></html>`;
 return {subject:oneLine(subject),text,html};
}
/** The sign-in email: a single-use link (token in the URL fragment) and the matching 6-digit code. */
export const loginLink=({url,code,supportEmail})=>render({subject:`Sign in to the ${PRODUCT}`,heading:'Your sign-in link',publicSiteUrl:originOf(url),supportEmail,blocks:[
 'Open the link below to sign in, or enter the code on the sign-in page. The code is handy on a phone or inside a wallet app’s browser.',
 {link:url,label:'Sign in',copy:true},{code},
 'The link and the code expire in 15 minutes and can be used once.',
 {note:'If you didn’t ask to sign in, you can ignore this email. Nobody can sign in without the link or the code.'}]});
export const paymentConfirmed=({plan,days,amount,token,periodEnd,txHash,explorerUrl,publicSiteUrl,supportEmail})=>render({
 subject:`Payment confirmed: Pro access until ${formatDay(periodEnd)}`,heading:'Your payment is confirmed',publicSiteUrl,supportEmail,notes:[NO_RENEWAL,REFUND],blocks:[
 `Thank you. We received ${amount} ${token} for the ${planLabel(plan)} plan, which adds ${days} ${Number(days)===1?'day':'days'} of Pro access.`,
 `Your Pro access now runs until ${formatDateTime(periodEnd)}. We’ll email you 7 days and 1 day before it ends.`,
 {rows:[['Plan',`${planLabel(plan)} (${days} ${Number(days)===1?'day':'days'})`],['Amount',`${amount} ${token}`],['Access until',formatDateTime(periodEnd)],['Transaction',txHash,explorerUrl||undefined]]},
 {link:`${site(publicSiteUrl)}/`,label:'Open the index'}]});
export const paymentUnderpaid=({amount,required,token,txHash,explorerUrl,publicSiteUrl,supportEmail})=>render({
 subject:'Your payment was below the plan price',heading:'We received less than the plan price',publicSiteUrl,supportEmail,notes:[NO_RENEWAL,REFUND],blocks:[
 `We received ${amount} ${token}, but the plan costs ${required} ${token}, so Pro access has not been activated.`,
 'Payments are not combined, so please don’t send the difference as a second payment.',
 supportEmail?`Contact ${supportEmail} with the transaction below and we’ll help you sort it out.`:'Keep this email and the transaction below for reference.',
 {rows:[['Received',`${amount} ${token}`],['Plan price',`${required} ${token}`],['Transaction',txHash,explorerUrl||undefined]]}]});
export function alertCrossed({direction,threshold,day,score:current,prevScore,publicSiteUrl,supportEmail}){
 const verb=direction==='below'?'fell below':'rose above',moved=direction==='below'?'fell':'rose';
 return render({subject:`Index alert: the score ${verb} ${score(threshold)}`,heading:`The index score ${verb} ${score(threshold)}`,publicSiteUrl,supportEmail,blocks:[
  `The ${PRODUCT} ${moved} from ${score(prevScore)} to ${score(current)} on ${formatDay(day)}, crossing your alert level of ${score(threshold)}.`,
  {rows:[['Day',formatDay(day)],['Score',score(current)],['Previous day',score(prevScore)],['Your alert',`${direction==='below'?'Below':'Above'} ${score(threshold)}`]]},
  {link:`${site(publicSiteUrl)}/`,label:'View the index'},
  {note:`You’ll get this email each time the score crosses this level. You can change or remove alerts on your account page.`}]});
}
export function renewalReminder({daysLeft,expiresAt,publicSiteUrl,supportEmail}){
 const soon=Number(daysLeft)<=1?'within a day':`in ${daysLeft} days`;
 return render({subject:`Your Pro access ends ${soon}`,heading:`Your Pro access ends ${soon}`,publicSiteUrl,supportEmail,notes:[REFUND],blocks:[
  `Your Pro access to the ${PRODUCT} ends on ${formatDateTime(expiresAt)}.`,
  'Nothing renews automatically. To keep access, make a new payment: renewing before the end date adds the new period to your current one, so you don’t lose any days.',
  {link:`${site(publicSiteUrl)}/checkout`,label:'Renew Pro'}]});
}
