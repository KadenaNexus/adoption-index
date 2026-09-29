import { test } from 'node:test';
import assert from 'node:assert/strict';
import { afterSignIn, safeNextPath } from '../lib/safe-next.ts';
import { safeNextPath as backendSafeNextPath } from '../../backend/src/auth.mjs';

const safe = ['/', '/account', '/checkout?plan=annual', '/checkout?plan=monthly&x=1', '/?range=90d', '/methodology#inputs', '/a/b.c/d', '/a-b_c~d'];
const unsafe = [
  null, undefined, 42, {}, ['/account'], '', 'account', 'https://evil.com', 'http://evil.com/account', '//evil.com', '///evil.com',
  '/\\evil.com', '/\\/evil.com', '/.//evil.com', '/..//evil.com', '/x/..//evil.com', '/a//b', '/x/../y', '/./x', '/x/.', '/x/..', '/x/..?y', '/x/.#y',
  '/%2f%2fevil.com', '/%2F/evil.com', '/%5cevil.com', '/%2e%2e/x', '/%2E/x', '/javascript:alert(1)', '/data:text/html,x', '/ account', '/account\n',
  '/acc\tount', '/x\u0000', '/x\u007f', '/' + 'a'.repeat(512),
];

test('safe next paths stay on this site', () => {
  for (const value of safe) assert.equal(safeNextPath(value), value, value);
  for (const value of unsafe) assert.equal(safeNextPath(value), null, JSON.stringify(value));
  assert.equal(safeNextPath('/' + 'a'.repeat(511)), '/' + 'a'.repeat(511), '512 characters is the limit');
});

test('the site rule is the same as the backend rule', () => {
  for (const value of [...safe, ...unsafe]) assert.equal(safeNextPath(value), backendSafeNextPath(value), JSON.stringify(value));
});

test('after sign-in: a safe next, else the account page, never back into sign-in', () => {
  assert.equal(afterSignIn('/checkout?plan=annual'), '/checkout?plan=annual');
  assert.equal(afterSignIn('/'), '/');
  for (const value of [null, undefined, '', '//evil.com', '/.//evil.com', 'https://evil.com', '/signin', '/signin/verify', '/signin?next=/account', '/signin#x'])
    assert.equal(afterSignIn(value), '/account', JSON.stringify(value));
  assert.equal(afterSignIn('/signing-up'), '/signing-up', 'only the sign-in pages themselves are skipped');
});
