import { relaySessionPost, reportResolveInput } from '../../../../../lib/site-api.ts';

// Closes a data issue report with the admin's note.
export async function POST(request: Request) {
  return relaySessionPost(request, '/admin/reports/resolve', { input: reportResolveInput, reply: () => ({ ok: true }) });
}
