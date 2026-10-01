import type { Metadata } from 'next';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import { PageShell } from '../index-view';
import { parseOverview } from '../../lib/admin-view';
import { backendFetch } from '../../lib/backend';
import { getAccountState, getSessionToken, requestClientIp } from '../../lib/session';
import ExtendForm from './extend-form';
import ReportResolveForm from './report-resolve-form';
import ResolveForm from './resolve-form';
export const metadata: Metadata = { title: 'Admin | Kadena Community Edition Adoption Index', robots: { index: false, follow: false } };
export const dynamic = 'force-dynamic';

const count = (value: number | null) => value === null ? '—' : value.toLocaleString('en-US');

// Admins only; everyone else gets the same 404 as a missing page. The backend checks again on every call.
export default async function Admin() {
  const state = await getAccountState();
  if (state.state !== 'signed-in' || !state.account.isAdmin) notFound();
  const overview = await backendFetch('/admin/overview', { session: await getSessionToken(), clientIp: await requestClientIp(), timeoutMs: 10000 });
  if (overview.status === 404) notFound();
  const data = overview.status === 200 ? parseOverview(overview.data) : null;
  const banner = data?.testnet ? <p className="site-notice site-notice-warn" role="status">Testnet mode — checkout is limited to admins</p> : undefined;
  if (!data) return <PageShell>
    <section className="notice-card" role="status"><h2>Admin data is unavailable</h2><p>The overview could not be loaded just now. Please try again in a minute.</p>
      <div className="notice-actions"><Link className="button" href="/admin">Try again</Link></div></section>
  </PageShell>;
  const open = data.counts.unresolvedTransfers ?? data.unmatched.filter(u => !u.resolved).length;
  // The backend's count only: an API that predates reports shows a dash, not a reassuring 0.
  const openReports = data.counts.openReports;
  return <PageShell banner={banner}>
    <section className="hero"><p className="eyebrow">Admin</p><h1>Payments and subscriptions</h1></section>
    <dl className="admin-counts">
      <div><dt>Users</dt><dd>{count(data.counts.users)}</dd></div>
      <div><dt>Active subscriptions</dt><dd>{count(data.counts.activeSubscriptions)}</dd></div>
      <div><dt>Confirmed payments</dt><dd>{count(data.counts.confirmedPayments)}</dd></div>
      <div><dt>Pending payments</dt><dd>{count(data.counts.pendingPayments)}</dd></div>
      <div><dt>Unmatched, open</dt><dd>{count(open)}</dd></div>
      <div><dt>Reports, open</dt><dd>{count(openReports)}</dd></div>
      <div><dt>Emails queued</dt><dd>{count(data.counts.queuedEmails)}</dd></div>
      <div><dt>Emails failed</dt><dd>{count(data.counts.failedEmails)}</dd></div>
    </dl>

    <section className="admin-section" aria-labelledby="extend-title">
      <h2 id="extend-title">Extend a subscription</h2>
      <p className="account-meta">Adds days from the current expiry (or from now if it has lapsed). An unknown email gets a new account. Every change is logged with your note.</p>
      <ExtendForm/>
    </section>

    <section className="admin-section" aria-labelledby="payments-title">
      <h2 id="payments-title">Payments <small>latest {data.payments.length}</small></h2>
      {data.payments.length ? <div className="table-wrap"><table className="admin-table">
        <thead><tr><th scope="col">Date</th><th scope="col">Email</th><th scope="col">Plan</th><th scope="col">Paid</th><th scope="col">Required</th><th scope="col">Status</th><th scope="col">Transaction</th></tr></thead>
        <tbody>{data.payments.map(p => <tr key={p.key}>
          <td className="nowrap">{p.date}</td><td className="break-all">{p.email}</td><td>{p.plan}<small>{p.source}</small></td>
          <td className="nowrap">{p.amount}</td><td className="nowrap">{p.required}</td>
          <td><span className={`badge badge-${p.status.tone}`}>{p.status.label}</span>{p.marker === 'overpaid' && <span className="badge badge-neutral" title="More than the plan price was sent">Overpaid</span>}{p.reason && <small>{p.reason}</small>}</td>
          <td>{p.explorerUrl ? <a className="text-link mono" href={p.explorerUrl} target="_blank" rel="noopener noreferrer">{p.hash}</a> : <span className="mono">{p.hash}</span>}<small>{p.network}</small></td>
        </tr>)}</tbody>
      </table></div> : <p className="account-meta">No payments yet.</p>}
    </section>

    <section className="admin-section" aria-labelledby="unmatched-title">
      <h2 id="unmatched-title">Unmatched transfers <small>{open} open</small></h2>
      <p className="account-meta">Transfers to the payment address from wallets not linked to any account, such as exchange withdrawals. Credit one with the extend form, then resolve it with a note.</p>
      {data.unmatched.length ? <div className="table-wrap"><table className="admin-table">
        <thead><tr><th scope="col">Seen</th><th scope="col">From</th><th scope="col">Amount</th><th scope="col">Transaction</th><th scope="col">Resolution</th></tr></thead>
        <tbody>{data.unmatched.map(u => <tr key={u.key}>
          <td className="nowrap">{u.seen}<small>block {u.block}</small></td><td className="mono break-all">{u.from}</td><td className="nowrap">{u.amount} {u.token}</td>
          <td>{u.explorerUrl ? <a className="text-link mono" href={u.explorerUrl} target="_blank" rel="noopener noreferrer">{u.hash}</a> : <span className="mono">{u.hash}</span>}<small>{u.network} · log {u.logIndex}</small></td>
          <td>{u.note && <span className="resolved-note">{u.note}</span>}{!u.resolved && u.logIndex >= 0 && <ResolveForm network={u.network} txHash={u.txHash} logIndex={u.logIndex}/>}</td>
        </tr>)}</tbody>
      </table></div> : <p className="account-meta">No unmatched transfers.</p>}
    </section>

    <section className="admin-section" id="reports" aria-labelledby="reports-title">
      <h2 id="reports-title">Data issue reports <small>{count(openReports)} open</small></h2>
      <p className="account-meta">Sent from the “Report a data issue” links beside the indicators and on the methodology page. The first 10 reports in any 24 hours are also emailed to the admins. Check each one, reply if an email was given, then resolve it with a note.</p>
      {data.reports.length ? <div className="table-wrap"><table className="admin-table">
        <thead><tr><th scope="col">Received</th><th scope="col">Indicator</th><th scope="col">Issue</th><th scope="col">Link or ID</th><th scope="col">Email</th><th scope="col">Resolution</th></tr></thead>
        <tbody>{data.reports.map(r => <tr key={r.key}>
          <td className="nowrap">{r.date}<small>#{r.id}</small></td><td>{r.indicator}</td>
          <td><span className="report-text" dir="auto">{r.description}</span></td>
          <td>{r.evidenceUrl ? <a className="text-link break-all" href={r.evidenceUrl} target="_blank" rel="noopener noreferrer nofollow">{r.evidenceUrl}</a> : <span className="mono break-all">{r.evidence}</span>}</td>
          <td className="break-all">{r.mailto ? <a className="text-link" href={r.mailto}>{r.email}</a> : r.email ?? <small>None given</small>}</td>
          <td>{r.note && <span className="resolved-note">{r.note}{r.resolvedBy && <small>{r.resolvedBy}</small>}</span>}{!r.resolved && r.id > 0 && <ReportResolveForm id={r.id}/>}</td>
        </tr>)}</tbody>
      </table></div> : <p className="account-meta">No reports yet.</p>}
    </section>

    <section className="admin-section" aria-labelledby="subs-title">
      <h2 id="subs-title">Subscriptions <small>{data.subscriptions.length}</small></h2>
      {data.subscriptions.length ? <div className="table-wrap"><table className="admin-table">
        <thead><tr><th scope="col">Email</th><th scope="col">Plan</th><th scope="col">Started</th><th scope="col">Expires</th><th scope="col">Status</th></tr></thead>
        <tbody>{data.subscriptions.map(s => <tr key={s.key}>
          <td className="break-all">{s.email}</td><td>{s.plan}</td><td className="nowrap">{s.started}</td><td className="nowrap">{s.expires}</td>
          <td><span className={`badge badge-${s.active ? 'ok' : 'neutral'}`}>{s.active ? 'Active' : 'Expired'}</span></td>
        </tr>)}</tbody>
      </table></div> : <p className="account-meta">No subscriptions yet.</p>}
    </section>
    {data.actions.length > 0 && <section className="admin-section" aria-labelledby="actions-title">
      <h2 id="actions-title">Recent admin actions <small>latest {data.actions.length}</small></h2>
      <div className="table-wrap"><table className="admin-table">
        <thead><tr><th scope="col">Date</th><th scope="col">Admin</th><th scope="col">Action</th><th scope="col">Details</th></tr></thead>
        <tbody>{data.actions.map(a => <tr key={a.key}><td className="nowrap">{a.date}</td><td className="break-all">{a.admin}</td><td>{a.action}</td><td className="break-all">{a.summary}</td></tr>)}</tbody>
      </table></div>
    </section>}
    <p className="auth-foot"><Link className="text-link" href="/account">Back to your account</Link></p>
  </PageShell>;
}
