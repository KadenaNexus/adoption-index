import { backendFetch } from '../../../../lib/backend.ts';
import { clientIpFrom, sameOrigin } from '../../../../lib/request-guard.ts';
import { completeSignIn, forbidden, json, readJsonBody, sessionFromCookies, verifyCodeInput } from '../../../../lib/site-api.ts';

// The 6-digit code from the sign-in email, for browsers that can't open the link (wallet in-app browsers).
export async function POST(request: Request) {
  if (!sameOrigin(request)) return forbidden();
  const body = await readJsonBody(request);
  if (body instanceof Response) return body;
  const input = verifyCodeInput(body);
  if ('error' in input) return json(input, 400);
  const clientIp = clientIpFrom(request.headers);
  const result = await backendFetch('/auth/verify-code', { method: 'POST', body: input, clientIp, timeoutMs: 10000 });
  return completeSignIn(result, sessionFromCookies(request.headers.get('cookie')), clientIp);
}
