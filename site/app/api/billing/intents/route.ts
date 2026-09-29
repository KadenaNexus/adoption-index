import { intentInput, relaySessionPost } from '../../../../lib/site-api.ts';
import { pickIntent } from '../../../../lib/wallet.ts';

// A payment intent: the exact amount, token and address the checkout builds its transfer from.
export async function POST(request: Request) {
  return relaySessionPost(request, '/billing/intents', { input: intentInput, reply: pickIntent, timeoutMs: 10000 });
}
