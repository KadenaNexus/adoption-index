import { relaySessionPost, resolveInput } from '../../../../lib/site-api.ts';

// Marks an unmatched transfer as handled, with the admin's note.
export async function POST(request: Request) {
  return relaySessionPost(request, '/admin/unmatched/resolve', { input: resolveInput, reply: () => ({ ok: true }) });
}
