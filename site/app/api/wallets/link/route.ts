import { linkInput, relaySessionPost } from '../../../../lib/site-api.ts';
import { pickLink } from '../../../../lib/wallet.ts';

// Links the wallet that signed the challenge.
export async function POST(request: Request) {
  return relaySessionPost(request, '/wallets/link', { input: linkInput, reply: pickLink, timeoutMs: 10000 });
}
