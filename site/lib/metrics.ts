// The five published index inputs, in display order. Weights mirror the backend formula.
export const METRICS = [
  { id: 'addresses', label: 'Active addresses', weight: 0.3 },
  { id: 'contracts', label: 'New contracts deployed', weight: 0.25 },
  { id: 'tvl', label: 'TVL', weight: 0.2 },
  { id: 'hashrate', label: 'Network hashrate', weight: 0.15 },
  { id: 'commits', label: 'GitHub commits', weight: 0.1 },
] as const;
export type MetricId = typeof METRICS[number]['id'];

export type Tone = 'declining' | 'recovery' | 'growth' | 'pending';
export const BASELINE_LEVEL = 50;
/** Position against the fixed baseline (50). Derived from the score itself; there are no peak-based bands. */
export function baselineComparison(score: number): { text: string; tone: Tone } {
  const percent = Math.round((score / BASELINE_LEVEL - 1) * 100);
  if (percent === 0) return { text: 'At baseline', tone: 'pending' };
  return percent > 0 ? { text: `${percent}% above baseline`, tone: 'growth' } : { text: `${-percent}% below baseline`, tone: 'declining' };
}
/** A component at or above its baseline reads green; below reads amber. */
export const ratioTone = (ratio: number): Tone => ratio >= 1 ? 'growth' : 'recovery';
export const formatRatio = (ratio: number): string => `${ratio.toFixed(2)}×`;

const compact = new Intl.NumberFormat('en-US', { notation: 'compact', maximumFractionDigits: 1 });
export const formatCount = (value: number): string => Math.round(value).toLocaleString('en-US');
export const formatAmount = (value: number): string => Number.isInteger(value) ? value.toLocaleString('en-US') : Number(value.toFixed(value < 10 ? 2 : 1)).toLocaleString('en-US');
export const formatUsd = (value: number): string => '$' + compact.format(value);
export const formatKda = (value: number): string => compact.format(value) + ' KDA';
export const formatHashrate = (value: number): string => `${value.toFixed(1)} PH/s`;
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
// Fixed three-letter months: locale data varies ("Sept") between Node and browser builds.
export const formatDay = (day: string, withYear = true): string => {
  const [year, month, date] = day.split('-').map(Number);
  return `${date} ${MONTHS[month - 1]}${withYear ? ' ' + year : ''}`;
};

// Change as an arrow plus magnitude, so direction never relies on colour alone.
export type Change = { arrow: '▲' | '▼' | ''; magnitude: string; direction: 'up' | 'down' | 'flat' | 'none' };
export function formatChange(value: number | null, digits: number): Change {
  if (value === null) return { arrow: '', magnitude: '—', direction: 'none' };
  const magnitude = Math.abs(value).toFixed(digits);
  if (Number(magnitude) === 0) return { arrow: '', magnitude, direction: 'flat' };
  return value > 0 ? { arrow: '▲', magnitude, direction: 'up' } : { arrow: '▼', magnitude, direction: 'down' };
}

