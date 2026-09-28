import { Y_TICKS, yFor } from '../lib/chart-geometry';

// Horizontal gridlines with labels; optionally the fixed baseline (50) as a reference line, labelled in the axis
// gutter so the series never runs through the label. The chart header carries the matching legend.
export default function ChartGrid({ ticks = [...Y_TICKS], max = 100, baseline }: { ticks?: number[]; max?: number; baseline?: number }) {
  return <div className="chart-grid" aria-hidden="true">
    {ticks.filter(t => t !== baseline).map(t => <div className="gridline" key={t} style={{ top: `${yFor(t, max)}%` }}><span>{t}</span></div>)}
    {baseline !== undefined && <div className="chart-baseline" style={{ top: `${yFor(baseline, max)}%` }}><span>{baseline}</span></div>}
  </div>;
}
