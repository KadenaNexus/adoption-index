import { test } from 'node:test';
import assert from 'node:assert/strict';
import { alertLabel, failureText, formatDate, parseThreshold, paymentRow, planName, safeHttpsUrl, shortHash, subscriptionStatus } from '../lib/account-view.ts';
import { parseOverview } from '../lib/admin-view.ts';
import { codeInput, levelInput } from '../lib/keyboard-input.ts';
import { tokenFromFragment } from '../lib/sign-in.ts';
import { postJson } from '../lib/post-json.ts';
import { TOKEN } from './accounts-stub.mjs';

const hash = '0x' + 'ab'.repeat(32);
const payment = (extra = {}) => ({ rail: 'evm', network: 'bsc', chain: '56', txHash: hash, token: 'USDT', amount: '9', decimals: 18, plan: 'monthly', status: 'confirmed',
  createdAt: '2026-09-29T10:00:00.000Z', periodEnd: '2026-10-29T10:00:00.000Z', explorerUrl: `https://bscscan.com/tx/${hash}`, failureReason: null, overpaid: false, ...extra });

test('subscription status reads "Active until", "Expired on" or "No subscription"', () => {
  const active = subscriptionStatus({ plan: 'annual', startedAt: '2026-09-01T00:00:00Z', expiresAt: '2026-10-12T08:00:00.000Z', active: true });
  assert.deepEqual(active, { state: 'active', label: 'Active until 12 Oct 2026', action: { label: 'Renew', href: '/checkout?plan=annual' } });
  const expired = subscriptionStatus({ plan: 'monthly', startedAt: '2026-08-01T00:00:00Z', expiresAt: '2026-09-03T23:59:00.000Z', active: false });
  assert.deepEqual(expired, { state: 'expired', label: 'Expired on 3 Sep 2026', action: { label: 'Renew', href: '/checkout?plan=monthly' } });
  assert.deepEqual(subscriptionStatus(null), { state: 'none', label: 'No subscription', action: { label: 'Get Pro', href: '/checkout' } });
  assert.equal(subscriptionStatus({ plan: 'manual', startedAt: '2026-09-01T00:00:00Z', expiresAt: '2026-12-01T00:00:00Z', active: true }).action.href, '/checkout');
  assert.equal(subscriptionStatus({ plan: 'test', startedAt: '2026-09-01T00:00:00Z', expiresAt: '2026-09-02T00:00:00Z', active: false }).action.href, '/checkout');
  assert.equal(formatDate('2026-12-31T23:59:59.999Z'), '31 Dec 2026', 'dates are UTC');
  assert.equal(formatDate('nonsense'), '—');
  assert.equal(formatDate(null), '—');
  assert.deepEqual(['monthly', 'annual', 'test', 'manual', 'promo'].map(planName), ['Monthly', 'Annual', 'Test', 'Complimentary', 'Promo']);
});

test('payment rows show state, overpayment, reasons and a safe explorer link', () => {
  const ok = paymentRow(payment());
  assert.deepEqual({ ...ok }, { key: `bsc:${hash}`, date: '29 Sep 2026', plan: 'Monthly', amount: '9 USDT', status: { label: 'Confirmed', tone: 'ok' }, overpaid: false, note: null,
    explorerUrl: `https://bscscan.com/tx/${hash}`, hash: '0xabababab…ababab', periodEnd: '29 Oct 2026' });
  assert.equal(paymentRow(payment({ overpaid: true, amount: '10' })).overpaid, true);
  assert.equal(paymentRow(payment({ status: 'underpaid', overpaid: true })).overpaid, false, 'overpaid only marks confirmed payments');
  const under = paymentRow(payment({ status: 'underpaid', amount: '5', periodEnd: null }));
  assert.deepEqual([under.status, under.periodEnd], [{ label: 'Underpaid', tone: 'warn' }, null]);
  assert.match(under.note, /less than the plan price/);
  const pending = paymentRow(payment({ status: 'pending', periodEnd: null }));
  assert.deepEqual(pending.status, { label: 'Pending', tone: 'pending' });
  assert.match(pending.note, /finalise/);
  assert.equal(paymentRow(payment({ status: 'pending', periodEnd: '2026-10-29T10:00:00.000Z' })).periodEnd, null, 'no access date until confirmed');
  assert.match(paymentRow(payment({ status: 'failed', failureReason: 'reverted' })).note, /failed on chain/);
  assert.match(paymentRow(payment({ status: 'failed', failureReason: 'receipt_missing' })).note, /could not be found/);
  assert.match(paymentRow(payment({ status: 'failed', failureReason: 'some_new_reason' })).note, /did not go through/);
  assert.equal(failureText('pending', 'some_new_reason'), 'Waiting for the network to finalise the transaction.');
  assert.deepEqual(paymentRow(payment({ status: 'refunded' })).status, { label: 'refunded', tone: 'neutral' });
  for (const url of ['javascript:alert(1)', 'http://bscscan.com/tx/x', 'data:text/html,x', '//evil.com', null, 42]) assert.equal(paymentRow(payment({ explorerUrl: url })).explorerUrl, null, String(url));
  assert.equal(safeHttpsUrl(`https://testnet.bscscan.com/tx/${hash}`), `https://testnet.bscscan.com/tx/${hash}`);
  assert.equal(paymentRow(payment({ token: 'USDC', amount: '79', plan: 'annual' })).amount, '79 USDC');
  assert.equal(shortHash('0x12'), '0x12');
});

test('alert levels: 0 to 100000, one decimal at most', () => {
  for (const [input, expected] of [['60', 60], ['45.5', 45.5], [' 0 ', 0], ['100000', 100000], [72.3, 72.3], [0, 0], ['007', 7]]) assert.equal(parseThreshold(input), expected, String(input));
  for (const input of ['', '45.25', '-1', '100000.1', '100001', '1e3', 'abc', '4 5', '.5', '5.', NaN, Infinity, null, undefined, {}, 1e21, 0.05]) assert.equal(parseThreshold(input), null, String(input));
  assert.equal(alertLabel({ direction: 'above', threshold: 60 }), 'Rises to or above 60.0');
  assert.equal(alertLabel({ direction: 'below', threshold: '45.5' }), 'Falls to or below 45.5', 'numeric strings from Postgres read the same');
});

test('numeric fields take what phone keyboards type: Arabic-Indic digits and a decimal comma', () => {
  assert.equal(levelInput('60,5'), '60.5', 'a decimal comma is not dropped into 605');
  assert.equal(levelInput('٦٠٫٥'), '60.5');
  assert.equal(levelInput('۴۵'), '45', 'Persian digits too');
  assert.equal(levelInput(' 72.3 pts'), '72.3');
  assert.equal(parseThreshold(levelInput('60,5')), 60.5);
  assert.equal(codeInput('١٢٣ ٤٥٦'), '123 456');
  assert.equal(codeInput('12-34a56'), '123456');
});

test('the sign-in token comes only from a well-formed #token fragment', () => {
  assert.equal(tokenFromFragment(`#token=${TOKEN}`), TOKEN);
  assert.equal(tokenFromFragment(`token=${TOKEN}`), TOKEN);
  assert.equal(tokenFromFragment(`#x=1&token=${TOKEN}`), TOKEN);
  for (const hashValue of ['', '#', '#token=', '#token=short', `#token=${TOKEN}x`, `#other=${TOKEN}`, `#token=${TOKEN.slice(0, 42)}!`]) assert.equal(tokenFromFragment(hashValue), null, hashValue);
});

test('browser POST helper: never throws, always an error code on failure', async () => {
  const reply = (status, body, type = 'application/json') => async () => new Response(typeof body === 'string' ? body : JSON.stringify(body), { status, headers: { 'Content-Type': type } });
  assert.deepEqual(await postJson('/api/x', {}, reply(202, { ok: true })), { ok: true, status: 202, data: { ok: true } });
  assert.deepEqual(await postJson('/api/x', {}, reply(429, { error: 'rate_limit' })), { ok: false, status: 429, data: { error: 'rate_limit' } });
  assert.deepEqual(await postJson('/api/x', {}, reply(502, '<html>Bad gateway</html>', 'text/html')), { ok: false, status: 502, data: { error: 'backend_unavailable' } });
  assert.deepEqual(await postJson('/api/x', {}, reply(404, '')), { ok: false, status: 404, data: { error: 'invalid_response' } });
  assert.deepEqual(await postJson('/api/x', {}, reply(200, '[1]')), { ok: false, status: 200, data: { error: 'invalid_response' } });
  assert.deepEqual(await postJson('/api/x', {}, async () => { throw new TypeError('Failed to fetch'); }), { ok: false, status: 0, data: { error: 'backend_unavailable' } });
  let seen;
  await postJson('/api/account/alerts', { direction: 'above', threshold: 60 }, async (url, init) => { seen = { url, init }; return new Response('{}'); });
  assert.deepEqual([seen.url, seen.init.method, seen.init.headers['Content-Type'], seen.init.body, seen.init.credentials], ['/api/account/alerts', 'POST', 'application/json', '{"direction":"above","threshold":60}', 'same-origin']);
});

test('admin overview in the shape the backend sends: preformatted amounts, resolved flags, audit log', () => {
  const view = parseOverview({
    network: 'bsc-testnet', testnet: true,
    payments: [
      { id: 4, rail: 'evm', network: 'bsc-testnet', chain: '97', txHash: hash, token: 'USDT', decimals: 18, amount: '10', required: '9', overpaid: true, plan: 'monthly', status: 'confirmed', failureReason: null,
        source: 'reconciler', createdAt: '2026-09-29T10:00:00.000Z', explorerUrl: `https://testnet.bscscan.com/tx/${hash}`, email: 'a@b.co', userId: 1 },
      { id: 5, rail: 'evm', network: 'bsc-testnet', txHash: hash, token: 'USDC', decimals: 18, amount: '8.5', required: '9', overpaid: false, plan: 'monthly', status: 'underpaid', source: 'checkout', createdAt: '2026-09-29T11:00:00.000Z', email: 'c@d.co' },
      { id: 6, rail: 'evm', network: 'bsc-testnet', txHash: hash, token: 'USDT', decimals: 18, amount: '9', required: '9', overpaid: false, plan: 'monthly', status: 'failed', failureReason: 'transfer_changed', source: 'checkout', email: 'e@f.co',
        explorerUrl: 'javascript:alert(1)' },
      { id: 7, rail: 'evm', network: 'bsc-testnet', txHash: hash, token: 'USDT', decimals: 18, amount: '10', required: '9', overpaid: true, plan: 'monthly', status: 'pending', failureReason: null, source: 'checkout', email: 'g@h.co' },
      null, 1,
    ],
    unmatched: [
      { network: 'bsc-testnet', txHash: hash, logIndex: 1, from: '0x' + '3'.repeat(40), token: 'USDT', amount: '25.5', amountBaseUnits: '25500000000000000000', decimals: 18, blockNumber: 1, seenAt: '2026-09-29T00:00:00.000Z', resolvedNote: 'claimed by payment 4', resolved: true },
      { network: 'bsc-testnet', txHash: hash, logIndex: 2, from: '0x' + '4'.repeat(40), token: 'USDT', amount: '9', amountBaseUnits: '9000000000000000000', decimals: 18, blockNumber: 2, seenAt: '2026-09-29T00:00:00.000Z', resolvedNote: 'processing_error: providers_unavailable', resolved: false },
      { network: 'bsc-testnet', txHash: hash, logIndex: 3, from: '0x' + '5'.repeat(40), token: '0xabc', amount: '123', amountBaseUnits: '123', decimals: null, blockNumber: 3, seenAt: '2026-09-29T00:00:00.000Z', resolvedNote: null, resolved: false },
    ],
    subscriptions: [{ userId: 1, email: 'a@b.co', plan: 'monthly', startedAt: '2026-09-29T10:00:00.000Z', expiresAt: '2026-10-29T10:00:00.000Z', active: true },
      { userId: 2, email: 'x@y.co', plan: 'manual', startedAt: '2026-01-01T00:00:00.000Z', expiresAt: '2026-02-01T00:00:00.000Z', active: false }],
    counts: { users: 3, activeSubscriptions: 1, confirmedPayments: 1, pendingPayments: 1, unresolvedTransfers: 2, queuedEmails: 0, failedEmails: 1 },
    actions: [
      { id: 2, adminEmail: 'naif@kadena.ws', action: 'resolve_unmatched', userId: null, details: { network: 'bsc-testnet', txHash: hash, logIndex: 1, note: 'claimed' }, createdAt: '2026-09-29T12:00:00.000Z' },
      { id: 1, adminEmail: 'naif@kadena.ws', action: 'extend_subscription', userId: 1, details: { email: 'a@b.co', days: 30, note: 'Binance withdrawal', plan: 'manual' }, createdAt: '2026-09-29T11:00:00.000Z' },
    ],
  });
  assert.equal(view.testnet, true);
  assert.deepEqual(view.payments.map(p => [p.amount, p.required, p.marker, p.status.label, p.reason, p.source]), [
    ['10 USDT', '9 USDT', 'overpaid', 'Confirmed', null, 'reconciler'], ['8.5 USDC', '9 USDC', 'underpaid', 'Underpaid', null, 'checkout'], ['9 USDT', '9 USDT', null, 'Failed', 'transfer_changed', 'checkout'],
    ['10 USDT', '9 USDT', null, 'Pending', null, 'checkout']], 'overpaid marks only a confirmed payment');
  assert.deepEqual(view.payments.map(p => p.explorerUrl), [`https://testnet.bscscan.com/tx/${hash}`, null, null, null], 'only an https link from the backend');
  assert.deepEqual([view.payments[0].date, view.payments[0].email, view.payments[0].plan, view.payments[0].hash], ['29 Sep 2026', 'a@b.co', 'Monthly', shortHash(hash)]);
  assert.deepEqual(view.unmatched.map(u => [u.logIndex, u.amount, u.resolved, u.block]), [[2, '9', false, '2'], [3, '123 base units of', false, '3'], [1, '25.5', true, '1']], 'unresolved first; a processing error still needs an admin');
  assert.deepEqual([view.unmatched[0].txHash, view.unmatched[0].from, view.unmatched[0].seen], [hash, '0x' + '4'.repeat(40), '29 Sep 2026'], 'the full hash is kept for the resolve call');
  assert.deepEqual(view.subscriptions.map(s => [s.email, s.plan, s.expires, s.active]), [['a@b.co', 'Monthly', '29 Oct 2026', true], ['x@y.co', 'Complimentary', '1 Feb 2026', false]]);
  assert.deepEqual(view.counts, { users: 3, activeSubscriptions: 1, confirmedPayments: 1, pendingPayments: 1, unresolvedTransfers: 2, queuedEmails: 0, failedEmails: 1 });
  assert.deepEqual(view.actions.map(a => [a.date, a.admin, a.action, a.summary]), [
    ['29 Sep 2026', 'naif@kadena.ws', 'Resolved transfer', `${shortHash(hash)} · “claimed”`], ['29 Sep 2026', 'naif@kadena.ws', 'Extended subscription', 'a@b.co · +30 days · “Binance withdrawal”']]);
  const bare = parseOverview({ payments: [], unmatched: [], subscriptions: [] });
  assert.deepEqual([bare.testnet, bare.actions, bare.counts.users], [false, [], null]);
  assert.equal(parseOverview({ payments: [] }), null);
  assert.equal(parseOverview(null), null);
});

test('underpaid payments name the plan price', () => {
  assert.equal(paymentRow(payment({ status: 'underpaid', amount: '8.5', required: '9' })).note, '8.5 USDT is less than the plan price of 9 USDT, so it did not add access.');
});
