import { billingTerms, plans, type PlanId } from '../lib/billing-terms.ts';
const escape = (value: string) => value.replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
// Template only. The future billing webhook must verify payment before using it.
// No mail client, checkout completion, payment processing, or sender is configured here.
export function subscriptionConfirmation({ planId, paidThrough, receiptId }: { planId: PlanId; paidThrough: string; receiptId: string }) {
  const plan = plans[planId];
  const lines = [
    'Your Index Pro subscription is active.',
    `Plan: ${plan.name} — ${plan.label}.`,
    `Paid access through: ${paidThrough}.`,
    `Renews at ${plan.label} until cancelled.`,
    billingTerms.cancellation,
    billingTerms.refund,
    `Receipt: ${receiptId}.`,
    'Kadena Community Edition Adoption Index',
  ];
  return { subject: 'Your Index Pro subscription confirmation', text: lines.join('\n\n'), html: `<main>${lines.map(line => `<p>${escape(line)}</p>`).join('')}</main>` };
}
