// Shared pieces of the site's own API routes (app/api/**). No Next.js imports, so tests can call the handlers.
// Handlers relay only chosen fields: a backend body is never passed through, so a session token can't reach page code.
import { backendFetch, type BackendResult } from './backend.ts';
import { clientIpFrom, sameOrigin } from './request-guard.ts';
import { parseThreshold } from './account-view.ts';
import { record, type Payload } from './payload.ts';
import { afterSignIn, safeNextPath } from './safe-next.ts';
import { SESSION_COOKIE, TOKEN_PATTERN, sessionCookieOptions } from './session-cookie.ts';
import { parseIntentId, pickError } from './wallet.ts';

export function json(body: unknown, status = 200, cookies: string[] = []): Response {
  const headers = new Headers({ 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  for (const cookie of cookies) headers.append('Set-Cookie', cookie);
  return new Response(JSON.stringify(body), { status, headers });
}
export const forbidden = () => json({ error: 'forbidden' }, 403);

/** The backend's `error` code when it is a plain code, else null. */
export function errorCode(data: unknown): string | null {
  const code = record(data)?.error;
  return typeof code === 'string' && /^[a-z0-9_]{1,64}$/.test(code) ? code : null;
}
/** A failed backend call as the same status with only the error fields pages show (see pickError). */
export function errorResponse(result: BackendResult): Response {
  const status = result.status >= 400 && result.status <= 599 ? result.status : 502;
  return json(pickError(result.data, status), status);
}

/** A small JSON object body, or the error response to send instead. */
export async function readJsonBody(request: Request, limit = 8192): Promise<Payload | Response> {
  const type = (request.headers.get('content-type') ?? '').split(';')[0].trim().toLowerCase();
  if (type !== 'application/json') return json({ error: 'json_required' }, 415);
  const declared = Number(request.headers.get('content-length'));
  if (Number.isFinite(declared) && declared > limit) return json({ error: 'payload_too_large' }, 413);
  let text: string;
  try { text = await request.text(); } catch { return json({ error: 'bad_request' }, 400); }
  if (text.length > limit) return json({ error: 'payload_too_large' }, 413);
  try { return record(JSON.parse(text)) ?? json({ error: 'invalid_json' }, 400); } catch { return json({ error: 'invalid_json' }, 400); }
}

// Session cookie, read and written without Next.js helpers. When a name repeats, the last value wins, as in next/headers.
export function sessionFromCookies(header: string | null): string | null {
  let value: string | null = null;
  for (const part of (header ?? '').split(';')) {
    const at = part.indexOf('=');
    if (at > 0 && part.slice(0, at).trim() === SESSION_COOKIE) value = part.slice(at + 1).trim();
  }
  return value && TOKEN_PATTERN.test(value) ? value : null;
}
function serializeCookie(value: string, options: ReturnType<typeof sessionCookieOptions>, maxAge?: number): string {
  return [`${SESSION_COOKIE}=${value}`, `Path=${options.path}`, `Expires=${options.expires.toUTCString()}`, maxAge === undefined ? '' : `Max-Age=${maxAge}`,
    options.secure ? 'Secure' : '', options.httpOnly ? 'HttpOnly' : '', 'SameSite=Lax'].filter(Boolean).join('; ');
}
export const sessionCookie = (token: string, expiresAt: string) => serializeCookie(token, sessionCookieOptions(expiresAt));
// Same name, path and Secure flag as when set, or a __Host- cookie would not be replaced.
export const clearedSessionCookie = () => serializeCookie('', sessionCookieOptions(new Date(0)), 0);

// Sign-in
const THIRTY_DAYS = 30 * 86_400_000;
export type SignInOutcome = { status: number; body: { next: string } | { error: string }; session?: { token: string; expiresAt: string } };
/** Maps a backend verify result: the token goes only into the cookie, the page gets `{next}` or `{error}`. */
export function signInOutcome(result: BackendResult): SignInOutcome {
  const data = record(result.data);
  if (result.status !== 200) return { status: result.status >= 400 && result.status <= 599 ? result.status : 502, body: { error: errorCode(data) ?? 'backend_unavailable' } };
  const token = data?.sessionToken;
  if (typeof token !== 'string' || !TOKEN_PATTERN.test(token)) return { status: 502, body: { error: 'invalid_response' } };
  const expires = typeof data?.expiresAt === 'string' ? Date.parse(data.expiresAt) : NaN;
  const expiresAt = new Date(Number.isFinite(expires) && expires > Date.now() ? expires : Date.now() + THIRTY_DAYS).toISOString();
  return { status: 200, body: { next: afterSignIn(data?.next) }, session: { token, expiresAt } };
}
/** Sets the new session cookie; a different session this browser still held is ended on the backend first. */
export async function completeSignIn(result: BackendResult, previous: string | null, clientIp: string): Promise<Response> {
  const outcome = signInOutcome(result);
  if (!outcome.session) return json(outcome.body, outcome.status);
  if (previous && previous !== outcome.session.token) await backendFetch('/auth/logout', { method: 'POST', session: previous, clientIp, timeoutMs: 5000 });
  return json(outcome.body, 200, [sessionCookie(outcome.session.token, outcome.session.expiresAt)]);
}

// Input checks. The backend validates again; these only keep malformed requests from travelling further.
type Input<T> = T | { error: string };
const text = (value: unknown, max: number) => typeof value === 'string' ? value.trim().slice(0, max + 1) : '';
const email = (value: unknown) => { const v = text(value, 254); return v.length >= 3 && v.length <= 254 && v.includes('@') ? v : null; };
const integer = (value: unknown, min: number, max: number) => {
  const n = typeof value === 'string' && /^\d{1,12}$/.test(value.trim()) ? Number(value) : value;
  return typeof n === 'number' && Number.isSafeInteger(n) && n >= min && n <= max ? n : null;
};

export function requestLinkInput(body: Payload): Input<{ email: string; next?: string }> {
  const address = email(body.email);
  if (!address) return { error: 'invalid_email' };
  const next = safeNextPath(body.next);
  return next ? { email: address, next } : { email: address };
}
export function verifyCodeInput(body: Payload): Input<{ email: string; code: string }> {
  const address = email(body.email);
  if (!address) return { error: 'invalid_email' };
  const code = text(body.code, 12).replace(/\s/g, '');
  return /^\d{6}$/.test(code) ? { email: address, code } : { error: 'invalid_code' };
}
export function verifyTokenInput(body: Payload): Input<{ token: string }> {
  const token = text(body.token, 64);
  return TOKEN_PATTERN.test(token) ? { token } : { error: 'invalid_or_expired' };
}
export function alertInput(body: Payload): Input<{ direction: 'above' | 'below'; threshold: number }> {
  const threshold = parseThreshold(body.threshold);
  return (body.direction === 'above' || body.direction === 'below') && threshold !== null ? { direction: body.direction, threshold } : { error: 'invalid_alert' };
}
export function alertDeleteInput(body: Payload): Input<{ id: number }> {
  const id = integer(body.id, 1, Number.MAX_SAFE_INTEGER);
  return id === null ? { error: 'invalid_id' } : { id };
}
export function extendInput(body: Payload): Input<{ email: string; days: number; note: string }> {
  const address = email(body.email), days = integer(body.days, 1, 400), note = text(body.note, 500);
  if (!address) return { error: 'invalid_email' };
  if (days === null) return { error: 'invalid_days' };
  return note.length >= 1 && note.length <= 500 ? { email: address, days, note } : { error: 'invalid_note' };
}
export function resolveInput(body: Payload): Input<{ network: string; txHash: string; logIndex: number; note: string }> {
  const network = text(body.network, 40), raw = text(body.txHash, 67), logIndex = integer(body.logIndex, 0, 1_000_000), note = text(body.note, 500);
  const txHash = /^0x[0-9a-fA-F]{64}$/.test(raw) ? raw.toLowerCase() : '';
  if (!/^[a-z0-9-]{2,40}$/.test(network)) return { error: 'invalid_network' };
  if (!txHash) return { error: 'invalid_tx_hash' };
  if (logIndex === null) return { error: 'invalid_log_index' };
  return note.length >= 1 && note.length <= 500 ? { network, txHash, logIndex, note } : { error: 'invalid_note' };
}
// Checkout: any missing or oversized field is invalid_request.
const field = (value: unknown, max: number) => { const v = text(value, max); return v.length >= 1 && v.length <= max ? v : null; };
const absent = (value: unknown) => value === undefined || value === null;
export function challengeInput(body: Payload): Input<{ address: string }> {
  const address = field(body.address, 64);
  return address ? { address } : { error: 'invalid_request' };
}
export function linkInput(body: Payload): Input<{ nonce: string; signature: string }> {
  const nonce = field(body.nonce, 128), signature = field(body.signature, 200);
  return nonce && signature ? { nonce, signature } : { error: 'invalid_request' };
}
export function intentInput(body: Payload): Input<{ plan: string; token: string }> {
  const plan = field(body.plan, 16), token = field(body.token, 16);
  return plan && token ? { plan, token } : { error: 'invalid_request' };
}
export function paymentInput(body: Payload): Input<{ txHash: string; intentId?: string | number; plan?: string }> {
  const txHash = field(body.txHash, 100), intentId = absent(body.intentId) ? undefined : parseIntentId(body.intentId);
  const plan = absent(body.plan) || body.plan === '' ? undefined : field(body.plan, 16);
  if (!txHash || intentId === null || plan === null) return { error: 'invalid_request' };
  return { txHash, ...(intentId === undefined ? {} : { intentId }), ...(plan === undefined ? {} : { plan }) };
}

type Relay<T> = { input: (body: Payload) => Input<T>; reply: (data: Payload) => unknown; timeoutMs?: number };
/**
 * A signed-in POST: same-origin check, the session from the cookie, a validated body, then the backend call with the
 * visitor's IP. Success sends only what `reply` picks, and a reply of null (the backend answered in an unexpected
 * shape) is a 502. Failure sends the backend status with errorResponse's fields.
 */
export async function relaySessionPost<T extends object>(request: Request, path: string, { input, reply, timeoutMs }: Relay<T>): Promise<Response> {
  if (!sameOrigin(request)) return forbidden();
  const session = sessionFromCookies(request.headers.get('cookie'));
  if (!session) return json({ error: 'session_required' }, 401);
  const body = await readJsonBody(request);
  if (body instanceof Response) return body;
  const parsed = input(body);
  if ('error' in parsed) return json({ error: parsed.error }, 400);
  const result = await backendFetch(path, { method: 'POST', body: parsed, session, clientIp: clientIpFrom(request.headers), timeoutMs });
  if (result.status < 200 || result.status >= 300) return errorResponse(result);
  const picked = reply(record(result.data) ?? {});
  return picked ? json(picked, result.status) : json({ error: 'invalid_response' }, 502);
}

// CSV export
const redirect = (location: string) => new Response(null, { status: 303, headers: { Location: location, 'Cache-Control': 'no-store' } });
/** The backend's CSV streamed to the browser as a download; a failure returns to the account page with its error code. */
export async function csvDownload(response: Response | null): Promise<Response> {
  if (!response) return redirect('/account?export=backend_unavailable#pro-tools');
  if (response.status === 401) return redirect('/signin?next=/account');
  const type = response.headers.get('content-type') ?? '';
  if (!response.ok || !type.startsWith('text/csv') || !response.body) {
    const code = response.ok ? 'export_failed' : errorCode(await response.json().catch(() => null)) ?? 'export_failed';
    return redirect(`/account?export=${code}#pro-tools`);
  }
  // Only a plain `name.csv` survives; anything else gets the default name.
  const given = /filename=(?:"([^"]*)"|([^;\s]*))/.exec(response.headers.get('content-disposition') ?? '');
  const candidate = given?.[1] ?? given?.[2] ?? '', name = /^[A-Za-z0-9][A-Za-z0-9._-]{0,119}\.csv$/.test(candidate) ? candidate : 'kce-adoption-index.csv';
  return new Response(response.body, { status: 200, headers: { 'Content-Type': 'text/csv; charset=utf-8', 'Content-Disposition': `attachment; filename="${name}"`, 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' } });
}
