import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  checkoutMessage, checkoutPlan, checkoutPlans, formatExpiry, parseCheckoutConfig, paymentOutcome, pickError, pickIntent, pickPaymentResult, planTerm, pollUntilSettled, stageStatus,
} from '../lib/wallet.ts';

const PAY_TO = '0x4274907CE85E100a5EbAe1f7286DeB5083a52e98';
const USDT = '0x55d398326f99059fF775485246999027B3197955', USDC = '0x8AC76a51cc950d9822D68b83fE1Ad97B32Cd580d';
const billing = (overrides = {}) => ({
  enabled: true, network: 'bsc', chainId: 56, chainName: 'BNB Smart Chain', explorerUrl: 'https://bscscan.com',
  addChainParams: { chainId: '0x38', chainName: 'BNB Smart Chain', nativeCurrency: { name: 'BNB', symbol: 'BNB', decimals: 18 }, rpcUrls: ['https://bsc-dataseed.bnbchain.org'], blockExplorerUrls: ['https://bscscan.com'] },
  payTo: PAY_TO, tokens: [{ symbol: 'USDT', address: USDT, decimals: 18 }, { symbol: 'USDC', address: USDC, decimals: 18 }],
  plans: [{ id: 'monthly', price: 9, days: 30 }, { id: 'annual', price: 79, days: 365 }], walletConnectProjectId: 'ab'.repeat(16),
  testnet: false, signinOpen: true, supportEmail: 'support@kadena.ws', ...overrides,
});

test('checkoutPlan: annual and monthly for everyone, test only when the account says so', () => {
  assert.equal(checkoutPlan('annual', false).id, 'annual');
  assert.equal(checkoutPlan('monthly', false).id, 'monthly');
  assert.equal(checkoutPlan('test', true).id, 'test');
  assert.equal(checkoutPlan('test', false).id, 'monthly');
  for (const odd of [undefined, null, '', 'Annual', 'lifetime', ['annual'], 1]) assert.equal(checkoutPlan(odd, true).id, 'monthly');
  assert.equal(checkoutPlan('test', 'yes').id, 'monthly');
  assert.deepEqual(checkoutPlans.test, { id: 'test', name: 'Test', price: 1, days: 1 });
  assert.equal(checkoutPlans.monthly.price, 9);
  assert.equal(checkoutPlans.annual.days, 365);
});

test('plan wording is a fixed period, never a renewal', () => {
  assert.equal(planTerm(checkoutPlans.monthly), 'One payment · 30 days');
  assert.equal(planTerm(checkoutPlans.annual), 'One payment · 365 days');
  assert.equal(planTerm(checkoutPlans.test), 'One payment · 1 day');
  const page = readFileSync(new URL('../app/checkout/page.tsx', import.meta.url), 'utf8');
  const flow = readFileSync(new URL('../app/checkout/checkout-flow.tsx', import.meta.url), 'utf8');
  for (const source of [page, flow]) {
    assert.doesNotMatch(source, /cancellation|until cancelled|\/ month|Flexible monthly/);
  }
  assert.match(page, /billingTerms\.renewal/);
  assert.match(page, /billingTerms\.refund/);
  assert.match(page, /Signed in as/);
  assert.match(page, /Subscriber sign-in opens soon/);
  assert.match(page, /Payments not yet open/);
  assert.match(flow, /TESTNET/, 'the testnet notice sits in the payment flow');
});

test('BNB Smart Chain is the only payment method: no method picker and no other currency', () => {
  const page = readFileSync(new URL('../app/checkout/page.tsx', import.meta.url), 'utf8');
  const flow = readFileSync(new URL('../app/checkout/checkout-flow.tsx', import.meta.url), 'utf8');
  for (const source of [page, flow]) assert.doesNotMatch(source, /\bKDA\b|pay-method/i);
  assert.match(page, /Pay \{plan\.price\} USDT or USDC on \{offered\.chainName\}\./);
  // WalletConnect is offered first, ahead of the browser wallets found on the page.
  assert.ok(flow.indexOf("connect('walletconnect')") < flow.indexOf('wallets.map(w =>'));
});

test('expiry dates read the same on the server and in the browser', () => {
  assert.equal(formatExpiry('2026-10-12T08:00:00.000Z'), '12 Oct 2026');
  // UTC: one second before midnight is still the 29th wherever the browser is.
  assert.match(formatExpiry('2027-09-29T23:59:59Z'), /^29 Sept? 2027$/);
  assert.equal(formatExpiry('never'), null);
  assert.equal(formatExpiry(undefined), null);
});

test('billing config: a well-formed config opens payments', () => {
  const config = parseCheckoutConfig(billing());
  assert.deepEqual(config.evm.tokens.map(t => t.symbol), ['USDT', 'USDC']);
  assert.equal(config.evm.chainId, 56);
  assert.equal(config.evm.payTo, PAY_TO);
  assert.equal(config.evm.addChainParams.chainId, '0x38');
  assert.equal(config.walletConnectProjectId, 'ab'.repeat(16));
  assert.equal(config.evm.testnet, false);
  assert.equal(config.signinOpen, true);
  assert.equal(config.supportEmail, 'support@kadena.ws');
  assert.deepEqual(Object.keys(config).sort(), ['evm', 'signinOpen', 'supportEmail', 'walletConnectProjectId']);
});
test('billing config: anything malformed keeps payments closed instead of guessing', () => {
  assert.equal(parseCheckoutConfig({ enabled: false }).evm, null);
  assert.equal(parseCheckoutConfig(null).evm, null);
  assert.equal(parseCheckoutConfig(billing({ payTo: '0x1234' })).evm, null);
  assert.equal(parseCheckoutConfig(billing({ chainId: '56' })).evm, null);
  assert.equal(parseCheckoutConfig(billing({ tokens: [] })).evm, null);
  assert.equal(parseCheckoutConfig(billing({ tokens: [{ symbol: 'USDT', address: 'nope', decimals: 18 }] })).evm, null);
  assert.equal(parseCheckoutConfig(billing({ addChainParams: { ...billing().addChainParams, chainId: '0x61' } })).evm, null);
  assert.equal(parseCheckoutConfig(billing({ addChainParams: { ...billing().addChainParams, rpcUrls: ['http://insecure'] } })).evm, null);
  assert.equal(parseCheckoutConfig(billing({ walletConnectProjectId: 'not-a-project' })).walletConnectProjectId, null);
  assert.equal(parseCheckoutConfig(billing({ walletConnectProjectId: null })).walletConnectProjectId, null);
  assert.equal(parseCheckoutConfig({ ...billing(), enabled: false }).walletConnectProjectId, null, 'no project id without payments');
  assert.equal(parseCheckoutConfig(billing({ supportEmail: 'not an email' })).supportEmail, null);
  assert.equal(parseCheckoutConfig(billing({ signinOpen: false })).signinOpen, false);
  assert.equal(parseCheckoutConfig(billing({ signinOpen: undefined })).signinOpen, true);
});
test('billing config: the testnet flag comes from the payment network', () => {
  const testnet = parseCheckoutConfig(billing({ network: 'bsc-testnet', chainId: 97, testnet: undefined, addChainParams: { ...billing().addChainParams, chainId: '0x61' } }));
  assert.equal(testnet.evm.testnet, true);
  assert.equal(testnet.evm.chainId, 97);
  assert.equal(parseCheckoutConfig(billing({ testnet: true })).evm.testnet, true);
});

// Every error code the backend (accounts, BSC) and the site's routes can return, plus the payment states.
const BACKEND_CODES = ['forbidden', 'session_required', 'site_key_required', 'accounts_disabled', 'backend_unavailable', 'internal_error', 'rate_limit', 'invalid_json', 'json_required',
  'payload_too_large', 'bad_request', 'invalid_request', 'method_not_allowed', 'payments_disabled', 'payments_not_open', 'invalid_plan', 'invalid_token', 'invalid_address',
  'invalid_signature', 'challenge_expired', 'challenge_used', 'wallet_linked_elsewhere', 'invalid_tx_hash', 'tx_not_found', 'tx_failed', 'wrong_token', 'wrong_recipient', 'unlinked_wallet',
  'tx_already_used', 'transfer_resolved', 'ambiguous_payment', 'providers_unavailable', 'invalid_response', 'temporarily_unavailable',
  'underpaid', 'receipt_missing', 'payment_failed', 'already_credited_expired', 'still_confirming'];
const CLIENT_CODES = ['user_rejected', 'request_pending', 'chain_not_added', 'switch_failed', 'wrong_chain', 'wc_chain_missing', 'no_accounts', 'account_changed', 'unsupported_method',
  'unauthorized', 'disconnected', 'request_expired', 'walletconnect_closed', 'walletconnect_expired', 'walletconnect_failed', 'invalid_tx_response', 'wallet_error', 'intent_mismatch'];
test('every backend and wallet error code has its own human message', () => {
  for (const code of [...BACKEND_CODES, ...CLIENT_CODES]) {
    const { text } = checkoutMessage(code);
    assert.ok(text.length > 10, code);
    assert.doesNotMatch(text, /Something went wrong/, code);
    assert.doesNotMatch(text, /_/, `${code} leaks a code: ${text}`);
  }
  assert.equal(checkoutMessage('brand_new_code').text, 'Something went wrong (brand_new_code). Please try again.');
  assert.equal(checkoutMessage('<script>').text, 'Something went wrong. Please try again.');
  assert.equal(checkoutMessage(undefined).text, 'Something went wrong. Please try again.');
  assert.equal(checkoutMessage('__proto__').text, 'Something went wrong (__proto__). Please try again.');
});
test('support email appears for the codes a person has to sort out', () => {
  for (const code of ['tx_not_found', 'unlinked_wallet', 'underpaid', 'wrong_token', 'wrong_recipient', 'ambiguous_payment', 'receipt_missing', 'tx_already_used', 'transfer_resolved', 'payment_failed'])
    assert.equal(checkoutMessage(code).support, true, code);
  for (const code of ['user_rejected', 'rate_limit', 'walletconnect_closed', 'wrong_chain']) assert.equal(checkoutMessage(code).support, false, code);
});
test('a cancel the visitor chose is a calm note, not an error', () => {
  for (const code of ['user_rejected', 'walletconnect_closed']) assert.equal(checkoutMessage(code).calm, true, code);
  for (const code of ['walletconnect_failed', 'walletconnect_expired', 'disconnected', 'wc_chain_missing', 'tx_failed', 'brand_new_code']) assert.equal(checkoutMessage(code).calm, false, code);
  assert.match(checkoutMessage('walletconnect_closed').text, /^The WalletConnect window was closed before a wallet connected\. Choose a wallet to try again\.$/);
});
test('messages carry the context that makes them actionable', () => {
  const unlinked = checkoutMessage('unlinked_wallet', { from: '0x2c7536e3605d9c16a7a3d7b1898e529396a65c23' }).text;
  assert.match(unlinked, /\(0x2c75…5c23\)/);
  assert.match(unlinked, /“Use another wallet” first if a different one is connected\); we’ll then check this transaction again automatically\.$/);
  assert.doesNotMatch(unlinked, /above|submit the transaction hash again/, 'the page re-checks by itself once the wallet is linked');
  assert.match(checkoutMessage('wrong_chain', { chainName: 'BNB Smart Chain Testnet' }).text, /BNB Smart Chain Testnet/);
  assert.match(checkoutMessage('wc_chain_missing', { chainName: 'BNB Smart Chain Testnet' }).text, /^Enable BNB Smart Chain Testnet in your wallet/);
  assert.equal(checkoutMessage('still_confirming').text, 'Still confirming — we’ll email you when it’s done.');
  assert.equal(checkoutMessage('invalid_signature').text, 'The signature didn’t match this wallet. Try linking it again.');
  assert.equal(checkoutMessage('payment_failed').text, 'This payment failed and Pro was not activated.');
  assert.equal(checkoutMessage('already_credited_expired').text, 'This payment was already credited and that period has ended. Send a new payment to renew.');
});

test('status text: over WalletConnect the page says to open the wallet app', () => {
  const chainName = 'BNB Smart Chain';
  assert.equal(stageStatus('opening', { walletConnect: true }), 'Opening WalletConnect…');
  assert.equal(stageStatus('connecting', { walletConnect: true }), 'Waiting for the wallet to connect…');
  assert.equal(stageStatus('linking', { walletConnect: true }), 'Open your wallet app to approve the signature. Signing is free and sends nothing.');
  assert.equal(stageStatus('linking', { walletConnect: false }), 'Sign the message in your wallet to link it. Signing is free and sends nothing.');
  assert.equal(stageStatus('sending', { walletConnect: true }), 'Open your wallet app to approve the transfer…');
  assert.equal(stageStatus('sending'), 'Confirm the transfer in your wallet…');
  assert.equal(stageStatus('confirming', { chainName, waiting: 'tx_not_found' }), 'Waiting for the transaction to appear on BNB Smart Chain…');
  assert.match(stageStatus('confirming', { chainName: 'BNB Smart Chain Testnet', waiting: 'pending' }), /^Waiting for BNB Smart Chain Testnet to finalise your payment\./);
  for (const stage of ['choose', 'connected', 'review', 'timeout', 'done', 'final']) assert.equal(stageStatus(stage, { walletConnect: true }), '', stage);
});

test('error replies keep only the code and the extras the checkout shows', () => {
  const from = '0x2c7536e3605d9c16a7a3d7b1898e529396a65c23';
  assert.deepEqual(pickError({ error: 'tx_not_found', retry: true, detail: 'x', sessionToken: 'secret' }, 404), { error: 'tx_not_found', retry: true });
  assert.deepEqual(pickError({ error: 'unlinked_wallet', from, userId: 4 }, 403), { error: 'unlinked_wallet', from });
  assert.deepEqual(pickError({ error: 'unlinked_wallet', from: 'not an address' }, 403), { error: 'unlinked_wallet' });
  assert.deepEqual(pickError({ error: 'tx_failed', amount: '1', chainId: 56, message: 'internal detail', balances: { 1: 2 } }, 422), { error: 'tx_failed' });
  assert.deepEqual(pickError(null, 503), { error: 'backend_unavailable' });
  assert.deepEqual(pickError({ error: 'Not A Code' }, 400), { error: 'invalid_response' });
  assert.deepEqual(pickError('<html>', 502), { error: 'backend_unavailable' });
});

test('intents and payment results are reduced to the fields the checkout needs', () => {
  const intent = { intentId: 12, payTo: PAY_TO, tokenAddress: USDT, token: 'USDT', decimals: 18, amount: '9000000000000000000', amountDisplay: '9', chainId: 56, expiresAt: '2026-09-30T12:00:00Z', userId: 3 };
  assert.deepEqual(pickIntent(intent), { intentId: 12, payTo: PAY_TO, tokenAddress: USDT, token: 'USDT', decimals: 18, amount: '9000000000000000000', amountDisplay: '9', chainId: 56, expiresAt: '2026-09-30T12:00:00Z' });
  assert.equal(pickIntent({ ...intent, amountDisplay: undefined }).amountDisplay, '9');
  assert.equal(pickIntent({ ...intent, chainId: '0x38' }).chainId, 56);
  for (const bad of [{ amount: '0' }, { amount: '9.0' }, { amount: 9 }, { payTo: 'x' }, { tokenAddress: null }, { intentId: -1 }, { decimals: 40 }, { chainId: 'bsc' }]) assert.equal(pickIntent({ ...intent, ...bad }), null, JSON.stringify(bad));
  const reply = { status: 'confirmed', payment: { id: 5, rail: 'evm', network: 'bsc', txHash: '0xab', status: 'confirmed', failureReason: null, periodEnd: '2026-10-29T00:00:00Z', from: PAY_TO, explorerUrl: 'https://bscscan.com/tx/0xab' },
    subscription: { plan: 'monthly', startedAt: '2026-09-29T00:00:00Z', expiresAt: '2026-10-29T00:00:00Z', active: true } };
  assert.deepEqual(pickPaymentResult(reply), { status: 'confirmed', payment: { status: 'confirmed', txHash: '0xab', failureReason: null, periodEnd: '2026-10-29T00:00:00Z', explorerUrl: 'https://bscscan.com/tx/0xab' },
    subscription: { plan: 'monthly', expiresAt: '2026-10-29T00:00:00Z', active: true } });
  assert.equal(pickPaymentResult({ status: 'pending' }).payment, null);
  assert.equal(pickPaymentResult({ payment: { status: 'pending' } }), null, 'the status is the top-level one');
  assert.equal(pickPaymentResult({ status: 'paid' }), null);
  assert.equal(pickPaymentResult({ status: 'failed', payment: { explorerUrl: 'javascript:x' } }).payment.explorerUrl, null);
});

test('payment outcomes: transient answers keep polling, only definite ones end it', () => {
  const sub = { expiresAt: '2026-10-29T00:00:00Z', plan: 'monthly', active: true };
  assert.deepEqual(paymentOutcome(200, { status: 'confirmed', payment: {}, subscription: sub }), { kind: 'confirmed', expiresAt: sub.expiresAt });
  assert.deepEqual(paymentOutcome(200, { status: 'confirmed', payment: { periodEnd: '2027-01-01T00:00:00Z' } }), { kind: 'confirmed', expiresAt: '2027-01-01T00:00:00Z' });
  assert.deepEqual(paymentOutcome(200, { status: 'pending' }), { kind: 'waiting', code: 'pending' });
  assert.deepEqual(paymentOutcome(202, { status: 'pending' }), { kind: 'waiting', code: 'pending' });
  // A hash credited long ago comes back confirmed, but the access it bought is over: not a success.
  assert.deepEqual(paymentOutcome(200, { status: 'confirmed', payment: { periodEnd: '2026-08-28T00:00:00Z' }, subscription: { ...sub, expiresAt: '2026-08-28T00:00:00Z', active: false } }),
    { kind: 'final', code: 'already_credited_expired' });
  assert.deepEqual(paymentOutcome(200, { status: 'underpaid' }), { kind: 'final', code: 'underpaid' });
  // Each failure reason the backend stores reads as its own message, never as the raw reason.
  for (const [reason, code] of [['reverted', 'tx_failed'], ['receipt_missing', 'receipt_missing'], ['wrong_token', 'wrong_token'], ['wrong_recipient', 'wrong_recipient'],
    ['ambiguous', 'ambiguous_payment'], ['transfer_changed', 'payment_failed'], ['Insufficient funds', 'payment_failed'], ['constructor', 'payment_failed']])
    assert.deepEqual(paymentOutcome(200, { status: 'failed', payment: { failureReason: reason } }), { kind: 'final', code }, reason);
  assert.deepEqual(paymentOutcome(200, { status: 'failed' }), { kind: 'final', code: 'payment_failed' });
  // Keep polling: not found yet, nodes or the backend down, any 5xx, and a rate limit.
  assert.deepEqual(paymentOutcome(404, { error: 'tx_not_found', retry: true }), { kind: 'waiting', code: 'tx_not_found' });
  assert.deepEqual(paymentOutcome(503, { error: 'providers_unavailable' }), { kind: 'waiting', code: 'providers_unavailable' });
  assert.deepEqual(paymentOutcome(503, { error: 'backend_unavailable' }), { kind: 'waiting', code: 'backend_unavailable' });
  assert.deepEqual(paymentOutcome(502, { error: 'invalid_response' }), { kind: 'waiting', code: 'invalid_response' });
  assert.deepEqual(paymentOutcome(500, null), { kind: 'waiting', code: 'backend_unavailable' });
  assert.deepEqual(paymentOutcome(429, { error: 'rate_limit' }), { kind: 'waiting', code: 'rate_limit' });
  // Other 4xx answers are final.
  assert.deepEqual(paymentOutcome(403, { error: 'unlinked_wallet', from: '0x2c7536e3605d9c16a7a3d7b1898e529396a65c23' }), { kind: 'final', code: 'unlinked_wallet', from: '0x2c7536e3605d9c16a7a3d7b1898e529396a65c23' });
  for (const [status, code] of [[422, 'tx_failed'], [422, 'wrong_token'], [422, 'wrong_recipient'], [409, 'tx_already_used'], [422, 'ambiguous_payment'], [400, 'invalid_tx_hash'], [401, 'session_required'], [403, 'payments_not_open']]) {
    assert.deepEqual(paymentOutcome(status, { error: code }), { kind: 'final', code });
  }
  assert.deepEqual(paymentOutcome(404, { error: 'not_found' }), { kind: 'final', code: 'not_found' });
});

function clock() {
  let t = 1_000_000;
  const sleeps = [];
  return { now: () => t, sleep: async ms => { sleeps.push(ms); t += ms; }, sleeps, advance: ms => { t += ms; } };
}
test('polling: asks at once, then every 3 s until the payment settles', async () => {
  const c = clock(), answers = [[404, { error: 'tx_not_found' }], [200, { status: 'pending' }], [503, { error: 'providers_unavailable' }], [200, { status: 'confirmed', subscription: { plan: 'monthly', expiresAt: '2026-10-29T00:00:00Z', active: true } }]];
  const seen = [];
  const result = await pollUntilSettled({ request: async () => { const [status, data] = answers.shift(); return { status, data }; }, intervalMs: 3000, timeoutMs: 180000, now: c.now, sleep: c.sleep, onWaiting: code => seen.push(code) });
  assert.deepEqual(result, { kind: 'confirmed', expiresAt: '2026-10-29T00:00:00Z' });
  assert.deepEqual(c.sleeps, [3000, 3000, 3000]);
  assert.deepEqual(seen, ['tx_not_found', 'pending', 'providers_unavailable']);
});
test('polling: stops after 3 minutes with the last transient answer', async () => {
  const c = clock();
  let asks = 0;
  const result = await pollUntilSettled({ request: async () => { asks++; return { status: 200, data: { status: 'pending' } }; }, intervalMs: 3000, timeoutMs: 180000, now: c.now, sleep: c.sleep });
  assert.deepEqual(result, { kind: 'timeout', code: 'pending' });
  assert.equal(asks, 61);
  assert.equal(c.sleeps.reduce((a, b) => a + b, 0), 180000);
});
test('polling: a definite answer ends it at once, a network failure does not, and closing the page stops it', async () => {
  const c = clock();
  let asks = 0;
  assert.deepEqual(await pollUntilSettled({ request: async () => { asks++; return { status: 422, data: { error: 'wrong_token' } }; }, intervalMs: 3000, timeoutMs: 180000, now: c.now, sleep: c.sleep }), { kind: 'final', code: 'wrong_token' });
  assert.equal(asks, 1);
  const flaky = [() => { throw new Error('offline'); }, () => ({ status: 200, data: { status: 'underpaid' } })];
  assert.deepEqual(await pollUntilSettled({ request: async () => flaky.shift()(), intervalMs: 3000, timeoutMs: 180000, now: c.now, sleep: c.sleep }), { kind: 'final', code: 'underpaid' });
  let open = true, cancelledAsks = 0;
  const result = await pollUntilSettled({ request: async () => { cancelledAsks++; open = false; return { status: 200, data: { status: 'pending' } }; }, intervalMs: 3000, timeoutMs: 180000, now: c.now, sleep: c.sleep, cancelled: () => !open });
  assert.deepEqual(result, { kind: 'cancelled' });
  assert.equal(cancelledAsks, 1);
});
