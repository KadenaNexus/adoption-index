import {fileURLToPath} from 'node:url';
import {normalizeEmail} from './auth.mjs';
import {isAddress,hasValidChecksum,toChecksum} from './evm-address.mjs';
/** Subscription plans. Prices are whole stablecoin units (1 USDT/USDC = $1). */
export const PLANS=Object.freeze({
 monthly:Object.freeze({id:'monthly',price:9,days:30}),
 annual:Object.freeze({id:'annual',price:79,days:365}),
 // Hidden, admin-only, for one small real payment before launch (PAYMENT_TEST_PLAN=1).
 test:Object.freeze({id:'test',price:1,days:1}),
});
export const planAmount=(plan,decimals)=>{if(!Object.hasOwn(PLANS,plan))throw new Error('Unknown plan');return BigInt(PLANS[plan].price)*10n**BigInt(decimals)};
// Probed live on 2026-09-29: three independent providers answer receipts and the `finalized` tag (quorum 2 of 3
// tolerates one outage); the official dataseed endpoints refuse eth_getLogs, publicnode serves it.
export const EVM_NETWORKS=Object.freeze({
 bsc:{chainId:56,chainName:'BNB Smart Chain',explorerUrl:'https://bscscan.com',native:{name:'BNB',symbol:'BNB',decimals:18},
  rpcUrls:['https://bsc-dataseed.bnbchain.org','https://bsc-rpc.publicnode.com','https://bsc-dataseed1.defibit.io'],logRpcUrls:['https://bsc-rpc.publicnode.com'],walletRpcUrl:'https://bsc-dataseed.bnbchain.org',
  tokens:[['USDT','0x55d398326f99059fF775485246999027B3197955',18],['USDC','0x8AC76a51cc950d9822D68b83fE1Ad97B32Cd580d',18]]},
 'bsc-testnet':{chainId:97,chainName:'BNB Smart Chain Testnet',explorerUrl:'https://testnet.bscscan.com',native:{name:'tBNB',symbol:'tBNB',decimals:18},
  rpcUrls:['https://data-seed-prebsc-1-s1.bnbchain.org:8545','https://bsc-testnet-rpc.publicnode.com','https://bsc-testnet.drpc.org'],logRpcUrls:['https://bsc-testnet-rpc.publicnode.com'],walletRpcUrl:'https://data-seed-prebsc-1-s1.bnbchain.org:8545',
  tokens:[['USDT','0x337610d27c682E347C9cD60BD4b3b107C9d34dDd',18],['USDC','0x64544969ed7EBf5f083679233325356EbE738930',18]]},
});
const list=value=>String(value??'').split(',').map(s=>s.trim()).filter(Boolean);
const loopback=host=>['127.0.0.1','localhost','[::1]'].includes(host);
function httpUrl(value,name,{allowPath=true}={}){
 let url;try{url=new URL(value)}catch{throw new Error(`${name} must be a URL`)}
 if(!(url.protocol==='https:'||(url.protocol==='http:'&&loopback(url.hostname)))||url.username||url.password||url.hash)throw new Error(`${name} must be https (http only on localhost), without credentials`);
 if(!allowPath&&url.pathname!=='/'&&url.pathname!=='')throw new Error(`${name} must be an origin without a path`);
 return allowPath?url.href.replace(/\/$/,''):url.origin;
}
function integer(value,fallback,name,min,max){
 if(value===undefined||value==='')return fallback;
 const n=Number(value);if(!Number.isSafeInteger(n)||n<min||n>max)throw new Error(`${name} must be an integer from ${min} to ${max}`);return n;
}
function mailConfig(env,publicSiteUrl){
 // Unset in production means `none`: nothing is sent and sign-in says it has not opened yet. `log` writes each
 // message, sign-in links included, to data/mail.log; outside local testing it is limited to ADMIN_EMAILS.
 const transport=env.MAIL_TRANSPORT||(env.NODE_ENV==='production'?'none':'log');
 if(!['none','log','resend'].includes(transport))throw new Error('MAIL_TRANSPORT must be none, log or resend');
 if(transport==='resend'&&(!env.RESEND_API_KEY||!env.MAIL_FROM))throw new Error('MAIL_TRANSPORT=resend needs RESEND_API_KEY and MAIL_FROM');
 // Public (checkout, email footers, reply-to), so only an address set here on purpose: never an admin's by default.
 const supportEmail=env.SUPPORT_EMAIL?normalizeEmail(env.SUPPORT_EMAIL):null;
 if(env.SUPPORT_EMAIL&&!supportEmail)throw new Error('SUPPORT_EMAIL is not a valid email address');
 return Object.freeze({transport,
  // Who may receive a sign-in link: everyone once email really goes out (or on a local test site), else admins only.
  open:transport==='resend'||(transport==='log'&&loopback(new URL(publicSiteUrl).hostname)),
  resendApiKey:transport==='resend'?env.RESEND_API_KEY:null,from:env.MAIL_FROM||'Kadena Adoption Index <index@kadena.ws>',supportEmail,
  logFile:env.MAIL_LOG_FILE||fileURLToPath(new URL('../data/mail.log',import.meta.url))});
}
function paymentTokens(spec,defaults){
 const entries=spec?list(spec).map(item=>item.split(':')):defaults;
 const tokens=entries.map(([symbol,address,decimals])=>{
  if(!/^[A-Z0-9]{2,10}$/.test(symbol??'')||!hasValidChecksum(address)||!/^\d{1,2}$/.test(String(decimals)))throw new Error('PAYMENT_TOKENS entries must be SYMBOL:0xaddress:decimals');
  return Object.freeze({symbol,address:address.toLowerCase(),checksum:toChecksum(address),decimals:Number(decimals)});
 });
 if(!tokens.length||new Set(tokens.map(t=>t.symbol)).size!==tokens.length||new Set(tokens.map(t=>t.address)).size!==tokens.length)throw new Error('Payment tokens must be non-empty and distinct');
 return Object.freeze(tokens);
}
export function paymentsConfig(env=process.env){
 const testPlan=env.PAYMENT_TEST_PLAN==='1';
 if(!env.PAYMENT_NETWORK)return Object.freeze({enabled:false,reason:'PAYMENT_NETWORK is not set',testPlan});
 const network=EVM_NETWORKS[env.PAYMENT_NETWORK];
 if(!network)throw new Error('PAYMENT_NETWORK must be bsc or bsc-testnet');
 if(!isAddress(env.PAYMENT_ADDRESS)||!hasValidChecksum(env.PAYMENT_ADDRESS))throw new Error('PAYMENT_ADDRESS must be a valid EIP-55 address');
 const rpcUrls=[...new Set((env.BSC_RPC_URLS?list(env.BSC_RPC_URLS):network.rpcUrls).map(u=>httpUrl(u,'BSC_RPC_URLS')))];
 const logRpcUrls=[...new Set((env.BSC_LOG_RPC_URLS?list(env.BSC_LOG_RPC_URLS):env.BSC_RPC_URLS?rpcUrls:network.logRpcUrls).map(u=>httpUrl(u,'BSC_LOG_RPC_URLS')))];
 const quorum=integer(env.BSC_RPC_QUORUM,Math.min(2,rpcUrls.length),'BSC_RPC_QUORUM',1,rpcUrls.length);
 const hexChain='0x'+network.chainId.toString(16);
 return Object.freeze({enabled:true,network:env.PAYMENT_NETWORK,chainId:network.chainId,chainName:network.chainName,explorerUrl:network.explorerUrl,
  addChainParams:Object.freeze({chainId:hexChain,chainName:network.chainName,nativeCurrency:network.native,rpcUrls:[network.walletRpcUrl],blockExplorerUrls:[network.explorerUrl]}),
  payTo:env.PAYMENT_ADDRESS.toLowerCase(),payToChecksum:toChecksum(env.PAYMENT_ADDRESS),tokens:paymentTokens(env.PAYMENT_TOKENS,network.tokens),
  rpcUrls:Object.freeze(rpcUrls),quorum,logRpcUrls:Object.freeze(logRpcUrls),logChunk:integer(env.BSC_LOG_CHUNK,2000,'BSC_LOG_CHUNK',1,5000),
  scanStartBlock:integer(env.PAYMENT_SCAN_START_BLOCK,null,'PAYMENT_SCAN_START_BLOCK',0,Number.MAX_SAFE_INTEGER),testPlan});
}
/** Account, email, payment and worker settings; throws on invalid values (see `npm run check-config`). */
export function accountsConfig(env=process.env){
 const siteKey=env.SITE_API_KEY||null;
 if(siteKey&&siteKey.length<32)throw new Error('SITE_API_KEY must be at least 32 characters');
 const walletConnectProjectId=env.WALLETCONNECT_PROJECT_ID||null;
 if(walletConnectProjectId&&!/^[0-9a-f]{32}$/.test(walletConnectProjectId))throw new Error('WALLETCONNECT_PROJECT_ID must be the 32-character project id from Reown Cloud');
 const publicSiteUrl=httpUrl(env.PUBLIC_SITE_URL||'https://adoption.kadena.ws','PUBLIC_SITE_URL',{allowPath:false});
 const admins=list(env.ADMIN_EMAILS).map(normalizeEmail);
 if(admins.includes(null))throw new Error('ADMIN_EMAILS must be comma-separated email addresses');
 const adminEmails=new Set(admins);
 return Object.freeze({siteKey,publicSiteUrl,adminEmails,mail:mailConfig(env,publicSiteUrl),
  payments:paymentsConfig(env),walletConnectProjectId,
  workerIntervalMs:integer(env.WORKER_INTERVAL_MS,60000,'WORKER_INTERVAL_MS',1000,3600000)});
}
/** Everything off: used when the .env settings are invalid, so the public index keeps running. */
export function disabledAccountsConfig(){
 return Object.freeze({siteKey:null,publicSiteUrl:'https://adoption.kadena.ws',adminEmails:new Set(),
  mail:Object.freeze({transport:'none',open:false,resendApiKey:null,from:'Kadena Adoption Index <index@kadena.ws>',supportEmail:null,logFile:fileURLToPath(new URL('../data/mail.log',import.meta.url))}),
  payments:Object.freeze({enabled:false,reason:'accounts configuration is invalid',testPlan:false}),
  walletConnectProjectId:null,workerIntervalMs:60000});
}
