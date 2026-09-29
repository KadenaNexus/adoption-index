// The same rules as the backend's safeNextPath (backend/src/auth.mjs): a same-site path that cannot normalise to
// another origin. Callers navigate to the returned string itself, never to a value rebuilt from new URL(...).
export function safeNextPath(value: unknown): string | null {
  if (typeof value !== 'string' || value.length > 512 || !value.startsWith('/') || value.includes('//') || /[\\\s\u0000-\u001f\u007f]/.test(value)
    || /^\/[a-z][a-z0-9+.-]*:/i.test(value) || /(^|\/)\.{1,2}(\/|$|\?|#)/.test(value) || /%2f|%5c|%2e/i.test(value)) return null;
  return value;
}

/** Where to go after signing in: a safe `next`, else the account page (never back into the sign-in pages). */
export function afterSignIn(value: unknown): string {
  const next = safeNextPath(value);
  return next && !/^\/signin(\/|\?|#|$)/.test(next) ? next : '/account';
}
