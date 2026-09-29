import { backendFetch } from '../../../../lib/backend.ts';
import { clientIpFrom, sameOrigin } from '../../../../lib/request-guard.ts';
import { clearedSessionCookie, forbidden, json, sessionFromCookies } from '../../../../lib/site-api.ts';

// Ends the session on the backend when it can; the cookie is removed whatever the backend answers.
export async function POST(request: Request) {
  if (!sameOrigin(request)) return forbidden();
  const session = sessionFromCookies(request.headers.get('cookie'));
  if (session) await backendFetch('/auth/logout', { method: 'POST', session, clientIp: clientIpFrom(request.headers), timeoutMs: 5000 });
  return json({ ok: true }, 200, [clearedSessionCookie()]);
}
