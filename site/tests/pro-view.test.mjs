import { test } from 'node:test';
import assert from 'node:assert/strict';
import { publicSummary, publishedIndex } from '../lib/public-index.ts';
import { getProData, parseBreakdown, parseHistory, rangeFrom } from '../lib/pro-data.ts';
import { SITE_KEY, TOKEN, stubBackend } from './accounts-stub.mjs';
import { areaPath, axisDays, nearestIndex, plotPoints, scaleFor, yFor } from '../lib/chart-geometry.ts';
import { baselineComparison, formatChange, formatRatio, ratioTone } from '../lib/metrics.ts';

const meta = { collectionStart: '2026-06-29', summaryRetention: 'permanent', normalization: 'fixed-baseline-first-30-days' };
const baselineMetric = (kind, perWindow, observedDailyMean, rule = 'observed') => ({ kind, perWindow, dailyMean: kind === 'count' ? perWindow / 7 : perWindow, observedDailyMean, rule });
const baseline = { fromDay: '2026-06-29', throughDay: '2026-07-28', days: 30, level: 50, metrics: {
  addresses: baselineMetric('average', 374.9, 374.9), contracts: baselineMetric('count', 7, 0.4667, 'minimum'),
  tvl: baselineMetric('average', 13222255.08, 13222255.08), hashrate: baselineMetric('average', 15.22, 15.22), commits: baselineMetric('count', 7, 0.8, 'minimum') } };
const today = (score, extra = {}) => ({ state: 'current', date: '2026-09-26', score, ...meta, baseline, ...extra });
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

test('without a session no Pro data is requested at all', async () => {
  const original = globalThis.fetch, origin = process.env.KCE_API_ORIGIN, key = process.env.KCE_SITE_KEY;
  let calls = 0;
  globalThis.fetch = () => { calls++; throw new Error('a free visitor must not trigger a Pro request'); };
  process.env.KCE_API_ORIGIN = 'http://127.0.0.1:3001'; process.env.KCE_SITE_KEY = SITE_KEY;
  try {
    for (const range of ['30d', '90d', '1y', 'all']) assert.equal(await getProData(range, null, '203.0.113.7'), null);
    assert.equal(calls, 0);
  } finally {
    globalThis.fetch = original;
    if (origin === undefined) delete process.env.KCE_API_ORIGIN; else process.env.KCE_API_ORIGIN = origin;
    if (key === undefined) delete process.env.KCE_SITE_KEY; else process.env.KCE_SITE_KEY = key;
  }
});

test('history ranges: 1Y is a real range now; unknown values fall back to 30D', () => {
  assert.equal(rangeFrom('90d'), '90d');
  assert.equal(rangeFrom('all'), 'all');
  assert.equal(rangeFrom('1y'), '1y');
  assert.equal(rangeFrom('2y'), '30d');
  assert.equal(rangeFrom(['1y']), '30d');
  assert.equal(rangeFrom(undefined), '30d');
});

test('1Y is offered only when the backend says a full year exists', () => {
  assert.deepEqual(parseHistory({ ...history, availableRanges: { '30d': true, '90d': true, all: true, '1y': false } }).availableRanges, { '30d': true, '90d': true, all: true, '1y': false });
  assert.equal(parseHistory({ ...history, availableRanges: { '30d': true, '90d': true, all: true, '1y': true } }).availableRanges['1y'], true);
  assert.equal(parseHistory(history).availableRanges['1y'], false, 'missing availableRanges keeps 1Y off');
  assert.equal(parseHistory({ ...history, availableRanges: { '1y': 'yes' } }).availableRanges['1y'], false, 'only an explicit true counts');
  const year = parseHistory({ ...history, range: '1y', availableRanges: { '30d': true, '90d': true, all: true, '1y': true } });
  assert.equal(year.range, '1y');
  assert.equal(year.availableRanges['1y'], true);
  assert.equal(parseHistory({ ...history, range: '2y' }), null);
});

const proBackend = (overrides = {}) => stubBackend(({ path }) => {
  if (overrides[path]) return overrides[path];
  if (path.startsWith('/index/history')) return { json: { ...history, range: new URL(path, 'http://x').searchParams.get('range'), availableRanges: { '30d': true, '90d': true, all: true, '1y': false } } };
  if (path === '/metrics/breakdown') return { json: breakdown };
  if (path === '/protocols') return { json: { protocols: [{ id: 'kdswap-amm', status: 'included' }] } };
  return { status: 404, json: { error: 'not_found' } };
});

test('subscriber Pro data is requested with the session and the visitor IP', async () => {
  const backend = await proBackend();
  try {
    const data = await getProData('90d', TOKEN, '203.0.113.7');
    assert.equal(data.history.range, '90d');
    assert.equal(data.breakdown.protocolCount, 1);
    const pro = backend.requests.filter(r => r.path !== '/protocols');
    assert.deepEqual(pro.map(r => r.path).sort(), ['/index/history?range=90d', '/metrics/breakdown']);
    for (const r of backend.requests) {
      assert.equal(r.headers['x-kce-site-key'], SITE_KEY);
      assert.equal(r.headers['x-kce-client-ip'], '203.0.113.7');
    }
    for (const r of pro) assert.equal(r.headers['x-kce-session'], TOKEN);
    assert.equal(backend.requests.find(r => r.path === '/protocols').headers['x-kce-session'], undefined, 'the public registry needs no session');
  } finally { await backend.close(); }
});

test('1Y before a full year of history falls back to 30D', async () => {
  const backend = await proBackend({ '/index/history?range=1y': { status: 400, json: { error: 'range_not_available', range: '1y', requiredDays: 365, availableDays: 93 } } });
  try {
    const data = await getProData('1y', TOKEN, '203.0.113.7');
    assert.equal(data.history.range, '30d');
    assert.equal(data.history.availableRanges['1y'], false);
    assert.deepEqual(backend.requests.filter(r => r.path.startsWith('/index/history')).map(r => r.path), ['/index/history?range=1y', '/index/history?range=30d']);
  } finally { await backend.close(); }
});

test('1Y is served once the backend has a full year', async () => {
  const backend = await proBackend({ '/index/history?range=1y': { json: { ...history, range: '1y', availableRanges: { '30d': true, '90d': true, all: true, '1y': true } } } });
  try {
    const data = await getProData('1y', TOKEN, '203.0.113.7');
    assert.equal(data.history.range, '1y');
    assert.equal(data.history.availableRanges['1y'], true);
  } finally { await backend.close(); }
});

test('Pro data is null when the subscription is refused, a part is missing or the days disagree', async () => {
  for (const overrides of [
    { '/index/history?range=30d': { status: 403, json: { error: 'subscription_required' } } },
    { '/metrics/breakdown': { status: 401, json: { error: 'session_required' } } },
    { '/metrics/breakdown': { json: { ...breakdown, date: '2026-09-25' } } },
    { '/index/history?range=90d': { status: 400, json: { error: 'invalid_range' } } },
    { '/index/history?range=30d': { status: 400, json: { error: 'range_not_available' } } },
  ]) {
    const backend = await proBackend(overrides);
    try {
      const range = Object.keys(overrides)[0].includes('90d') ? '90d' : '30d';
      assert.equal(await getProData(range, TOKEN, '203.0.113.7'), null, JSON.stringify(overrides));
    } finally { await backend.close(); }
  }
  const backend = await proBackend({ '/protocols': { status: 503, json: { error: 'temporarily_unavailable' } } });
  try { assert.equal((await getProData('30d', TOKEN, '203.0.113.7')).breakdown.protocolCount, null, 'the registry is optional'); }
  finally { await backend.close(); }
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
