import type { Metadata } from 'next';
import Link from 'next/link';
import { PageShell } from '../../index-view';
import VerifyForm from './verify-form';
// The token arrives in the URL fragment, so it never reaches server logs; no-referrer keeps the page URL out of
// any outgoing request (next.config.ts sends the same policy as a header).
export const metadata: Metadata = { title: 'Continue signing in | Kadena Community Edition Adoption Index', robots: { index: false, follow: false }, referrer: 'no-referrer' };

export default function Verify() {
  return <PageShell>
    <section className="hero"><h1>Continue signing in</h1><p>One more step: confirm it is you opening this link.</p></section>
    <section className="auth-card" aria-label="Confirm sign-in"><VerifyForm/></section>
    <p className="auth-foot"><Link className="text-link" href="/">Back to today’s index</Link></p>
  </PageShell>;
}
