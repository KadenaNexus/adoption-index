'use client';
import { useState, useTransition, type FormEvent } from 'react';
import { useRouter } from 'next/navigation';
import { errorMessage } from '../../lib/messages';
import { postJson } from '../../lib/post-json';

// One unmatched transfer: a note and a Resolve button.
export default function ResolveForm({ network, txHash, logIndex }: { network: string; txHash: string; logIndex: number }) {
  const router = useRouter();
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [refreshing, startRefresh] = useTransition();

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!note.trim()) { setError(errorMessage('invalid_note')); return; }
    setBusy(true); setError(null);
    const { ok, data } = await postJson('/api/admin/resolve', { network, txHash, logIndex, note: note.trim() });
    setBusy(false);
    if (!ok) { setError(errorMessage(data.error, 'resolve')); return; }
    startRefresh(() => router.refresh());
  }

  return <form className="resolve-form" onSubmit={submit} noValidate>
    <input className="field" type="text" aria-label={`Resolution note for log ${logIndex} of ${txHash}`} placeholder="Note, e.g. credited to a@b.co" maxLength={500} value={note} onChange={e => setNote(e.target.value)}/>
    <button className="button button-small" type="submit" disabled={busy || refreshing}>{busy || refreshing ? 'Saving…' : 'Resolve'}</button>
    {error && <p className="form-error" role="alert">{error}</p>}
  </form>;
}
