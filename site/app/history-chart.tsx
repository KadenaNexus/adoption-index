'use client';
import { useEffect, useRef, useState, type KeyboardEvent, type PointerEvent } from 'react';
import { areaPath, axisDays, linePath, nearestIndex, plotPoints, scaleFor, type SeriesPoint } from '../lib/chart-geometry';
import { BASELINE_LEVEL, formatDay } from '../lib/metrics';
import { proScore } from '../lib/score-display';
import ChartGrid from './chart-grid';

// endLabel names the last point: "Today" for a current reading, otherwise its date.
type Point = SeriesPoint & { windowDays?: number };
const windowNote = (p: Point) => p.windowDays && p.windowDays < 7 ? ` · ${p.windowDays}-day window` : '';

export default function HistoryChart({ series, endLabel }: { series: Point[]; endLabel: string }) {
  const scale = scaleFor(series.map(p => p.score), BASELINE_LEVEL);
  const points = plotPoints(series, scale.max);
  const [active, setActive] = useState<number | null>(null);
  const plot = useRef<HTMLDivElement>(null);
  // A tap keeps its reading visible; tapping anywhere else clears it.
  useEffect(() => {
    const clear = (event: globalThis.PointerEvent) => { if (!plot.current?.contains(event.target as Node)) setActive(null); };
    document.addEventListener('pointerdown', clear);
    return () => document.removeEventListener('pointerdown', clear);
  }, []);
  if (!points.length) return null;
  const last = points[points.length - 1];
  const shown = active === null ? null : points[active];
  const pick = (event: PointerEvent<HTMLDivElement>) => {
    const box = event.currentTarget.getBoundingClientRect();
    setActive(nearestIndex(points, (event.clientX - box.left) / box.width * 100));
  };
  const key = (event: KeyboardEvent<HTMLDivElement>) => {
    const step = { ArrowLeft: -1, ArrowRight: 1, Home: -points.length, End: points.length }[event.key];
    if (step === undefined) return;
    event.preventDefault();
    setActive(Math.min(points.length - 1, Math.max(0, (active ?? points.length - 1) + step)));
  };
  const first = series[0], days = axisDays(series);
  const summary = `Index history from ${formatDay(first.date)} to ${formatDay(last.date)}: ${proScore(first.score)} to ${proScore(last.score)} (baseline ${BASELINE_LEVEL}).`;
  return <figure className="chart">
    <ChartGrid ticks={scale.ticks} max={scale.max} baseline={BASELINE_LEVEL}/>
    <div ref={plot} className="chart-plot" tabIndex={0} role="group" aria-label={`${summary} Use the arrow keys to read daily values.`}
      onPointerMove={pick} onPointerDown={pick} onPointerLeave={event => { if (event.pointerType !== 'touch') setActive(null); }}
      onKeyDown={key} onBlur={() => setActive(null)}>
      <svg viewBox="0 0 100 100" preserveAspectRatio="none" aria-hidden="true">
        <defs><linearGradient id="history-fill" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stopColor="var(--crimson)" stopOpacity=".3"/><stop offset="1" stopColor="var(--crimson)" stopOpacity=".02"/></linearGradient></defs>
        <path d={areaPath(points)} fill="url(#history-fill)"/>
        <path d={linePath(points)} fill="none" stroke="var(--crimson)" strokeWidth="2.5" strokeLinejoin="round" strokeLinecap="round" vectorEffect="non-scaling-stroke"/>
      </svg>
      <span className={`chart-end-label ${last.y < 14 ? 'below' : ''}`} style={{ left: `${last.x}%`, top: `${last.y}%` }} aria-hidden="true">{endLabel}: {proScore(last.score)}</span>
      <span className="chart-dot" style={{ left: `${last.x}%`, top: `${last.y}%` }} aria-hidden="true"/>
      {shown && <>
        <span className="chart-crosshair" style={{ left: `${shown.x}%` }} aria-hidden="true"/>
        <span className="chart-dot chart-dot-hover" style={{ left: `${shown.x}%`, top: `${shown.y}%` }} aria-hidden="true"/>
        <span className={`chart-tooltip ${shown.x > 70 ? 'flip' : ''}`} style={{ left: `${shown.x}%` }} aria-hidden="true"><b>{proScore(shown.score)}</b><span>{formatDay(shown.date)}{windowNote(shown)}</span></span>
      </>}
      <span className="sr-only" role="status">{shown ? `Index ${proScore(shown.score)} on ${formatDay(shown.date)}${windowNote(shown)}` : ''}</span>
    </div>
    <div className="chart-x" aria-hidden="true">{days.map((d, i) => <span key={d.date} className={i === days.length - 1 ? 'end' : i === 0 ? 'start' : 'middle'} style={{ left: `${d.x}%` }}>{formatDay(d.date, false)}</span>)}</div>
    {/* The wrapper hides the table: overflow does not apply to table boxes, so a hidden table would still lengthen the page. */}
    <div className="sr-only"><table><caption>Daily index scores</caption><thead><tr><th scope="col">Date (UTC)</th><th scope="col">Score</th></tr></thead>
      <tbody>{series.map(p => <tr key={p.date}><td>{p.date}</td><td>{proScore(p.score)}</td></tr>)}</tbody></table></div>
  </figure>;
}
