// Parses GET /admin/overview for the admin page. Amounts come in token units and flags already decided by the backend.
import { formatDate, paymentStatus, planName, safeHttpsUrl, shortHash, type Tone } from './account-view.ts';
import { record, type Payload } from './payload.ts';

const str = (row: Payload, name: string): string => { const v = row[name]; return typeof v === 'string' ? v : typeof v === 'number' ? String(v) : ''; };
const num = (row: Payload, name: string): number | null => { const v = row[name]; return typeof v === 'number' && Number.isFinite(v) ? v : null; };

export type AdminPayment = { key: string; date: string; email: string; plan: string; network: string; amount: string; required: string; status: { label: string; tone: Tone };
  marker: 'overpaid' | 'underpaid' | null; reason: string | null; source: string; hash: string; explorerUrl: string | null };
export type AdminUnmatched = { key: string; network: string; txHash: string; hash: string; logIndex: number; from: string; token: string; amount: string; block: string; seen: string;
  note: string | null; resolved: boolean; explorerUrl: string | null };
export type AdminSubscription = { key: string; email: string; plan: string; started: string; expires: string; active: boolean };
export type AdminAction = { key: string; date: string; admin: string; action: string; summary: string };
export type AdminCounts = { users: number | null; activeSubscriptions: number | null; confirmedPayments: number | null; pendingPayments: number | null; unresolvedTransfers: number | null; queuedEmails: number | null; failedEmails: number | null };
export type AdminOverview = { testnet: boolean; payments: AdminPayment[]; unmatched: AdminUnmatched[]; subscriptions: AdminSubscription[]; actions: AdminAction[]; counts: AdminCounts };

function payment(row: Payload, i: number): AdminPayment {
  const network = str(row, 'network'), hash = str(row, 'txHash'), status = str(row, 'status'), token = str(row, 'token');
  const amount = str(row, 'amount'), required = str(row, 'required');
  const marker = status === 'underpaid' ? 'underpaid' : status === 'confirmed' && row.overpaid === true ? 'overpaid' : null;
  return { key: `${network}:${hash}:${i}`, date: formatDate(str(row, 'createdAt')), email: str(row, 'email'), plan: planName(str(row, 'plan')), network,
    amount: amount ? `${amount} ${token}`.trim() : '—', required: required ? `${required} ${token}`.trim() : '—', status: paymentStatus(status), marker,
    reason: str(row, 'failureReason') || null, source: str(row, 'source'), hash: shortHash(hash), explorerUrl: safeHttpsUrl(row.explorerUrl) };
}
function unmatched(row: Payload, i: number): AdminUnmatched {
  const network = str(row, 'network'), txHash = str(row, 'txHash'), logIndex = num(row, 'logIndex');
  // A token the backend has no decimals for keeps its raw base-unit amount.
  const amount = num(row, 'decimals') === null ? `${str(row, 'amountBaseUnits')} base units of` : str(row, 'amount');
  return { key: `${network}:${txHash}:${logIndex}:${i}`, network, txHash, hash: shortHash(txHash), logIndex: logIndex ?? -1, from: str(row, 'from'), token: str(row, 'token'), amount,
    block: str(row, 'blockNumber'), seen: formatDate(str(row, 'seenAt')), note: str(row, 'resolvedNote') || null, resolved: row.resolved === true, explorerUrl: safeHttpsUrl(row.explorerUrl) };
}
function subscription(row: Payload, i: number): AdminSubscription {
  return { key: `${str(row, 'email')}:${i}`, email: str(row, 'email'), plan: planName(str(row, 'plan')), started: formatDate(str(row, 'startedAt')),
    expires: formatDate(str(row, 'expiresAt')), active: row.active === true };
}
const ACTIONS: Record<string, string> = { extend_subscription: 'Extended subscription', resolve_unmatched: 'Resolved transfer' };
function action(row: Payload, i: number): AdminAction {
  const d = record(row.details) ?? {}, name = str(row, 'action');
  const parts = [str(d, 'email'), d.days !== undefined ? `+${str(d, 'days')} days` : '', str(d, 'txHash') ? shortHash(str(d, 'txHash')) : '', str(d, 'note') ? `“${str(d, 'note').slice(0, 140)}”` : ''].filter(Boolean);
  return { key: `${str(row, 'id')}:${i}`, date: formatDate(str(row, 'createdAt')), admin: str(row, 'adminEmail'), action: ACTIONS[name] ?? name, summary: parts.join(' · ') };
}
const rows = (value: unknown): Payload[] => Array.isArray(value) ? value.map(record).filter((r): r is Payload => !!r) : [];

export function parseOverview(data: unknown): AdminOverview | null {
  const p = record(data);
  if (!p || !Array.isArray(p.payments) || !Array.isArray(p.unmatched) || !Array.isArray(p.subscriptions)) return null;
  const list = rows(p.unmatched).map(unmatched);
  // Unresolved transfers first, whatever order the backend used.
  const ordered = [...list.filter(u => !u.resolved), ...list.filter(u => u.resolved)];
  const c = record(p.counts) ?? {};
  return { testnet: p.testnet === true, payments: rows(p.payments).map(payment), unmatched: ordered, subscriptions: rows(p.subscriptions).map(subscription),
    actions: rows(p.actions).map(action),
    counts: { users: num(c, 'users'), activeSubscriptions: num(c, 'activeSubscriptions'), confirmedPayments: num(c, 'confirmedPayments'),
      pendingPayments: num(c, 'pendingPayments'), unresolvedTransfers: num(c, 'unresolvedTransfers'), queuedEmails: num(c, 'queuedEmails'), failedEmails: num(c, 'failedEmails') } };
}
