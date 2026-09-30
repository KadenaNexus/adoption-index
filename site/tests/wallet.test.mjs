import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  TRANSFER_SELECTOR, chainIdHex, classifyWalletError, encodeTransfer, explorerTxUrl, formatTokenAmount, isAddress, isTxHash, noWalletMessage,
  normalizeTxHash, parseChainId, sameChain, shortAddress, unsupportedWalletsMessage, utf8ToHex, walletConnectAddress, walletConnectFailure, walletConnectInit,
} from '../lib/wallet.ts';

const PAY_TO = '0x4274907CE85E100a5EbAe1f7286DeB5083a52e98';
const E18 = 10n ** 18n;

test('encodeTransfer matches independently computed ERC-20 transfer calldata', () => {
  // Vectors computed with Python (address left-padded to 32 bytes, amount as a 32-byte big-endian word).
  assert.equal(encodeTransfer(PAY_TO, 9n * E18),
    '0xa9059cbb0000000000000000000000004274907ce85e100a5ebae1f7286deb5083a52e980000000000000000000000000000000000000000000000007ce66c50e2840000');
  assert.equal(encodeTransfer(PAY_TO, (79n * E18).toString()),
    '0xa9059cbb0000000000000000000000004274907ce85e100a5ebae1f7286deb5083a52e9800000000000000000000000000000000000000000000000448586170a7dc0000');
  assert.equal(encodeTransfer('0x0000000000000000000000000000000000000001', 1n),
    '0xa9059cbb00000000000000000000000000000000000000000000000000000000000000010000000000000000000000000000000000000000000000000000000000000001');
  // keccak256("transfer(address,uint256)")[0..4], checked with @noble/hashes when the vector was written.
  assert.equal(TRANSFER_SELECTOR, '0xa9059cbb');
  assert.equal(encodeTransfer(PAY_TO.toLowerCase(), 9n * E18), encodeTransfer(PAY_TO, 9n * E18));
  assert.equal(encodeTransfer(PAY_TO, (1n << 256n) - 1n).slice(-64), 'f'.repeat(64));
});
test('encodeTransfer refuses anything that is not a positive uint256 to a 20-byte address', () => {
  for (const to of ['0x1234', PAY_TO.slice(2), `${PAY_TO}00`, '0xZZ74907CE85E100a5EbAe1f7286DeB5083a52e98', null]) assert.throws(() => encodeTransfer(to, 1n), /address/);
  for (const amount of [0n, -1n, 1n << 256n, '1.5', '-1', '', '1e18', ' 9']) assert.throws(() => encodeTransfer(PAY_TO, amount), /amount/);
});

test('utf8ToHex encodes UTF-8 bytes, so non-ASCII emails in the link message sign correctly', () => {
  assert.equal(utf8ToHex(''), '0x');
  assert.equal(utf8ToHex('Link'), '0x4c696e6b');
  assert.equal(utf8ToHex('é€😀中'), '0xc3a9e282acf09f9880e4b8ad');
  const message = 'Link this wallet to ali@exämple.com';
  assert.equal(utf8ToHex(message), '0x4c696e6b20746869732077616c6c657420746f20616c69406578c3a46d706c652e636f6d');
  // The byte length (what EIP-191 prefixes) is longer than the string length for non-ASCII text.
  assert.equal((utf8ToHex(message).length - 2) / 2, message.length + 1);
  assert.equal(utf8ToHex('a\nb'), '0x610a62');
});

test('chain ids: hex for the wallet, and any reported form compared as a number', () => {
  assert.equal(chainIdHex(56), '0x38');
  assert.equal(chainIdHex(97), '0x61');
  for (const bad of [0, -1, 1.5, Number.NaN]) assert.throws(() => chainIdHex(bad));
  for (const value of ['0x38', '0X38', ' 0x38 ', 56, '56']) assert.equal(parseChainId(value), 56);
  for (const value of ['0x', 'bsc', null, undefined, 0, -56, '0x0', {}]) assert.equal(parseChainId(value), null);
  assert.equal(sameChain('0x38', 56), true);
  assert.equal(sameChain('0x61', 56), false);
  assert.equal(sameChain(undefined, 56), false);
});

test('token amounts use BigInt, with no rounding', () => {
  assert.equal(formatTokenAmount(9n * E18, 18), '9');
  assert.equal(formatTokenAmount((79n * E18).toString(), 18), '79');
  assert.equal(formatTokenAmount('1', 18), '0.000000000000000001');
  assert.equal(formatTokenAmount(8_500_000n, 6), '8.5');
  assert.equal(formatTokenAmount(1n, 6), '0.000001');
  assert.equal(formatTokenAmount(0n, 18), '0');
  assert.equal(formatTokenAmount(-15n, 1), '-1.5');
  assert.equal(formatTokenAmount(42n, 0), '42');
  assert.throws(() => formatTokenAmount('9.5', 18));
  assert.throws(() => formatTokenAmount(1n, 37));
});

test('short addresses, transaction hashes and explorer links', () => {
  assert.equal(shortAddress(PAY_TO), '0x4274…2e98');
  assert.equal(shortAddress('0x' + 'ab'.repeat(32), 10, 8), '0xabababab…abababab');
  assert.equal(shortAddress('0x1234'), '0x1234');
  assert.equal(shortAddress(undefined), '');
  const hash = '0x' + 'aB'.repeat(32);
  assert.equal(isTxHash(hash), true);
  assert.equal(isTxHash(hash.slice(0, -1)), false);
  assert.equal(isTxHash(hash.slice(2)), false);
  assert.equal(normalizeTxHash(`  ${hash}\n`), hash.toLowerCase());
  assert.equal(normalizeTxHash('0x123'), null);
  assert.equal(normalizeTxHash(42), null);
  assert.equal(isAddress(PAY_TO), true);
  assert.equal(explorerTxUrl('https://bscscan.com', hash), `https://bscscan.com/tx/${hash.toLowerCase()}`);
  assert.equal(explorerTxUrl('https://testnet.bscscan.com/', hash), `https://testnet.bscscan.com/tx/${hash.toLowerCase()}`);
  assert.equal(explorerTxUrl('javascript:alert(1)', hash), null);
  assert.equal(explorerTxUrl('https://bscscan.com', '0x12'), null);
  assert.equal(explorerTxUrl(null, hash), null);
});

test('EIP-1193 errors: user rejection, unknown chain (top-level and MetaMask Mobile’s nested -32603) and the rest', () => {
  assert.equal(classifyWalletError({ code: 4001, message: 'User rejected the request.' }), 'user_rejected');
  assert.equal(classifyWalletError({ code: 'ACTION_REJECTED' }), 'user_rejected');
  assert.equal(classifyWalletError({ code: -32603, data: { originalError: { code: 4001 } } }), 'user_rejected');
  assert.equal(classifyWalletError({ code: 4902 }), 'chain_not_added');
  assert.equal(classifyWalletError({ code: -32603, message: 'Internal JSON-RPC error.', data: { originalError: { code: 4902, message: 'Unrecognized chain ID' } } }), 'chain_not_added');
  assert.equal(classifyWalletError({ code: -32603, data: { code: 4902 } }), 'chain_not_added');
  assert.equal(classifyWalletError(new Error('Unrecognized chain ID "0x38". Try adding the chain using wallet_addEthereumChain first.')), 'chain_not_added');
  // A bare -32603 is an internal error, not a missing chain: adding the chain would be the wrong reaction.
  assert.equal(classifyWalletError({ code: -32603, message: 'Internal JSON-RPC error.' }), 'wallet_error');
  assert.equal(classifyWalletError({ code: -32002 }), 'request_pending');
  assert.equal(classifyWalletError({ code: 4200 }), 'unsupported_method');
  assert.equal(classifyWalletError({ code: -32601 }), 'unsupported_method');
  assert.equal(classifyWalletError({ code: 4100 }), 'unauthorized');
  assert.equal(classifyWalletError({ code: 4900 }), 'disconnected');
  assert.equal(classifyWalletError({ code: 4901 }), 'disconnected');
  for (const odd of [null, undefined, 'boom', 42, {}, { code: 1234 }]) assert.equal(classifyWalletError(odd), 'wallet_error');
});

test('WalletConnect errors: a refusal in the wallet app, a session that is gone, and a request that expired', () => {
  // A refusal relayed from the wallet: a JSON-RPC error with code 5000 or 4001, or (from some wallets) only the text.
  for (const refusal of [{ code: 5000, message: 'User rejected.' }, { code: 5002, message: 'User rejected methods.' }, { code: 4001, message: 'User rejected the request.' },
    new Error('User rejected.'), { code: -32000, message: 'User denied transaction signature' }, { code: 1, message: 'Transaction cancelled by user' },
    { message: 'User canceled' }, { message: 'Request rejected by the user' }, 'User declined']) assert.equal(classifyWalletError(refusal), 'user_rejected', JSON.stringify(refusal));
  for (const gone of [{ code: 6000, message: 'User disconnected.' }, new Error('Missing or invalid. Record was recently deleted - session: 4a1b'),
    new Error("No matching key. session topic doesn't exist: 4a1b"), new Error('Please call connect() before request()')]) assert.equal(classifyWalletError(gone), 'disconnected', String(gone.message));
  assert.equal(classifyWalletError(new Error('Request expired. Please try again.')), 'request_expired');
  assert.equal(classifyWalletError(new Error('Connection request reset. Please try again.')), 'wallet_error', 'a closed QR modal is a WalletConnect matter, not a wallet refusal');
});

test('a failed WalletConnect connect: closed modal, refused session, BSC left out, expired QR code, or a broken start', () => {
  // EthereumProvider rejects a closed modal with this text, and wraps a wallet's refusal as new Error(message).
  assert.equal(walletConnectFailure(new Error('Connection request reset. Please try again.')), 'walletconnect_closed');
  assert.equal(walletConnectFailure(new Error('User rejected.')), 'user_rejected');
  assert.equal(walletConnectFailure({ code: 5000, message: 'User rejected.' }), 'user_rejected');
  assert.equal(walletConnectFailure(new Error('Unsupported chains.')), 'wc_chain_missing');
  assert.equal(walletConnectFailure(new Error('User rejected chains.')), 'wc_chain_missing');
  assert.equal(walletConnectFailure({ code: 5100, message: 'Unsupported' }), 'wc_chain_missing');
  assert.equal(walletConnectFailure(new Error('Proposal expired')), 'walletconnect_expired');
  for (const broken of [new Error("Couldn't establish socket connection to the relay server: wss://relay.walletconnect.org"),
    new Error('No internet connection detected. Please restart your network and try again.'), new Error('Unauthorized: invalid key'), null, 'boom'])
    assert.equal(walletConnectFailure(broken), 'walletconnect_failed', String(broken?.message ?? broken));
});

test('WalletConnect init: BSC as an optional chain, the page origin, and a PNG icon for the wallet', () => {
  const init = walletConnectInit({ projectId: 'ab'.repeat(16), chainId: 56, rpcUrl: 'https://bsc-dataseed.bnbchain.org', description: 'Index Pro payment on BNB Smart Chain' }, 'https://adoption.kadena.ws');
  assert.deepEqual(init, {
    projectId: 'ab'.repeat(16), optionalChains: [56], rpcMap: { 56: 'https://bsc-dataseed.bnbchain.org' }, showQrModal: true,
    metadata: { name: 'Kadena Community Edition Adoption Index', description: 'Index Pro payment on BNB Smart Chain', url: 'https://adoption.kadena.ws', icons: ['https://adoption.kadena.ws/icon-192.png'] },
  });
  assert.equal('chains' in init, false, 'no required chains: wallets may refuse a session that requires one');
});

test('a WalletConnect session pays from an approved account on this chain', () => {
  const address = '0x2c7536e3605d9c16a7a3d7b1898e529396a65c23', other = '0x' + '3'.repeat(40);
  const upper = address.toUpperCase().replace('0X', '0x');
  const session = { namespaces: { eip155: { accounts: [`eip155:1:${other}`, `eip155:56:${upper}`, `eip155:56:${PAY_TO}`] } } };
  assert.equal(walletConnectAddress(session, 56, [address]), address, 'the account the wallet reported, when BSC has it');
  assert.equal(walletConnectAddress(session, 56, [other]), upper, 'an account from another chain is not used; the first BSC account is');
  assert.equal(walletConnectAddress(session, 56, undefined), upper);
  assert.equal(walletConnectAddress(session, 97, [address]), null, 'no account on this chain');
  assert.equal(walletConnectAddress({ namespaces: { eip155: { accounts: [`eip155:1:${address}`] } } }, 56, [address]), null);
  assert.equal(walletConnectAddress({ namespaces: { eip155: { accounts: ['eip155:56:nope', 5] } } }, 56, ['nope']), null);
  for (const odd of [undefined, null, {}, { namespaces: {} }, { namespaces: { eip155: { accounts: 'x' } } }]) assert.equal(walletConnectAddress(odd, 56, [address]), null);
});

test('the no-wallet message leads with WalletConnect and mentions the 6-digit code for in-app browsers', () => {
  const withWc = noWalletMessage(true);
  assert.match(withWc, /^No browser wallet found\. Connect with WalletConnect — scan the QR code or open your wallet app\./);
  assert.ok(withWc.indexOf('WalletConnect') < withWc.indexOf('MetaMask'));
  assert.match(withWc, /6-digit code from your email/);
  const without = noWalletMessage(false);
  assert.doesNotMatch(without, /WalletConnect/);
  assert.match(without, /MetaMask, Trust Wallet or Binance Wallet/);
  assert.match(without, /6-digit code from your email/);
});

test('a wallet left out for lacking BNB Smart Chain is named, so the visitor knows why it is missing', () => {
  assert.equal(unsupportedWalletsMessage(['Phantom'], 'BNB Smart Chain'), 'Phantom doesn’t support BNB Smart Chain, so it isn’t listed.');
  assert.equal(unsupportedWalletsMessage(['Phantom', 'Other', 'Third'], 'BNB Smart Chain'), 'Phantom, Other and Third don’t support BNB Smart Chain, so they aren’t listed.');
});
