import type { Metadata } from 'next';
import Link from 'next/link';
import { redirect } from 'next/navigation';
import { PageShell } from '../index-view';
import { afterSignIn, safeNextPath } from '../../lib/safe-next';
import { getAccountState } from '../../lib/session';
import SignInForm from './signin-form';
export const metadata: Metadata = { title: 'Sign in | Kadena Community Edition Adoption Index', robots: { index: false, follow: false } };
export const dynamic = 'force-dynamic';

// "Already signed in" is decided by the backend, never by the cookie alone, so a stale cookie cannot loop
// between /signin and /account.
export default async function SignIn({ searchParams }: { searchParams: Promise<{ next?: string | string[] }> }) {
  const raw = (await searchParams).next;
  const next = safeNextPath(Array.isArray(raw) ? raw[0] : raw);
  const state = await getAccountState();
  if (state.state === 'signed-in') redirect(afterSignIn(next));
  return <PageShell>
    <section className="hero"><h1>Sign in</h1><p>We email you a sign-in link and a 6-digit code. No password needed.</p></section>
    {state.state === 'unavailable' && <p className="form-notice" role="status">We couldn’t check whether you are already signed in. You can still sign in below.</p>}
    <section className="auth-card" aria-label="Sign in with email">
      <SignInForm next={next}/>
    </section>
    <p className="auth-foot">New to Pro? <Link className="text-link" href="/access">See the plans</Link></p>
  </PageShell>;
}
