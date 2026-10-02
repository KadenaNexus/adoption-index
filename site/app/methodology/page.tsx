import type { Metadata } from 'next';
import Link from 'next/link';
import { ArrowLeft, ArrowUpRight } from 'lucide-react';
import { PageShell } from '../index-view';
import ReportLink from '../report-link';
import { getPublicIndex } from '../../lib/public-index';
import { formatAmount } from '../../lib/metrics';
export const metadata: Metadata = { title: 'Methodology | Kadena Community Edition Adoption Index' };
export const dynamic = 'force-dynamic';

const BASELINE_ROWS = [
  { id: 'addresses', label: 'Active addresses', unit: 'accounts per chain, daily average', short: 'accounts' },
  { id: 'contracts', label: 'New contracts', unit: 'new modules per 7 days', short: '' },
  { id: 'tvl', label: 'TVL', unit: 'KDA, daily average', short: 'KDA' },
  { id: 'hashrate', label: 'Network hashrate', unit: 'PH/s, daily average', short: 'PH/s' },
  { id: 'commits', label: 'GitHub commits', unit: 'human commits per 7 days', short: '' },
] as const;

export default async function Methodology() {
  const baseline = (await getPublicIndex()).baseline;
  return <PageShell><article className="methodology">
    <p className="eyebrow">TRANSPARENT BY DESIGN</p>
    <h1>What goes into the index.</h1>
    <p className="lead">Five measures of Kadena Community Edition activity, each compared with one fixed baseline.</p>
    <section><h2>Five signals, one daily reading.</h2>
      <div className="formula">Index = 50 × (0.30 × Addresses + 0.25 × Contracts + 0.20 × TVL + 0.15 × Hashrate + 0.10 × Commits), each as current ÷ baseline</div>
      <p>Each input is divided by its own fixed baseline, weighted, summed and multiplied by 50. Baseline activity therefore scores 50. The index has no upper limit: if all five inputs match their baselines it scores 50, if all double it scores 100, if all triple it scores 150, and if all fall 20% below baseline it scores 40.</p>
      <p>Current values are trailing 7-day averages for active addresses, TVL in KDA and hashrate, and trailing 7-day counts for new contracts and commits. The composite is rounded once to one decimal. The public score card shows a whole number; Pro shows one decimal.</p>
      <p>The first six collected days (29 June to 4 July 2026) use the 1 to 6 days available, compared with the same number of baseline days, and are labelled as shorter windows rather than full weeks. Missing observations prevent publication; weights are never redistributed.</p>
    </section>
    <section id="baseline"><h2>The fixed baseline</h2>
      <p>The first 30 verified days, 29 June to 28 July 2026, set one permanent baseline for each input: the 30-day mean of daily observations for average-based inputs, and 7 × the 30-day mean daily count for weekly counts. New highs never change a baseline or restate an earlier score. Daily summaries are kept permanently and the history grows as each completed day is added.</p>
      {baseline ? <div className="baseline-table" role="region" aria-label="Fixed baseline values" tabIndex={0}><table>
        <thead><tr><th scope="col">Input</th><th scope="col">Baseline (index level 50)</th><th scope="col">Observed, 29 Jun to 28 Jul</th><th scope="col">Rule</th></tr></thead>
        <tbody>{BASELINE_ROWS.map(row => {
          const m = baseline.metrics[row.id], weekly = m.kind === 'count';
          return <tr key={row.id}><th scope="row">{row.label}</th><td>{formatAmount(m.perWindow)} <small>{row.unit}</small></td>
            <td>{weekly ? `${formatAmount(m.observedDailyMean * 30)} in 30 days (${formatAmount(m.observedDailyMean)} per day)` : `${formatAmount(m.observedDailyMean)} ${row.short}, daily average`}</td>
            <td>{m.rule === 'minimum' ? 'Minimum of 1 per day applied' : 'Observed'}</td></tr>;
        })}</tbody></table></div> : <p className="caveat">Baseline values appear here once the verified history is loaded.</p>}
      <p className="caveat">Small and zero baselines: a count below one event per day is too sparse for a stable 7-day ratio. Such a count baseline uses the documented minimum of one per day (7 per 7-day window), and the observed value stays visible above. An average-based baseline of zero cannot be divided by and stops publication. No arbitrary divisor is used and no weight is changed.</p>
    </section>
    <section id="sources"><h2>The inputs</h2><div className="method-metrics">
      <div><h3><span>01</span> Daily active addresses <b>30%</b></h3>
        <p>Distinct senders and receivers within each UTC day and each of the 20 Pact mainnet chains, summed across chains and averaged over seven days. A gas-paying sender counts even when their included transaction fails. Transfer recipients come from executed token events; mining rewards are excluded.</p>
        <a href="https://api.chainweb-community.org/info">Community Edition Chainweb <ArrowUpRight size={13}/></a>
        <p className="caveat">An account on two chains counts once on each chain. Accounts are not people.</p>
        <ReportLink indicator="addresses"/>
      </div>
      <div><h3><span>02</span> New contracts <b>25%</b></h3>
        <p>Unique new Pact modules over seven days. Identity includes the chain, namespace and module name. Upgrades and redeployments are stored separately; failed transactions and identified test artifacts are excluded.</p>
        <p className="caveat">A module inventory immediately before collection began distinguishes existing modules from new ones; older transaction history is not collected. Unresolved identities and unreviewed test candidates prevent the affected data from being published.</p>
        <ReportLink indicator="contracts"/>
      </div>
      <div><h3><span>03</span> Total value locked <b>20%</b></h3>
        <p>Balances read directly from historical Pact state for a versioned registry of the active protocols: Mercatus, BroDEX and KoberluSW. Pool assets, staked principal, funded order escrow and unspent DCA deposits are valued in KDA. Receipt tokens are not counted again.</p>
        <p>The index uses the seven-day mean in KDA. The USD display uses Mercatus’s KDA/USDT price, treating USDT as one USD; this is an approximation and does not affect the index.</p>
        <p className="caveat">The registry defines coverage. KDSwap, KDLaunch, Chips and Kadena Cabinet are left out as inactive, across the whole history. Pool-implied prices, particularly for illiquid tokens, are valuations rather than guaranteed sale proceeds. DefiLlama is a cross-check only.</p>
        <ReportLink indicator="tvl"/>
      </div>
      <div><h3><span>04</span> Network hashrate <b>15%</b></h3>
        <p>The sum of proof of work from canonical block targets across all 20 chains, divided by the observed time and expressed in PH/s. The index uses its seven-day average.</p>
        <a href="https://github.com/kda-community/chainweb-node">Community node source <ArrowUpRight size={13}/></a>
        <ReportLink indicator="hashrate"/>
      </div>
      <div><h3><span>05</span> Developer activity <b>10%</b></h3>
        <p>Seven-day human commit totals across public kda-community repositories, including forks. GitHub API records are collected at captured default-branch heads. Merge commits, identified bots and duplicate commit hashes are excluded. Dates use the UTC committer timestamp.</p>
        <a href="https://github.com/kda-community">kda-community on GitHub <ArrowUpRight size={13}/></a>
        <p className="caveat">Commits measure development activity, not its quality or eventual adoption.</p>
        <ReportLink indicator="commits"/>
      </div>
    </div></section>
    <section><h2>Reading the index</h2><div className="levels"><div><b>40</b><span>20% below baseline</span></div><div><b>50</b><span>Baseline activity</span></div><div><b>100</b><span>Double the baseline</span></div><div><b>150</b><span>Triple the baseline</span></div></div>
      <p>The score card states the position against the baseline, for example “12% above baseline”. There are no fixed bands and no ceiling. Changes are index points against exactly seven and thirty days earlier; unavailable comparisons show a dash. Contract and commit cards show 7-day totals against a 7-day baseline.</p>
    </section>
    <section id="publication"><h2>When a score is published</h2><ol>
      <li>Collection begins with 90 completed UTC days, starting 29 June 2026. The current partial day is excluded.</li>
      <li>Daily summaries are retained permanently. Raw block payloads may be discarded after validated summaries and supporting evidence have been stored.</li>
      <li>The daily job starts at 00:00 UTC, waits for finality and publishes the previous completed day after all five inputs pass coverage checks. Earlier days are never recalculated.</li>
      <li>Canonical records since collection began, precise TVL state boundaries and bounded source pagination are checked before computing the index.</li>
      <li>If an update fails, the last verified score retains its date and is marked stale.</li>
    </ol><p className="callout">Collection began 29 June 2026; earlier history not yet included. This is the configured first observation date. No score is published until initial collection is verified and the required checks pass.</p></section>
    <Link className="text-link" href="/"><ArrowLeft size={14}/> Back to today’s index</Link>
  </article></PageShell>;
}
