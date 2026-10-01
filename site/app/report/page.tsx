import type { Metadata } from 'next';
import Link from 'next/link';
import { PageShell } from '../index-view';
import { reportIndicator } from '../../lib/report';
import { getAccountState } from '../../lib/session';
import ReportForm from './report-form';
export const metadata: Metadata = { title: 'Report a data issue | Kadena Community Edition Adoption Index', robots: { index: false, follow: false } };
export const dynamic = 'force-dynamic';

// Open to everyone. A signed-in visitor finds their email filled in; it stays optional and can be cleared.
export default async function Report({ searchParams }: { searchParams: Promise<{ indicator?: string | string[] }> }) {
  const raw = (await searchParams).indicator;
  const state = await getAccountState();
  return <PageShell>
    <section className="hero"><h1>Report a data issue</h1><p>If a published number looks wrong, tell us which indicator, what you saw and where we can check it.</p></section>
    <section className="auth-card report-card" aria-label="Report a data issue">
      <ReportForm indicator={reportIndicator(Array.isArray(raw) ? raw[0] : raw)} email={state.state === 'signed-in' ? state.account.email : ''}/>
    </section>
    <p className="auth-foot"><Link className="text-link" href="/methodology">How each indicator is measured</Link></p>
  </PageShell>;
}
