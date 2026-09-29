'use client';
import { useState, useTransition, type FormEvent } from 'react';
import { useRouter } from 'next/navigation';
import { MAX_ALERTS, alertLabel, parseThreshold } from '../../lib/account-view';
import { levelInput } from '../../lib/keyboard-input';
import { errorMessage } from '../../lib/messages';
import { postJson } from '../../lib/post-json';

type Alert = { id: number; direction: 'above' | 'below'; threshold: number };
// Errors about the level typed in; only these mark the field invalid (a failed delete or a network error does not).
const LEVEL_ERRORS = new Set(['invalid_threshold', 'invalid_alert', 'invalid_direction', 'duplicate_alert']);

// Adds and deletes alert rules, then reloads the account data from the server.
export default function AlertsForm({ alerts, canAdd }: { alerts: Alert[]; canAdd: boolean }) {
  const router = useRouter();
  const [direction, setDirection] = useState<'above' | 'below'>('above');
  const [threshold, setThreshold] = useState('');
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<{ message: string; field: boolean } | null>(null);
  const [refreshing, startRefresh] = useTransition();
  const full = alerts.length >= MAX_ALERTS;

  async function add(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const value = parseThreshold(threshold);
    if (value === null) { setError({ message: errorMessage('invalid_threshold'), field: true }); return; }
    setBusy('add'); setError(null);
    const { ok, data } = await postJson('/api/account/alerts', { direction, threshold: value });
    setBusy(null);
    if (!ok) { setError({ message: errorMessage(data.error, 'alerts'), field: LEVEL_ERRORS.has(data.error ?? '') }); return; }
    setThreshold('');
    startRefresh(() => router.refresh());
  }
  async function remove(id: number) {
    setBusy(`delete:${id}`); setError(null);
    const { ok, data } = await postJson('/api/account/alerts/delete', { id });
    setBusy(null);
    if (!ok) { setError({ message: errorMessage(data.error, 'alert-delete'), field: false }); return; }
    startRefresh(() => router.refresh());
  }

  const working = busy !== null || refreshing;
  return <div className="alerts">
    {alerts.length > 0 && <ul className="alert-list">
      {alerts.map(a => <li key={a.id}>
        <span>{alertLabel(a)}</span>
        <button type="button" className="link-button" onClick={() => remove(a.id)} disabled={working} aria-label={`Delete alert: ${alertLabel(a)}`}>{busy === `delete:${a.id}` ? 'Deleting…' : 'Delete'}</button>
      </li>)}
    </ul>}
    {canAdd && !full && <form className="alert-form" onSubmit={add} noValidate>
      <label className="field-label" htmlFor="alert-direction">Email me when the index</label>
      <div className="alert-row">
        <select id="alert-direction" className="field" value={direction} onChange={e => setDirection(e.target.value === 'below' ? 'below' : 'above')}>
          <option value="above">rises to or above</option>
          <option value="below">falls to or below</option>
        </select>
        <input className="field field-number" type="text" inputMode="decimal" aria-label="Index level" placeholder="e.g. 60" maxLength={8}
          value={threshold} onChange={e => setThreshold(levelInput(e.target.value))} aria-invalid={error?.field === true} aria-describedby={error?.field ? 'alert-error' : undefined}/>
        <button className="button" type="submit" disabled={working || !threshold}>{busy === 'add' ? 'Adding…' : 'Add alert'}</button>
      </div>
    </form>}
    {canAdd && full && <p className="account-meta">You have {MAX_ALERTS} alerts, the most allowed. Delete one to add another.</p>}
    {error && <p id="alert-error" className="form-error" role="alert">{error.message}</p>}
  </div>;
}
