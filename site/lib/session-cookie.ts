// The session cookie's name and attributes. No Next.js imports, so route handlers and tests share it.
// In production the __Host- prefix makes browsers refuse the cookie unless it is Secure, host-only and Path=/,
// so another kadena.ws subdomain cannot plant one.
export const SESSION_COOKIE = process.env.NODE_ENV === 'production' ? '__Host-kce_session' : 'kce_session';
export const TOKEN_PATTERN = /^[A-Za-z0-9_-]{43}$/;
export function sessionCookieOptions(expiresAt: string | Date) {
  return { httpOnly: true, secure: process.env.NODE_ENV === 'production', sameSite: 'lax' as const, path: '/', expires: new Date(expiresAt) };
}
