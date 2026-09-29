/** Queues one email for the worker to send. The dedupe key makes every notice at-most-once; returns true when queued now. */
export async function enqueueEmail(db,{dedupeKey,kind,to,message}){
 if(!dedupeKey||!kind||!to||!message?.subject||typeof message.text!=='string'||typeof message.html!=='string')throw new Error('Incomplete email');
 const result=await db.query('INSERT INTO email_outbox(dedupe_key,kind,to_email,subject,text_body,html_body) VALUES($1,$2,$3,$4,$5,$6) ON CONFLICT(dedupe_key) DO NOTHING',[dedupeKey,kind,to,message.subject,message.text,message.html]);
 return result.rowCount===1;
}
