import {test} from 'node:test';
import assert from 'node:assert/strict';
import {secp256k1} from '@noble/curves/secp256k1.js';
import {keccak_256} from '@noble/hashes/sha3.js';
import {personalHash,recoverPersonalSigner,decodeTransferLog,addressTopic,toChecksum,hasValidChecksum,isAddress,TRANSFER_TOPIC} from '../src/evm.mjs';
// Vectors from an independent implementation (viem 2.57: privateKeyToAccount().signMessage, hashMessage,
// recoverMessageAddress, getAddress). A test that signs and recovers with noble alone would pass
// even with the prehash, byte-order or UTF-8 length mistakes these guard against.
const KEY='0x4c0883a69102937d6231471b5dbb6204fe5129617082792ae468d01a3f362318',SIGNER='0x2c7536e3605d9c16a7a3d7b1898e529396a65c23';
const MESSAGE='Link this wallet to a@b.co\nNonce: abc';
const SIG='0x300f9bc27df1c78200d20059bd4a186ab9541ee1580184c98aa2e6d49002cc71259b647cf683197c82051e5c2892f4b901c6826a07ffb8ab31fc25ed37d6d8621b';
// The same signature mirrored (s := n - s, v 27 -> 28); viem recovers the same signer from it.
const HIGH_S='0x300f9bc27df1c78200d20059bd4a186ab9541ee1580184c98aa2e6d49002cc71da649b83097ce6837dfae1a3d76d0b45b8e85a7ca748e7908dd6389f985f68df1c';
const UTF8={message:'Link this wallet to jürgen@exämple.de — 日本語 ✓\nNonce: 7f3a',hash:'0xca975fd08795468ce48e43d8dee84cc9f881f6dd43f51679fcaa8c669817e6db',
 sig:'0xd3310c33bcc1b785d900619b28bf350b8029c067bad1b603abb07605ce2e562e143a98dad6fed4397324ae46a5a803119cb0b5d253c80886f8ecc268fd7d7c3f1b'};
// Second key (0x11 repeated); this signature has v = 28.
const V28={signer:'0x19e7e376e7c213b7e7e7e46cc70a5dd086daff2a',message:'Ethereum ✓ 🚀 multi-byte',hash:'0x8259dadb2a5ef9a733b10e7121df718402d5aa5442d294737a48d8dfe7913a45',
 sig:'0x76f26abf8df20f0f5e6e871bbc4c2f68873f0b5ac630bf0a271c05b9375a26ec690bf45b26e1e1fda575aab06231838144fafa98b50c04a01082184b9d3d61881c'};
const hex=bytes=>'0x'+Buffer.from(bytes).toString('hex');
const rejects=(sig,message=MESSAGE)=>assert.throws(()=>recoverPersonalSigner(message,sig),e=>e.code==='invalid_signature',String(sig).slice(0,20));

test('the required viem known-answer vector recovers the documented signer',()=>{
 assert.equal(recoverPersonalSigner(MESSAGE,SIG),SIGNER);
 assert.equal(hex(personalHash(MESSAGE)),'0x41015cef456edb58876392564b4c155df85a3af00d8aac88995dffa65d6c4583');
 // The key really is the signer's (sanity check of the vector itself, independent of recovery).
 assert.equal(hex(keccak_256(secp256k1.getPublicKey(Buffer.from(KEY.slice(2),'hex'),false).subarray(1)).slice(-20)),SIGNER);
});
test('v may be 27/28 or 0/1, upper- or lowercase hex',()=>{
 assert.equal(recoverPersonalSigner(MESSAGE,SIG.slice(0,130)+'00'),SIGNER);
 assert.equal(recoverPersonalSigner(V28.message,V28.sig),V28.signer);
 assert.equal(recoverPersonalSigner(V28.message,V28.sig.slice(0,130)+'01'),V28.signer);
 assert.equal(recoverPersonalSigner(MESSAGE,'0x'+SIG.slice(2).toUpperCase()),SIGNER);
 assert.equal(hex(personalHash(V28.message)),V28.hash);
});
test('a high-s signature is normalised (s := n - s, v flipped), not rejected',()=>{
 assert.equal(recoverPersonalSigner(MESSAGE,HIGH_S),SIGNER);
 assert.equal(recoverPersonalSigner(MESSAGE,HIGH_S.slice(0,130)+'01'),SIGNER);
});
test('the EIP-191 length prefix counts UTF-8 bytes, so non-ASCII emails link',()=>{
 assert.notEqual(Buffer.byteLength(UTF8.message),UTF8.message.length);
 assert.equal(hex(personalHash(UTF8.message)),UTF8.hash);
 assert.equal(recoverPersonalSigner(UTF8.message,UTF8.sig),SIGNER);
 assert.equal(hex(personalHash('')),'0x5f35dce98ba4fba25530a026ed80b2cecdaa31091ba4958b99b52ea1d068adad');
 assert.equal(recoverPersonalSigner('','0x8a68b4e66cd2b575338e16069d7b65f6f67c7ceae8945dccf8cb7bdb06278d933dd9c888f3444ca4698464079a067ad3cfffe96d493b8ecf56885169d0fdfe7d1b'),SIGNER);
});
test('a signature over another message recovers someone else',()=>{
 assert.notEqual(recoverPersonalSigner(MESSAGE+' ',SIG),SIGNER);
 assert.notEqual(recoverPersonalSigner(UTF8.message.normalize('NFD'),UTF8.sig),SIGNER);
});
test('bad lengths, encodings, recovery ids and ranges are invalid_signature',()=>{
 const N=secp256k1.Point.Fn.ORDER,r=SIG.slice(2,66),s=SIG.slice(66,130),word=n=>n.toString(16).padStart(64,'0');
 for(const sig of [SIG.slice(0,130),SIG+'00',SIG.slice(0,-1),'0x',SIG.slice(2),'0x'+'g'.repeat(130),`${SIG} `,undefined,null,42,{},
  SIG.slice(0,130)+'02',SIG.slice(0,130)+'1a',SIG.slice(0,130)+'1d',SIG.slice(0,130)+'ff',
  '0x'+'0'.repeat(64)+s+'1b','0x'+r+'0'.repeat(64)+'1b','0x'+word(N)+s+'1b','0x'+r+word(N)+'1b','0x'+'f'.repeat(128)+'1b'])rejects(sig);
 assert.throws(()=>recoverPersonalSigner(42,SIG),TypeError);
});
test('decodeTransferLog accepts only standard ERC-20 Transfer logs',()=>{
 const token='0x55d398326f99059fF775485246999027B3197955',from='0x'+'11'.repeat(20),to='0x'+'22'.repeat(20);
 const log={address:token,topics:[TRANSFER_TOPIC,addressTopic(from),addressTopic(to).toUpperCase().replace('0X','0x')],data:'0x'+(5n*10n**17n).toString(16).padStart(64,'0'),logIndex:'0x1f',transactionHash:'0x'+'AB'.repeat(32),blockNumber:'0x10',blockHash:'0x'+'cd'.repeat(32)};
 assert.deepEqual(decodeTransferLog(log),{address:token.toLowerCase(),from,to,value:5n*10n**17n,logIndex:31,transactionHash:'0x'+'ab'.repeat(32),blockNumber:16,blockHash:'0x'+'cd'.repeat(32)});
 assert.equal(decodeTransferLog({...log,data:'0x'+'0'.repeat(64)}).value,0n);
 assert.equal(decodeTransferLog({...log,logIndex:7}).logIndex,7);
 for(const bad of [{...log,topics:[...log.topics,addressTopic(to)]},{...log,topics:log.topics.slice(0,2)},{...log,data:log.data+'00'.repeat(32)},{...log,data:'0x'},
  {...log,topics:[TRANSFER_TOPIC.replace('d','e'),...log.topics.slice(1)]},{...log,topics:[TRANSFER_TOPIC,'0x01'+addressTopic(from).slice(4),log.topics[2]]},{...log,address:'0x1234'},null,'x'])assert.equal(decodeTransferLog(bad),null);
});
test('address helpers match viem getAddress',()=>{
 assert.equal(toChecksum('0x4274907ce85e100a5ebae1f7286deb5083a52e98'),'0x4274907CE85E100a5EbAe1f7286DeB5083a52e98');
 assert.equal(toChecksum(SIGNER),'0x2c7536E3605D9C16a7a3D7b1898e529396a65c23');
 assert.ok(hasValidChecksum('0x55d398326f99059fF775485246999027B3197955'));assert.ok(hasValidChecksum('0x55d398326f99059ff775485246999027b3197955'));
 assert.ok(!hasValidChecksum('0x55d398326f99059FF775485246999027B3197955'));assert.ok(!isAddress('0x55d398326f99059fF775485246999027B319795'));
 assert.equal(addressTopic('0x4274907CE85E100a5EbAe1f7286DeB5083a52e98'),'0x0000000000000000000000004274907ce85e100a5ebae1f7286deb5083a52e98');
});
