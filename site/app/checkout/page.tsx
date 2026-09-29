import type { Metadata } from 'next';
import Link from 'next/link';
import { ArrowLeft, LockKeyhole } from 'lucide-react';
import { PageShell } from '../index-view';
import { billingTerms } from '../../lib/billing-terms';
import { backendFetch } from '../../lib/backend';
import { getAccountState, requestClientIp } from '../../lib/session';
import { checkoutPlan, checkoutPlans, parseCheckoutConfig, planTerm, type CheckoutConfig, type CheckoutPlan, type CheckoutPlanId } from '../../lib/wallet';
import CheckoutFlow from './checkout-flow';
import './checkout.css';

export const metadata: Metadata = { title: 'Checkout | Kadena Community Edition Adoption Index', robots: { index: false, follow: false } };

const PLAN_NOTES: Record<CheckoutPlanId, string> = { monthly: 'No auto-renewal', annual: 'Save 27% compared with monthly', test: 'Admin test payment' };

function Notice({ title, children, action }: { title: string; children: React.ReactNode; action?: React.ReactNode }) {
  return <div className="pay-notice" role="status"><h3>{title}</h3><p>{children}</p>{action && <div className="pay-actions">{action}</div>}</div>;
}

export default async function Checkout({ searchParams }: { searchParams: Promise<{ plan?: string | string[] }> }) {
  const requested = (await searchParams).plan;
  const clientIp = await requestClientIp();
  const [state, billing] = await Promise.all([getAccountState(), backendFetch('/billing/config', { clientIp })]);
  const account = state.state === 'signed-in' ? state.account : null;
  const plan: CheckoutPlan = checkoutPlan(typeof requested === 'string' ? requested : undefined, account?.testPlanAvailable === true);
  // Signed-out visitors come back to the plan they asked for, including an admin's test link.
  const back = `/checkout?plan=${typeof requested === 'string' && Object.hasOwn(checkoutPlans, requested) ? requested : plan.id}`;
  const signInHref = `/signin?next=${encodeURIComponent(back)}`;
  const configError = (billing.data as { error?: unknown } | null)?.error;
  const config: CheckoutConfig | null = billing.status === 200 ? parseCheckoutConfig(billing.data) : null;
  const unreachable = !config && configError !== 'accounts_disabled';
  const open = !!config?.evm;
  // On testnet the backend lets only admins pay, so everyone else sees that instead of a flow that would be refused.
  const evm = config?.evm && (!config.evm.testnet || account?.isAdmin) ? config.evm : null;
  const choices: CheckoutPlan[] = [checkoutPlans.monthly, checkoutPlans.annual, ...(account?.testPlanAvailable ? [checkoutPlans.test] : [])];

  let payment: React.ReactNode;
  if (unreachable) payment = <Notice title="Checkout is temporarily unavailable">Please try again in a few minutes. No payment has been taken.</Notice>;
  else if (!open || !config) payment = <Notice title="Payments not yet open">Subscriptions are not active yet. No payment will be collected.</Notice>;
  else if (state.state === 'unavailable') payment = <Notice title="Your account is temporarily unavailable">Please try again in a minute.</Notice>;
  else if (!account) payment = config.signinOpen
    ? <Notice title="Sign in to continue" action={<Link className="button" href={signInHref}>Sign in</Link>}>Pro is tied to your email address. Sign in with a one-time link or code, then come back here to pay.</Notice>
    : <Notice title="Subscriber sign-in opens soon">Today’s index stays free for everyone in the meantime.</Notice>;
  else if (!evm) payment = <Notice title="Testnet mode — checkout is limited to admins">Payments open to everyone when the payment network moves to BNB Smart Chain mainnet.</Notice>;
  else payment = <>
    <p className="pay-signed-in">Signed in as <b>{account.email}</b></p>
    {/* key: a plan change must drop any intent made for the previous plan. */}
    <CheckoutFlow key={plan.id} plan={plan} evm={evm} walletConnectProjectId={config.walletConnectProjectId} linkedWallets={(account.wallets ?? []).map(w => w.address)}
      supportEmail={config.supportEmail} signInHref={signInHref}/>
  </>;

  const offered = account ? evm : config?.evm && !config.evm.testnet ? config.evm : null;
  return <PageShell>
    <section className="hero"><p className="eyebrow">Index Pro</p><h1>Checkout</h1><p>Every recorded day. Every metric. More context.</p></section>
    <div className="checkout-layout pay-layout">
      <div className="pay-main">
        <section aria-labelledby="plan-heading">
          <h2 id="plan-heading">Choose a plan</h2>
          <div className="checkout-options">{choices.map(option => <Link key={option.id} href={`/checkout?plan=${option.id}`} className={`checkout-option ${plan.id === option.id ? 'selected' : ''}`} aria-current={plan.id === option.id ? 'true' : undefined}>
            <span><b>{option.name}</b><small>{planTerm(option)} · {PLAN_NOTES[option.id]}</small></span><strong>${option.price}</strong>
          </Link>)}</div>
        </section>
        <section aria-labelledby="pay-heading" className="pay-section">
          <h2 id="pay-heading">Payment</h2>
          {payment}
        </section>
      </div>
      <aside className="checkout-summary pay-summary" aria-label="Order summary">
        <p className="eyebrow">Your plan</p>
        <h2>Index Pro · {plan.name}</h2>
        <p className="checkout-price">${plan.price}</p>
        <p className="pay-term">{planTerm(plan)}</p>
        {offered && <p className="checkout-terms">Pay {plan.price} USDT or USDC on {offered.chainName}.</p>}
        {!open && !unreachable && <><button className="button" disabled aria-describedby="payment-status"><LockKeyhole size={15} aria-hidden="true"/> Payments not yet open</button>
          <p id="payment-status" className="checkout-notice">Subscriptions are not active yet. No payment will be collected.</p></>}
        <p className="checkout-terms">{billingTerms.renewal}</p>
        <p className="checkout-terms">{billingTerms.refund}</p>
      </aside>
    </div>
    <Link className="text-link checkout-back" href="/access"><ArrowLeft size={14} aria-hidden="true"/> Back to Pro plans</Link>
  </PageShell>;
}
