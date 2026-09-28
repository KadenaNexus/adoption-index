import { test } from 'node:test';
import assert from 'node:assert/strict';
import { publicSummary, publishedIndex } from '../lib/public-index.ts';
import { getProPreview, parseBreakdown, parseHistory, proPreviewEnabled, rangeFrom } from '../lib/pro-data.ts';
import { areaPath, axisDays, nearestIndex, plotPoints, scaleFor, yFor } from '../lib/chart-geometry.ts';
import { baselineComparison, formatChange, formatRatio, ratioTone } from '../lib/metrics.ts';

const meta = { collectionStart: '2026-06-29', summaryRetention: 'permanent', normalization: 'fixed-baseline-first-30-days' };
const baselineMetric = (kind, perWindow, observedDailyMean, rule = 'observed') => ({ kind, perWindow, dailyMean: kind === 'count' ? perWindow / 7 : perWindow, observedDailyMean, rule });
const baseline = { fromDay: '2026-06-29', throughDay: '2026-07-28', days: 30, level: 50, metrics: {
  addresses: baselineMetric('average', 374.9, 374.9), contracts: baselineMetric('count', 7, 0.4667, 'minimum'),
  tvl: baselineMetric('average', 13222255.08, 13222255.08), hashrate: baselineMetric('average', 15.22, 15.22), commits: baselineMetric('count', 7, 0.8, 'minimum') } };
const today = (score, extra = {}) => ({ state: 'current', date: '2026-09-26', score, ...meta, baseline, ...extra });
const key = 'k'.repeat(40);
const history = { ...meta, baselineLevel: 50, range: '30d', fromDay: '2026-09-24', throughDay: '2026-09-26', series: [
  { date: '2026-09-24', score: 43.4, windowDays: 7 }, { date: '2026-09-25', score: 43.7, windowDays: 7 }, { date: '2026-09-26', score: 45.1, windowDays: 7 }] };
const metric = (id, weight, extra = {}) => ({ id, kind: ['contracts', 'commits'].includes(id) ? 'count' : 'average', rawValue: 10, windowDays: 7, baselineValue: 8,
  baselineRule: 'observed', observedBaselineDailyMean: 8, ratio: 1.25, index: 62.5, weight, contribution: 62.5 * weight, weekOverWeek: { absolute: 1, percent: 12.5 }, ...extra });
const breakdown = { ...meta, date: '2026-09-26', score: 62.5, baseline, tvlUsd: 158397.2, kdaUsd: 0.0113973, metrics: [
  metric('tvl', 0.2), metric('commits', 0.1, { weekOverWeek: { absolute: null, percent: null } }), metric('hashrate', 0.15), metric('addresses', 0.3), metric('contracts', 0.25)] };

test('free visitors never receive the Pro-only 7-day and 30-day change', () => {
  const index = publishedIndex(today(45, { changes: { sevenDay: 3.4, thirtyDay: -21.3 } }));
  assert.equal(index.sevenDay, 3.4);
  const summary = publicSummary(index);
  assert.deepEqual(Object.keys(summary).sort(), ['baseline', 'day', 'message', 'score', 'state', 'updatedAt']);
  assert.ok(!JSON.stringify(summary).includes('21.3'));
});

test('subscriber preview is closed in production even when configured', async () => {
  assert.equal(proPreviewEnabled({ NODE_ENV: 'production', KCE_PRO_PREVIEW: '1', KCE_API_KEY: key, KCE_API_ORIGIN: 'http://127.0.0.1:3001' }), false);
  assert.equal(proPreviewEnabled({ NODE_ENV: 'development', KCE_PRO_PREVIEW: '1', KCE_API_KEY: key, KCE_API_ORIGIN: 'http://127.0.0.1:3001' }), true);
  assert.equal(proPreviewEnabled({ NODE_ENV: 'development', KCE_API_KEY: key, KCE_API_ORIGIN: 'http://127.0.0.1:3001' }), false);
  assert.equal(proPreviewEnabled({ NODE_ENV: 'development', KCE_PRO_PREVIEW: '1', KCE_API_KEY: 'short', KCE_API_ORIGIN: 'http://127.0.0.1:3001' }), false);
  const original = globalThis.fetch;
  globalThis.fetch = () => { throw new Error('production must not request Pro data'); };
  try { assert.equal(await getProPreview('30d', { NODE_ENV: 'production', KCE_PRO_PREVIEW: '1', KCE_API_KEY: key, KCE_API_ORIGIN: 'http://127.0.0.1:3001' }), null); }
  finally { globalThis.fetch = original; }
});

test('history ranges: 1Y and unknown values fall back to 30D', () => {
  assert.equal(rangeFrom('90d'), '90d');
  assert.equal(rangeFrom('all'), 'all');
  assert.equal(rangeFrom('1y'), '30d');
  assert.equal(rangeFrom(undefined), '30d');
});

test('history payloads must be ordered, fixed-start and fixed-baseline, with no ceiling', () => {
  assert.equal(parseHistory(history).series.length, 3);
  const above = parseHistory({ ...history, series: [...history.series.slice(0, 2), { date: '2026-09-26', score: 187.4, windowDays: 7 }] });
  assert.equal(above.series[2].score, 187.4, 'scores above 100 are valid');
  const startup = { ...history, fromDay: '2026-06-29', throughDay: '2026-06-30', series: [{ date: '2026-06-29', score: 34.8, windowDays: 1 }, { date: '2026-06-30', score: 40.2, windowDays: 2 }] };
  assert.deepEqual(parseHistory(startup).series.map(p => p.windowDays), [1, 2]);
  assert.equal(parseHistory({ ...history, collectionStart: '2025-11-08' }), null);
  assert.equal(parseHistory({ ...history, normalization: 'since-collection-causal-high' }), null, 'the old peak-based method is rejected');
  assert.equal(parseHistory({ ...history, baselineLevel: 100 }), null);
  assert.equal(parseHistory({ ...history, series: [...history.series].reverse() }), null);
  assert.equal(parseHistory({ ...history, series: [...history.series.slice(0, 2), { date: '2026-09-26', score: -1, windowDays: 7 }] }), null);
  assert.equal(parseHistory({ ...history, series: [...history.series.slice(0, 2), { date: '2026-09-26', score: 45.1 }] }), null, 'window length is required');
  assert.equal(parseHistory({ ...history, series: [...history.series.slice(0, 2), { date: '2026-09-26', score: 45.1, windowDays: 8 }] }), null);
  assert.equal(parseHistory({ ...history, throughDay: '2026-09-27' }), null);
  assert.equal(parseHistory({ ...history, series: [] }), null);
});

test('breakdown requires exactly the five weighted inputs, each with its fixed baseline', () => {
  const parsed = parseBreakdown(breakdown, 7);
  assert.deepEqual(parsed.metrics.map(m => m.id), ['addresses', 'contracts', 'tvl', 'hashrate', 'commits']);
  assert.deepEqual(parsed.metrics.map(m => m.kind), ['average', 'count', 'average', 'average', 'count']);
  assert.equal(parsed.metrics[0].baselineValue, 8);
  assert.equal(parsed.metrics[0].ratio, 1.25);
  assert.equal(parsed.metrics[0].weekOverWeek, 12.5);
  assert.equal(parsed.metrics[4].weekOverWeek, null);
  assert.equal(parsed.protocolCount, 7);
  const tripled = parseBreakdown({ ...breakdown, metrics: [metric('tvl', 0.2, { ratio: 3, index: 150, contribution: 30 }), ...breakdown.metrics.slice(1)] });
  assert.equal(tripled.metrics[2].index, 150, 'a component above 100 is valid');
  const minimum = parseBreakdown({ ...breakdown, metrics: [...breakdown.metrics.slice(0, 4), metric('contracts', 0.25, { baselineValue: 7, baselineRule: 'minimum', observedBaselineDailyMean: 0 })] });
  assert.equal(minimum.metrics[1].baselineRule, 'minimum');
  assert.equal(parseBreakdown({ ...breakdown, metrics: breakdown.metrics.slice(1) }), null);
  assert.equal(parseBreakdown({ ...breakdown, metrics: [...breakdown.metrics.slice(1), metric('commits', 0.1)] }), null);
  assert.equal(parseBreakdown({ ...breakdown, metrics: [metric('tvl', 0.3), ...breakdown.metrics.slice(1)] }), null);
  assert.equal(parseBreakdown({ ...breakdown, metrics: [metric('tvl', 0.2, { baselineValue: 0 }), ...breakdown.metrics.slice(1)] }), null, 'a zero baseline is never divided by');
  assert.equal(parseBreakdown({ ...breakdown, metrics: [metric('tvl', 0.2, { ratio: -1 }), ...breakdown.metrics.slice(1)] }), null);
  assert.equal(parseBreakdown({ ...breakdown, metrics: [metric('tvl', 0.2, { baselineRule: 'guessed' }), ...breakdown.metrics.slice(1)] }), null);
  assert.equal(parseBreakdown({ ...breakdown, normalization: 'since-collection-causal-high' }), null);
});

test('chart geometry spans the plot and closes the area on zero', () => {
  const points = plotPoints(history.series);
  assert.deepEqual(points.map(p => p.x), [0, 50, 100]);
  assert.ok(Math.abs(points[2].y - 54.9) < 1e-9);
  assert.match(areaPath(points), /L100 100 L0 100 Z$/);
  assert.equal(nearestIndex(points, 70), 1);
  assert.equal(nearestIndex(points, 90), 2);
  assert.deepEqual(axisDays(history.series).map(d => d.date), ['2026-09-24', '2026-09-25', '2026-09-26']);
  assert.equal(plotPoints([{ date: '2026-09-26', score: 45 }])[0].x, 100);
});

test('the chart scale always shows the baseline and grows with scores above 100', () => {
  assert.deepEqual(scaleFor([43.4, 45.1]), { max: 60, ticks: [20, 40] });
  assert.deepEqual(scaleFor([56.3, 197.5]), { max: 250, ticks: [50, 100, 150, 200] });
  assert.deepEqual(scaleFor([382.3]), { max: 500, ticks: [100, 200, 300, 400] });
  assert.deepEqual(scaleFor([0]), { max: 60, ticks: [20, 40] }, 'a verified zero still shows the baseline');
  for (const scores of [[12], [99.9, 100.1], [150, 40], [1234.5]]) {
    const { max, ticks } = scaleFor(scores);
    assert.ok(max > Math.max(50, ...scores), `${scores} fits below the top`);
    assert.ok(ticks.length >= 1 && ticks.length <= 5 && ticks.every(t => t > 0 && t < max));
  }
  const points = plotPoints([{ date: '2026-09-25', score: 50 }, { date: '2026-09-26', score: 150 }], 250);
  assert.deepEqual(points.map(p => p.y), [80, 40]);
  assert.equal(yFor(300, 250), 0, 'clamped to the plot box');
});

test('changes and baseline comparisons never rely on colour alone', () => {
  assert.deepEqual(formatChange(3.44, 1), { arrow: '▲', magnitude: '3.4', direction: 'up' });
  assert.deepEqual(formatChange(-21.3, 1), { arrow: '▼', magnitude: '21.3', direction: 'down' });
  assert.equal(formatChange(0.04, 1).direction, 'flat');
  assert.equal(formatChange(null, 1).magnitude, '—');
  assert.equal(baselineComparison(100).text, '100% above baseline');
  assert.equal(baselineComparison(25).text, '50% below baseline');
  assert.equal(baselineComparison(0).text, '100% below baseline');
  assert.equal(ratioTone(1), 'growth');
  assert.equal(ratioTone(0.99), 'recovery');
  assert.equal(formatRatio(1.2857), '1.29×');
});

test('dates render with fixed English month abbreviations', async () => {
  const { formatDay } = await import('../lib/metrics.ts');
  assert.equal(formatDay('2026-09-26'), '26 Sep 2026');
  assert.equal(formatDay('2026-06-29', false), '29 Jun');
});

test('public JSON never carries more than the whole-number score', () => {
  assert.equal(publicSummary(publishedIndex(today(67.6))).score, 68);
  assert.equal(publicSummary(publishedIndex(today(112.5))).score, 113);
});

test('protocol count groups registry components by protocol', async () => {
  const { protocolCount } = await import('../lib/pro-data.ts');
  const registry = { protocols: [{ id: 'mercatus-amm', status: 'included' }, { id: 'mercatus-staking', status: 'included' }, { id: 'kdswap-amm', status: 'included' }, { id: 'old-dex', status: 'excluded' }] };
  assert.equal(protocolCount(registry), 2);
  assert.equal(protocolCount({}), null);
});

test('breakdown requires a positive KDA price for the USD display', () => {
  assert.equal(parseBreakdown({ ...breakdown, kdaUsd: 0 }), null);
  assert.equal(parseBreakdown({ ...breakdown, kdaUsd: 0.0114 }).kdaUsd, 0.0114);
});

test('public index is cached so page views cannot exhaust the API rate limit', async () => {
  const { getPublicIndex, resetPublicIndexCache } = await import('../lib/public-index.ts');
  const original = globalThis.fetch, origin = process.env.KCE_API_ORIGIN;
  let calls = 0;
  globalThis.fetch = async () => { calls++; return new Response(JSON.stringify(today(45)), { status: 200 }); };
  process.env.KCE_API_ORIGIN = 'http://127.0.0.1:3001';
  try {
    resetPublicIndexCache();
    const results = await Promise.all([getPublicIndex(), getPublicIndex(), getPublicIndex()]);
    await getPublicIndex();
    assert.equal(calls, 1);
    assert.ok(results.every(r => r.score === 45));
  } finally {
    globalThis.fetch = original; resetPublicIndexCache();
    if (origin === undefined) delete process.env.KCE_API_ORIGIN; else process.env.KCE_API_ORIGIN = origin;
  }
});

test('during an outage every request keeps the last verified reading', async () => {
  const { getPublicIndex, resetPublicIndexCache } = await import('../lib/public-index.ts');
  const original = globalThis.fetch, origin = process.env.KCE_API_ORIGIN, realNow = Date.now;
  let now = 1_000_000, up = true;
  Date.now = () => now;
  globalThis.fetch = async () => { if (!up) throw new Error('down'); return new Response(JSON.stringify(today(45)), { status: 200 }); };
  process.env.KCE_API_ORIGIN = 'http://127.0.0.1:3001';
  try {
    resetPublicIndexCache();
    assert.equal((await getPublicIndex()).score, 45);
    up = false;
    for (const t of [61_000, 62_000, 67_000, 75_000, 300_000]) { now = 1_000_000 + t; assert.equal((await getPublicIndex()).score, 45, `at +${t}ms`); }
    now = 1_000_000 + 11 * 60_000;
    assert.equal((await getPublicIndex()).state, 'unavailable');
  } finally {
    globalThis.fetch = original; Date.now = realNow; resetPublicIndexCache();
    if (origin === undefined) delete process.env.KCE_API_ORIGIN; else process.env.KCE_API_ORIGIN = origin;
  }
});
