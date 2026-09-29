import { record } from '../../../../lib/payload.ts';
import { extendInput, relaySessionPost } from '../../../../lib/site-api.ts';

// Adds days to a subscriber's access (or creates it); the backend records who did it and why.
export async function POST(request: Request) {
  return relaySessionPost(request, '/admin/subscriptions/extend', {
    input: extendInput,
    reply: data => { const s = record(data.subscription); return { subscription: s ? { plan: s.plan, startedAt: s.startedAt, expiresAt: s.expiresAt, active: s.active } : null, userCreated: data.userCreated === true }; },
  });
}
