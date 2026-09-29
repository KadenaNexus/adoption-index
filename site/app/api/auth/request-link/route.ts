import { backendFetch } from '../../../../lib/backend.ts';
import { clientIpFrom, sameOrigin } from '../../../../lib/request-guard.ts';
import { errorResponse, forbidden, json, readJsonBody, requestLinkInput } from '../../../../lib/site-api.ts';

// Sends the sign-in email (a link and a 6-digit code). The backend waits up to 10 s for the mail provider.
export async function POST(request: Request) {
  if (!sameOrigin(request)) return forbidden();
  const body = await readJsonBody(request);
  if (body instanceof Response) return body;
  const input = requestLinkInput(body);
  if ('error' in input) return json(input, 400);
  const result = await backendFetch('/auth/request-link', { method: 'POST', body: input, clientIp: clientIpFrom(request.headers), timeoutMs: 15000 });
  return result.status >= 200 && result.status < 300 ? json({ ok: true }, 202) : errorResponse(result);
}
