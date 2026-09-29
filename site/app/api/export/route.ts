import { backendResponse } from '../../../lib/backend.ts';
import { clientIpFrom } from '../../../lib/request-guard.ts';
import { csvDownload, sessionFromCookies } from '../../../lib/site-api.ts';
export const dynamic = 'force-dynamic';

// A plain link on the account page: the browser downloads the backend's CSV, streamed through unchanged.
export async function GET(request: Request) {
  const session = sessionFromCookies(request.headers.get('cookie'));
  if (!session) return new Response(null, { status: 303, headers: { Location: '/signin?next=/account', 'Cache-Control': 'no-store' } });
  return csvDownload(await backendResponse('/export.csv', { session, clientIp: clientIpFrom(request.headers), timeoutMs: 20000 }));
}
