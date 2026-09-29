'use client';
import { useState } from 'react';
import { errorMessage } from '../../lib/messages';
import { postJson } from '../../lib/post-json';

export default function SignOutButton() {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  async function signOut() {
    setBusy(true); setError(null);
    const { ok, data } = await postJson('/api/auth/logout');
    if (!ok) { setBusy(false); setError(errorMessage(data.error, 'signout')); return; }
    // A full page load, so no signed-in page stays in the client router cache on a shared computer.
    // eslint-disable-next-line @next/next/no-location-assign-relative-destination
    window.location.assign('/');
  }
  return <div className="sign-out">
    <button className="button button-outline" type="button" onClick={signOut} disabled={busy}>{busy ? 'Signing out…' : 'Sign out'}</button>
    {error && <p className="form-error" role="alert">{error}</p>}
  </div>;
}
