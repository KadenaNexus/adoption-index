import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { billingTerms, plans } from '../lib/billing-terms.ts';

const root = new URL('..', import.meta.url);
const source = path => readFileSync(new URL(path, root), 'utf8');
// Pages and components of the accounts UI (checkout and wallet flows have their own tests).
const OTHERS = /^app\/(checkout|api\/billing|api\/wallets)\//;
const files = [
  ...readdirSync(new URL('app', root), { recursive: true }).map(f => `app/${String(f).split('\\').join('/')}`).filter(f => /\.(tsx?|mjs)$/.test(f) && !OTHERS.test(f)),
  'lib/billing-terms.ts', 'lib/messages.ts', 'lib/account-view.ts',
];

test('no page promises automatic renewal or cancellation', () => {
  assert.ok(files.includes('app/access/page.tsx') && files.includes('app/index-view.tsx') && files.includes('app/plan-picker.tsx') && files.includes('app/account/page.tsx'));
  for (const file of files) {
    const text = source(file).replace(/Nothing renews automatically/g, '');
    for (const pattern of [/cancel/i, /\brenews\b/i, /\brenewing\b/i, /auto-?renews\b/i, /recurring/i, /\bper (month|year)\b/i, /subscriber preview/i])
      assert.doesNotMatch(text, pattern, `${file} ${pattern}`);
  }
});

test('one payment buys 30 or 365 days, and the terms say so', () => {
  assert.deepEqual([plans.monthly.days, plans.annual.days], [30, 365]);
  assert.match(billingTerms.renewal, /Each payment buys 30 days \(Monthly\) or 365 days \(Annual\)/);
  assert.match(billingTerms.renewal, /Nothing renews automatically/);
  assert.match(billingTerms.renewal, /7 days and 1 day before/);
  assert.deepEqual(Object.keys(billingTerms).sort(), ['refund', 'renewal']);
  const access = source('app/access/page.tsx');
  assert.match(access, /One payment buys 365 days/);
  assert.match(access, /One payment buys 30 days/);
  assert.doesNotMatch(access, /Coming soon|not active/i, 'the plans page no longer says payments are closed');
  assert.doesNotMatch(access, /\/ ?(month|year)\b/, 'no per-period price');
  const picker = source('app/plan-picker.tsx');
  assert.match(picker, /monthly: \['30 days', 'no auto-renewal'\]/);
  assert.match(picker, /annual: \['365 days', 'save 27%'\]/);
  const panel = source('app/index-view.tsx');
  assert.match(panel, /One payment buys 30 or 365 days\. Nothing renews automatically\./);
});

test('the preview mechanism is gone', () => {
  assert.throws(() => readdirSync(new URL('app/preview', root)), /ENOENT/);
  for (const file of [...files, 'lib/pro-data.ts', 'app/globals.css'])
    assert.doesNotMatch(source(file), /proPreviewEnabled|getProPreview|KCE_PRO_PREVIEW|preview-banner|\/preview\/subscriber/, file);
});
