// Checks for the site's own POST endpoints (route handlers). Pure functions, so tests can import them.

const IPV4 = /^(25[0-5]|2[0-4]\d|1?\d?\d)(\.(25[0-5]|2[0-4]\d|1?\d?\d)){3}$/;
const IPV6 = /^[0-9a-f:.]{2,45}$/i;
const isIp = (value: string) => IPV4.test(value) || (value.includes(':') && IPV6.test(value));
const loopback = (value: string) => value === '::1' || value.startsWith('127.') || value === '::ffff:127.0.0.1';

/**
 * A state-changing request must come from this site's own pages: the browser's Origin must match the Host
 * that Nginx forwards, and a cross-site Sec-Fetch-Site is refused. SameSite=Lax cookies are the second layer.
 */
export function sameOrigin(request: Request): boolean {
  const fetchSite = request.headers.get('sec-fetch-site');
  if (fetchSite && fetchSite !== 'same-origin') return false;
  const origin = request.headers.get('origin');
  const host = request.headers.get('host');
  if (!origin) return fetchSite === 'same-origin';
  try { return !!host && new URL(origin).host === host; } catch { return false; }
}

/**
 * The visitor's address for per-visitor limits: the last X-Forwarded-For entry that is not a loopback hop.
 * Nginx's $proxy_add_x_forwarded_for appends the real peer last; a client can only add entries before it.
 * X-Real-IP is ignored because the deployed Nginx does not set it, so a client could.
 */
export function clientIpFrom(headers: Headers): string {
  const forwarded = (headers.get('x-forwarded-for') ?? '').split(',').map(s => s.trim()).filter(Boolean);
  for (let i = forwarded.length - 1; i >= 0; i--) if (isIp(forwarded[i]) && !loopback(forwarded[i])) return forwarded[i];
  return '127.0.0.1';
}
