// The "Report a data issue" form: what a report can be about and the checks on its fields. Pure functions shared by the
// form, the site's route handler and the tests; the backend (backend/src/reports.mjs) applies the same rules again.
import { METRICS, type MetricId } from './metrics.ts';

export type ReportIndicator = 'index' | MetricId | 'other';
// The Pro card names; two also carry the name their methodology card uses.
const LABELS: Record<ReportIndicator, string> = { index: 'Index score', addresses: 'Active addresses', contracts: 'New contracts deployed', tvl: 'TVL (total value locked)',
  hashrate: 'Network hashrate', commits: 'GitHub commits (developer activity)', other: 'Something else' };
export const REPORT_INDICATORS: readonly { id: ReportIndicator; label: string }[] = (['index', ...METRICS.map(m => m.id), 'other'] as ReportIndicator[]).map(id => ({ id, label: LABELS[id] }));
export const DESCRIPTION_LENGTH = { min: 10, max: 2000 } as const;
export const EVIDENCE_MAX = 500;

export const reportIndicator = (value: unknown): ReportIndicator | null => REPORT_INDICATORS.find(i => i.id === value)?.id ?? null;
export const indicatorLabel = (id: string): string => REPORT_INDICATORS.find(i => i.id === id)?.label ?? id;
/** The form's address; a link beside an indicator preselects it. */
export const reportHref = (indicator?: ReportIndicator): string => indicator ? `/report?indicator=${indicator}` : '/report';

// Text as the backend stores it. Control characters go (PostgreSQL refuses NUL), and so do the invisible and
// direction-changing characters that can make text read differently from what it is. The description keeps line breaks
// and tabs, and the joiners some scripts and emoji need; the evidence becomes one plain line.
export const cleanDescription = (value: unknown): string => typeof value === 'string' ? value.replace(/\r\n?/g, '\n').replace(/[\u0000-\u0008\u000b-\u001f\u007f-\u009f\u061c\u200b\u200e\u200f\u202a-\u202e\u2060-\u2064\u2066-\u2069\ufeff]/g, '').trim() : '';
export const cleanEvidence = (value: unknown): string => typeof value === 'string' ? value.replace(/[\u061c\u200b-\u200f\u202a-\u202e\u2060-\u2064\u2066-\u2069\ufeff]/g, '').replace(/[\u0000-\u001f\u007f-\u009f\s]+/g, ' ').trim() : '';
// A plain address only (the backend's rule), so a reply link can never carry extra recipients or headers.
const PLAIN_EMAIL = /^[a-z0-9._+-]+@[a-z0-9-]+(\.[a-z0-9-]+)*\.[a-z]{2,63}$/i;

export type ReportFields = { indicator: ReportIndicator; description: string; evidence: string; email?: string };
/** The report to send, or the code of the first field to fix (the email is optional; blank means none). */
export function reportFields(body: Record<string, unknown>): ReportFields | { error: string } {
  const indicator = reportIndicator(body.indicator);
  if (!indicator) return { error: 'invalid_indicator' };
  const description = cleanDescription(body.description);
  if (description.length < DESCRIPTION_LENGTH.min || description.length > DESCRIPTION_LENGTH.max) return { error: 'invalid_description' };
  const evidence = cleanEvidence(body.evidence);
  if (!evidence || evidence.length > EVIDENCE_MAX) return { error: 'invalid_evidence' };
  const email = typeof body.email === 'string' ? body.email.trim() : body.email == null ? '' : null;
  if (email === null) return { error: 'invalid_email' };
  if (!email) return { indicator, description, evidence };
  return email.length <= 254 && PLAIN_EMAIL.test(email) ? { indicator, description, evidence, email } : { error: 'invalid_email' };
}
