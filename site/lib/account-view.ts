// Display logic for the account and admin pages. No JSX and no Next.js imports, so tests can import it.
import type { AccountPayment, AccountState, Subscription } from './session.ts';
import { formatDay } from './metrics.ts';

/** Pro data is requested only for a signed-in account whose subscription is active. */
export const isSubscriber = (state: AccountState): boolean => state.state === 'signed-in' && state.account.subscription?.active === true;

const PLAN_NAMES: Record<string, string> = { monthly: 'Monthly', annual: 'Annual', test: 'Test', manual: 'Complimentary' };
export const planName = (plan: string): string => PLAN_NAMES[plan] ?? plan.charAt(0).toUpperCase() + plan.slice(1);

/** "12 Oct 2026" for an ISO timestamp (UTC); an unparseable value gives "—". */
export function formatDate(value: string | null | undefined): string {
  const time = value ? Date.parse(value) : NaN;
  return Number.isFinite(time) ? formatDay(new Date(time).toISOString().slice(0, 10)) : '—';
}

export type SubscriptionStatus = { state: 'active' | 'expired' | 'none'; label: string; action: { label: 'Renew' | 'Get Pro'; href: string } };
export function subscriptionStatus(subscription: Subscription | null): SubscriptionStatus {
  if (!subscription) return { state: 'none', label: 'No subscription', action: { label: 'Get Pro', href: '/checkout' } };
  // The Renew link preselects the same public plan (a manual or test plan has no checkout page of its own).
  const href = subscription.plan === 'annual' || subscription.plan === 'monthly' ? `/checkout?plan=${subscription.plan}` : '/checkout';
  return subscription.active
    ? { state: 'active', label: `Active until ${formatDate(subscription.expiresAt)}`, action: { label: 'Renew', href } }
    : { state: 'expired', label: `Expired on ${formatDate(subscription.expiresAt)}`, action: { label: 'Renew', href } };
}

export type Tone = 'ok' | 'pending' | 'warn' | 'bad' | 'neutral';
const STATUS: Record<string, { label: string; tone: Tone }> = {
  confirmed: { label: 'Confirmed', tone: 'ok' }, pending: { label: 'Pending', tone: 'pending' },
  underpaid: { label: 'Underpaid', tone: 'warn' }, failed: { label: 'Failed', tone: 'bad' },
};
export const paymentStatus = (status: string): { label: string; tone: Tone } => STATUS[status] ?? { label: status || 'Unknown', tone: 'neutral' };

const REASONS: Record<string, string> = {
  reverted: 'The transaction failed on chain, so no tokens were sent.',
  receipt_missing: 'The transaction could not be found on chain. If it later confirms, submit the hash again or contact support.',
  underpaid: 'The amount was less than the plan price, so it did not add access.',
};
/** A reason the subscriber can read; a code we don't know gets a general line, never the raw code. */
export function failureText(status: string, reason: string | null | undefined): string | null {
  if (reason && Object.hasOwn(REASONS, reason)) return REASONS[reason];
  if (status === 'underpaid') return REASONS.underpaid;
  if (status === 'pending') return 'Waiting for the network to finalise the transaction.';
  if (status === 'failed') return 'This payment did not go through. Contact support if tokens left your wallet.';
  return null;
}

/** Only https links from the backend become anchors. */
export function safeHttpsUrl(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  try { return new URL(value).protocol === 'https:' ? value : null; } catch { return null; }
}
export const shortHash = (hash: string): string => hash.length > 20 ? `${hash.slice(0, 10)}…${hash.slice(-6)}` : hash;

export type PaymentRow = { key: string; date: string; plan: string; amount: string; status: { label: string; tone: Tone }; overpaid: boolean; note: string | null; explorerUrl: string | null; hash: string; periodEnd: string | null };
export function paymentRow(p: AccountPayment): PaymentRow {
  return {
    key: `${p.network}:${p.txHash}`, date: formatDate(p.createdAt), plan: planName(p.plan), amount: `${p.amount} ${p.token}`,
    status: paymentStatus(p.status), overpaid: p.status === 'confirmed' && p.overpaid === true,
    note: p.status === 'underpaid' && p.required ? `${p.amount} ${p.token} is less than the plan price of ${p.required} ${p.token}, so it did not add access.` : failureText(p.status, p.failureReason),
    explorerUrl: safeHttpsUrl(p.explorerUrl), hash: shortHash(p.txHash), periodEnd: p.status === 'confirmed' && p.periodEnd ? formatDate(p.periodEnd) : null,
  };
}

/** An alert level: 0 to 100000 with at most one decimal place (the index is published to one decimal). */
export function parseThreshold(value: unknown): number | null {
  const v = typeof value === 'number' && Number.isFinite(value) ? String(value) : typeof value === 'string' ? value.trim() : '';
  if (!/^\d{1,6}(\.\d)?$/.test(v)) return null;
  const n = Number(v);
  return n <= 100000 ? n : null;
}
export const MAX_ALERTS = 5;
export const alertLabel = (alert: { direction: 'above' | 'below'; threshold: number }): string =>
  `${alert.direction === 'above' ? 'Rises to or above' : 'Falls to or below'} ${Number(alert.threshold).toFixed(1)}`;
