import {keccak_256} from '@noble/hashes/sha3.js';
export const isAddress=value=>typeof value==='string'&&/^0x[0-9a-fA-F]{40}$/.test(value);
export function toChecksum(address){
 if(!isAddress(address))throw new Error('Invalid EVM address');
 const lower=address.slice(2).toLowerCase(),hash=Buffer.from(keccak_256(Buffer.from(lower,'ascii'))).toString('hex');
 return '0x'+[...lower].map((c,i)=>parseInt(hash[i],16)>=8?c.toUpperCase():c).join('');
}
/** All-lowercase or all-uppercase addresses carry no checksum; mixed case must match EIP-55 exactly. */
export const hasValidChecksum=address=>{if(!isAddress(address))return false;const hex=address.slice(2);return hex===hex.toLowerCase()||hex===hex.toUpperCase()||toChecksum(address)===address};
