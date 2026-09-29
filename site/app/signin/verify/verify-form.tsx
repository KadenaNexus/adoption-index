'use client';
import { useEffect, useState } from 'react';
import Link from 'next/link';
import { errorMessage } from '../../../lib/messages';
import { postJson } from '../../../lib/post-json';
import { afterSignIn } from '../../../lib/safe-next';
import { tokenFromFragment } from '../../../lib/sign-in';

// The link token is used only when the button is pressed: mail scanners that open links never POST it.
export default function VerifyForm() {
  const [token, setToken] = useState<string | null | undefined>(undefined);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<{ code: string; text: string } | null>(null);

  useEffect(() => {
    const found = tokenFromFragment(window.location.hash);
    // Clear the fragment at once so the token is not left in the address bar or the history entry.
    if (window.location.hash) window.history.replaceState(null, '', window.location.pathname);
    // The fragment exists only in the browser, so it is read after hydration. Keeping an earlier value covers
    // effects that run twice in development.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setToken(current => found ?? current ?? null);
  }, []);

  async function continueSignIn() {
    if (!token) return;
    setBusy(true); setError(null);
    const { ok, data } = await postJson('/api/auth/verify', { token });
    if (!ok) { setBusy(false); setError({ code: String(data.error), text: errorMessage(data.error, 'verify') }); return; }
    window.location.assign(afterSignIn(data.next));
  }

  if (token === undefined) return <p className="auth-status" role="status">Reading your sign-in link…</p>;
  if (token === null) return <div className="auth-sent">
    <h2>This link is incomplete</h2>
    <p>{errorMessage('missing_token')}</p>
    <div className="notice-actions"><Link className="button" href="/signin">Request a new link</Link></div>
  </div>;
  return <div className="auth-sent">
    <p>You are signing in to the Kadena Community Edition Adoption Index.</p>
    {error && <p className="form-error" role="alert">{error.text}</p>}
    <div className="notice-actions">
      {/* A used or expired link cannot work again; anything else (an outage, a rate limit) can be retried. */}
      {error?.code === 'invalid_or_expired' ? <Link className="button" href="/signin">Request a new link</Link>
        : <button className="button" type="button" onClick={continueSignIn} disabled={busy}>{busy ? 'Signing in…' : error ? 'Try again' : 'Continue signing in'}</button>}
    </div>
  </div>;
}
