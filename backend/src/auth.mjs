import {randomBytes,createHash} from 'node:crypto';
// Session and login tokens: 32 random bytes, only their SHA-256 is stored.
export const TOKEN_PATTERN=/^[A-Za-z0-9_-]{43}$/;
export const newToken=()=>randomBytes(32).toString('base64url');
export const hashToken=token=>createHash('sha256').update(String(token)).digest('hex');
const EMAIL=/^[^\s@<>()[\]\\,;:"']+@[^\s@<>()[\]\\,;:"']+\.[^\s@<>()[\]\\,;:"'.]{2,}$/;
export function normalizeEmail(value){
 if(typeof value!=='string')return null;
 const email=value.trim().toLowerCase();
 return email.length>=3&&email.length<=254&&EMAIL.test(email)&&!/[\u0000-\u001f\u007f]/.test(email)?email:null;
}
/** A same-site path to return to after sign-in; anything that could normalise to another site is dropped. */
export function safeNextPath(value){
 if(typeof value!=='string'||value.length>512||!value.startsWith('/')||value.includes('//')||/[\\\s\u0000-\u001f\u007f]/.test(value)
  ||/^\/[a-z][a-z0-9+.-]*:/i.test(value)||/(^|\/)\.{1,2}(\/|$|\?|#)/.test(value)||/%2f|%5c|%2e/i.test(value))return null;
 return value;
}
export const isAdmin=(email,cfg)=>!!email&&!!cfg?.adminEmails?.has(email);
const iso=value=>value instanceof Date?value.toISOString():new Date(value).toISOString();
/** The user's subscription row, active or expired; null when they never had one. */
export async function subscriptionFor(db,userId,now=new Date()){
 const row=(await db.query('SELECT plan,started_at,expires_at FROM subscriptions WHERE user_id=$1',[userId])).rows[0];
 return row?{plan:row.plan,startedAt:iso(row.started_at),expiresAt:iso(row.expires_at),active:new Date(row.expires_at)>now}:null;
}
export async function resolveSession(db,token,{cfg,now=new Date()}={}){
 if(typeof token!=='string'||!TOKEN_PATTERN.test(token))return null;
 const hash=hashToken(token);
 const row=(await db.query('SELECT s.user_id,s.last_seen_at,u.email FROM sessions s JOIN users u ON u.id=s.user_id WHERE s.token_hash=$1 AND s.revoked_at IS NULL AND s.expires_at>$2',[hash,now])).rows[0];
 if(!row)return null;
 if(now-new Date(row.last_seen_at)>5*60000)await db.query('UPDATE sessions SET last_seen_at=$2 WHERE token_hash=$1',[hash,now]);
 const user={id:Number(row.user_id),email:row.email,isAdmin:isAdmin(row.email,cfg)};
 return {sessionHash:hash,user,subscription:await subscriptionFor(db,user.id,now)};
}
