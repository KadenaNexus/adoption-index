import { alertInput, relaySessionPost } from '../../../../lib/site-api.ts';

export async function POST(request: Request) {
  return relaySessionPost(request, '/account/alerts', { input: alertInput, reply: data => ({ id: data.id }) });
}
