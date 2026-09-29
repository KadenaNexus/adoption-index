import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { TOKEN, post, sessionCookieHeader, stubBackend } from './accounts-stub.mjs';
import { POST as intents } from '../app/api/billing/intents/route.ts';
import { POST as payments } from '../app/api/billing/payments/route.ts';
import { POST as challenge } from '../app/api/wallets/challenge/route.ts';
import { POST as link } from '../app/api/wallets/link/route.ts';

const PAY_TO = '0x4274907CE85E100a5EbAe1f7286DeB5083a52e98', USDT = '0x55d398326f99059fF775485246999027B3197955';
const HASH = '0x' + 'ab'.repeat(32);
const ROUTES = { 'billing/intents': intents, 'billing/payments': payments, 'wallets/challenge': challenge, 'wallets/link': link };
const signedIn = { cookie: sessionCookieHeader() };
const withBackend = async (reply, run) => { const backend = await stubBackend(reply); try { await run(backend); } finally { await backend.close(); } };
async function call(handler, body, options = signedIn) {
  const response = await handler(post('/api/checkout', body, options));
  return { response, status: response.status, json: await response.json() };
}

test('every checkout POST refuses other origins before calling the backend', async () => {
  await withBackend(() => ({ json: {} }), async backend => {
    const attacks = [{ fetchSite: 'cross-site' }, { fetchSite: 'same-site' }, { origin: 'https://evil.example', fetchSite: null }, { origin: 'null', fetchSite: null }];
    for (const attack of attacks) for (const handler of Object.values(ROUTES)) {
      const { status, json } = await call(handler, {}, { ...signedIn, ...attack });
      assert.deepEqual([status, json], [403, { error: 'forbidden' }], JSON.stringify(attack));
    }
    assert.equal(backend.requests.length, 0);
  });
});
test('signed-out requests stop at the site with 401 session_required', async () => {
  await withBackend(() => ({ json: {} }), async backend => {
    for (const handler of Object.values(ROUTES)) assert.deepEqual((await call(handler, {}, {})).json, { error: 'session_required' });
    assert.equal(backend.requests.length, 0);
  });
});
test('bodies must be small JSON objects with every field the route needs', async () => {
  await withBackend(() => ({ json: {} }), async backend => {
    assert.equal((await call(intents, 'plan=monthly', { ...signedIn, contentType: 'application/x-www-form-urlencoded' })).status, 415);
    assert.deepEqual((await call(intents, '{"plan":')).json, { error: 'invalid_json' });
    assert.deepEqual((await call(intents, '["monthly"]')).json, { error: 'invalid_json' });
    assert.equal((await call(intents, { plan: 'x'.repeat(20000) })).status, 413);
    for (const [handler, body] of [[intents, { plan: 'monthly' }], [intents, { plan: 'monthly', token: 'x'.repeat(17) }], [challenge, {}], [link, { nonce: 'n1' }],
      [payments, {}], [payments, { txHash: HASH, intentId: -1 }], [payments, { txHash: HASH, plan: 5 }]]) {
      const { status, json } = await call(handler, body);
      assert.deepEqual([status, json], [400, { error: 'invalid_request' }], JSON.stringify(body));
    }
    assert.equal(backend.requests.length, 0);
  });
});

test('path, session, client IP and only the known fields go to the backend', async () => {
  await withBackend(() => ({ status: 400, json: { error: 'x' } }), async backend => {
    const cases = [
      [challenge, { address: PAY_TO, email: 'x@y.z' }, '/wallets/challenge', { address: PAY_TO }],
      [link, { nonce: 'n1', signature: '0x' + 'cd'.repeat(65), userId: 9 }, '/wallets/link', { nonce: 'n1', signature: '0x' + 'cd'.repeat(65) }],
      [intents, { plan: 'annual', token: 'USDC', amount: '1' }, '/billing/intents', { plan: 'annual', token: 'USDC' }],
      [payments, { txHash: HASH, intentId: 12, plan: 'monthly', from: PAY_TO }, '/billing/payments', { txHash: HASH, intentId: 12, plan: 'monthly' }],
      [payments, { txHash: HASH, intentId: '12' }, '/billing/payments', { txHash: HASH, intentId: '12' }],
      [payments, { txHash: HASH, intentId: null, plan: '' }, '/billing/payments', { txHash: HASH }],
    ];
    for (const [handler, body, path, forwarded] of cases) {
      await call(handler, body);
      const sent = backend.requests.at(-1);
      assert.deepEqual([sent.method, sent.path, sent.body], ['POST', path, forwarded], path);
      assert.equal(sent.headers['x-kce-session'], TOKEN);
      assert.equal(sent.headers['x-kce-client-ip'], '203.0.113.7');
    }
    assert.equal(backend.requests.length, cases.length);
  });
});
test('success replies carry only the fields the checkout uses', async () => {
  const replies = {
    '/billing/intents': { status: 201, json: { intentId: 12, payTo: PAY_TO, tokenAddress: USDT, token: 'USDT', decimals: 18, amount: '9000000000000000000', amountDisplay: '9', chainId: 56, expiresAt: '2026-09-30T12:00:00Z', userId: 3, email: 'a@b.co' } },
    '/wallets/challenge': { json: { nonce: 'n1', message: 'Link this wallet', expiresAt: '2026-09-29T12:10:00Z', address: PAY_TO.toLowerCase(), userId: 3 } },
    '/wallets/link': { json: { address: PAY_TO, linkedAt: 'now', signature: '0xab' } },
    // The payment in the same shape as on GET /account.
    '/billing/payments': { json: { status: 'confirmed', subscription: { plan: 'monthly', startedAt: 'x', expiresAt: '2026-10-29T00:00:00.000Z', active: true }, sessionToken: TOKEN, payment: {
      id: 5, rail: 'evm', network: 'bsc', chain: '56', txHash: HASH, token: 'USDT', decimals: 18, amount: '9', required: '9', overpaid: false, plan: 'monthly', status: 'confirmed', failureReason: null,
      from: PAY_TO, to: PAY_TO, source: 'checkout', createdAt: '2026-09-29T00:00:00.000Z', confirmedAt: '2026-09-29T00:01:00.000Z', periodStart: '2026-09-29T00:01:00.000Z',
      periodEnd: '2026-10-29T00:00:00.000Z', explorerUrl: `https://bscscan.com/tx/${HASH}` } } },
  };
  await withBackend(({ path }) => replies[path], async () => {
    const intent = await call(intents, { plan: 'monthly', token: 'USDT' });
    assert.equal(intent.status, 201);
    assert.deepEqual(Object.keys(intent.json).sort(), ['amount', 'amountDisplay', 'chainId', 'decimals', 'expiresAt', 'intentId', 'payTo', 'token', 'tokenAddress']);
    assert.deepEqual((await call(challenge, { address: PAY_TO })).json, { nonce: 'n1', message: 'Link this wallet', expiresAt: '2026-09-29T12:10:00Z' });
    assert.deepEqual((await call(link, { nonce: 'n1', signature: '0xab' })).json, { ok: true, address: PAY_TO });
    const payment = await call(payments, { txHash: HASH });
    assert.deepEqual(payment.json, { status: 'confirmed', payment: { status: 'confirmed', txHash: HASH, failureReason: null, periodEnd: '2026-10-29T00:00:00.000Z', explorerUrl: `https://bscscan.com/tx/${HASH}` },
      subscription: { plan: 'monthly', expiresAt: '2026-10-29T00:00:00.000Z', active: true } });
    assert.ok(!JSON.stringify(payment.json).includes(TOKEN));
  });
  for (const reply of [{ json: { intentId: 12 } }, { json: [1] }, { text: 'not json' }])
    await withBackend(() => reply, async () => {
      const malformed = await call(intents, { plan: 'monthly', token: 'USDT' });
      assert.deepEqual([malformed.status, malformed.json], [502, { error: 'invalid_response' }], 'a success in an unexpected shape is never relayed');
    });
});
test('errors keep the backend status and only the extras the checkout shows', async () => {
  for (const [reply, expected] of [
    [{ status: 404, json: { error: 'tx_not_found', retry: true, detail: 'rpc host x' } }, [404, { error: 'tx_not_found', retry: true }]],
    [{ status: 403, json: { error: 'unlinked_wallet', from: PAY_TO, userId: 3 } }, [403, { error: 'unlinked_wallet', from: PAY_TO }]],
    [{ status: 503, json: { error: 'backend_unavailable' } }, [503, { error: 'backend_unavailable' }]],
    [{ status: 422, json: { error: 'Not A Code' } }, [422, { error: 'invalid_response' }]],
    [{ status: 302 }, [502, { error: 'backend_unavailable' }]],
  ]) await withBackend(() => reply, async () => {
    const { response, status, json } = await call(payments, { txHash: HASH });
    assert.deepEqual([status, json], expected, JSON.stringify(reply));
    assert.equal(response.headers.get('cache-control'), 'no-store');
  });
});

test('each route file relays one backend path, POST only, with its own timeout', () => {
  const expected = { 'billing/intents': ['/billing/intents', 10000], 'billing/payments': ['/billing/payments', 25000], 'wallets/challenge': ['/wallets/challenge', 10000], 'wallets/link': ['/wallets/link', 10000] };
  for (const [dir, [path, timeoutMs]] of Object.entries(expected)) {
    const source = readFileSync(new URL(`../app/api/${dir}/route.ts`, import.meta.url), 'utf8');
    assert.match(source, new RegExp(`relaySessionPost\\(request, '${path}', \\{ .*timeoutMs: ${timeoutMs} \\}\\)`), dir);
    assert.match(source, /export async function POST/, dir);
    assert.doesNotMatch(source, /export (async )?function GET/, dir);
  }
});
