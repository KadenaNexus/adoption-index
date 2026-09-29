export const plans = {
  monthly: { name: 'Monthly', price: 9, days: 30 },
  annual: { name: 'Annual', price: 79, days: 365 },
} as const;
export type PlanId = keyof typeof plans;
// Wallet payments cannot be charged again automatically, so each payment buys a fixed period.
export const billingTerms = {
  refund: 'Payments are non-refundable except where required by law.',
  renewal: 'Each payment buys 30 days (Monthly) or 365 days (Annual) of access. Nothing renews automatically: we email you 7 days and 1 day before it ends.',
};
