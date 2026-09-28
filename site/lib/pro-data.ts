import { BASELINE_LEVEL, COLLECTION_START, NORMALIZATION } from './preview-state.ts';
import { METRICS, type MetricId } from './metrics.ts';

// Pro history and breakdown come only from the backend's API-key protected endpoints.
// Subscriber sign-in and entitlements are not implemented, so the subscriber view is
// available solely as a local development preview; production never requests Pro data.

export const HISTORY_RANGES = [
  { id: '30d', label: '30D' }, { id: '90d', label: '90D' }, { id: '1y', label: '1Y' }, { id: 'all', label: 'ALL' },
] as const;
export type HistoryRangeId = '30d' | '90d' | 'all';
// 1Y stays unavailable until a full year of verified history exists.
export const rangeFrom = (value: unknown): HistoryRangeId => value === '90d' || value === 'all' ? value : '30d';

export type HistoryPoint = { date: string; score: number; windowDays: number };
export type ProHistory = { range: HistoryRangeId; fromDay: string; throughDay: string; series: HistoryPoint[] };
/** One input against its fixed baseline: current value, baseline in the matching unit, ratio and contribution. */
export type ProMetric = { id: MetricId; kind: 'average' | 'count'; value: number; windowDays: number; baselineValue: number; baselineRule: 'observed' | 'minimum'; observedBaselineDailyMean: number; ratio: number; index: number; weight: number; contribution: number; weekOverWeek: number | null };
export type ProBreakdown = { date: string; metrics: ProMetric[]; kdaUsd: number; protocolCount: number | null };
export type ProData = { history: ProHistory; breakdown: ProBreakdown };

type Payload = Record<string, unknown>;
const record = (value: unknown): Payload | null => value && typeof value === 'object' && !Array.isArray(value) ? value as Payload : null;
const finite = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value);
const isDay = (value: unknown): value is string => typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value) && value >= COLLECTION_START;
const fixedStart = (p: Payload) => p.collectionStart === COLLECTION_START && p.summaryRetention === 'permanent' && p.normalization === NORMALIZATION;

export function parseHistory(payload: unknown): ProHistory | null {
  const p = record(payload);
  if (!p || !fixedStart(p) || p.baselineLevel !== BASELINE_LEVEL || !['30d', '90d', 'all'].includes(String(p.range)) || !isDay(p.fromDay) || !isDay(p.throughDay) || !Array.isArray(p.series)) return null;
  const series: HistoryPoint[] = [];
  for (const item of p.series) {
    const row = record(item);
    // No ceiling: the fixed-baseline index can exceed 100.
    if (!row || !isDay(row.date) || !finite(row.score) || row.score < 0 || !Number.isInteger(row.windowDays) || Number(row.windowDays) < 1 || Number(row.windowDays) > 7) return null;
    if (series.length && row.date <= series[series.length - 1].date) return null;
    series.push({ date: row.date, score: row.score, windowDays: Number(row.windowDays) });
  }
  if (!series.length || series[0].date < p.fromDay || series[series.length - 1].date !== p.throughDay) return null;
  return { range: p.range as HistoryRangeId, fromDay: p.fromDay, throughDay: p.throughDay, series };
}

export function parseBreakdown(payload: unknown, protocolCount: number | null = null): ProBreakdown | null {
  const p = record(payload);
  if (!p || !fixedStart(p) || !isDay(p.date) || !Array.isArray(p.metrics) || !finite(p.kdaUsd) || p.kdaUsd <= 0) return null;
  const byId = new Map<MetricId, ProMetric>();
  for (const item of p.metrics) {
    const m = record(item);
    const spec = m && METRICS.find(s => s.id === m.id);
    if (!m || !spec || byId.has(spec.id) || !['average', 'count'].includes(String(m.kind)) || !finite(m.rawValue) || m.rawValue < 0
      || !finite(m.baselineValue) || m.baselineValue <= 0 || !finite(m.ratio) || m.ratio < 0 || !finite(m.index) || m.index < 0
      || !finite(m.contribution) || !finite(m.observedBaselineDailyMean) || m.observedBaselineDailyMean < 0 || !['observed', 'minimum'].includes(String(m.baselineRule))
      || !Number.isInteger(m.windowDays) || m.weight !== spec.weight) return null;
    const percent = record(m.weekOverWeek)?.percent;
    byId.set(spec.id, { id: spec.id, kind: m.kind as ProMetric['kind'], value: m.rawValue, windowDays: Number(m.windowDays), baselineValue: m.baselineValue,
      baselineRule: m.baselineRule as ProMetric['baselineRule'], observedBaselineDailyMean: m.observedBaselineDailyMean, ratio: m.ratio, index: m.index,
      weight: spec.weight, contribution: m.contribution, weekOverWeek: finite(percent) ? percent : null });
  }
  if (byId.size !== METRICS.length) return null;
  return { date: p.date, metrics: METRICS.map(s => byId.get(s.id)!), kdaUsd: p.kdaUsd, protocolCount };
}

// Registry entries are protocol components (Mercatus has pools and staking); ids share the protocol prefix.
export function protocolCount(registry: unknown): number | null {
  const protocols = record(registry)?.protocols;
  if (!Array.isArray(protocols)) return null;
  const ids = protocols.map(record).filter(p => p && p.status === 'included' && typeof p.id === 'string').map(p => String(p!.id).split('-')[0]);
  return ids.length ? new Set(ids).size : null;
}

type Env = Record<string, string | undefined>;
// Never in a production build or server: there is no subscriber authentication yet. The literal
// process.env.NODE_ENV check is inlined by the production build, so no runtime variable can reopen it.
export function proPreviewEnabled(env: Env = process.env): boolean {
  if (process.env.NODE_ENV === 'production') return false;
  return env.NODE_ENV !== 'production' && env.KCE_PRO_PREVIEW === '1' && !!env.KCE_API_ORIGIN && (env.KCE_API_KEY?.length ?? 0) >= 32;
}

async function getJson(origin: string, path: string, key?: string): Promise<unknown> {
  const url = new URL(path, origin);
  if (!['http:', 'https:'].includes(url.protocol)) return null;
  const response = await fetch(url, { cache: 'no-store', signal: AbortSignal.timeout(5000), headers: key ? { 'X-API-Key': key } : {} });
  return response.ok ? response.json() : null;
}

export async function getProPreview(range: HistoryRangeId, env: Env = process.env): Promise<ProData | null> {
  if (!proPreviewEnabled(env)) return null;
  const origin = env.KCE_API_ORIGIN!, key = env.KCE_API_KEY!;
  try {
    const [history, breakdown, registry] = await Promise.all([
      getJson(origin, `/index/history?range=${range}`, key), getJson(origin, '/metrics/breakdown', key), getJson(origin, '/protocols'),
    ]);
    const parsedHistory = parseHistory(history), parsedBreakdown = parseBreakdown(breakdown, protocolCount(registry));
    return parsedHistory && parsedBreakdown && parsedHistory.throughDay === parsedBreakdown.date ? { history: parsedHistory, breakdown: parsedBreakdown } : null;
  } catch { return null; }
}
