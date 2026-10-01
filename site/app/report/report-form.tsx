'use client';
import Link from 'next/link';
import { useEffect, useRef, useState, type FormEvent } from 'react';
import { errorMessage } from '../../lib/messages';
import { postJson } from '../../lib/post-json';
import { DESCRIPTION_LENGTH, EVIDENCE_MAX, REPORT_INDICATORS, cleanDescription, reportFields, type ReportIndicator } from '../../lib/report';

type Field = 'indicator' | 'description' | 'evidence' | 'email';
// An error about one field marks that field and moves focus to it, so its message is read with it; any other error is
// announced next to the button.
const FIELD_OF: Record<string, Field> = { invalid_indicator: 'indicator', invalid_description: 'description', invalid_evidence: 'evidence', invalid_email: 'email' };

export default function ReportForm({ indicator: preset, email: accountEmail }: { indicator: ReportIndicator | null; email: string }) {
  const [indicator, setIndicator] = useState<string>(preset ?? '');
  const [description, setDescription] = useState('');
  const [evidence, setEvidence] = useState('');
  const [email, setEmail] = useState(accountEmail);
  const [hp, setHp] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<{ message: string; field: Field | null } | null>(null);
  // The address a reply may go to once sent ('' when none was given); null while the form is showing.
  const [sentTo, setSentTo] = useState<string | null>(null);
  const sentHeading = useRef<HTMLHeadingElement>(null), another = useRef(false);
  // Whichever view replaces the other takes focus: the confirmation heading, or the first field for another report.
  useEffect(() => {
    if (sentTo !== null) sentHeading.current?.focus();
    else if (another.current) { another.current = false; document.getElementById('report-indicator')?.focus(); }
  }, [sentTo]);
  // Focus is moved after the message renders, so it is read as part of the field. A field that already has focus (Enter
  // pressed in it) is blurred first, or the screen reader would not read it again.
  useEffect(() => {
    const field = error?.field ? document.getElementById(`report-${error.field}`) : null;
    if (field === document.activeElement) field?.blur();
    field?.focus();
  }, [error]);

  const fail = (code: string | undefined) => setError({ message: errorMessage(code, 'report'), field: code && Object.hasOwn(FIELD_OF, code) ? FIELD_OF[code] : null });
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const fields = reportFields({ indicator, description, evidence, email });
    if ('error' in fields) { fail(fields.error); return; }
    setBusy(true); setError(null);
    const { ok, data } = await postJson('/api/reports', { ...fields, hp });
    setBusy(false);
    if (!ok) { fail(data.error); return; }
    setSentTo(fields.email ?? '');
  }
  function reportAnother() { another.current = true; setDescription(''); setEvidence(''); setError(null); setSentTo(null); }

  if (sentTo !== null) return <div className="auth-sent">
    <h2 ref={sentHeading} tabIndex={-1}>Thank you, your report is in</h2>
    <p>{sentTo ? <>We’ll check it against the source data and write to <b className="break-all">{sentTo}</b> if we need more detail. No confirmation email is sent.</> : 'We’ll check it against the source data.'}</p>
    <div className="notice-actions"><Link className="button" href="/">Back to today’s index</Link><button type="button" className="link-button" onClick={reportAnother}>Report another issue</button></div>
  </div>;

  const invalid = (field: Field) => error?.field === field;
  const describedBy = (field: Field, hint: string) => invalid(field) ? `report-error ${hint}` : hint;
  const fieldError = (field: Field) => invalid(field) && <p id="report-error" className="form-error">{error?.message}</p>;
  return <form className="report-form" onSubmit={submit} noValidate>
    <div className="report-field">
      <label className="field-label" htmlFor="report-indicator">Indicator</label>
      <select id="report-indicator" className="field" required value={indicator} onChange={e => setIndicator(e.target.value)} aria-invalid={invalid('indicator')} aria-describedby={invalid('indicator') ? 'report-error' : undefined}>
        <option value="" disabled>Choose an indicator</option>
        {REPORT_INDICATORS.map(i => <option key={i.id} value={i.id}>{i.label}</option>)}
      </select>
      {fieldError('indicator')}
    </div>
    <div className="report-field">
      <label className="field-label" htmlFor="report-description">Issue description</label>
      <textarea id="report-description" className="field" required rows={6} maxLength={DESCRIPTION_LENGTH.max} value={description} onChange={e => setDescription(e.target.value)}
        aria-invalid={invalid('description')} aria-describedby={describedBy('description', 'report-description-hint')}/>
      <p id="report-description-hint" className="field-hint">What looks wrong, and what you expected instead. {cleanDescription(description).length.toLocaleString('en-US')} of {DESCRIPTION_LENGTH.max.toLocaleString('en-US')} characters, at least {DESCRIPTION_LENGTH.min}.</p>
      {fieldError('description')}
    </div>
    <div className="report-field">
      <label className="field-label" htmlFor="report-evidence">Supporting link or transaction ID</label>
      <input id="report-evidence" className="field" type="text" required autoComplete="off" spellCheck={false} maxLength={EVIDENCE_MAX} value={evidence} onChange={e => setEvidence(e.target.value)}
        aria-invalid={invalid('evidence')} aria-describedby={describedBy('evidence', 'report-evidence-hint')}/>
      <p id="report-evidence-hint" className="field-hint">For example a block explorer page, a request key or transaction hash, or a GitHub link.</p>
      {fieldError('evidence')}
    </div>
    <div className="report-field">
      <label className="field-label" htmlFor="report-email">Email for follow-up <span className="field-optional">(optional)</span></label>
      <input id="report-email" className="field" type="email" autoComplete="email" inputMode="email" maxLength={254} value={email} onChange={e => setEmail(e.target.value)}
        aria-invalid={invalid('email')} aria-describedby={describedBy('email', 'report-email-hint')}/>
      <p id="report-email-hint" className="field-hint">Only used to reply about this report.</p>
      {fieldError('email')}
    </div>
    {/* Hidden from people and screen readers, and named so autofill leaves it alone. A bot that fills it in is answered as usual and nothing is stored. */}
    <div className="hp-field" aria-hidden="true">
      <label htmlFor="report-hp">Leave this empty</label>
      <input id="report-hp" type="text" name="kce_hp" tabIndex={-1} autoComplete="off" data-1p-ignore="" data-lpignore="true" data-bwignore="" data-form-type="other" value={hp} onChange={e => setHp(e.target.value)}/>
    </div>
    {error && !error.field && <p id="report-error" className="form-error" role="alert">{error.message}</p>}
    <button className="button" type="submit" disabled={busy}>{busy ? 'Sending…' : 'Send report'}</button>
  </form>;
}
