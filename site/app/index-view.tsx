import Link from 'next/link';
import { Fragment, type ReactNode } from 'react';
import type { PublicIndex } from '../db/store';
import { proScore, publicScore } from '../lib/score-display';
import { billingTerms } from '../lib/billing-terms';
import { areaPath, linePath } from '../lib/chart-geometry';
import { BASELINE_LEVEL, METRICS, baselineComparison, formatAmount, formatChange, formatCount, formatDay, formatHashrate, formatKda, formatRatio, formatUsd, ratioTone, type Change } from '../lib/metrics';
import { HISTORY_RANGES, type AvailableRanges, type HistoryRangeId, type ProBreakdown, type ProData, type ProMetric } from '../lib/pro-data';
import { getSessionToken } from '../lib/session';
import ChartGrid from './chart-grid';
import HistoryChart from './history-chart';
import LockIcon from './lock-icon';
import PlanPicker from './plan-picker';
import ReportLink from './report-link';

// Decided by the cookie alone (no backend call); pages that need the account itself ask the backend.
export async function SiteHeader() {
  const signedIn = !!await getSessionToken();
  return <header className="site-header">
    <Link className="brand" href="/">kadena.ws</Link>
    {signedIn ? <Link className="signin-button" href="/account">Account</Link> : <Link className="signin-button" href="/signin">Sign in</Link>}
  </header>;
}

export function Footer({ day = null }: { day?: string | null }) {
  return <footer className="site-footer">
    <Link href="/methodology">How is the index calculated?</Link>
    <p>Updated daily at 00:00 UTC · Not financial advice</p>
    <p className="footnote">{day ? `Latest reading: ${formatDay(day)} (UTC) · ` : ''}Collection began 29 June 2026; earlier history not yet included.</p>
  </footer>;
}

// Header and footer sit outside <main> so the skip link and landmarks work.
export function PageShell({ children, day = null, banner }: { children: ReactNode; day?: string | null; banner?: ReactNode }) {
  return <div className="page">
    {banner}
    <SiteHeader/>
    <main id="main-content" tabIndex={-1}>{children}</main>
    <Footer day={day}/>
  </div>;
}

function ChangeText({ change, suffix }: { change: Change; suffix: string }) {
  return <span className="change"><b className={`change-${change.direction}`}>{change.arrow && <><span aria-hidden="true">{change.arrow} </span><span className="sr-only">{change.direction === 'up' ? 'up ' : 'down '}</span></>}{change.magnitude}</b> {suffix}</span>;
}

// Card captions tint the whole change, as in the mockup ("▲ 12% WoW").
function WeekChange({ change, suffix }: { change: Change; suffix: string }) {
  return <span className={`week-change change-${change.direction}`}>{change.arrow && <><span aria-hidden="true">{change.arrow} </span><span className="sr-only">{change.direction === 'up' ? 'up ' : 'down '}</span></>}{change.magnitude}% {suffix}</span>;
}

// Subscribers see the composite to one decimal (from their history) when it is the same day as the public reading.
function ScoreCard({ index, subscriber, precise = null }: { index: PublicIndex; subscriber: boolean; precise?: number | null }) {
  const available = index.score !== null;
  // No peak-based bands: the pill states the position against the fixed baseline (50).
  const comparison = available ? baselineComparison(Math.round(index.score!)) : null;
  const tone = comparison?.tone ?? 'pending';
  const status = comparison?.text ?? (index.state === 'unavailable' ? 'Temporarily unavailable' : 'Awaiting verified data');
  const note = index.state === 'stale' && index.day ? `Reading for ${formatDay(index.day)} (UTC). The next update is awaiting validation.` : available ? null : index.message;
  return <section className="score-card" aria-labelledby="score-label">
    <p className="score-label" id="score-label">{index.state === 'stale' ? 'Last verified index' : "Today's index"}</p>
    <p className="score"><span className={`score-value ${available ? '' : 'pending'}`}>{available ? precise !== null ? proScore(precise) : publicScore(index.score!) : '—'}</span></p>
    <p className={`baseline-pill tone-${tone}`}>{status}</p>
    <p className="baseline-note">Baseline = {BASELINE_LEVEL}: average activity from 29 Jun to 28 Jul 2026. No upper limit.</p>
    {subscriber
      ? <p className="delta-row"><ChangeText change={formatChange(index.sevenDay, 1)} suffix="vs 7 days ago"/><span className="delta-sep" aria-hidden="true">·</span><ChangeText change={formatChange(index.thirtyDay, 1)} suffix="vs 30 days ago"/></p>
      : <Link className="delta-locked" href="/access">
        <span className="delta-ghost" aria-hidden="true"><i className="ghost-up"/><i/><i className="ghost-down"/><i/></span>
        <span className="delta-lock-label"><LockIcon size={14}/> 7-day and 30-day change: Pro</span>
      </Link>}
    {note && <p className="score-note">{note}</p>}
    <ReportLink indicator="index"/>
  </section>;
}

function LockOverlay({ title, text }: { title: string; text: string }) {
  return <div className="lock-overlay">
    <span className="lock-icon"><LockIcon size={34}/></span>
    <h3>{title}</h3>
    <p>{text}</p>
    <Link className="button" href="/access">Unlock Pro</Link>
  </div>;
}

// Decorative shape behind the blur. It is not index data; Pro data is never sent to free visitors.
const TEASER = [24, 19, 22, 31, 27, 35, 39, 43, 38, 45, 43, 50, 47].map((score, i, all) => ({ date: '', score, x: i / (all.length - 1) * 100, y: 100 - score }));

// 1Y becomes a link only when the backend reports a full year of verified history.
function RangeToggle({ active, basePath, available }: { active?: HistoryRangeId; basePath?: string; available?: AvailableRanges }) {
  return <nav className="range-toggle" aria-label="History range">
    {HISTORY_RANGES.map(r => !basePath || available?.[r.id] !== true
      ? <span key={r.id} className={`range-btn ${!basePath && r.id === '30d' ? 'active' : ''}`} {...(basePath ? { 'aria-disabled': true, title: 'Available once a full year of verified history exists' } : {})}>{r.label}</span>
      : <Link key={r.id} href={`${basePath}?range=${r.id}`} scroll={false} className={`range-btn ${active === r.id ? 'active' : ''}`} aria-current={active === r.id ? 'true' : undefined}>{r.label}</Link>)}
  </nav>;
}

function LockedHistory() {
  return <div className="chart-card locked">
    <div className="locked-content" aria-hidden="true">
      <RangeToggle/>
      <div className="chart"><ChartGrid baseline={BASELINE_LEVEL}/><div className="chart-plot"><svg viewBox="0 0 100 100" preserveAspectRatio="none">
        <path d={areaPath(TEASER)} className="teaser-area"/><path d={linePath(TEASER)} className="teaser-line" vectorEffect="non-scaling-stroke"/>
      </svg></div></div>
    </div>
    <LockOverlay title="Unlock Historical Data" text="See how adoption has evolved over 30 days, 90 days, and since collection began."/>
  </div>;
}

const TEASER_BARS = [40, 40, 45, 62, 55];
function LockedBreakdown() {
  return <div className="breakdown-locked">
    <div className="metric-grid locked-content" aria-hidden="true">
      {METRICS.map((m, i) => <div className="metric-card" key={m.id}>
        <div className="metric-head"><span className="metric-label">{m.label}</span><span className="weight-badge">{Math.round(m.weight * 100)}%</span></div>
        <span className="ghost-value"/>
        <div className="meter"><i className={`tone-${i > 2 ? 'growth' : 'recovery'}`} style={{ width: `${TEASER_BARS[i]}%` }}/></div>
        <span className="ghost-caption"/>
      </div>)}
    </div>
    <LockOverlay title="See the Breakdown" text="The 5 components behind today's index, updated daily."/>
  </div>;
}

// Each card shows the current value against its fixed baseline (matching unit) and the ratio.
function describe(metric: ProMetric, breakdown: ProBreakdown): { value: string; title?: string; approx?: { text: string; title: string }; parts: string[]; wow?: string } {
  const window = metric.windowDays < 7 ? `${metric.windowDays}-day` : '7-day';
  const minimum = metric.baselineRule === 'minimum' ? ' (minimum)' : '';
  const ratio = `${formatRatio(metric.ratio)} baseline`;
  switch (metric.id) {
    case 'addresses': return { value: formatCount(metric.value), parts: [`${window} avg`, `baseline ${formatAmount(metric.baselineValue)}`, ratio], wow: 'WoW' };
    case 'contracts': return { value: formatCount(metric.value), parts: [`${window} total`, `baseline ${formatAmount(metric.baselineValue)}${minimum}`, ratio] };
    // The same 7-day mean in KDA that the index uses, like the bar and the baseline; the dollar figure under it is a guide
    // at the latest KDA/USDT price (USDT taken as one US dollar).
    case 'tvl': return { value: formatKda(metric.value), approx: { text: `≈ ${formatUsd(metric.value * breakdown.kdaUsd)} at today’s price`, title: 'At the latest KDA/USDT price on Mercatus, taking USDT as one US dollar' },
      parts: [breakdown.protocolCount ? `${breakdown.protocolCount} protocols` : 'Named registry', `${window} avg`, `baseline ${formatKda(metric.baselineValue)}`, ratio], wow: '(KDA-denom)' };
    case 'hashrate': return { value: formatHashrate(metric.value), parts: [`${window} avg`, `baseline ${formatHashrate(metric.baselineValue)}`, ratio], wow: 'WoW' };
    case 'commits': return { value: formatCount(metric.value), title: `${window} total`, parts: ['kda-community org', `baseline ${formatAmount(metric.baselineValue)}${minimum}`, ratio] };
  }
}

function Breakdown({ breakdown }: { breakdown: ProBreakdown }) {
  return <div className="metric-grid">
    {breakdown.metrics.map(metric => {
      const spec = METRICS.find(m => m.id === metric.id)!, d = describe(metric, breakdown);
      return <article className="metric-card" key={metric.id}>
        <div className="metric-head"><h3 className="metric-label">{spec.label}</h3><span className="weight-badge" title="Weight in the index">{Math.round(spec.weight * 100)}%</span></div>
        <p className="metric-value" title={d.title}>{d.value}</p>
        {d.approx && <p className="metric-approx" title={d.approx.title}>{d.approx.text}</p>}
        <div className="meter meter-baseline" role="img" aria-label={`${formatRatio(metric.ratio)} its baseline; the mark is the baseline`}><i className={`tone-${ratioTone(metric.ratio)}`} style={{ width: `${Math.min(100, metric.ratio * 50)}%` }}/></div>
        <p className="metric-caption">{d.parts.map((part, i) => <Fragment key={part}>{i ? ' · ' : ''}<span className="nowrap">{part}</span></Fragment>)}{d.wow && metric.weekOverWeek !== null && <> · <WeekChange change={formatChange(metric.weekOverWeek, 0)} suffix={d.wow}/></>}</p>
        <ReportLink indicator={metric.id}/>
      </article>;
    })}
  </div>;
}

function AccessPanel() {
  return <section className="access-panel" aria-labelledby="access-title">
    <h2 id="access-title">Get Full Access</h2>
    <p className="access-lead">Historical charts, index breakdown, 7-day and 30-day change, email alerts when the index crosses your target.</p>
    <PlanPicker/>
    <p className="access-terms">One payment buys 30 or 365 days. Nothing renews automatically. {billingTerms.refund}</p>
  </section>;
}

export type Subscriber = { data: ProData | null; range: HistoryRangeId; basePath: string };

export default function IndexView({ index, subscriber, notice }: { index: PublicIndex; subscriber?: Subscriber; notice?: ReactNode }) {
  const unavailable = <div className="pro-unavailable">Pro data could not be loaded just now. Please reload the page in a minute.</div>;
  const series = subscriber?.data?.history.series ?? [];
  const lastDay = series.length ? series[series.length - 1].date : null;
  const endLabel = index.state === 'ready' && lastDay === index.day ? 'Today' : lastDay ? formatDay(lastDay, false) : '';
  return <PageShell day={index.day} banner={notice}>
    <section className="hero">
      <h1>Kadena Community Edition Adoption Index</h1>
      <p>One number that tells you if Kadena Community Edition is being adopted. Updated daily.</p>
    </section>
    <ScoreCard index={index} subscriber={!!subscriber} precise={subscriber?.data && lastDay === index.day ? series[series.length - 1].score : null}/>
    <section className="section" aria-labelledby="trend-title">
      <h2 id="trend-title">Historical Trend</h2>
      {!subscriber ? <LockedHistory/> : subscriber.data ? <div className="chart-card"><div className="chart-head"><span className="chart-legend"><i aria-hidden="true"/>Baseline ({BASELINE_LEVEL})</span><RangeToggle active={subscriber.range} basePath={subscriber.basePath} available={subscriber.data.history.availableRanges}/></div><HistoryChart series={series} endLabel={endLabel}/></div> : unavailable}
    </section>
    <section className="section" aria-labelledby="inside-title">
      <h2 id="inside-title">What&apos;s Inside the Index</h2>
      {!subscriber ? <LockedBreakdown/> : subscriber.data ? <Breakdown breakdown={subscriber.data.breakdown}/> : unavailable}
      {/* Free visitors can't use links inside the blurred cards, so theirs sits under them. */}
      {!subscriber && <ReportLink/>}
    </section>
    {!subscriber && <AccessPanel/>}
  </PageShell>;
}
