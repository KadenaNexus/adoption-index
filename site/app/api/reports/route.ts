import { backendFetch } from '../../../lib/backend.ts';
import { reportFields } from '../../../lib/report.ts';
import { clientIpFrom, sameOrigin } from '../../../lib/request-guard.ts';
import { errorResponse, forbidden, json, readJsonBody, sessionFromCookies } from '../../../lib/site-api.ts';

// A report from the "Report a data issue" form. Anyone may send one. A session, when there is one, goes along only so the
// backend can spare a subscriber its daily cap; it is never stored with the report.
export async function POST(request: Request) {
  if (!sameOrigin(request)) return forbidden();
  // A description of 2,000 characters can take up to 6 KB as UTF-8, and more once JSON escapes it.
  const body = await readJsonBody(request, 16384);
  if (body instanceof Response) return body;
  // People never see the hidden field; a bot that fills it in gets the usual answer and nothing is stored. The log line
  // (no content) shows whether real visitors ever trip it.
  if (typeof body.hp === 'string' && body.hp !== '') { console.warn(JSON.stringify({ event: 'report_honeypot' })); return json({ ok: true }, 202); }
  const input = reportFields(body);
  if ('error' in input) return json(input, 400);
  const result = await backendFetch('/reports', { method: 'POST', body: input, session: sessionFromCookies(request.headers.get('cookie')), clientIp: clientIpFrom(request.headers), timeoutMs: 10000 });
  return result.status >= 200 && result.status < 300 ? json({ ok: true }, 202) : errorResponse(result);
}
