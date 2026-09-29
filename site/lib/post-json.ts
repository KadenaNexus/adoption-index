// Browser-side POST to the site's own API routes. Never throws: a network failure or a non-JSON reply comes back
// as an `error` code the forms map to a message.
export type PostResult = { ok: boolean; status: number; data: { error?: string; [key: string]: unknown } };

export async function postJson(path: string, body: unknown = {}, fetcher: typeof fetch = fetch): Promise<PostResult> {
  let response: Response;
  try {
    response = await fetcher(path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body), credentials: 'same-origin', cache: 'no-store' });
  } catch {
    return { ok: false, status: 0, data: { error: 'backend_unavailable' } };
  }
  let data: unknown = null;
  try { data = await response.json(); } catch { data = null; }
  const object = data && typeof data === 'object' && !Array.isArray(data) ? data as PostResult['data'] : null;
  if (response.ok && object) return { ok: true, status: response.status, data: object };
  const error = typeof object?.error === 'string' ? object.error : response.status >= 500 || response.status === 0 ? 'backend_unavailable' : 'invalid_response';
  return { ok: false, status: response.status, data: { ...object, error } };
}
