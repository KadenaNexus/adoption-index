import { TOKEN_PATTERN } from './session-cookie.ts';

/** The login token from a `#token=…` fragment, or null when it is missing or malformed. */
export function tokenFromFragment(hash: string): string | null {
  const value = new URLSearchParams(hash.replace(/^#/, '')).get('token')?.trim() ?? '';
  return TOKEN_PATTERN.test(value) ? value : null;
}
