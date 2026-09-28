import type { PublicIndex } from '../db/store';
export const INITIAL_HISTORY_DAYS = 90;
export const COLLECTION_START = '2026-06-29';
/** Fixed baseline: the first 30 collected days score 50. */
export const BASELINE_THROUGH = '2026-07-28';
export const BASELINE_LEVEL = 50;
export const NORMALIZATION = 'fixed-baseline-first-30-days';
export function collectionPeriod(now = new Date()) {
  const end = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()) - 86_400_000);
  const start = new Date(COLLECTION_START + 'T00:00:00Z');
  const label = (date: Date) => date.toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' });
  return { start: COLLECTION_START, end: end.toISOString().slice(0, 10), startLabel: label(start), endLabel: label(end), historyDays: Math.max(0, Math.round((end.getTime() - start.getTime()) / 86_400_000) + 1) };
}
// No fallback observations. Only a fully verified backend publication may populate the index.
export const emptyIndex: PublicIndex = {
  state: 'pending', day: null, score: null, baseline: null, sevenDay: null,
  thirtyDay: null, updatedAt: null,
  message: 'The initial 90-day history is awaiting verification. No score is published.',
};
