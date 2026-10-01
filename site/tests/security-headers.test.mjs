import { test } from 'node:test';
import assert from 'node:assert/strict';
import config, { securityHeaders } from '../next.config.ts';

const forPath = (rules, path) => {
  // The same override rule Next.js applies: a later matching rule replaces an earlier value for the same key.
  const headers = {};
  for (const rule of rules) if (rule.source === '/:path*' || rule.source === path) for (const { key, value } of rule.headers) headers[key] = value;
  return headers;
};

test('every route gets the security headers; HSTS only in production', async () => {
  const dev = forPath(securityHeaders(false), '/account');
  assert.deepEqual(dev, { 'X-Frame-Options': 'DENY', 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'strict-origin-when-cross-origin', 'Permissions-Policy': 'camera=(), microphone=(), geolocation=()' });
  const prod = forPath(securityHeaders(true), '/');
  assert.equal(prod['Strict-Transport-Security'], 'max-age=31536000');
  assert.equal(prod['X-Frame-Options'], 'DENY');
  assert.deepEqual(await config.headers(), securityHeaders(process.env.NODE_ENV === 'production'));
  assert.equal(config.poweredByHeader, false);
});

test('the sign-in link page sends no referrer', () => {
  for (const production of [false, true]) {
    const rules = securityHeaders(production);
    assert.equal(forPath(rules, '/signin/verify')['Referrer-Policy'], 'no-referrer');
    assert.equal(forPath(rules, '/signin')['Referrer-Policy'], 'strict-origin-when-cross-origin');
    assert.equal(rules.at(-1).source, '/signin/verify', 'listed last so it overrides the site-wide value');
  }
});

test('production builds start fresh: no persistent build cache to ship a previous stylesheet', () => {
  assert.equal(config.experimental?.turbopackFileSystemCacheForBuild, false);
});
