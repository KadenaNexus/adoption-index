import type { Metadata } from 'next';
import Link from 'next/link';
import { ArrowLeft, LockKeyhole } from 'lucide-react';
import { PageShell } from '../index-view';
import { billingTerms, planFrom, plans } from '../../lib/billing-terms';
export const metadata: Metadata = { title: 'Checkout | Kadena Community Edition Adoption Index', robots: { index: false, follow: false } };
export default async function Checkout({ searchParams }: { searchParams: Promise<{ plan?: string }> }) {
  const selected = planFrom((await searchParams).plan), plan = plans[selected];
  return <PageShell>
    <section className="hero"><p className="eyebrow">Index Pro</p><h1>Choose your plan.</h1><p>Every recorded day. Every metric. More context.</p></section>
    <section className="checkout-layout" aria-label="Subscription checkout">
      <div><h2>Choose a plan</h2>
        <div className="checkout-options">{Object.entries(plans).map(([id, option]) => <Link key={id} href={`/checkout?plan=${id}`} className={`checkout-option ${selected === id ? 'selected' : ''}`} aria-current={selected === id ? 'true' : undefined}><span><b>{option.name}</b><small>{id === 'annual' ? 'Save 27% compared with monthly' : 'Flexible monthly access'}</small></span><strong>{option.label}</strong></Link>)}</div>
        <p className="checkout-terms">{billingTerms.cancellation}</p>
      </div>
      <aside className="checkout-summary"><p className="eyebrow">Your plan</p><h2>Index Pro · {plan.name}</h2>
        <p className="checkout-price">${plan.price}<small> / {plan.cadence}</small></p><p className="checkout-terms">Renews at {plan.label} until cancelled.</p>
        <button className="button" disabled aria-describedby="payment-status"><LockKeyhole size={15} aria-hidden="true"/> Payments not yet open</button>
        <p id="payment-status" className="checkout-notice">Subscriptions are not active yet. No payment will be collected.</p><p className="checkout-terms">{billingTerms.refund}</p>
      </aside>
    </section>
    <Link className="text-link checkout-back" href="/access"><ArrowLeft size={14} aria-hidden="true"/> Back to Pro plans</Link>
    </PageShell>;
}
