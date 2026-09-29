import type { Metadata } from 'next';
import Link from 'next/link';
import { redirect } from 'next/navigation';
import { PageShell } from '../index-view';
import { billingTerms } from '../../lib/billing-terms';
import { errorMessage } from '../../lib/messages';
import { MAX_ALERTS, formatDate, paymentRow, planName, subscriptionStatus } from '../../lib/account-view';
import { getAccountState } from '../../lib/session';
import AlertsForm from './alerts-form';
import SignOutButton from './sign-out-button';
export const metadata: Metadata = { title: 'Your account | Kadena Community Edition Adoption Index', robots: { index: false, follow: false } };
export const dynamic = 'force-dynamic';

const EMAIL = /^[^\s@<>"]+@[^\s@<>"]+\.[^\s@<>"]+$/;

export default async function AccountPage({ searchParams }: { searchParams: Promise<{ export?: string | string[] }> }) {
  const state = await getAccountState();
  if (state.state === 'signed-out') redirect('/signin?next=/account');
  // A backend outage is not a sign-out: say so instead of sending a subscriber back to sign-in.
  if (state.state === 'unavailable') return <PageShell>
    <section className="notice-card" role="status">
      <h2>Your account is temporarily unavailable</h2>
      <p>Your account is temporarily unavailable, please try again in a minute. Today’s index is still free to view.</p>
      <div className="notice-actions"><Link className="button" href="/account">Try again</Link><Link className="text-link" href="/">Back to today’s index</Link></div>
    </section>
  </PageShell>;

  const account = state.account;
  const status = subscriptionStatus(account.subscription), active = status.state === 'active';
  const raw = (await searchParams).export, exportCode = typeof raw === 'string' && /^[a-z0-9_]{1,64}$/.test(raw) ? raw : null;
  const support = account.supportEmail && EMAIL.test(account.supportEmail) ? account.supportEmail : null;
  const payments = account.payments.map(paymentRow), alerts = account.alerts, wallets = account.wallets;
  return <PageShell>
    <section className="hero"><h1>Your account</h1><p>Signed in as <b className="break-all">{account.email}</b></p></section>

    <div className="account-grid">
      <section className="account-card" aria-labelledby="plan-title">
        <p className="eyebrow">Index Pro</p>
        <h2 id="plan-title"><span className={`badge badge-${active ? 'ok' : status.state === 'expired' ? 'warn' : 'neutral'}`}>{active ? 'Active' : status.state === 'expired' ? 'Expired' : 'Free'}</span> {status.label}</h2>
        {account.subscription && <p className="account-meta">{planName(account.subscription.plan)} · since {formatDate(account.subscription.startedAt)}</p>}
        <p className="account-note">{billingTerms.renewal}</p>
        <div className="account-actions">
          <Link className="button" href={status.action.href}>{status.action.label}</Link>
          {active && <Link className="text-link" href="/">Open the full index</Link>}
        </div>
      </section>

      <section className="account-card" id="pro-tools" aria-labelledby="tools-title">
        <h2 id="tools-title">Download data</h2>
        {active ? <>
          <p className="account-meta">Every published day as a CSV: the score and each input against its fixed baseline.</p>
          {/* A plain link: the browser saves the file, or comes back here with a message if it fails. */}
          <div className="account-actions"><a className="button button-outline" href="/api/export">Download CSV</a></div>
          {exportCode && <p className="form-error" role="alert">{errorMessage(exportCode, 'export')}</p>}
        </> : <p className="account-meta">The CSV export and email alerts are part of Index Pro.</p>}
      </section>
    </div>

    {(active || alerts.length > 0) && <section className="account-section" aria-labelledby="alerts-title">
      <h2 id="alerts-title">Email alerts</h2>
      <p className="account-meta">We email you when the daily index (to one decimal) crosses a level you choose. Up to {MAX_ALERTS} alerts.{!active && ' Alerts are paused until Pro is active again.'}</p>
      <AlertsForm alerts={alerts} canAdd={active}/>
    </section>}

    <section className="account-section" aria-labelledby="payments-title">
      <h2 id="payments-title">Payments</h2>
      {payments.length ? <ul className="payment-list">
        {payments.map(p => <li className="payment-item" key={p.key}>
          <div className="payment-head">
            <b>{p.amount}</b><span className="payment-plan">{p.plan}</span>
            <span className={`badge badge-${p.status.tone}`}>{p.status.label}</span>
            {p.overpaid && <span className="badge badge-neutral" title="More than the plan price was sent">Overpaid</span>}
          </div>
          <p className="payment-meta">{p.date}{p.periodEnd && <> · access until {p.periodEnd}</>}</p>
          {p.note && <p className="payment-note">{p.note}</p>}
          {p.explorerUrl
            ? <a className="text-link payment-link" href={p.explorerUrl} target="_blank" rel="noopener noreferrer">{p.hash} · BscScan ↗</a>
            : <span className="mono payment-link">{p.hash}</span>}
        </li>)}
      </ul> : <p className="account-meta">No payments yet.</p>}
      {support && <p className="account-meta support-line">Questions about a payment? Email <a className="text-link" href={`mailto:${support}`}>{support}</a> with the transaction link.</p>}
    </section>

    <section className="account-section" aria-labelledby="wallets-title">
      <h2 id="wallets-title">Linked wallets</h2>
      {wallets.length ? <ul className="wallet-list">
        {wallets.map(w => <li key={w.address}><span className="mono break-all" title={w.address}>{w.address}</span><small>Linked {formatDate(w.linkedAt)}</small></li>)}
      </ul> : <p className="account-meta">No wallet linked yet. You link one at checkout by signing a free message; payments count only from linked wallets.</p>}
    </section>

    <section className="account-footer" aria-label="Session">
      {account.isAdmin && <Link className="text-link" href="/admin">Admin</Link>}
      <SignOutButton/>
    </section>
  </PageShell>;
}
