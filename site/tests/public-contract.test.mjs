import { test } from 'node:test';
import assert from 'node:assert/strict';
import { publicScore, proScore } from '../lib/score-display.ts';
import { collectionPeriod } from '../lib/preview-state.ts';
import { publishedIndex } from '../lib/public-index.ts';
import { billingTerms } from '../lib/billing-terms.ts';
import { subscriptionConfirmation } from '../emails/subscription-confirmation.ts';

test('public card uses a whole number while Pro preserves one decimal', () => {
  assert.equal(publicScore(88.5), '89');
  assert.equal(proScore(88.5), '88.5');
  assert.equal(publicScore(0), '0');
  assert.equal(proScore(100), '100.0');
});
test('history grows from one fixed collection date', () => {
  const first = collectionPeriod(new Date('2026-09-27T12:00:00Z'));
  const later = collectionPeriod(new Date('2027-01-01T12:00:00Z'));
  assert.equal(first.start, '2026-06-29');
  assert.equal(first.historyDays, 90);
  assert.equal(later.start, first.start);
  assert.ok(later.historyDays > 90);
});
const baseline = { fromDay: '2026-06-29', throughDay: '2026-07-28', days: 30, level: 50, metrics: {
  addresses: { kind: 'average', perWindow: 374.9, dailyMean: 374.9, observedDailyMean: 374.9, rule: 'observed' },
  contracts: { kind: 'count', perWindow: 7, dailyMean: 1, observedDailyMean: 0.4667, rule: 'minimum' },
  tvl: { kind: 'average', perWindow: 13222255.08, dailyMean: 13222255.08, observedDailyMean: 13222255.08, rule: 'observed' },
  hashrate: { kind: 'average', perWindow: 15.22, dailyMean: 15.22, observedDailyMean: 15.22, rule: 'observed' },
  commits: { kind: 'count', perWindow: 7, dailyMean: 1, observedDailyMean: 0.8, rule: 'minimum' } } };
const fixed = { state: 'current', date: '2026-09-26', score: 56, collectionStart: '2026-06-29', summaryRetention: 'permanent', normalization: 'fixed-baseline-first-30-days', baseline, changes: { sevenDay: 1.2, thirtyDay: null } };
test('public adapter accepts the fixed-baseline index with no ceiling, and rejects the old peak method', () => {
  assert.equal(publishedIndex(fixed).score, 56);
  assert.equal(publishedIndex(fixed).state, 'ready');
  assert.equal(publishedIndex(fixed).baseline.metrics.contracts.rule, 'minimum');
  assert.equal(publishedIndex({ ...fixed, score: 0 }).score, 0, 'verified zero');
  assert.equal(publishedIndex({ ...fixed, score: 250 }).score, 250, 'no ceiling');
  assert.equal(publishedIndex({ ...fixed, score: -1 }), null);
  assert.equal(publishedIndex({ ...fixed, normalization: 'since-collection-causal-high', band: 'Early Recovery' }), null);
  assert.equal(publishedIndex({ ...fixed, state: 'staged' }), null);
  assert.equal(publishedIndex({ ...fixed, baseline: { ...baseline, throughDay: '2026-07-29' } }), null, 'the baseline period is fixed');
  assert.equal(publishedIndex({ ...fixed, baseline: { ...baseline, level: 100 } }), null);
  assert.equal(publishedIndex({ ...fixed, baseline: undefined }), null);
  assert.equal(publishedIndex({ ...fixed, score: null }), null);
});

test('future confirmation uses the checkout terms and safely escapes receipt text', () => {
  const mail = subscriptionConfirmation({ planId: 'annual', paidThrough: '2027-09-27', receiptId: '<untrusted>' });
  for (const value of Object.values(billingTerms)) assert.ok(mail.text.includes(value));
  assert.ok(mail.text.includes('$79/year'));
  assert.ok(mail.html.includes('&lt;untrusted&gt;'));
  assert.ok(!mail.html.includes('<untrusted>'));
});

test('the score card states the position against the baseline instead of a band', async () => {
  const { baselineComparison } = await import('../lib/metrics.ts');
  assert.deepEqual(baselineComparison(50), { text: 'At baseline', tone: 'pending' });
  assert.deepEqual(baselineComparison(56), { text: '12% above baseline', tone: 'growth' });
  assert.deepEqual(baselineComparison(150), { text: '200% above baseline', tone: 'growth' });
  assert.deepEqual(baselineComparison(40), { text: '20% below baseline', tone: 'declining' });
});
