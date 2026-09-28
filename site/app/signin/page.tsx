import type { Metadata } from 'next';
import Link from 'next/link';
import { PageShell } from '../index-view';
import LockIcon from '../lock-icon';
export const metadata: Metadata = { title: 'Sign in | Kadena Community Edition Adoption Index', robots: { index: false, follow: false } };
export default function SignIn() {
  return <PageShell>
    <section className="hero"><h1>Sign in</h1><p>Pro accounts open when subscriptions launch.</p></section>
    <section className="notice-card">
      <span className="lock-icon"><LockIcon size={34}/></span>
      <h2>Subscriber sign-in is coming soon</h2>
      <p>Today’s index stays free for everyone. Sign-in will unlock historical charts, the index breakdown and 7-day and 30-day change once Pro is available.</p>
      <div className="notice-actions"><Link className="button" href="/access">See Pro plans</Link><Link className="text-link" href="/">Back to today’s index</Link></div>
    </section>
    </PageShell>;
}
