import { challengeInput, relaySessionPost } from '../../../../lib/site-api.ts';
import { pickChallenge } from '../../../../lib/wallet.ts';

// The message a wallet signs to be linked to the account.
export async function POST(request: Request) {
  return relaySessionPost(request, '/wallets/challenge', { input: challengeInput, reply: pickChallenge, timeoutMs: 10000 });
}
