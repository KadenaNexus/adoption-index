import { test } from 'node:test';
import assert from 'node:assert/strict';
import { CheckoutError, connectInjected, connectionCounter, connectWalletConnect, discoverWallets, ensureChain, errorCodeOf, linkWallet, sendTransfer } from '../app/checkout/evm-wallets.ts';
import { encodeTransfer, utf8ToHex } from '../lib/wallet.ts';

const ADDRESS = '0x2c7536e3605d9c16a7a3d7b1898e529396a65c23', PAY_TO = '0x4274907CE85E100a5EbAe1f7286DeB5083a52e98', USDT = '0x55d398326f99059fF775485246999027B3197955';
const ADD_CHAIN = { chainId: '0x38', chainName: 'BNB Smart Chain', nativeCurrency: { name: 'BNB', symbol: 'BNB', decimals: 18 }, rpcUrls: ['https://bsc-dataseed.bnbchain.org'], blockExplorerUrls: ['https://bscscan.com'] };
const HASH = '0x' + 'ab'.repeat(32);

/** A scripted EIP-1193 provider: each method answers with a value, a function of the params, or a thrown error. */
function wallet(script) {
  const calls = [];
  return {
    calls, methods: () => calls.map(c => c.method),
    async request({ method, params }) {
      calls.push({ method, params });
      let answer = script[method];
      if (Array.isArray(answer) && answer.queue) answer = answer.length > 1 ? answer.shift() : answer[0];
      if (typeof answer === 'function') return answer(params, calls);
      if (answer instanceof Error || (answer && answer.throws)) throw answer.throws ?? answer;
      if (answer === undefined) throw Object.assign(new Error('not scripted'), { code: 4200 });
      return answer;
    },
  };
}
const queue = (...items) => Object.assign(items, { queue: true });
const rejects = (error) => ({ throws: error });
const codeOf = async (promise) => { try { await promise; return null; } catch (error) { assert.ok(error instanceof CheckoutError, String(error)); return error.code; } };
const tick = () => new Promise(resolve => setTimeout(resolve, 5));

test('ensureChain: nothing to do on the right chain', async () => {
  const w = wallet({ eth_chainId: '0x38' });
  await ensureChain(w, 56, ADD_CHAIN);
  assert.deepEqual(w.methods(), ['eth_chainId']);
});
test('ensureChain: switches when the wallet knows the chain', async () => {
  const w = wallet({ eth_chainId: queue('0x1', '0x38'), wallet_switchEthereumChain: null });
  await ensureChain(w, 56, ADD_CHAIN);
  assert.deepEqual(w.methods(), ['eth_chainId', 'wallet_switchEthereumChain', 'eth_chainId']);
  assert.deepEqual(w.calls[1].params, [{ chainId: '0x38' }]);
});
test('ensureChain: 4902 adds the chain with addChainParams, then switches', async () => {
  const w = wallet({ eth_chainId: queue('0x1', '0x1', '0x38'), wallet_switchEthereumChain: queue(rejects({ code: 4902 }), null), wallet_addEthereumChain: null });
  await ensureChain(w, 56, ADD_CHAIN);
  assert.deepEqual(w.methods(), ['eth_chainId', 'wallet_switchEthereumChain', 'wallet_addEthereumChain', 'eth_chainId', 'wallet_switchEthereumChain', 'eth_chainId']);
  assert.deepEqual(w.calls[2].params, [ADD_CHAIN]);
});
test('ensureChain: MetaMask Mobile’s -32603 with originalError 4902 also adds the chain', async () => {
  const nested = { code: -32603, message: 'Internal JSON-RPC error.', data: { originalError: { code: 4902 } } };
  const w = wallet({ eth_chainId: queue('0x1', '0x38', '0x38'), wallet_switchEthereumChain: rejects(nested), wallet_addEthereumChain: null });
  await ensureChain(w, 56, ADD_CHAIN);
  // Adding switched the wallet already, so no second switch is sent.
  assert.deepEqual(w.methods(), ['eth_chainId', 'wallet_switchEthereumChain', 'wallet_addEthereumChain', 'eth_chainId', 'eth_chainId']);
});
test('ensureChain: rejections and failures map to their own codes', async () => {
  assert.equal(await codeOf(ensureChain(wallet({ eth_chainId: '0x1', wallet_switchEthereumChain: rejects({ code: 4001 }) }), 56, ADD_CHAIN)), 'user_rejected');
  const internal = wallet({ eth_chainId: '0x1', wallet_switchEthereumChain: rejects({ code: -32603 }), wallet_addEthereumChain: null });
  assert.equal(await codeOf(ensureChain(internal, 56, ADD_CHAIN)), 'switch_failed');
  assert.ok(!internal.methods().includes('wallet_addEthereumChain'), 'a bare -32603 must not add the chain');
  assert.equal(await codeOf(ensureChain(wallet({ eth_chainId: '0x1', wallet_switchEthereumChain: rejects({ code: 4902 }), wallet_addEthereumChain: rejects({ code: 4001 }) }), 56, ADD_CHAIN)), 'user_rejected');
  assert.equal(await codeOf(ensureChain(wallet({ eth_chainId: '0x1', wallet_switchEthereumChain: rejects({ code: 4902 }), wallet_addEthereumChain: rejects({ code: -32000 }) }), 56, ADD_CHAIN)), 'chain_not_added');
  assert.equal(await codeOf(ensureChain(wallet({ eth_chainId: '0x1', wallet_switchEthereumChain: rejects({ code: -32002 }) }), 56, ADD_CHAIN)), 'request_pending');
  assert.equal(await codeOf(ensureChain(wallet({ eth_chainId: '0x1', wallet_switchEthereumChain: null }), 56, ADD_CHAIN)), 'wrong_chain');
});

const transfer = { from: ADDRESS, chainId: 56, tokenAddress: USDT, payTo: PAY_TO, amount: '9000000000000000000' };
test('sendTransfer re-reads the chain right before sending and puts chainId in the transaction', async () => {
  const w = wallet({ eth_chainId: '0x38', eth_accounts: [ADDRESS.toUpperCase().replace('0X', '0x')], eth_sendTransaction: HASH.toUpperCase().replace('0X', '0x') });
  assert.equal(await sendTransfer(w, transfer), HASH);
  assert.deepEqual(w.methods(), ['eth_chainId', 'eth_accounts', 'eth_sendTransaction']);
  assert.deepEqual(w.calls[2].params, [{ from: ADDRESS, to: USDT, data: encodeTransfer(PAY_TO, 9n * 10n ** 18n), value: '0x0', chainId: '0x38' }]);
});
test('sendTransfer never sends on the wrong chain or from a different account', async () => {
  const moved = wallet({ eth_chainId: '0x1', eth_accounts: [ADDRESS], eth_sendTransaction: HASH });
  assert.equal(await codeOf(sendTransfer(moved, transfer)), 'wrong_chain');
  assert.ok(!moved.methods().includes('eth_sendTransaction'));
  const switched = wallet({ eth_chainId: '0x38', eth_accounts: [PAY_TO], eth_sendTransaction: HASH });
  assert.equal(await codeOf(sendTransfer(switched, transfer)), 'account_changed');
  assert.ok(!switched.methods().includes('eth_sendTransaction'));
  assert.equal(await codeOf(sendTransfer(wallet({ eth_chainId: '0x38', eth_accounts: [ADDRESS], eth_sendTransaction: rejects({ code: 4001 }) }), transfer)), 'user_rejected');
  assert.equal(await codeOf(sendTransfer(wallet({ eth_chainId: '0x38', eth_accounts: [ADDRESS], eth_sendTransaction: { hash: HASH } }), transfer)), 'invalid_tx_response');
});

function poster(replies) {
  const posts = [];
  return { posts, post: async (url, body) => { posts.push({ url, body }); const reply = replies[url]; return typeof reply === 'function' ? reply(body) : reply; } };
}
const message = 'adoption.kadena.ws wants you to link this wallet.\nLink this wallet to ali@exämple.com for Kadena Community Edition Adoption Index payments.\nNonce: n1';
const SIG = '0x' + 'cd'.repeat(65);
test('linkWallet: challenge → personal_sign [utf8ToHex(message), address] → link', async () => {
  const w = wallet({ personal_sign: SIG });
  const api = poster({ '/api/wallets/challenge': { status: 200, data: { nonce: 'n1', message, expiresAt: '2026-09-29T12:10:00Z' } }, '/api/wallets/link': { status: 200, data: { ok: true } } });
  await linkWallet(w, ADDRESS, api.post);
  assert.deepEqual(api.posts, [{ url: '/api/wallets/challenge', body: { address: ADDRESS } }, { url: '/api/wallets/link', body: { nonce: 'n1', signature: SIG } }]);
  assert.deepEqual(w.calls[0], { method: 'personal_sign', params: [utf8ToHex(message), ADDRESS] });
  assert.ok(w.calls[0].params[0].includes('c3a4'), 'ä is sent as its UTF-8 bytes');
});
test('linkWallet: errors from either step keep their code, and a refused signature links nothing', async () => {
  const challenge = { status: 200, data: { nonce: 'n1', message } };
  const elsewhere = poster({ '/api/wallets/challenge': challenge, '/api/wallets/link': { status: 409, data: { error: 'wallet_linked_elsewhere' } } });
  assert.equal(await codeOf(linkWallet(wallet({ personal_sign: SIG }), ADDRESS, elsewhere.post)), 'wallet_linked_elsewhere');
  const refused = poster({ '/api/wallets/challenge': challenge, '/api/wallets/link': { status: 200, data: {} } });
  assert.equal(await codeOf(linkWallet(wallet({ personal_sign: rejects({ code: 4001 }) }), ADDRESS, refused.post)), 'user_rejected');
  assert.deepEqual(refused.posts.map(p => p.url), ['/api/wallets/challenge']);
  assert.equal(await codeOf(linkWallet(wallet({ personal_sign: '0x1234' }), ADDRESS, refused.post)), 'invalid_signature');
  assert.equal(await codeOf(linkWallet(wallet({}), ADDRESS, poster({ '/api/wallets/challenge': { status: 403, data: { error: 'payments_not_open' } } }).post)), 'payments_not_open');
  assert.equal(await codeOf(linkWallet(wallet({}), ADDRESS, poster({ '/api/wallets/challenge': { status: 503, data: null } }).post)), 'backend_unavailable');
  assert.equal(await codeOf(linkWallet(wallet({ personal_sign: SIG }), ADDRESS, poster({ '/api/wallets/challenge': challenge, '/api/wallets/link': { status: 400, data: { error: 'challenge_expired' } } }).post)), 'challenge_expired');
});

test('a late answer from a connection the visitor has left is recognised, even from the same WalletConnect provider', async () => {
  const connections = connectionCounter();
  let expire;
  const shared = wallet({ personal_sign: () => new Promise((_, reject) => { expire = reject; }) });
  const api = poster({ '/api/wallets/challenge': { status: 200, data: { nonce: 'n1', message } }, '/api/wallets/link': { status: 200, data: {} } });
  const first = connections.start();
  const late = linkWallet(shared, ADDRESS, api.post).catch(error => ({ code: errorCodeOf(error), current: connections.current() === first }));
  await tick();
  connections.end(); // Use another wallet
  const second = connections.start(); // WalletConnect again: the same provider object comes back
  // WalletConnect expires the unanswered signature request 15 minutes later.
  expire(new Error('Request expired. Please try again.'));
  assert.deepEqual(await late, { code: 'request_expired', current: false });
  assert.equal(connections.current(), second);
});

test('connectInjected returns the first account, and handles refusal', async () => {
  assert.equal(await connectInjected(wallet({ eth_requestAccounts: [ADDRESS, PAY_TO] })), ADDRESS);
  assert.equal(await codeOf(connectInjected(wallet({ eth_requestAccounts: [] }))), 'no_accounts');
  assert.equal(await codeOf(connectInjected(wallet({ eth_requestAccounts: rejects({ code: 4001 }) }))), 'user_rejected');
  assert.equal(await codeOf(connectInjected(wallet({ eth_requestAccounts: rejects({ code: -32002 }) }))), 'request_pending');
});

/** A fake EthereumProvider: `enable` pairs a session holding `namespaceAccounts` (or runs `enable`); closing the modal is counted. */
function walletConnectFake({ accounts = [ADDRESS], namespaceAccounts = [`eip155:56:${ADDRESS}`], enable, session = null } = {}) {
  const fake = {
    disconnects: 0, enables: 0, modalCloses: 0, session,
    request: async () => null,
    enable: async () => {
      fake.enables++;
      if (enable) return enable(fake);
      fake.session ??= { namespaces: { eip155: { accounts: namespaceAccounts } } };
      return accounts;
    },
    disconnect: async () => { fake.disconnects++; fake.session = null; },
    modal: { close: async () => { fake.modalCloses++; } },
  };
  return fake;
}
const wcSettings = { projectId: 'ab'.repeat(16), chainId: 56, rpcUrl: 'https://bsc-dataseed.bnbchain.org', description: 'Index Pro payment' };
const loads = fake => async () => fake;
test('WalletConnect: the approved session must hold a BSC account, which is the one paid from', async () => {
  const good = walletConnectFake(), seen = [];
  const connected = await connectWalletConnect(wcSettings, { load: async settings => { seen.push(settings); return good; } });
  assert.equal(connected.address, ADDRESS);
  assert.equal(connected.provider, good);
  assert.deepEqual(seen, [wcSettings]);
  const noBsc = walletConnectFake({ namespaceAccounts: [`eip155:1:${ADDRESS}`] });
  assert.equal(await codeOf(connectWalletConnect(wcSettings, { load: loads(noBsc) })), 'wc_chain_missing');
  assert.equal(noBsc.disconnects, 1, 'a session without BSC is ended, so the next connect shows a new QR code');
  // enable() reports the accounts of the provider's default chain, which need not be BSC: the session decides.
  const otherChainFirst = walletConnectFake({ accounts: [PAY_TO], namespaceAccounts: [`eip155:1:${PAY_TO}`, `eip155:56:${ADDRESS}`] });
  assert.equal((await connectWalletConnect(wcSettings, { load: loads(otherChainFirst) })).address, ADDRESS);
  assert.equal((await connectWalletConnect(wcSettings, { load: loads(walletConnectFake({ accounts: [] })) })).address, ADDRESS);
});
test('WalletConnect: a closed modal, a refusal, an expired QR code and a failed start each keep their own code', async () => {
  const failing = error => walletConnectFake({ enable: async () => { throw error; } });
  assert.equal(await codeOf(connectWalletConnect(wcSettings, { load: loads(failing(new Error('Connection request reset. Please try again.'))) })), 'walletconnect_closed');
  assert.equal(await codeOf(connectWalletConnect(wcSettings, { load: loads(failing(new Error('User rejected.'))) })), 'user_rejected');
  assert.equal(await codeOf(connectWalletConnect(wcSettings, { load: loads(failing(new Error('Unsupported chains.'))) })), 'wc_chain_missing');
  assert.equal(await codeOf(connectWalletConnect(wcSettings, { load: loads(failing(new Error('Proposal expired'))) })), 'walletconnect_expired');
  assert.equal(await codeOf(connectWalletConnect(wcSettings, { load: loads(failing(new Error("Couldn't establish socket connection to the relay server"))) })), 'walletconnect_failed');
  assert.equal(await codeOf(connectWalletConnect(wcSettings, { load: async () => { throw new Error('chunk load failed'); } })), 'walletconnect_failed');
  assert.equal(await codeOf(connectWalletConnect(wcSettings, { load: async () => { throw new Error('Unauthorized: invalid key'); } })), 'walletconnect_failed');
  assert.equal(errorCodeOf(new CheckoutError('wrong_chain')), 'wrong_chain');
  assert.equal(errorCodeOf({ code: 4001 }), 'user_rejected');
});
test('WalletConnect: onReady fires once the provider is loaded, before the modal opens', async () => {
  const order = [], fake = walletConnectFake({ enable: async f => { order.push('enable'); f.session = { namespaces: { eip155: { accounts: [`eip155:56:${ADDRESS}`] } } }; return [ADDRESS]; } });
  await connectWalletConnect(wcSettings, { load: async () => { order.push('load'); return fake; }, onReady: () => order.push('ready') });
  assert.deepEqual(order, ['load', 'ready', 'enable']);
});
test('WalletConnect: a restored session is reused, unless the visitor chose another wallet (fresh)', async () => {
  const restored = { namespaces: { eip155: { accounts: [`eip155:56:${ADDRESS}`] } } };
  const reused = walletConnectFake({ session: restored });
  assert.equal((await connectWalletConnect(wcSettings, { load: loads(reused) })).address, ADDRESS);
  assert.equal(reused.disconnects, 0);
  const fresh = walletConnectFake({ session: restored, namespaceAccounts: [`eip155:56:${PAY_TO}`] });
  assert.equal((await connectWalletConnect(wcSettings, { load: loads(fresh), fresh: true })).address, PAY_TO);
  assert.deepEqual([fresh.disconnects, fresh.enables], [1, 1], 'the old session ends before the new pairing');
  // If the old session can't be ended (relay unreachable), nothing is paired on top of it.
  const stuck = walletConnectFake({ session: restored });
  stuck.disconnect = async () => { stuck.disconnects++; throw new Error('No internet connection detected.'); };
  assert.equal(await codeOf(connectWalletConnect(wcSettings, { load: loads(stuck), fresh: true })), 'walletconnect_failed');
  assert.equal(stuck.enables, 0);
});
test('WalletConnect: a relay that refuses the project id fails at once instead of after a minute of retries', async () => {
  const relayer = new EventTarget(), listeners = new Set();
  const fakeRelayer = { on: (event, listener) => { listeners.add(listener); relayer.addEventListener(event, listener); }, off: (event, listener) => { listeners.delete(listener); relayer.removeEventListener(event, listener); } };
  const refused = walletConnectFake({ enable: () => new Promise(() => {}) });
  refused.signer = { client: { core: { relayer: fakeRelayer } } };
  const pending = connectWalletConnect(wcSettings, { load: loads(refused) });
  await new Promise(resolve => setTimeout(resolve, 5));
  relayer.dispatchEvent(new Event('relayer_error'));
  assert.equal(await codeOf(pending), 'walletconnect_failed');
  assert.equal(refused.modalCloses, 1);
  assert.equal(listeners.size, 0, 'the relay listener is removed afterwards');
  const fine = walletConnectFake();
  fine.signer = { client: { core: { relayer: fakeRelayer } } };
  assert.equal((await connectWalletConnect(wcSettings, { load: loads(fine) })).address, ADDRESS);
  assert.equal(listeners.size, 0);
});
test('WalletConnect: Cancel stops the wait and closes the modal, even when the modal never opened', async () => {
  let settle;
  const hanging = walletConnectFake({ enable: () => new Promise((resolve, reject) => { settle = reject; }) });
  const cancel = new AbortController();
  const pending = connectWalletConnect(wcSettings, { load: loads(hanging), signal: cancel.signal });
  await new Promise(resolve => setTimeout(resolve, 5));
  cancel.abort();
  assert.equal(await codeOf(pending), 'walletconnect_closed');
  assert.equal(hanging.modalCloses, 1);
  settle(new Error('Connection request reset. Please try again.'));
  await new Promise(resolve => setTimeout(resolve, 5));
  // Aborted while still loading: nothing is enabled.
  const early = new AbortController();
  early.abort();
  const loaded = walletConnectFake();
  assert.equal(await codeOf(connectWalletConnect(wcSettings, { load: loads(loaded), signal: early.signal })), 'walletconnect_closed');
  assert.equal(loaded.enables, 0);
});
test('WalletConnect: Cancel while the old session is still ending starts no new pairing', async () => {
  let finish;
  const ending = walletConnectFake({ session: { namespaces: { eip155: { accounts: [`eip155:56:${ADDRESS}`] } } } });
  ending.disconnect = () => new Promise(resolve => { finish = () => { ending.session = null; resolve(); }; });
  let ready = 0;
  const cancel = new AbortController();
  const pending = connectWalletConnect(wcSettings, { load: loads(ending), fresh: true, signal: cancel.signal, onReady: () => { ready++; } });
  await tick();
  cancel.abort();
  finish();
  assert.equal(await codeOf(pending), 'walletconnect_closed');
  assert.deepEqual([ending.enables, ready, ending.modalCloses], [0, 0, 0]);
});

/** AppKit's modal as the provider sees it: close() and state changes, with listeners told only when `open` changes. */
function appKitModal() {
  const listeners = new Set();
  const modal = {
    open: false, closes: 0, listeners,
    close: async () => { modal.closes++; modal.show(false); },
    subscribeState: listener => { listeners.add(listener); return () => { listeners.delete(listener); }; },
    show: open => { if (modal.open === open) return; modal.open = open; for (const listener of [...listeners]) listener({ open }); },
  };
  return modal;
}
test('WalletConnect: a QR modal that appears after Cancel is closed as soon as it shows, and only for that attempt', async () => {
  const modal = appKitModal();
  // AppKit is still fetching its wallet list, so nothing is shown yet and close() has nothing to close.
  const loading = walletConnectFake({ enable: () => new Promise(() => {}) });
  loading.modal = modal;
  const cancel = new AbortController();
  const pending = connectWalletConnect(wcSettings, { load: loads(loading), signal: cancel.signal });
  await tick();
  cancel.abort();
  assert.equal(await codeOf(pending), 'walletconnect_closed');
  assert.deepEqual([modal.closes, modal.open], [1, false]);
  modal.show(true);
  assert.deepEqual([modal.closes, modal.open, modal.listeners.size], [2, false, 0], 'closed again the moment it appeared');
  // A relay refusal ends the attempt the same way; the next attempt's modal is left alone.
  const relayer = new EventTarget();
  const refused = walletConnectFake({ enable: () => new Promise(() => {}) });
  refused.modal = modal;
  refused.signer = { client: { core: { relayer: { on: (event, listener) => relayer.addEventListener(event, listener), off: (event, listener) => relayer.removeEventListener(event, listener) } } } };
  const failing = connectWalletConnect(wcSettings, { load: loads(refused) });
  await tick();
  relayer.dispatchEvent(new Event('relayer_error'));
  assert.equal(await codeOf(failing), 'walletconnect_failed');
  assert.equal(modal.listeners.size, 1, 'still watching for the refused attempt’s modal');
  const next = walletConnectFake({ enable: () => { modal.show(true); return new Promise(() => {}); } });
  next.modal = modal;
  connectWalletConnect(wcSettings, { load: loads(next) });
  await tick();
  assert.deepEqual([modal.open, modal.listeners.size], [true, 0], 'a new attempt stops the watch before its own modal opens');
});

function fakeWindow(extra = {}) {
  const target = new EventTarget();
  return Object.assign(target, { setTimeout: (fn, ms) => setTimeout(fn, ms), clearTimeout: id => clearTimeout(id) }, extra);
}
async function withWindow(win, fn) {
  const previous = globalThis.window;
  globalThis.window = win;
  try { return await fn(); } finally { if (previous === undefined) delete globalThis.window; else globalThis.window = previous; }
}
const provider = () => ({ request: async () => null });
test('EIP-6963 discovery lists announced wallets once each, keeping only data: icons', async () => {
  const win = fakeWindow(), lists = [];
  const metamask = provider(), trust = provider();
  win.addEventListener('eip6963:requestProvider', () => {
    const announce = (info, p) => win.dispatchEvent(new CustomEvent('eip6963:announceProvider', { detail: { info, provider: p } }));
    announce({ uuid: 'u1', name: 'MetaMask', icon: 'data:image/svg+xml;base64,PHN2Zy8+', rdns: 'io.metamask' }, metamask);
    announce({ uuid: 'u2', name: 'Trust Wallet', icon: 'https://evil.example/pixel.png', rdns: 'com.trustwallet.app' }, trust);
    announce({ uuid: 'u3', name: 'MetaMask again', icon: '', rdns: 'io.metamask' }, metamask);
    announce({ uuid: 'u4', name: 'Broken' }, { notAProvider: true });
  });
  await withWindow(win, async () => {
    const stop = discoverWallets(list => lists.push(list), 20);
    await new Promise(r => setTimeout(r, 40));
    stop();
  });
  const last = lists.at(-1);
  assert.deepEqual(last.map(w => [w.id, w.name, w.icon]), [['u1', 'MetaMask', 'data:image/svg+xml;base64,PHN2Zy8+'], ['u2', 'Trust Wallet', null]]);
  assert.equal(last[0].provider, metamask);
});
test('EIP-6963 discovery falls back to window.ethereum only when nothing announces', async () => {
  const injected = { ...provider(), isTrust: true }, lists = [];
  await withWindow(fakeWindow({ ethereum: injected }), async () => {
    const stop = discoverWallets(list => lists.push(list), 10);
    await new Promise(r => setTimeout(r, 30));
    stop();
  });
  assert.deepEqual(lists.map(l => l.map(w => w.name)), [['Trust Wallet']]);
  assert.equal(lists[0][0].provider, injected);
  const none = [];
  await withWindow(fakeWindow(), async () => { const stop = discoverWallets(list => none.push(list), 10); await new Promise(r => setTimeout(r, 30)); stop(); });
  assert.deepEqual(none, []);
  // After cleanup, a late announcement is ignored.
  const win = fakeWindow(), late = [];
  await withWindow(win, async () => {
    const stop = discoverWallets(list => late.push(list), 10);
    stop();
    win.dispatchEvent(new CustomEvent('eip6963:announceProvider', { detail: { info: { uuid: 'x', name: 'Late' }, provider: provider() } }));
    await new Promise(r => setTimeout(r, 30));
  });
  assert.deepEqual(late, []);
});
