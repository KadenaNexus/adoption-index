import type { Metadata } from 'next';
import Link from 'next/link';
import { Check } from 'lucide-react';
import { PageShell } from '../index-view';
import { billingTerms, plans } from '../../lib/billing-terms';
export const metadata: Metadata = { title: 'Pro plans | Kadena Community Edition Adoption Index', alternates: { canonical: '/access' } };
const included = [
  'Historical charts: 30D, 90D and All; 1Y unlocks once a full year of verified history exists',
  'The index breakdown: all five inputs against their fixed baselines, every day',
  '7-day and 30-day change, and the composite to one decimal',
  'CSV export of permanently retained daily readings',
  'Email alerts when the index crosses your target',
];
export default function Access() {
  return <PageShell>
    <section className="hero"><p className="eyebrow">Index Pro</p><h1>The bigger picture.</h1><p>Today’s index will always be free. Pro adds the detail behind it.</p></section>
    <div className="plan-grid">{Object.entries(plans).map(([id, plan]) => <section className="plan-card" key={id}>
      <p className="eyebrow">{id === 'annual' ? 'The long view' : 'Flexible access'}</p>
      <h2>{plan.name}</h2>
      <strong>${plan.price}<small> · one payment · {plan.days} days</small></strong>
      <p>{id === 'annual' ? 'One payment buys 365 days. Save 27% compared with monthly.' : 'One payment buys 30 days.'} Nothing renews automatically.<br/>Full access to Index Pro.</p>
      <Link className="button" href={`/checkout?plan=${id}`}>View {plan.name.toLowerCase()} plan</Link>
    </section>)}</div>
    <section className="info-card"><h2>Included with Pro</h2>
      <ul className="check-list">{included.map(s => <li key={s}><Check size={17} aria-hidden="true"/>{s}</li>)}</ul>
      <p>{billingTerms.renewal}</p><p>{billingTerms.refund}</p>
      <p>Pay once from your own crypto wallet, with USDT or USDC on BNB Smart Chain. Already a subscriber? <Link className="text-link" href="/signin">Sign in</Link></p>
    </section>
    </PageShell>;
}
