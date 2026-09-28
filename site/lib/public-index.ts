import type { Baseline, BaselineMetric, PublicIndex } from '../db/store';
import { BASELINE_LEVEL, BASELINE_THROUGH, COLLECTION_START, NORMALIZATION, emptyIndex } from './preview-state.ts';

const METRIC_IDS = ['addresses', 'contracts', 'tvl', 'hashrate', 'commits'] as const;
const finite = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value);
export function parseBaseline(value: unknown): Baseline | null {
  if (!value || typeof value !== 'object') return null;
  const b = value as Record<string, unknown>, metrics = b.metrics as Record<string, Record<string, unknown>> | undefined;
  if (b.fromDay !== COLLECTION_START || b.throughDay !== BASELINE_THROUGH || b.level !== BASELINE_LEVEL || !metrics || typeof metrics !== 'object') return null;
  const parsed: Partial<Baseline['metrics']> = {};
  for (const id of METRIC_IDS) {
    const m = metrics[id];
    if (!m || !['average', 'count'].includes(String(m.kind)) || !finite(m.perWindow) || m.perWindow <= 0 || !finite(m.observedDailyMean) || m.observedDailyMean < 0 || !['observed', 'minimum'].includes(String(m.rule))) return null;
    parsed[id] = { kind: m.kind as BaselineMetric['kind'], perWindow: m.perWindow, observedDailyMean: m.observedDailyMean, rule: m.rule as BaselineMetric['rule'] };
  }
  return { fromDay: COLLECTION_START, throughDay: BASELINE_THROUGH, level: BASELINE_LEVEL, metrics: parsed as Baseline['metrics'] };
}

export function publishedIndex(payload: unknown): PublicIndex | null {
  if (!payload || typeof payload !== 'object') return null;
  const p = payload as Record<string, unknown>;
  const baseline = parseBaseline(p.baseline);
  // Fixed-baseline index: no ceiling, never negative.
  if (!['current', 'stale'].includes(String(p.state)) || typeof p.date !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(p.date)
    || p.date < COLLECTION_START || p.collectionStart !== COLLECTION_START || p.summaryRetention !== 'permanent'
    || p.normalization !== NORMALIZATION || !finite(p.score) || p.score < 0 || !baseline) return null;
  const changes = p.changes && typeof p.changes === 'object' ? p.changes as Record<string, unknown> : {};
  const delta = (value: unknown) => finite(value) ? value : null;
  return { state: p.state === 'current' ? 'ready' : 'stale', day: p.date, score: p.score, baseline,
    sevenDay: delta(changes.sevenDay), thirtyDay: delta(changes.thirtyDay), updatedAt: typeof p.updatedAt === 'string' ? p.updatedAt : null,
    message: p.state === 'stale' ? 'Last verified reading. The next update is awaiting validation.' : 'Five verified inputs. Daily summaries retained since 29 June 2026.' };
}
// Free visitors get the score and the fixed baseline only; 7-day and 30-day change are Pro. An allowlist keeps new fields private by default.
export function publicSummary({ state, day, score, baseline, updatedAt, message }: PublicIndex): Omit<PublicIndex, 'sevenDay' | 'thirtyDay'> {
  return { state, day, score: score === null ? null : Math.round(score), baseline, updatedAt, message };
}

// The index changes once a day. Caching (per server bundle) keeps page views from exhausting the
// API's per-IP rate limit (every request arrives from 127.0.0.1), and a brief outage keeps showing
// the last verified reading for a few minutes instead of blanking it.
const FRESH_MS = 60_000, RETRY_MS = 10_000, LAST_GOOD_MS = 10 * 60_000;
let cached: { index: PublicIndex; until: number } | null = null;
let lastGood: { index: PublicIndex; at: number } | null = null;
let inflight: Promise<PublicIndex> | null = null;
export function resetPublicIndexCache() { cached = null; lastGood = null; inflight = null; }

export async function getPublicIndex(): Promise<PublicIndex> {
  if (cached && Date.now() < cached.until) return cached.index;
  inflight ??= fetchPublicIndex().finally(() => { inflight = null; });
  const index = await inflight, now = Date.now();
  if (index.state !== 'unavailable') {
    cached = { index, until: now + FRESH_MS };
    lastGood = index.score === null ? null : { index, at: now };
    return index;
  }
  const fallback = lastGood && now - lastGood.at < LAST_GOOD_MS ? lastGood.index : index;
  cached = { index: fallback, until: now + RETRY_MS };
  return fallback;
}

async function fetchPublicIndex(): Promise<PublicIndex> {
  const origin = process.env.KCE_API_ORIGIN;
  if (!origin) return emptyIndex;
  try {
    const endpoint = new URL('/index/today', origin);
    if (!['http:', 'https:'].includes(endpoint.protocol)) return { ...emptyIndex, state: 'unavailable', message: 'The data service is temporarily unavailable.' };
    const response = await fetch(endpoint, { cache: 'no-store', signal: AbortSignal.timeout(5000) });
    const payload: unknown = await response.json();
    if (response.status === 503 && payload && typeof payload === 'object' && 'error' in payload && payload.error === 'index_not_ready') return emptyIndex;
    const index = response.ok ? publishedIndex(payload) : null;
    return index ?? { ...emptyIndex, state: 'unavailable', message: 'The data service is temporarily unavailable.' };
  } catch { return { ...emptyIndex, state: 'unavailable', message: 'The data service is temporarily unavailable.' }; }
}
