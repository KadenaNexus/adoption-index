import {HttpError} from './http.mjs';
import {createChallenge,linkWallet,createIntent,submitPayment} from './billing.mjs';
import {safeMessage} from './bsc.mjs';
// BSC checkout routes. The server has already checked the site key, and the session for every route but the config.
const log=entry=>console.error(JSON.stringify(typeof entry?.message==='string'?{...entry,message:safeMessage(entry.message)}:entry));
/** What the checkout needs to pay. */
export function billingConfig(cfg){
 const p=cfg.payments;
 const common={signinOpen:!!cfg.mail?.open,supportEmail:cfg.mail?.supportEmail??null,walletConnectProjectId:cfg.walletConnectProjectId??null};
 if(!p?.enabled)return {enabled:false,testnet:false,...common};
 return {enabled:true,network:p.network,testnet:p.network==='bsc-testnet',chainId:p.chainId,chainName:p.chainName,explorerUrl:p.explorerUrl,addChainParams:p.addChainParams,
  payTo:p.payToChecksum,tokens:p.tokens.map(t=>({symbol:t.symbol,address:t.checksum,decimals:t.decimals})),...common};
}
// Each status poll fans out to every RPC provider; the site polls every 3 s, so 60 a minute leaves room for two tabs.
const polls=new Map();
function limitPolls(userId,at=Date.now()){
 const entry=polls.get(userId);
 if(!entry||entry.end<=at)polls.set(userId,{end:at+60000,count:1});else if(++entry.count>60)throw new HttpError(429,'rate_limit');
 if(polls.size>10000)for(const [key,value] of polls)if(value.end<=at)polls.delete(key);
}
const body=ctx=>ctx.body??{};
export const routes={
 'GET /billing/config':async ctx=>({status:200,body:billingConfig(ctx.cfg)}),
 'POST /wallets/challenge':async ctx=>({status:200,body:await createChallenge(ctx.db,ctx.cfg,ctx.requireSession().user,body(ctx),{now:ctx.now})}),
 'POST /wallets/link':async ctx=>({status:200,body:await linkWallet(ctx.db,ctx.cfg,ctx.requireSession().user,body(ctx),{now:ctx.now})}),
 'POST /billing/intents':async ctx=>({status:200,body:await createIntent(ctx.db,ctx.cfg,ctx.requireSession().user,body(ctx),{now:ctx.now})}),
 'POST /billing/payments':async ctx=>{
  const {user}=ctx.requireSession();limitPolls(user.id);
  return {status:200,body:await submitPayment(ctx.db,ctx.cfg,user,body(ctx),{now:ctx.now,log})};
 },
};
