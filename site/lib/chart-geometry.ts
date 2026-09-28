// Pure geometry for the history chart. Coordinates are percentages of the plot box,
// so the SVG can stretch to any width while labels stay as real text.
export const Y_TICKS = [20, 40, 60, 80] as const;
export type SeriesPoint = { date: string; score: number };
export type PlotPoint = SeriesPoint & { x: number; y: number };
export type Scale = { max: number; ticks: number[] };

const dayMs = (day: string) => Date.parse(day + 'T00:00:00Z');
const r = (value: number) => Math.round(value * 100) / 100;
const STEPS = [10, 20, 25, 50, 100, 200, 250, 500, 1000];

/** The index has no ceiling: the axis runs from 0 to a round number above both the highest score and the baseline. */
export function scaleFor(scores: number[], baseline = 50): Scale {
  const top = Math.max(baseline, ...scores) * 1.1;
  const step = STEPS.find(s => top / s <= 5) ?? Math.ceil(top / 5000) * 1000;
  const max = Math.max(step, Math.ceil(top / step) * step), ticks: number[] = [];
  for (let t = step; t < max; t += step) ticks.push(t);
  return { max, ticks };
}
export const yFor = (score: number, max = 100): number => 100 - Math.min(100, Math.max(0, score / max * 100));

export function plotPoints<T extends SeriesPoint>(series: T[], max = 100): (T & { x: number; y: number })[] {
  if (!series.length) return [];
  const first = dayMs(series[0].date), span = dayMs(series[series.length - 1].date) - first;
  return series.map(p => ({ ...p, x: span > 0 ? (dayMs(p.date) - first) / span * 100 : 100, y: yFor(p.score, max) }));
}

export const linePath = (points: PlotPoint[]): string => points.map((p, i) => `${i ? 'L' : 'M'}${r(p.x)} ${r(p.y)}`).join(' ');

export function areaPath(points: PlotPoint[]): string {
  if (!points.length) return '';
  return `${linePath(points)} L${r(points[points.length - 1].x)} 100 L${r(points[0].x)} 100 Z`;
}

export function nearestIndex(points: PlotPoint[], x: number): number {
  let best = 0;
  for (let i = 1; i < points.length; i++) if (Math.abs(points[i].x - x) < Math.abs(points[best].x - x)) best = i;
  return best;
}

// First, middle and last dates of the selected range.
export function axisDays(series: SeriesPoint[]): { date: string; x: number }[] {
  const points = plotPoints(series);
  if (points.length < 3) return points.map(({ date, x }) => ({ date, x }));
  return [points[0], points[Math.floor((points.length - 1) / 2)], points[points.length - 1]].map(({ date, x }) => ({ date, x }));
}
