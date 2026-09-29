// A local stand-in for the backend API (node:http on port 0) plus request builders for the site's route handlers.
// Not a test file itself (the runner only picks up *.test.mjs).
import http from 'node:http';

export const SITE_KEY = 's'.repeat(40);
export const TOKEN = 'A'.repeat(21) + '_' + 'b'.repeat(21);
export const OTHER_TOKEN = 'Z'.repeat(43);

/** Starts a stub backend and points lib/backend.ts at it. `reply(request)` returns {status, json | text, headers}. */
export async function stubBackend(reply = () => ({ status: 200, json: {} })) {
  const requests = [];
  const server = http.createServer(async (req, res) => {
    let raw = '';
    for await (const chunk of req) raw += chunk;
    let body; try { body = raw ? JSON.parse(raw) : undefined; } catch { body = raw; }
    const entry = { method: req.method, path: req.url, headers: req.headers, body };
    requests.push(entry);
    const { status = 200, json, text, headers = {} } = (await reply(entry)) ?? {};
    res.writeHead(status, { 'Content-Type': text !== undefined ? 'text/csv; charset=utf-8' : 'application/json; charset=utf-8', ...headers });
    res.end(text ?? (json === undefined ? '' : JSON.stringify(json)));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const saved = { origin: process.env.KCE_API_ORIGIN, key: process.env.KCE_SITE_KEY };
  process.env.KCE_API_ORIGIN = `http://127.0.0.1:${server.address().port}`;
  process.env.KCE_SITE_KEY = SITE_KEY;
  return {
    requests,
    async close() {
      for (const [name, value] of [['KCE_API_ORIGIN', saved.origin], ['KCE_SITE_KEY', saved.key]]) if (value === undefined) delete process.env[name]; else process.env[name] = value;
      await new Promise(resolve => server.close(resolve));
    },
  };
}

/** A backend origin with nothing listening, for outage tests. */
export async function deadOrigin() {
  const server = http.createServer();
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${server.address().port}`;
  await new Promise(resolve => server.close(resolve));
  return origin;
}

/** A browser-like POST from the site's own page, unless the options say otherwise. */
export function post(path, body, { origin = 'https://adoption.test', host = 'adoption.test', fetchSite = 'same-origin', cookie, forwardedFor = '203.0.113.7, 127.0.0.1', contentType = 'application/json' } = {}) {
  const headers = { host };
  if (origin) headers.origin = origin;
  if (fetchSite) headers['sec-fetch-site'] = fetchSite;
  if (cookie) headers.cookie = cookie;
  if (forwardedFor) headers['x-forwarded-for'] = forwardedFor;
  if (contentType) headers['content-type'] = contentType;
  return new Request(`https://adoption.test${path}`, { method: 'POST', headers, body: body === undefined ? undefined : typeof body === 'string' ? body : JSON.stringify(body) });
}
export function get(path, { cookie, forwardedFor = '203.0.113.7' } = {}) {
  const headers = { host: 'adoption.test' };
  if (cookie) headers.cookie = cookie;
  if (forwardedFor) headers['x-forwarded-for'] = forwardedFor;
  return new Request(`https://adoption.test${path}`, { headers });
}
export const sessionCookieHeader = (token = TOKEN) => `theme=light; kce_session=${token}`;
