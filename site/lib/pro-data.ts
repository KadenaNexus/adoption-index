import { backendFetch } from './backend.ts';
import { BASELINE_LEVEL, COLLECTION_START, NORMALIZATION } from './preview-state.ts';
import { METRICS, type MetricId } from './metrics.ts';
import { record, type Payload } from './payload.ts';

// Pro history and breakdown come from the backend's Pro endpoints, requested with the subscriber's session.
// Only the home page asks for them, and only after the account shows an active subscription.

export const HISTORY_RANGES = [
  { id: '30d', label: '30D' }, { id: '90d', label: '90D' }, { id: '1y', label: '1Y' }, { id: 'all', label: 'ALL' },
] as const;
export type HistoryRangeId = typeof HISTORY_RANGES[number]['id'];
const RANGE_IDS: readonly string[] = HISTORY_RANGES.map(r => r.id);
export const rangeFrom = (value: unknown): HistoryRangeId => typeof value === 'string' && RANGE_IDS.includes(value) ? value as HistoryRangeId : '30d';
/** 1Y is offered only once the backend reports a full year of verified history. */
export type AvailableRanges = Record<HistoryRangeId, boolean>;

export type HistoryPoint = { date: string; score: number; windowDays: number };
export type ProHistory = { range: HistoryRangeId; fromDay: string; throughDay: string; series: HistoryPoint[]; availableRanges: AvailableRanges };
/** One input against its fixed baseline: current value, baseline in the matching unit, ratio and contribution. */
export type ProMetric = { id: MetricId; kind: 'average' | 'count'; value: number; windowDays: number; baselineValue: number; baselineRule: 'observed' | 'minimum'; observedBaselineDailyMean: number; ratio: number; index: number; weight: number; contribution: number; weekOverWeek: number | null };
export type ProBreakdown = { date: string; metrics: ProMetric[]; kdaUsd: number; protocolCount: number | null };
export type ProData = { history: ProHistory; breakdown: ProBreakdown };

const finite = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value);
const isDay = (value: unknown): value is string => typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value) && value >= COLLECTION_START;
const fixedStart = (p: Payload) => p.collectionStart === COLLECTION_START && p.summaryRetention === 'permanent' && p.normalization === NORMALIZATION;

export function parseHistory(payload: unknown): ProHistory | null {
  const p = record(payload);
  if (!p || !fixedStart(p) || p.baselineLevel !== BASELINE_LEVEL || !RANGE_IDS.includes(String(p.range)) || !isDay(p.fromDay) || !isDay(p.throughDay) || !Array.isArray(p.series)) return null;
  const series: HistoryPoint[] = [];
  for (const item of p.series) {
    const row = record(item);
    // No ceiling: the fixed-baseline index can exceed 100.
    if (!row || !isDay(row.date) || !finite(row.score) || row.score < 0 || !Number.isInteger(row.windowDays) || Number(row.windowDays) < 1 || Number(row.windowDays) > 7) return null;
    if (series.length && row.date <= series[series.length - 1].date) return null;
    series.push({ date: row.date, score: row.score, windowDays: Number(row.windowDays) });
  }
  if (!series.length || series[0].date < p.fromDay || series[series.length - 1].date !== p.throughDay) return null;
  const range = p.range as HistoryRangeId, offered = record(p.availableRanges);
  // The shorter ranges always exist; 1Y needs the backend's explicit `true` (or a 1Y reply itself).
  const availableRanges: AvailableRanges = { '30d': true, '90d': true, all: true, '1y': range === '1y' || offered?.['1y'] === true };
  return { range, fromDay: p.fromDay, throughDay: p.throughDay, series, availableRanges };
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

type Fetched = { status: number; data: unknown };
/**
 * History (for `range`), breakdown and the protocol registry for a signed-in subscriber, or null if any part is
 * missing or inconsistent. Without a session nothing is requested. A 1Y request before a full year of history
 * exists falls back to 30D.
 */
export async function getProData(range: HistoryRangeId, sessionToken: string | null, clientIp: string): Promise<ProData | null> {
  if (!sessionToken) return null;
  const options = { session: sessionToken, clientIp, timeoutMs: 5000 };
  const history = (selected: HistoryRangeId): Promise<Fetched> => backendFetch(`/index/history?range=${selected}`, options);
  const [first, breakdown, registry] = await Promise.all([history(range), backendFetch('/metrics/breakdown', options), backendFetch('/protocols', { clientIp, timeoutMs: 5000 })]);
  const notYet = range !== '30d' && first.status === 400 && record(first.data)?.error === 'range_not_available';
  const reply = notYet ? await history('30d') : first;
  if (reply.status !== 200 || breakdown.status !== 200) return null;
  const parsedHistory = parseHistory(reply.data), parsedBreakdown = parseBreakdown(breakdown.data, registry.status === 200 ? protocolCount(registry.data) : null);
  return parsedHistory && parsedBreakdown && parsedHistory.throughDay === parsedBreakdown.date ? { history: parsedHistory, breakdown: parsedBreakdown } : null;
}
