import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { OTHER_TOKEN, SITE_KEY, TOKEN, deadOrigin, get, post, sessionCookieHeader, stubBackend } from './accounts-stub.mjs';
import { clearedSessionCookie, readJsonBody, sessionCookie, sessionFromCookies, signInOutcome } from '../lib/site-api.ts';
import { POST as requestLink } from '../app/api/auth/request-link/route.ts';
import { POST as verify } from '../app/api/auth/verify/route.ts';
import { POST as verifyCode } from '../app/api/auth/verify-code/route.ts';
import { POST as logout } from '../app/api/auth/logout/route.ts';
import { POST as addAlert } from '../app/api/account/alerts/route.ts';
import { POST as deleteAlert } from '../app/api/account/alerts/delete/route.ts';
import { POST as extend } from '../app/api/admin/extend/route.ts';
import { POST as resolve } from '../app/api/admin/resolve/route.ts';
import { POST as sendReport } from '../app/api/reports/route.ts';
import { POST as resolveReport } from '../app/api/admin/reports/resolve/route.ts';
import { GET as exportCsv } from '../app/api/export/route.ts';

const EXPIRES = '2026-10-29T12:00:00.000Z';
const verified = (extra = {}) => ({ status: 200, json: { sessionToken: TOKEN, expiresAt: EXPIRES, next: '/checkout?plan=annual', ...extra } });
const read = async response => ({ status: response.status, text: await response.text(), cookies: response.headers.getSetCookie() });
const withBackend = async (reply, run) => { const backend = await stubBackend(reply); try { await run(backend); } finally { await backend.close(); } };

test('verify results map to a cookie and {next}: the session token never reaches the page', () => {
  const ok = signInOutcome({ status: 200, data: { sessionToken: TOKEN, expiresAt: EXPIRES, next: '/checkout?plan=annual', email: 'a@b.co' } });
  assert.deepEqual(ok.body, { next: '/checkout?plan=annual' });
  assert.deepEqual(ok.session, { token: TOKEN, expiresAt: EXPIRES });
  assert.ok(!JSON.stringify(ok.body).includes(TOKEN) && !JSON.stringify(ok.body).includes('sessionToken'));
  assert.deepEqual(signInOutcome({ status: 200, data: { sessionToken: TOKEN, expiresAt: EXPIRES, next: null } }).body, { next: '/account' });
  assert.deepEqual(signInOutcome({ status: 200, data: { sessionToken: TOKEN, expiresAt: EXPIRES, next: '/.//evil.com' } }).body, { next: '/account' });
  for (const sessionToken of [undefined, '', 'short', TOKEN + '=', 42]) {
    const bad = signInOutcome({ status: 200, data: { sessionToken, expiresAt: EXPIRES } });
    assert.deepEqual([bad.status, bad.body, bad.session], [502, { error: 'invalid_response' }, undefined]);
  }
  assert.deepEqual(signInOutcome({ status: 400, data: { error: 'invalid_or_expired' } }), { status: 400, body: { error: 'invalid_or_expired' } });
  assert.deepEqual(signInOutcome({ status: 503, data: { error: 'backend_unavailable' } }), { status: 503, body: { error: 'backend_unavailable' } });
  assert.deepEqual(signInOutcome({ status: 500, data: { error: '<script>' } }), { status: 500, body: { error: 'backend_unavailable' } }, 'only plain codes pass');
  assert.deepEqual(signInOutcome({ status: 302, data: null }), { status: 502, body: { error: 'backend_unavailable' } });
  const noExpiry = signInOutcome({ status: 200, data: { sessionToken: TOKEN, expiresAt: 'soon' } });
  assert.ok(Date.parse(noExpiry.session.expiresAt) > Date.now() + 29 * 86_400_000, 'an unreadable expiry falls back to 30 days');
});

test('session cookie: httpOnly, Lax, whole site; cleared with the same name and path', () => {
  const set = sessionCookie(TOKEN, EXPIRES);
  assert.equal(set, `kce_session=${TOKEN}; Path=/; Expires=Thu, 29 Oct 2026 12:00:00 GMT; HttpOnly; SameSite=Lax`);
  assert.equal(clearedSessionCookie(), 'kce_session=; Path=/; Expires=Thu, 01 Jan 1970 00:00:00 GMT; Max-Age=0; HttpOnly; SameSite=Lax');
  assert.equal(sessionFromCookies(`a=1; kce_session=${TOKEN}; b=2`), TOKEN);
  assert.equal(sessionFromCookies(`kce_session=${OTHER_TOKEN}; kce_session=${TOKEN}`), TOKEN, 'the last duplicate wins, as in next/headers');
  assert.equal(sessionFromCookies('kce_session=not-a-token'), null);
  assert.equal(sessionFromCookies(`xkce_session=${TOKEN}`), null);
  assert.equal(sessionFromCookies(null), null);
});

test('in production the cookie is __Host- prefixed and Secure', () => {
  const lib = new URL('../lib/site-api.ts', import.meta.url).href;
  const script = `const m = await import(${JSON.stringify(lib)}); console.log(JSON.stringify([m.sessionCookie(${JSON.stringify(TOKEN)}, ${JSON.stringify(EXPIRES)}), m.clearedSessionCookie(), m.sessionFromCookies('__Host-kce_session=${TOKEN}'), m.sessionFromCookies('kce_session=${TOKEN}')]));`;
  const [set, cleared, host, plain] = JSON.parse(execFileSync(process.execPath, ['--input-type=module', '-e', script], { env: { ...process.env, NODE_ENV: 'production' }, cwd: fileURLToPath(new URL('..', import.meta.url)) }).toString());
  assert.equal(set, `__Host-kce_session=${TOKEN}; Path=/; Expires=Thu, 29 Oct 2026 12:00:00 GMT; Secure; HttpOnly; SameSite=Lax`);
  assert.equal(cleared, '__Host-kce_session=; Path=/; Expires=Thu, 01 Jan 1970 00:00:00 GMT; Max-Age=0; Secure; HttpOnly; SameSite=Lax');
  assert.equal(host, TOKEN);
  assert.equal(plain, null, 'a planted unprefixed cookie is ignored in production');
});

test('JSON bodies: object only, small, application/json', async () => {
  assert.equal((await readJsonBody(post('/x', 'x=1', { contentType: 'application/x-www-form-urlencoded' }))).status, 415);
  assert.equal((await readJsonBody(post('/x', '[1]'))).status, 400);
  assert.equal((await readJsonBody(post('/x', '{bad'))).status, 400);
  assert.equal((await readJsonBody(post('/x', { note: 'x'.repeat(9000) }))).status, 413);
  assert.deepEqual(await readJsonBody(post('/x', { a: 1 })), { a: 1 });
});

test('every POST route refuses cross-site requests before calling the backend', async () => {
  await withBackend(() => ({ status: 200, json: {} }), async backend => {
    const routes = [[requestLink, { email: 'a@b.co' }], [verify, { token: TOKEN }], [verifyCode, { email: 'a@b.co', code: '123456' }], [logout, {}],
      [addAlert, { direction: 'above', threshold: 60 }], [deleteAlert, { id: 1 }], [extend, { email: 'a@b.co', days: 30, note: 'x' }],
      [resolve, { network: 'bsc', txHash: '0x' + 'a'.repeat(64), logIndex: 0, note: 'x' }],
      [sendReport, { indicator: 'tvl', description: 'The TVL card looks too low.', evidence: 'https://explorer.example/tx/1' }], [resolveReport, { id: 1, note: 'x' }]];
    const attacks = [{ origin: 'https://evil.test', fetchSite: 'cross-site' }, { origin: 'https://evil.test', fetchSite: null }, { origin: null, fetchSite: 'same-site' },
      { origin: null, fetchSite: null }, { origin: 'https://adoption.test', host: 'other.test', fetchSite: null }, { origin: 'null', fetchSite: null }];
    for (const [handler, body] of routes) for (const attack of attacks) {
      const response = await handler(post('/api/x', body, { cookie: sessionCookieHeader(), ...attack }));
      assert.deepEqual([response.status, await response.json()], [403, { error: 'forbidden' }], `${handler.name} ${JSON.stringify(attack)}`);
      assert.deepEqual(response.headers.getSetCookie(), [], 'a refused logout keeps the cookie');
    }
    assert.equal(backend.requests.length, 0);
  });
});

test('verify: the token goes only into an httpOnly cookie; the page gets {next}', async () => {
  await withBackend(({ path }) => path === '/auth/verify' ? verified({ email: 'a@b.co', isAdmin: true }) : { status: 404, json: { error: 'not_found' } }, async backend => {
    const { status, text, cookies } = await read(await verify(post('/api/auth/verify', { token: ` ${TOKEN} ` })));
    assert.equal(status, 200);
    assert.deepEqual(JSON.parse(text), { next: '/checkout?plan=annual' });
    assert.ok(!text.includes(TOKEN) && !text.includes('sessionToken') && !text.includes('a@b.co'), 'nothing but next is relayed');
    assert.deepEqual(cookies, [`kce_session=${TOKEN}; Path=/; Expires=Thu, 29 Oct 2026 12:00:00 GMT; HttpOnly; SameSite=Lax`]);
    const [call] = backend.requests;
    assert.equal(backend.requests.length, 1);
    assert.deepEqual([call.method, call.path, call.body], ['POST', '/auth/verify', { token: TOKEN }]);
    assert.equal(call.headers['x-kce-site-key'], SITE_KEY);
    assert.equal(call.headers['x-kce-client-ip'], '203.0.113.7', 'the last non-loopback X-Forwarded-For entry');
    assert.equal(call.headers['x-kce-session'], undefined);
  });
});

test('verify: signing in over another session ends the old one; the same session is left alone', async () => {
  await withBackend(({ path }) => path === '/auth/verify' ? verified() : { status: 200, json: { ok: true } }, async backend => {
    assert.equal((await verify(post('/api/auth/verify', { token: TOKEN }, { cookie: sessionCookieHeader(OTHER_TOKEN) }))).status, 200);
    const out = backend.requests.find(r => r.path === '/auth/logout');
    assert.equal(out.headers['x-kce-session'], OTHER_TOKEN);
    assert.equal(out.headers['x-kce-client-ip'], '203.0.113.7');
    backend.requests.length = 0;
    assert.equal((await verify(post('/api/auth/verify', { token: TOKEN }, { cookie: sessionCookieHeader(TOKEN) }))).status, 200);
    assert.deepEqual(backend.requests.map(r => r.path), ['/auth/verify']);
  });
});

test('verify: failures pass the status and code only, and set no cookie', async () => {
  for (const [reply, expected] of [
    [{ status: 400, json: { error: 'invalid_or_expired' } }, [400, { error: 'invalid_or_expired' }]],
    [{ status: 429, json: { error: 'rate_limit', detail: 'x' } }, [429, { error: 'rate_limit' }]],
    [{ status: 503, json: { error: 'accounts_disabled' } }, [503, { error: 'accounts_disabled' }]],
    [{ status: 200, json: { sessionToken: 'bad', next: '/account' } }, [502, { error: 'invalid_response' }]],
    [{ status: 500, text: 'oops' }, [500, { error: 'backend_unavailable' }]],
  ]) await withBackend(() => reply, async () => {
    const { status, text, cookies } = await read(await verify(post('/api/auth/verify', { token: TOKEN })));
    assert.deepEqual([status, JSON.parse(text)], expected);
    assert.deepEqual(cookies, []);
  });
  await withBackend(() => verified(), async backend => {
    for (const token of ['', 'short', TOKEN + 'x', 42, null]) {
      const response = await verify(post('/api/auth/verify', { token }));
      assert.deepEqual([response.status, await response.json()], [400, { error: 'invalid_or_expired' }]);
    }
    assert.equal(backend.requests.length, 0, 'malformed tokens never reach the backend');
  });
  const origin = process.env.KCE_API_ORIGIN, key = process.env.KCE_SITE_KEY;
  process.env.KCE_API_ORIGIN = await deadOrigin(); process.env.KCE_SITE_KEY = SITE_KEY;
  try {
    const response = await verify(post('/api/auth/verify', { token: TOKEN }));
    assert.deepEqual([response.status, await response.json()], [503, { error: 'backend_unavailable' }]);
  } finally {
    if (origin === undefined) delete process.env.KCE_API_ORIGIN; else process.env.KCE_API_ORIGIN = origin;
    if (key === undefined) delete process.env.KCE_SITE_KEY; else process.env.KCE_SITE_KEY = key;
  }
});

test('verify-code: six digits for an email, same cookie-only result', async () => {
  await withBackend(({ path }) => path === '/auth/verify-code' ? verified({ next: null }) : { status: 404, json: {} }, async backend => {
    const { status, text, cookies } = await read(await verifyCode(post('/api/auth/verify-code', { email: ' A@B.co ', code: '012 345' })));
    assert.deepEqual([status, JSON.parse(text)], [200, { next: '/account' }]);
    assert.ok(!text.includes(TOKEN) && !text.includes('sessionToken'));
    assert.match(cookies[0], new RegExp(`^kce_session=${TOKEN}; `));
    assert.deepEqual(backend.requests[0].body, { email: 'A@B.co', code: '012345' });
    assert.equal(backend.requests[0].headers['x-kce-client-ip'], '203.0.113.7');
    backend.requests.length = 0;
    for (const [body, error] of [[{ email: 'a@b.co', code: '12345' }, 'invalid_code'], [{ email: 'a@b.co', code: 'abcdef' }, 'invalid_code'], [{ email: 'a@b.co' }, 'invalid_code'],
      [{ email: 'nope', code: '123456' }, 'invalid_email'], [{ code: '123456' }, 'invalid_email']]) {
      const response = await verifyCode(post('/api/auth/verify-code', body));
      assert.deepEqual([response.status, await response.json()], [400, { error }], JSON.stringify(body));
    }
    assert.equal(backend.requests.length, 0);
  });
  await withBackend(() => ({ status: 400, json: { error: 'invalid_or_expired' } }), async () => {
    const { status, text, cookies } = await read(await verifyCode(post('/api/auth/verify-code', { email: 'a@b.co', code: '123456' })));
    assert.deepEqual([status, JSON.parse(text), cookies], [400, { error: 'invalid_or_expired' }, []]);
  });
});

test('request-link: sends the email and a safe next only, with the visitor IP', async () => {
  await withBackend(() => ({ status: 202, json: { ok: true, debug: 'x' } }), async backend => {
    let response = await requestLink(post('/api/auth/request-link', { email: 'a@b.co', next: '/checkout?plan=annual' }));
    assert.deepEqual([response.status, await response.json()], [202, { ok: true }]);
    assert.deepEqual(backend.requests[0].body, { email: 'a@b.co', next: '/checkout?plan=annual' });
    assert.equal(backend.requests[0].headers['x-kce-client-ip'], '203.0.113.7');
    response = await requestLink(post('/api/auth/request-link', { email: 'a@b.co', next: '//evil.com' }));
    assert.equal(response.status, 202);
    assert.deepEqual(backend.requests[1].body, { email: 'a@b.co' }, 'an unsafe next is dropped');
    response = await requestLink(post('/api/auth/request-link', { email: 'not-an-email' }));
    assert.deepEqual([response.status, await response.json()], [400, { error: 'invalid_email' }]);
    assert.equal(backend.requests.length, 2);
  });
  for (const [status, error] of [[503, 'signin_not_open'], [503, 'mail_not_configured'], [429, 'rate_limit'], [502, 'mail_failed'], [400, 'invalid_email']])
    await withBackend(() => ({ status, json: { error } }), async () => {
      const response = await requestLink(post('/api/auth/request-link', { email: 'a@b.co' }));
      assert.deepEqual([response.status, await response.json()], [status, { error }]);
    });
});

test('logout always clears the cookie and ends the backend session when there is one', async () => {
  const cleared = 'kce_session=; Path=/; Expires=Thu, 01 Jan 1970 00:00:00 GMT; Max-Age=0; HttpOnly; SameSite=Lax';
  for (const reply of [{ status: 200, json: { ok: true } }, { status: 500, json: { error: 'internal_error' } }, { status: 401, json: { error: 'session_required' } }])
    await withBackend(() => reply, async backend => {
      const { status, text, cookies } = await read(await logout(post('/api/auth/logout', undefined, { cookie: sessionCookieHeader(), contentType: null })));
      assert.deepEqual([status, JSON.parse(text), cookies], [200, { ok: true }, [cleared]]);
      assert.equal(backend.requests[0].path, '/auth/logout');
      assert.equal(backend.requests[0].headers['x-kce-session'], TOKEN);
      assert.equal(backend.requests[0].headers['x-kce-client-ip'], '203.0.113.7');
    });
  await withBackend(() => ({ status: 200, json: {} }), async backend => {
    const { status, cookies } = await read(await logout(post('/api/auth/logout', undefined, { contentType: null })));
    assert.deepEqual([status, cookies], [200, [cleared]]);
    assert.equal(backend.requests.length, 0, 'no cookie, no backend call');
  });
  const origin = process.env.KCE_API_ORIGIN;
  process.env.KCE_API_ORIGIN = await deadOrigin(); process.env.KCE_SITE_KEY = SITE_KEY;
  try {
    const { status, cookies } = await read(await logout(post('/api/auth/logout', undefined, { cookie: sessionCookieHeader(), contentType: null })));
    assert.deepEqual([status, cookies], [200, [cleared]], 'a backend outage still signs the browser out');
  } finally { if (origin === undefined) delete process.env.KCE_API_ORIGIN; else process.env.KCE_API_ORIGIN = origin; delete process.env.KCE_SITE_KEY; }
});

test('alerts: session required, input checked, only the new id relayed', async () => {
  await withBackend(({ path }) => path === '/account/alerts' ? { status: 201, json: { id: 7, userId: 3 } } : { status: 200, json: { ok: true, extra: 1 } }, async backend => {
    let response = await addAlert(post('/api/account/alerts', { direction: 'above', threshold: 60 }));
    assert.deepEqual([response.status, await response.json()], [401, { error: 'session_required' }]);
    response = await addAlert(post('/api/account/alerts', { direction: 'below', threshold: '45.5' }, { cookie: sessionCookieHeader() }));
    assert.deepEqual([response.status, await response.json()], [201, { id: 7 }]);
    assert.deepEqual(backend.requests[0].body, { direction: 'below', threshold: 45.5 });
    assert.equal(backend.requests[0].headers['x-kce-session'], TOKEN);
    assert.equal(backend.requests[0].headers['x-kce-client-ip'], '203.0.113.7');
    for (const body of [{ direction: 'above', threshold: 45.25 }, { direction: 'above', threshold: -1 }, { direction: 'above', threshold: 100000.1 }, { direction: 'above', threshold: 'abc' },
      { direction: 'sideways', threshold: 50 }, { direction: 'above' }, { direction: 'above', threshold: 1e21 }]) {
      response = await addAlert(post('/api/account/alerts', body, { cookie: sessionCookieHeader() }));
      assert.deepEqual([response.status, await response.json()], [400, { error: 'invalid_alert' }], JSON.stringify(body));
    }
    response = await deleteAlert(post('/api/account/alerts/delete', { id: '7' }, { cookie: sessionCookieHeader() }));
    assert.deepEqual([response.status, await response.json()], [200, { ok: true }]);
    assert.deepEqual(backend.requests.at(-1).body, { id: 7 });
    for (const id of [0, -1, 1.5, 'x', null]) {
      response = await deleteAlert(post('/api/account/alerts/delete', { id }, { cookie: sessionCookieHeader() }));
      assert.deepEqual([response.status, await response.json()], [400, { error: 'invalid_id' }]);
    }
    assert.equal(backend.requests.length, 2);
  });
  for (const [status, error] of [[409, 'too_many_alerts'], [409, 'duplicate_alert'], [403, 'subscription_required'], [404, 'not_found'], [401, 'session_required']])
    await withBackend(() => ({ status, json: { error, count: 5 } }), async () => {
      const response = await addAlert(post('/api/account/alerts', { direction: 'above', threshold: 100000 }, { cookie: sessionCookieHeader() }));
      assert.deepEqual([response.status, await response.json()], [status, { error }]);
    });
});

test('admin extend and resolve: validated input, backend status passed through', async () => {
  await withBackend(({ path }) => path === '/admin/subscriptions/extend'
    ? { json: { subscription: { plan: 'manual', startedAt: '2026-09-29T00:00:00.000Z', expiresAt: '2026-10-29T00:00:00.000Z', active: true, userId: 9 }, userCreated: true, audit: 'x' } }
    : { json: { ok: true, row: {} } }, async backend => {
    let response = await extend(post('/api/admin/extend', { email: 'a@b.co', days: '30', note: ' Paid by exchange withdrawal ' }, { cookie: sessionCookieHeader() }));
    assert.deepEqual([response.status, await response.json()], [200, { subscription: { plan: 'manual', startedAt: '2026-09-29T00:00:00.000Z', expiresAt: '2026-10-29T00:00:00.000Z', active: true }, userCreated: true }]);
    assert.deepEqual(backend.requests[0].body, { email: 'a@b.co', days: 30, note: 'Paid by exchange withdrawal' });
    for (const [body, error] of [[{ email: 'x', days: 30, note: 'n' }, 'invalid_email'], [{ email: 'a@b.co', days: 0, note: 'n' }, 'invalid_days'], [{ email: 'a@b.co', days: 401, note: 'n' }, 'invalid_days'],
      [{ email: 'a@b.co', days: 1.5, note: 'n' }, 'invalid_days'], [{ email: 'a@b.co', days: 30, note: '  ' }, 'invalid_note'], [{ email: 'a@b.co', days: 30, note: 'n'.repeat(501) }, 'invalid_note']]) {
      response = await extend(post('/api/admin/extend', body, { cookie: sessionCookieHeader() }));
      assert.deepEqual([response.status, await response.json()], [400, { error }], JSON.stringify(body).slice(0, 80));
    }
    const hash = '0x' + 'AB'.repeat(32);
    response = await resolve(post('/api/admin/resolve', { network: 'bsc', txHash: hash, logIndex: 3, note: 'credited a@b.co' }, { cookie: sessionCookieHeader() }));
    assert.deepEqual([response.status, await response.json()], [200, { ok: true }]);
    assert.deepEqual(backend.requests.at(-1).body, { network: 'bsc', txHash: hash.toLowerCase(), logIndex: 3, note: 'credited a@b.co' });
    response = await resolve(post('/api/admin/resolve', { network: 'bsc-testnet', txHash: hash, logIndex: '0', note: 'n' }, { cookie: sessionCookieHeader() }));
    assert.equal(response.status, 200);
    assert.deepEqual(backend.requests.at(-1).body, { network: 'bsc-testnet', txHash: hash.toLowerCase(), logIndex: 0, note: 'n' });
    // Only BSC transaction hashes: a 43-character base64url token is refused before it reaches the backend.
    for (const [body, error] of [[{ network: 'BSC!', txHash: hash, logIndex: 0, note: 'n' }, 'invalid_network'], [{ network: 'bsc', txHash: '0x12', logIndex: 0, note: 'n' }, 'invalid_tx_hash'],
      [{ network: 'bsc', txHash: TOKEN, logIndex: 0, note: 'n' }, 'invalid_tx_hash'],
      [{ network: 'bsc', txHash: hash, logIndex: -1, note: 'n' }, 'invalid_log_index'], [{ network: 'bsc', txHash: hash, logIndex: 0, note: '' }, 'invalid_note']]) {
      response = await resolve(post('/api/admin/resolve', body, { cookie: sessionCookieHeader() }));
      assert.deepEqual([response.status, await response.json()], [400, { error }], JSON.stringify(body));
    }
    assert.equal(backend.requests.length, 3);
  });
  await withBackend(() => ({ json: { subscription: null } }), async () => {
    const response = await extend(post('/api/admin/extend', { email: 'a@b.co', days: 1, note: 'n' }, { cookie: sessionCookieHeader() }));
    assert.deepEqual(await response.json(), { subscription: null, userCreated: false });
  });
  await withBackend(() => ({ status: 404, json: { error: 'not_found' } }), async () => {
    const response = await extend(post('/api/admin/extend', { email: 'a@b.co', days: 30, note: 'n' }, { cookie: sessionCookieHeader() }));
    assert.deepEqual([response.status, await response.json()], [404, { error: 'not_found' }], 'a non-admin gets the backend 404');
  });
});

test('CSV export streams the backend file with a clean filename, or returns to the account page', async () => {
  const csv = 'date,score,window_days\n2026-09-26,45.1,7\n';
  await withBackend(() => ({ text: csv, headers: { 'Content-Disposition': 'attachment; filename="kce-adoption-index-2026-09-26.csv"' } }), async backend => {
    const response = await exportCsv(get('/api/export', { cookie: sessionCookieHeader() }));
    assert.equal(response.status, 200);
    assert.equal(response.headers.get('content-type'), 'text/csv; charset=utf-8');
    assert.equal(response.headers.get('content-disposition'), 'attachment; filename="kce-adoption-index-2026-09-26.csv"');
    assert.equal(response.headers.get('cache-control'), 'no-store');
    assert.equal(await response.text(), csv);
    assert.deepEqual([backend.requests[0].method, backend.requests[0].path], ['GET', '/export.csv']);
    assert.equal(backend.requests[0].headers['x-kce-session'], TOKEN);
    assert.equal(backend.requests[0].headers['x-kce-client-ip'], '203.0.113.7');
  });
  for (const disposition of ['attachment; filename="../../etc/passwd.csv"', 'attachment; filename="a b.csv"', 'attachment; filename="x.csv"; filename*=UTF-8\'\'evil', 'attachment; filename="report.html"', 'attachment', 'attachment; filename=..csv'])
    await withBackend(() => ({ text: csv, headers: { 'Content-Disposition': disposition } }), async () => {
      const response = await exportCsv(get('/api/export', { cookie: sessionCookieHeader() }));
      const expected = disposition.includes('"x.csv"') ? 'x.csv' : 'kce-adoption-index.csv';
      assert.equal(response.headers.get('content-disposition'), `attachment; filename="${expected}"`, disposition);
    });
  await withBackend(() => ({ status: 200, json: { not: 'csv' } }), async () => {
    assert.equal((await exportCsv(get('/api/export', { cookie: sessionCookieHeader() }))).headers.get('location'), '/account?export=export_failed#pro-tools');
  });
  for (const [status, error, location] of [[403, 'subscription_required', '/account?export=subscription_required#pro-tools'], [503, 'index_not_ready', '/account?export=index_not_ready#pro-tools'],
    [429, 'rate_limit', '/account?export=rate_limit#pro-tools'], [401, 'session_required', '/signin?next=/account']])
    await withBackend(() => ({ status, json: { error } }), async () => {
      const response = await exportCsv(get('/api/export', { cookie: sessionCookieHeader() }));
      assert.deepEqual([response.status, response.headers.get('location')], [303, location]);
    });
  await withBackend(() => ({ text: csv }), async backend => {
    const response = await exportCsv(get('/api/export'));
    assert.deepEqual([response.status, response.headers.get('location')], [303, '/signin?next=/account']);
    assert.equal(backend.requests.length, 0);
  });
  const origin = process.env.KCE_API_ORIGIN;
  process.env.KCE_API_ORIGIN = await deadOrigin(); process.env.KCE_SITE_KEY = SITE_KEY;
  try { assert.equal((await exportCsv(get('/api/export', { cookie: sessionCookieHeader() }))).headers.get('location'), '/account?export=backend_unavailable#pro-tools'); }
  finally { if (origin === undefined) delete process.env.KCE_API_ORIGIN; else process.env.KCE_API_ORIGIN = origin; delete process.env.KCE_SITE_KEY; }
});
