import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { isSubscriber } from '../lib/account-view.ts';

const source = path => readFileSync(new URL(`../${path}`, import.meta.url), 'utf8');
const account = subscription => ({ state: 'signed-in', account: { email: 'a@b.co', isAdmin: false, subscription, wallets: [], alerts: [], payments: [], testPlanAvailable: false } });
const sub = active => ({ plan: 'monthly', startedAt: '2026-09-01T00:00:00Z', expiresAt: '2026-10-01T00:00:00Z', active });

test('only a signed-in account with an active subscription is a subscriber', () => {
  assert.equal(isSubscriber({ state: 'signed-out' }), false);
  assert.equal(isSubscriber({ state: 'unavailable' }), false, 'a backend outage never unlocks Pro');
  assert.equal(isSubscriber(account(null)), false);
  assert.equal(isSubscriber(account(sub(false))), false);
  assert.equal(isSubscriber(account({ ...sub(true), active: 'true' })), false, 'only a real true');
  assert.equal(isSubscriber(account(sub(true))), true);
  assert.equal(isSubscriber({ ...account(sub(true)), account: { ...account(sub(true)).account, isAdmin: true, subscription: null } }), false, 'admins are not subscribers by role');
});

test('the home page makes its only Pro call after the subscriber check', () => {
  const page = source('app/page.tsx');
  const gate = page.indexOf('if (!isSubscriber(state))'), freeReturn = page.indexOf('return <IndexView index={index} notice={notice}/>'), call = page.indexOf('getProData(');
  assert.ok(gate > 0 && freeReturn > gate, 'free visitors return early');
  assert.equal(page.split('getProData(').length, 2, 'exactly one Pro call');
  assert.ok(call > freeReturn, 'the Pro call comes after the early return');
  assert.equal(page.split('subscriber=').length, 2, 'Pro data is passed only on the subscriber path');
  assert.ok(page.indexOf('subscriber=') > call);
  assert.match(page, /getProData\(requested, await getSessionToken\(\), await requestClientIp\(\)\)/, 'with the session and the visitor IP');
  assert.doesNotMatch(page, /backendFetch|backendResponse|\/index\/history|\/metrics\/breakdown/, 'no other Pro request');
});

test('shared components never fetch Pro data themselves', () => {
  for (const file of ['app/index-view.tsx', 'app/history-chart.tsx', 'app/chart-grid.tsx', 'app/plan-picker.tsx', 'app/layout.tsx'])
    assert.doesNotMatch(source(file), /getProData|backendFetch|backendResponse|getAccount/, file);
  // The header reads only the cookie; account data comes from the pages that need it.
  assert.match(source('app/index-view.tsx'), /getSessionToken\(\)/);
});

test('client components never import the server-only backend client', () => {
  const clients = ['app/signin/signin-form.tsx', 'app/signin/verify/verify-form.tsx', 'app/account/alerts-form.tsx', 'app/account/sign-out-button.tsx', 'app/admin/extend-form.tsx', 'app/admin/resolve-form.tsx', 'app/plan-picker.tsx', 'app/history-chart.tsx'];
  for (const file of clients) {
    const text = source(file);
    assert.match(text, /^'use client';/, file);
    assert.doesNotMatch(text, /lib\/(backend|session|site-api|pro-data|admin-view)['.]|next\/headers|KCE_SITE_KEY/, file);
  }
});

test('the sign-in and account pages decide by the backend, not the cookie', () => {
  const signin = source('app/signin/page.tsx'), accountPage = source('app/account/page.tsx'), admin = source('app/admin/page.tsx');
  assert.match(signin, /getAccountState\(\)/);
  assert.match(signin, /state\.state === 'signed-in'\) redirect\(afterSignIn\(next\)\)/);
  assert.doesNotMatch(signin, /getSessionToken/);
  assert.match(accountPage, /state\.state === 'signed-out'\) redirect\('\/signin\?next=\/account'\)/);
  assert.match(accountPage, /state\.state === 'unavailable'\) return/);
  assert.match(accountPage, /Your account is temporarily unavailable, please try again/);
  assert.match(admin, /if \(state\.state !== 'signed-in' \|\| !state\.account\.isAdmin\) notFound\(\);/);
  assert.match(admin, /Testnet mode — checkout is limited to admins/);
  const verify = source('app/signin/verify/verify-form.tsx');
  assert.match(verify, /window\.history\.replaceState\(null, '', window\.location\.pathname\)/);
  assert.match(verify, /Continue signing in/);
  assert.match(source('app/signin/verify/page.tsx'), /referrer: 'no-referrer'/);
});
