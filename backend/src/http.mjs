import {createHash,timingSafeEqual} from 'node:crypto';
import {isIP} from 'node:net';
/** A handled API error: `code` is the machine-readable `error` field the site maps to a message. */
export class HttpError extends Error{
 constructor(status,code,extra={}){super(code);this.name='HttpError';this.status=status;this.code=code;this.extra=extra}
}
export function send(response,status,body,extra={}){
 response.writeHead(status,{'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store','X-Content-Type-Options':'nosniff',...extra});
 response.end(JSON.stringify(body));
}
/** JSON object bodies only, at most `limit` bytes. */
export async function readJson(request,{limit=16384}={}){
 // A POST without a body (e.g. sign-out) needs no Content-Type.
 if(!request.headers['transfer-encoding']&&(request.headers['content-length']===undefined||Number(request.headers['content-length'])===0)){for await(const _ of request);return {}}
 const type=String(request.headers['content-type']??'').split(';')[0].trim().toLowerCase();
 if(type!=='application/json')throw new HttpError(415,'json_required');
 const declared=Number(request.headers['content-length']);
 if(Number.isFinite(declared)&&declared>limit)throw new HttpError(413,'payload_too_large');
 const chunks=[];let size=0;
 for await(const chunk of request){size+=chunk.length;if(size>limit)throw new HttpError(413,'payload_too_large');chunks.push(chunk)}
 if(!size)return {};
 let value;try{value=JSON.parse(Buffer.concat(chunks).toString('utf8'))}catch{throw new HttpError(400,'invalid_json')}
 if(!value||typeof value!=='object'||Array.isArray(value))throw new HttpError(400,'invalid_json');
 return value;
}
const digest=value=>createHash('sha256').update(value).digest();
/**
 * The key a client is rate-limited by: an IPv4 address as is (also when IPv4-mapped), an IPv6 address by its /64
 * ("2001:db8:1:2::/64"), since one host or home network holds a whole /64. Null for anything that is not an IP.
 */
export function ipGroup(value){
 const version=typeof value==='string'?isIP(value):0;
 if(version!==6)return version===4?value:null;
 let text=value.split('%')[0].toLowerCase();
 const v4=/(\d+)\.(\d+)\.(\d+)\.(\d+)$/.exec(text);
 if(v4)text=text.slice(0,v4.index)+[(v4[1]<<8)|v4[2],(v4[3]<<8)|v4[4]].map(n=>n.toString(16)).join(':');
 const [head,tail]=text.split('::'),left=head?head.split(':'):[],right=tail?tail.split(':'):[];
 const words=[...left,...Array(8-left.length-right.length).fill('0'),...right].map(word=>parseInt(word,16));
 if(words.slice(0,5).every(word=>word===0)&&words[5]===0xffff)return [words[6]>>8,words[6]&255,words[7]>>8,words[7]&255].join('.');
 return words.slice(0,4).map(word=>word.toString(16)).join(':')+'::/64';
}
/** Only the website's server holds SITE_API_KEY; with it, its forwarded client IP (as ipGroup) and session token are trusted. */
export function siteContext(request,cfg){
 const key=request.headers['x-kce-site-key'];
 const siteOk=!!cfg?.siteKey&&typeof key==='string'&&timingSafeEqual(digest(key),digest(cfg.siteKey));
 const ip=request.headers['x-kce-client-ip'],session=request.headers['x-kce-session'];
 return {siteOk,clientIp:siteOk?ipGroup(ip):null,sessionToken:siteOk&&typeof session==='string'&&session?session:null};
}
