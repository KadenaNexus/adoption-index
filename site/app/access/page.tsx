import type { Metadata } from 'next';
import Link from 'next/link';
import { Check } from 'lucide-react';
import { PageShell } from '../index-view';
import { billingTerms, plans } from '../../lib/billing-terms';
export const metadata: Metadata = { title: 'Pro plans | Kadena Community Edition Adoption Index' };
const included = [
  'Historical charts: 30D, 90D and All; 1Y unlocks once a full year of verified history exists',
  'The index breakdown: all five inputs against their fixed baselines, every day',
  '7-day and 30-day change, and the composite to one decimal',
  'CSV export of permanently retained daily readings',
  'Email alerts when the index crosses your target',
];
export default function Access() {
  return <PageShell>
    <section className="hero"><p className="eyebrow">Index Pro · Coming soon</p><h1>The bigger picture.</h1><p>Today’s index will always be free. Pro adds the detail behind it.</p></section>
    <div className="plan-grid">{Object.entries(plans).map(([id, plan]) => <section className="plan-card" key={id}>
      <p className="eyebrow">{id === 'annual' ? 'The long view' : 'Flexible access'}</p>
      <h2>{plan.name}</h2>
      <strong>${plan.price}<small> / {plan.cadence}</small></strong>
      <p>{id === 'annual' ? 'Billed annually. Save 27% compared with monthly.' : 'Billed monthly. Cancel anytime.'}<br/>Full access to Index Pro.</p>
      <Link className="button" href={`/checkout?plan=${id}`}>View {plan.name.toLowerCase()} plan</Link>
    </section>)}</div>
    <section className="info-card"><h2>Included with Pro</h2>
      <ul className="check-list">{included.map(s => <li key={s}><Check size={17} aria-hidden="true"/>{s}</li>)}</ul>
      <p>{billingTerms.cancellation}</p><p>{billingTerms.refund}</p>
      <p className="subscription-note">Subscriptions are coming soon. Payment collection is not active.</p>
    </section>
    </PageShell>;
}
