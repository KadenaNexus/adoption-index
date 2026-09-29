'use client';
import { useState, useTransition, type FormEvent } from 'react';
import { useRouter } from 'next/navigation';
import { formatDate } from '../../lib/account-view';
import { errorMessage } from '../../lib/messages';
import { postJson } from '../../lib/post-json';

export default function ExtendForm() {
  const router = useRouter();
  const [email, setEmail] = useState('');
  const [days, setDays] = useState('30');
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<string | null>(null);
  const [, startRefresh] = useTransition();

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const n = Number(days);
    if (!Number.isInteger(n) || n < 1 || n > 400) { setError(errorMessage('invalid_days')); return; }
    if (!note.trim()) { setError(errorMessage('invalid_note')); return; }
    setBusy(true); setError(null); setDone(null);
    const { ok, data } = await postJson('/api/admin/extend', { email: email.trim(), days: n, note: note.trim() });
    setBusy(false);
    if (!ok) { setError(errorMessage(data.error, 'admin')); return; }
    const subscription = data.subscription as { expiresAt?: string } | null | undefined;
    setDone(`${email.trim()} now has access until ${formatDate(subscription?.expiresAt)}.${data.userCreated === true ? ' A new account was created for this email.' : ''}`);
    setEmail(''); setNote('');
    startRefresh(() => router.refresh());
  }

  return <form className="admin-form" onSubmit={submit} noValidate>
    <div className="admin-fields">
      <label><span className="field-label">Email</span><input className="field" type="email" autoComplete="off" required maxLength={254} value={email} onChange={e => setEmail(e.target.value)}/></label>
      <label><span className="field-label">Days</span><input className="field field-number" type="number" min={1} max={400} step={1} required value={days} onChange={e => setDays(e.target.value)}/></label>
    </div>
    <label><span className="field-label">Note (why)</span><input className="field" type="text" required maxLength={500} value={note} onChange={e => setNote(e.target.value)} placeholder="e.g. Paid 9 USDT from a Binance withdrawal, tx 0x…"/></label>
    {error && <p className="form-error" role="alert">{error}</p>}
    {done && <p className="form-success" role="status">{done}</p>}
    <button className="button" type="submit" disabled={busy || !email.trim()}>{busy ? 'Saving…' : 'Extend'}</button>
  </form>;
}
