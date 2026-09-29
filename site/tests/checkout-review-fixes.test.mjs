import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { checkoutMessage } from '../lib/wallet.ts';
import { errorMessage } from '../lib/messages.ts';
const page = readFileSync(new URL('../app/checkout/page.tsx', import.meta.url), 'utf8');
const flow = readFileSync(new URL('../app/checkout/checkout-flow.tsx', import.meta.url), 'utf8');

test('changing the plan remounts the checkout, so no intent from the previous plan survives', () => {
  assert.match(page, /<CheckoutFlow key=\{plan\.id\}/);
});

test('a pasted hash never carries the page plan; only the transaction this page sent keeps its intent', () => {
  assert.doesNotMatch(flow, /txHash: hash, plan: plan\.id/);
  assert.match(flow, /sentHash\.current === hash \? \{ intentId: intent\.intentId \}/);
});

test('new backend codes have their own messages', () => {
  assert.match(checkoutMessage('transfer_resolved').text, /already handled this transfer/);
  assert.match(errorMessage('code_locked', 'code'), /Use the sign-in link/);
});

test('late wallet answers are matched to their connection, and change nothing once the payment is sent', () => {
  assert.match(flow, /useState\(connectionCounter\)/);
  assert.doesNotMatch(flow, /provider\.current === p\b/, 'WalletConnect returns the same provider on every connect');
  assert.match(flow, /if \(!stillCurrent\(id\) \|\| SENT\.has\(stageNow\.current\)\) return;/);
});

test('a payment from an unlinked wallet is checked again once that wallet is linked, never offered for payment again', () => {
  assert.match(flow, /if \(result\.code === 'unlinked_wallet'\) recheck\.current = body\.txHash;/);
  const prepare = flow.slice(flow.indexOf('async function prepare('), flow.indexOf('async function connect('));
  const recheck = prepare.indexOf('await confirm({ txHash: pending }); return;');
  assert.ok(recheck > 0 && recheck < prepare.indexOf('createIntent('), 'the re-check comes before any new intent');
});

test('only a transfer this page sent promises a receipt email', () => {
  assert.match(flow, /const own = body\.txHash === sentHash\.current;/);
  assert.match(flow, /\{receipt && <p>A receipt is on its way to your email\.<\/p>\}/);
});
