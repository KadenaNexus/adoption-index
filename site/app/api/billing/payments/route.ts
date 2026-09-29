import { paymentInput, relaySessionPost } from '../../../../lib/site-api.ts';
import { pickPaymentResult } from '../../../../lib/wallet.ts';

// Checks a transaction hash for the account. The backend waits on BSC nodes, so the timeout sits just under Nginx's 30 s.
export async function POST(request: Request) {
  return relaySessionPost(request, '/billing/payments', { input: paymentInput, reply: pickPaymentResult, timeoutMs: 25000 });
}
