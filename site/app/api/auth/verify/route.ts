import { backendFetch } from '../../../../lib/backend.ts';
import { clientIpFrom, sameOrigin } from '../../../../lib/request-guard.ts';
import { completeSignIn, forbidden, json, readJsonBody, sessionFromCookies, verifyTokenInput } from '../../../../lib/site-api.ts';

// Consumes the emailed link token. Only a POST does, so mail scanners that prefetch the link cannot use it up.
export async function POST(request: Request) {
  if (!sameOrigin(request)) return forbidden();
  const body = await readJsonBody(request);
  if (body instanceof Response) return body;
  const input = verifyTokenInput(body);
  if ('error' in input) return json(input, 400);
  const clientIp = clientIpFrom(request.headers);
  const result = await backendFetch('/auth/verify', { method: 'POST', body: input, clientIp, timeoutMs: 10000 });
  return completeSignIn(result, sessionFromCookies(request.headers.get('cookie')), clientIp);
}
