import { alertDeleteInput, relaySessionPost } from '../../../../../lib/site-api.ts';

export async function POST(request: Request) {
  return relaySessionPost(request, '/account/alerts/delete', { input: alertDeleteInput, reply: () => ({ ok: true }) });
}
