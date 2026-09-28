export const plans = {
  monthly: { name: 'Monthly', price: 9, cadence: 'month', label: '$9/month' },
  annual: { name: 'Annual', price: 79, cadence: 'year', label: '$79/year' },
} as const;
export type PlanId = keyof typeof plans;
export const billingTerms = {
  refund: 'Payments are non-refundable except where required by law.',
  cancellation: 'Cancel anytime to stop the next renewal. Access continues until the end of the paid period.',
};
export const planFrom = (value: unknown): PlanId => value === 'annual' ? 'annual' : 'monthly';
