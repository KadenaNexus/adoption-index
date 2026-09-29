'use client';
import { useEffect, useRef, useState, type FormEvent } from 'react';
import { codeInput } from '../../lib/keyboard-input';
import { errorMessage } from '../../lib/messages';
import { afterSignIn } from '../../lib/safe-next';
import { postJson } from '../../lib/post-json';

// Step 1 sends the email; step 2 accepts the 6-digit code from it, so a phone user can finish in whatever browser
// (for example a wallet's in-app browser) they started in. The link in the email works too.
export default function SignInForm({ next }: { next: string | null }) {
  const [email, setEmail] = useState('');
  const [sentTo, setSentTo] = useState<string | null>(null);
  const [code, setCode] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [resent, setResent] = useState(false);
  const sentHeading = useRef<HTMLHeadingElement>(null);
  // The form (and its focused button) is replaced, so focus moves to the new heading and screen readers announce it.
  useEffect(() => { if (sentTo) sentHeading.current?.focus(); }, [sentTo]);

  async function requestLink(address: string) {
    setBusy(true); setError(null);
    const { ok, data } = await postJson('/api/auth/request-link', next ? { email: address, next } : { email: address });
    setBusy(false);
    if (!ok) { setError(errorMessage(data.error, 'signin')); return false; }
    setSentTo(address); setCode('');
    return true;
  }
  async function sendEmail(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    await requestLink(email.trim());
  }
  async function verifyCode(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const digits = code.replace(/\D/g, '');
    if (digits.length !== 6) { setError(errorMessage('invalid_code')); return; }
    setBusy(true); setError(null);
    const { ok, data } = await postJson('/api/auth/verify-code', { email: sentTo, code: digits });
    if (!ok) { setBusy(false); setError(errorMessage(data.error, 'code')); return; }
    // A full navigation, so every server component sees the new session cookie.
    window.location.assign(afterSignIn(data.next));
  }

  if (!sentTo) return <form className="auth-form" onSubmit={sendEmail} noValidate>
    <label className="field-label" htmlFor="signin-email">Email address</label>
    <input id="signin-email" className="field" type="email" name="email" autoComplete="email" inputMode="email" required maxLength={254}
      value={email} onChange={e => setEmail(e.target.value)} aria-invalid={!!error} aria-describedby={error ? 'signin-error' : undefined}/>
    {error && <p id="signin-error" className="form-error" role="alert">{error}</p>}
    <button className="button" type="submit" disabled={busy || !email.trim()}>{busy ? 'Sending…' : 'Email me a sign-in link'}</button>
  </form>;

  return <div className="auth-sent">
    <h2 ref={sentHeading} tabIndex={-1}>Check your email</h2>
    <p>We sent a sign-in link and a 6-digit code to <b className="break-all">{sentTo}</b>. Both work for 15 minutes.</p>
    <form className="auth-form" onSubmit={verifyCode} noValidate>
      <label className="field-label" htmlFor="signin-code">6-digit code</label>
      <input id="signin-code" className="field field-code" type="text" name="code" autoComplete="one-time-code" inputMode="numeric" pattern="[0-9]*" maxLength={7}
        value={code} onChange={e => setCode(codeInput(e.target.value))} aria-invalid={!!error} aria-describedby={error ? 'code-error' : undefined}/>
      {error && <p id="code-error" className="form-error" role="alert">{error}</p>}
      <button className="button" type="submit" disabled={busy}>{busy ? 'Checking…' : 'Sign in'}</button>
    </form>
    <p className="auth-help">No email? Check spam, or{' '}
      <button type="button" className="link-button" disabled={busy} onClick={async () => { setResent(await requestLink(sentTo)); }}>send a new one</button>
      {' '}·{' '}<button type="button" className="link-button" disabled={busy} onClick={() => { setSentTo(null); setError(null); setResent(false); }}>use a different email</button>
    </p>
    {resent && !error && <p className="form-success" role="status">A new email is on its way. Use the newest code.</p>}
  </div>;
}
