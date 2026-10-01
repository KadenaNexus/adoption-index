import {test} from 'node:test';
import assert from 'node:assert/strict';
import {loginLink,paymentConfirmed,paymentUnderpaid,alertCrossed,renewalReminder,dataReport,formatDay,formatDateTime} from '../src/emails.mjs';
const site='https://adoption.kadena.ws',support='help@kadena.ws',hash='0x'+'ab'.repeat(32),explorer=`https://bscscan.com/tx/${hash}`;
const REFUND='Payments are non-refundable except where required by law.',RENEWAL='Nothing renews automatically';
const all=supportEmail=>({
 loginLink:loginLink({url:`${site}/signin/verify#token=${'t'.repeat(43)}`,code:'012345',supportEmail}),
 paymentConfirmed:paymentConfirmed({plan:'monthly',days:30,amount:'9',token:'USDT',periodEnd:'2026-10-31T12:00:00.000Z',txHash:hash,explorerUrl:explorer,publicSiteUrl:site,supportEmail}),
 paymentUnderpaid:paymentUnderpaid({amount:'5',required:'9',token:'USDC',txHash:hash,explorerUrl:explorer,publicSiteUrl:site,supportEmail}),
 alertCrossed:alertCrossed({direction:'above',threshold:60,day:'2026-09-28',score:61.2,prevScore:58.4,publicSiteUrl:site,supportEmail}),
 renewalReminder:renewalReminder({daysLeft:7,expiresAt:'2026-10-12T09:05:00.000Z',publicSiteUrl:site,supportEmail}),
});
test('every email has a one-line subject, text and HTML, the product name and a footer with the manage link',()=>{
 for(const [name,email] of Object.entries(all(support))){
  assert.equal(typeof email.subject,'string',name);assert.ok(email.subject.length>5&&!/[\r\n]/.test(email.subject),name);
  assert.match(email.text,/Kadena Community Edition Adoption Index/,name);assert.match(email.html,/Kadena Community Edition Adoption Index/,name);
  assert.ok(email.text.includes(`Manage your account: ${site}/account`),name);assert.ok(email.html.includes(`href="${site}/account"`),name);
  assert.ok(email.text.includes(`Contact ${support}`),name);assert.ok(email.html.includes(`href="mailto:${support}"`),name);
  assert.match(email.html,/^<!doctype html><html lang="en">/,name);assert.ok(email.html.endsWith('</html>'),name);
 }
});
test('the support contact is left out when none is configured',()=>{
 for(const [name,email] of Object.entries(all(null))){assert.ok(!/Questions\?|mailto:/.test(email.text+email.html),name);assert.ok(email.text.includes(`${site}/account`),name)}
});
test('payment emails carry the refund and no-renewal wording; the reminder says nothing renews; alerts and sign-in do not mention payments',()=>{
 const e=all(support);
 for(const name of ['paymentConfirmed','paymentUnderpaid']){for(const part of ['text','html']){assert.ok(e[name][part].includes(REFUND),name+part);assert.ok(e[name][part].includes(RENEWAL),name+part)}}
 assert.ok(e.renewalReminder.text.includes(RENEWAL));assert.ok(e.renewalReminder.text.includes(REFUND));assert.equal(e.renewalReminder.text.split(RENEWAL).length,2,'said once');
 for(const name of ['loginLink','alertCrossed'])assert.ok(!e[name].text.includes(REFUND),name);
});
test('the sign-in email shows the link and the 6-digit code, the 15-minute single use, and what to do if unexpected',()=>{
 const url=`${site}/signin/verify#token=${'Ab_-'.repeat(10)}xyz`,{subject,text,html}=loginLink({url,code:'004271'});
 assert.equal(subject,'Sign in to the Kadena Community Edition Adoption Index');
 assert.ok(text.includes(url));assert.ok(html.includes(`href="${url}"`));
 assert.match(text,/^004271$/m);assert.ok(html.includes('>004271<'));
 for(const part of [text,html]){assert.match(part,/expire in 15 minutes/);assert.match(part,/can be used once/);assert.match(part,/didn.t ask to sign in, you can ignore this email/)}
 // The manage link comes from the link's own origin.
 assert.ok(text.includes(`${site}/account`));
 assert.ok(!subject.includes('004271'),'the code stays out of the subject line');
});
test('payment confirmation and underpayment details',()=>{
 const ok=paymentConfirmed({plan:'annual',days:365,amount:'79',token:'USDC',periodEnd:'2027-10-01T00:00:00.000Z',txHash:hash,explorerUrl:explorer,publicSiteUrl:site});
 assert.equal(ok.subject,'Payment confirmed: Pro access until 1 October 2027');
 assert.match(ok.text,/79 USDC for the Annual plan, which adds 365 days/);assert.match(ok.text,/until 1 October 2027, 00:00 UTC/);
 assert.ok(ok.text.includes(hash)&&ok.text.includes(explorer));assert.ok(ok.html.includes(`href="${explorer}"`));
 assert.match(ok.text,/7 days and 1 day before it ends/);
 const test1=paymentConfirmed({plan:'test',days:1,amount:'1',token:'USDT',periodEnd:'2027-10-01T00:00:00.000Z',txHash:hash,explorerUrl:null,publicSiteUrl:site});
 assert.match(test1.text,/adds 1 day of Pro/);assert.ok(!test1.html.includes('href="null"'));
 const under=paymentUnderpaid({amount:'5.5',required:'9',token:'USDT',txHash:hash,explorerUrl:explorer,publicSiteUrl:site,supportEmail:support});
 assert.equal(under.subject,'Your payment was below the plan price');
 assert.match(under.text,/We received 5.5 USDT, but the plan costs 9 USDT, so Pro access has not been activated/);
 assert.match(under.text,/don.t send the difference/);assert.ok(under.text.includes(`Contact ${support} with the transaction`));
 assert.match(paymentUnderpaid({amount:'5',required:'9',token:'USDT',txHash:hash,explorerUrl:explorer,publicSiteUrl:site}).text,/Keep this email/);
});
test('alert wording for both directions, with one-decimal scores',()=>{
 const up=alertCrossed({direction:'above',threshold:60,day:'2026-09-28',score:60,prevScore:59.9,publicSiteUrl:site});
 assert.equal(up.subject,'Index alert: the score rose above 60.0');
 assert.match(up.text,/rose from 59\.9 to 60\.0 on 28 September 2026, crossing your alert level of 60\.0/);
 const down=alertCrossed({direction:'below',threshold:40.5,day:'2026-10-02',score:39,prevScore:41.25,publicSiteUrl:site});
 assert.equal(down.subject,'Index alert: the score fell below 40.5');assert.match(down.text,/fell from 41\.3 to 39\.0 on 2 October 2026/);
 assert.match(down.text,/Below 40\.5/);assert.ok(down.text.includes(`${site}/`));
});
test('renewal reminder wording for 7 days and the last day',()=>{
 const week=renewalReminder({daysLeft:7,expiresAt:'2026-10-12T09:05:00.000Z',publicSiteUrl:site});
 assert.equal(week.subject,'Your Pro access ends in 7 days');assert.match(week.text,/ends on 12 October 2026, 09:05 UTC/);assert.ok(week.text.includes(`${site}/checkout`));
 assert.equal(renewalReminder({daysLeft:1,expiresAt:'2026-10-12T09:05:00.000Z',publicSiteUrl:site}).subject,'Your Pro access ends within a day');
});
test('every value is HTML-escaped, including link targets',()=>{
 const evil='<script>alert("x")</script>&\'';
 const emails=[loginLink({url:`${site}/signin/verify#token="><img src=x>`,code:'<b>1</b>',supportEmail:'a"b@example.com'}),
  paymentConfirmed({plan:evil,days:30,amount:evil,token:evil,periodEnd:'2026-10-31T12:00:00Z',txHash:evil,explorerUrl:'https://bscscan.com/tx/"onmouseover="x',publicSiteUrl:site}),
  paymentUnderpaid({amount:evil,required:'9',token:evil,txHash:evil,explorerUrl:explorer,publicSiteUrl:site}),
  alertCrossed({direction:'above',threshold:evil,day:evil,score:evil,prevScore:evil,publicSiteUrl:site}),
  renewalReminder({daysLeft:evil,expiresAt:evil,publicSiteUrl:site})];
 for(const {html} of emails){
  assert.ok(!html.includes('<script>'));assert.ok(!html.includes('<img'));assert.ok(!html.includes('"onmouseover="'));assert.ok(!html.includes('<b>1</b>'));
  assert.ok(!/href="[^"]*"[^ >]/.test(html.replace(/href="[^"]*" style=/g,'')),'no attribute breakout');
 }
 assert.ok(emails[1].html.includes('&lt;script&gt;alert(&quot;x&quot;)&lt;/script&gt;&amp;&#39;'));
 assert.ok(emails[1].html.includes('href="https://bscscan.com/tx/&quot;onmouseover=&quot;x"'));
});
test('dates are formatted in UTC',()=>{
 assert.equal(formatDay('2026-06-29'),'29 June 2026');assert.equal(formatDateTime('2026-12-31T23:59:00Z'),'31 December 2026, 23:59 UTC');
 assert.equal(formatDay('not a date'),'not a date');
});
test('the data issue notice escapes the visitor text, keeps its line breaks, shows a link in its normalised form and has no account footer',()=>{
 const base={id:12,indicator:'TVL',description:'Line <one>\n\nLine "two" & more',evidence:'https://explorer.example/tx/<x>',evidenceUrl:'https://explorer.example/tx/%3Cx%3E',email:'reader@example.com',createdAt:'2026-10-01T10:05:00.000Z',publicSiteUrl:site};
 const {subject,text,html}=dataReport(base);
 assert.equal(subject,'Data issue report #12: TVL');
 assert.ok(text.includes('Line <one>\n\nLine "two" & more'),'the text version is the report as typed');
 assert.ok(html.includes('Line &lt;one&gt;\n\nLine &quot;two&quot; &amp; more')&&html.includes('white-space:pre-wrap'),'escaped, line breaks kept');
 assert.ok(html.includes('href="https://explorer.example/tx/%3Cx%3E" style="color:#a3404e">https://explorer.example/tx/%3Cx%3E</a>')&&!html.includes('<x>'),'the visible link text is the address it opens');
 assert.match(text,/^Supporting link or ID: https:\/\/explorer\.example\/tx\/%3Cx%3E$/m);
 // The admin page needs a sign-in on a phone or in a mail app, so the button goes through it.
 assert.ok(text.includes(`${site}/signin?next=/admin%23reports`)&&html.includes(`href="${site}/signin?next=/admin%23reports"`));
 assert.ok(!text.includes('/account')&&!html.includes('/account'),'a notice for the team has no manage-your-account link');
 assert.match(text,/^Received: 1 October 2026, 10:05 UTC$/m);
 assert.match(text,/^Follow-up email: reader@example\.com$/m);
 const plain=dataReport({...base,evidence:'tx 0xabc',evidenceUrl:null,email:null});
 assert.ok(!plain.html.includes('href="tx')&&plain.text.includes('Supporting link or ID: tx 0xabc\n'),'text evidence is never a link');
 assert.match(plain.text,/^Follow-up email: None given$/m);
 assert.ok(!plain.text.includes('10th report'));
 assert.match(dataReport({...base,lastNotice:true}).text,/This is the 10th report in 24 hours\. Until that count drops, new reports appear only on the admin page/);
});
