import {secp256k1} from '@noble/curves/secp256k1.js';
import {keccak_256} from '@noble/hashes/sha3.js';
import {isAddress,toChecksum,hasValidChecksum} from './evm-address.mjs';
export {isAddress,toChecksum,hasValidChecksum};
/** keccak256("Transfer(address,address,uint256)"). */
export const TRANSFER_TOPIC='0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef';
const N=secp256k1.Point.Fn.ORDER,HALF_N=N>>1n;
const word=value=>value.toString(16).padStart(64,'0');
const invalid=reason=>Object.assign(new Error(`Invalid signature (${reason})`),{code:'invalid_signature'});
// JSON-RPC quantities are hex strings; normalised receipts already hold integers.
const hexNumber=value=>Number.isSafeInteger(value)&&value>=0?value:typeof value==='string'&&/^0x[0-9a-fA-F]{1,16}$/.test(value)&&Number.isSafeInteger(Number(value))?Number(value):null;
/** The 32-byte log topic of an address. */
export function addressTopic(address){if(!isAddress(address))throw new Error('Invalid EVM address');return '0x'+'0'.repeat(24)+address.slice(2).toLowerCase()}
const topicAddress=topic=>/^0x0{24}[0-9a-f]{40}$/.test(topic)?'0x'+topic.slice(26):null;
/** EIP-191 personal_sign digest. The length prefix counts UTF-8 bytes, not JavaScript characters. */
export function personalHash(message){
 if(typeof message!=='string')throw new TypeError('The message must be a string');
 const m=Buffer.from(message,'utf8');
 return keccak_256(Buffer.concat([Buffer.from('\x19Ethereum Signed Message:\n'+m.length,'utf8'),m]));
}
/**
 * The lowercase address whose key produced a 65-byte personal_sign signature (r‖s‖v). A successful ECDSA recovery
 * is the EOA test: contract wallets (EIP-1271) are unsupported, and eth_getCode is never used because EIP-7702
 * accounts on BSC carry code yet still sign with their key.
 */
export function recoverPersonalSigner(message,sigHex){
 if(typeof sigHex!=='string'||!/^0x[0-9a-fA-F]{130}$/.test(sigHex))throw invalid('expected 65 bytes of hex');
 const b=Buffer.from(sigHex.slice(2),'hex');
 let v=b[64];if(v>=27)v-=27;if(v>1)throw invalid('recovery id');
 const r=BigInt('0x'+b.subarray(0,32).toString('hex'));let s=BigInt('0x'+b.subarray(32,64).toString('hex'));
 if(r<1n||r>=N||s<1n||s>=N)throw invalid('out of range');
 // A high-s signature is the same signature mirrored; some wallets still produce it, so normalise instead of refusing.
 if(s>HALF_N){s=N-s;v^=1}
 // noble v2: the recovery byte goes first, prehash must be off (the digest is already keccak), and the result is compressed.
 const digest=personalHash(message);let pub;
 try{pub=secp256k1.Point.fromBytes(secp256k1.recoverPublicKey(Uint8Array.of(v,...Buffer.from(word(r)+word(s),'hex')),digest,{prehash:false})).toBytes(false)}
 catch{throw invalid('recovery failed')}
 return '0x'+Buffer.from(keccak_256(pub.subarray(1)).slice(-20)).toString('hex');
}
/**
 * A standard ERC-20 Transfer log as {address, from, to, value (BigInt), logIndex, transactionHash, blockNumber, blockHash},
 * all hex lowercase; null for anything else (ERC-721 Transfers have 4 topics, non-standard data is not 32 bytes).
 */
export function decodeTransferLog(log){
 if(!log||typeof log!=='object'||!isAddress(log.address)||!Array.isArray(log.topics)||log.topics.length!==3||typeof log.data!=='string')return null;
 const topics=log.topics.map(t=>String(t).toLowerCase()),data=log.data.toLowerCase();
 if(topics[0]!==TRANSFER_TOPIC||!/^0x[0-9a-f]{64}$/.test(data))return null;
 const from=topicAddress(topics[1]),to=topicAddress(topics[2]);
 if(!from||!to)return null;
 const hash=value=>typeof value==='string'&&/^0x[0-9a-fA-F]{64}$/.test(value)?value.toLowerCase():null;
 return {address:log.address.toLowerCase(),from,to,value:BigInt(data),logIndex:hexNumber(log.logIndex),transactionHash:hash(log.transactionHash),blockNumber:hexNumber(log.blockNumber),blockHash:hash(log.blockHash)};
}
