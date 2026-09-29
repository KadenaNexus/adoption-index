// Server-side calls from the website to the backend API (127.0.0.1). Never import this into a client component:
// it reads KCE_SITE_KEY, the secret shared with the backend.

export type BackendResult<T = unknown> = { status: number; data: T | null };
// Pass clientIp with every session call, so the backend limits each visitor separately.
type Options = { method?: 'GET' | 'POST'; body?: unknown; session?: string | null; clientIp?: string | null; timeoutMs?: number };

function request(path: string, { method = 'GET', body, session, clientIp }: Options): { url: URL; init: RequestInit } | null {
  const origin = process.env.KCE_API_ORIGIN, key = process.env.KCE_SITE_KEY;
  if (!origin || !key || key.length < 32) return null;
  let url: URL;
  try { url = new URL(path, origin); } catch { return null; }
  if (!['http:', 'https:'].includes(url.protocol)) return null;
  const headers: Record<string, string> = { 'X-KCE-Site-Key': key };
  if (session) headers['X-KCE-Session'] = session;
  if (clientIp) headers['X-KCE-Client-IP'] = clientIp;
  const payload = method === 'POST' ? body ?? {} : body;
  if (payload !== undefined) headers['Content-Type'] = 'application/json';
  return { url, init: { method, headers, body: payload === undefined ? undefined : JSON.stringify(payload), cache: 'no-store' } };
}

/** JSON call. Network failures and a missing configuration come back as 503 with an `error` code, never a throw. */
export async function backendFetch<T = unknown>(path: string, options: Options = {}): Promise<BackendResult<T>> {
  const built = request(path, options);
  if (!built) return { status: 503, data: { error: 'accounts_disabled' } as T };
  try {
    const response = await fetch(built.url, { ...built.init, signal: AbortSignal.timeout(options.timeoutMs ?? 8000) });
    const text = await response.text();
    let data: T | null = null;
    try { data = text ? JSON.parse(text) as T : null; } catch { data = null; }
    return { status: response.status, data };
  } catch {
    return { status: 503, data: { error: 'backend_unavailable' } as T };
  }
}

/** Raw response, for streaming a file (the CSV export) straight through. */
export async function backendResponse(path: string, options: Options = {}): Promise<Response | null> {
  const built = request(path, options);
  if (!built) return null;
  try { return await fetch(built.url, { ...built.init, signal: AbortSignal.timeout(options.timeoutMs ?? 15000) }); } catch { return null; }
}
