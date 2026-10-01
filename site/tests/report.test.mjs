import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { SITE_KEY, TOKEN, deadOrigin, post, sessionCookieHeader, stubBackend } from './accounts-stub.mjs';
import { DESCRIPTION_LENGTH, EVIDENCE_MAX, REPORT_INDICATORS, cleanDescription, cleanEvidence, indicatorLabel, reportFields, reportHref } from '../lib/report.ts';
import { METRICS } from '../lib/metrics.ts';
import { parseOverview } from '../lib/admin-view.ts';
import { POST as sendReport } from '../app/api/reports/route.ts';
import { POST as resolveReport } from '../app/api/admin/reports/resolve/route.ts';
import * as backend from '../../backend/src/reports.mjs';

const source = path => readFileSync(new URL(`../${path}`, import.meta.url), 'utf8');
const withBackend = async (reply, run) => { const stub = await stubBackend(reply); try { await run(stub); } finally { await stub.close(); } };
const valid = { indicator: 'tvl', description: 'The TVL card shows 13M KDA but BroDEX alone holds more.', evidence: 'https://explorer.example/tx/abc' };

test('the form offers the index, the five inputs in display order and "Something else", the same list as the backend', () => {
  assert.deepEqual(REPORT_INDICATORS.map(i => i.id), ['index', ...METRICS.map(m => m.id), 'other']);
  assert.deepEqual(Object.fromEntries(REPORT_INDICATORS.map(i => [i.id, i.label])), backend.REPORT_INDICATORS, 'ids and labels match backend/src/reports.mjs');
  assert.deepEqual([DESCRIPTION_LENGTH.min, DESCRIPTION_LENGTH.max, EVIDENCE_MAX], [backend.DESCRIPTION_LENGTH.min, backend.DESCRIPTION_LENGTH.max, backend.EVIDENCE_MAX]);
  assert.equal(indicatorLabel('tvl'), 'TVL (total value locked)');
  assert.equal(indicatorLabel('commits'), 'GitHub commits (developer activity)', 'the methodology card calls it developer activity');
  assert.equal(indicatorLabel('gone'), 'gone', 'an id the site does not know is shown as is');
  assert.equal(reportHref('hashrate'), '/report?indicator=hashrate');
  assert.equal(reportHref(), '/report');
});

test('the site and the backend clean typed text the same way', () => {
  const inputs = ['  a\r\nb\rc\n\td\u0000e\u0007f\u001b[31m\u007f  ', '\u00a0x\u2028y\u3000z  ', '', '   ', 42, null, undefined, { a: 1 }, 'é'.repeat(3) + '\n\n\n',
    'bsc\u202escan\u2066x\u2069 \u200b\u200c\u200d\u200e\u200f \u0085\u009f \ufeff\u061c\u2060end', '👨\u200d👩\u200d👧 ک\u200cه'];
  for (const value of inputs) {
    assert.equal(cleanDescription(value), backend.cleanDescription(value), JSON.stringify(value));
    assert.equal(cleanEvidence(value), backend.cleanEvidence(value), JSON.stringify(value));
  }
  assert.equal(cleanDescription('  a\r\nb\u0000\tc  '), 'a\nb\tc');
  assert.equal(cleanEvidence(' tx\n abc \t def '), 'tx abc def');
  assert.equal(cleanDescription('see bsc\u202escan.com\u200b'), 'see bscscan.com', 'direction overrides and invisible characters go');
  assert.equal(cleanDescription('👨\u200d👩\u200d👧'), '👨\u200d👩\u200d👧', 'joiners stay in the description');
  assert.equal(cleanEvidence('ab\u200c\u200dcd'), 'abcd', 'and go from the evidence');
});

test('report fields: indicator, 10 to 2,000 characters of description, a link or ID up to 500, and an optional email', () => {
  assert.deepEqual(reportFields(valid), valid);
  assert.deepEqual(reportFields({ ...valid, email: '  a@b.co ' }), { ...valid, email: 'a@b.co' });
  for (const email of ['', '   ', undefined, null]) assert.deepEqual(reportFields({ ...valid, email }), valid, `email ${JSON.stringify(email)} is none`);
  assert.equal(reportFields({ ...valid, email: 'First.Last+tag@Sub.Example.co.uk' }).email, 'First.Last+tag@Sub.Example.co.uk');
  assert.deepEqual(reportFields({ ...valid, description: 'x'.repeat(10) }).description, 'x'.repeat(10));
  assert.equal(reportFields({ ...valid, description: 'x'.repeat(2000) }).description.length, 2000);
  assert.equal(reportFields({ ...valid, evidence: 'y'.repeat(500) }).evidence.length, 500);
  for (const [body, error] of [
    [{ indicator: undefined }, 'invalid_indicator'], [{ indicator: 'price' }, 'invalid_indicator'], [{ indicator: 'constructor' }, 'invalid_indicator'], [{ indicator: ['tvl'] }, 'invalid_indicator'],
    [{ description: 'too short' }, 'invalid_description'], [{ description: ' \n\u0000\n ' }, 'invalid_description'], [{ description: 'x'.repeat(2001) }, 'invalid_description'],
    [{ evidence: '' }, 'invalid_evidence'], [{ evidence: ' \n ' }, 'invalid_evidence'], [{ evidence: 'y'.repeat(501) }, 'invalid_evidence'], [{ evidence: 42 }, 'invalid_evidence'],
    [{ email: 'not-an-email' }, 'invalid_email'], [{ email: 'a@b' }, 'invalid_email'], [{ email: 42 }, 'invalid_email'], [{ email: 'x'.repeat(250) + '@b.co' }, 'invalid_email'],
    [{ email: 'x@evil.example?cc=boss%40example.com' }, 'invalid_email'], [{ email: 'a\u200b@b.co' }, 'invalid_email'], [{ email: 'a&b@example.com' }, 'invalid_email'], [{ email: 'ok@exämple.com' }, 'invalid_email'],
  ]) assert.deepEqual(reportFields({ ...valid, ...body }), { error }, JSON.stringify(body).slice(0, 60));
  // The first problem wins, in the order of the form.
  assert.deepEqual(reportFields({ indicator: 'x', description: '', evidence: '', email: 'x' }), { error: 'invalid_indicator' });
});

test('POST /api/reports relays only the report, the visitor IP and the session (for the subscriber exemption)', async () => {
  await withBackend(() => ({ status: 202, json: { ok: true, id: 9, debug: 'x' } }), async stub => {
    const response = await sendReport(post('/api/reports', { ...valid, description: ` ${valid.description}\r\n `, email: ' a@b.co ', hp: '', extra: 'dropped' }, { cookie: sessionCookieHeader() }));
    assert.deepEqual([response.status, await response.json()], [202, { ok: true }], 'only ok is relayed');
    assert.equal(stub.requests.length, 1);
    const [call] = stub.requests;
    assert.deepEqual([call.method, call.path, call.body], ['POST', '/reports', { ...valid, email: 'a@b.co' }]);
    assert.equal(call.headers['x-kce-client-ip'], '203.0.113.7');
    assert.equal(call.headers['x-kce-session'], TOKEN, 'a subscriber is spared the daily cap');
    assert.ok(!JSON.stringify(call.body).includes(TOKEN));
    await sendReport(post('/api/reports', valid));
    assert.equal(stub.requests[1].headers['x-kce-session'], undefined, 'no cookie, no session');
  });
});

test('POST /api/reports: a filled-in hidden field and invalid input never reach the backend', async () => {
  await withBackend(() => ({ status: 202, json: { ok: true } }), async stub => {
    let response = await sendReport(post('/api/reports', { ...valid, hp: 'https://spam.example' }));
    assert.deepEqual([response.status, await response.json()], [202, { ok: true }], 'a bot sees the usual answer');
    response = await sendReport(post('/api/reports', { ...valid, description: 'short' }));
    assert.deepEqual([response.status, await response.json()], [400, { error: 'invalid_description' }]);
    response = await sendReport(post('/api/reports', 'indicator=tvl', { contentType: 'application/x-www-form-urlencoded' }));
    assert.equal(response.status, 415, 'a plain HTML form post is refused');
    response = await sendReport(post('/api/reports', { ...valid, description: 'x'.repeat(2000), evidence: 'y'.repeat(500), padding: 'z'.repeat(15000) }));
    assert.deepEqual([response.status, await response.json()], [413, { error: 'payload_too_large' }]);
    assert.equal(stub.requests.length, 0);
    // The longest valid report fits, even in a script that takes three bytes a character in UTF-8.
    response = await sendReport(post('/api/reports', { ...valid, description: '数'.repeat(2000), evidence: '据'.repeat(500) }));
    assert.equal(response.status, 202);
    assert.equal(stub.requests.length, 1);
  });
});

test('POST /api/reports passes backend refusals through as the status and code only', async () => {
  for (const [status, error] of [[429, 'rate_limit'], [429, 'reports_busy'], [400, 'invalid_email'], [503, 'accounts_disabled'], [401, 'site_key_required']])
    await withBackend(() => ({ status, json: { error, detail: 'x' } }), async () => {
      const response = await sendReport(post('/api/reports', valid));
      assert.deepEqual([response.status, await response.json()], [status, { error }]);
    });
  await withBackend(() => ({ status: 500, text: 'oops' }), async () => {
    const response = await sendReport(post('/api/reports', valid));
    assert.deepEqual([response.status, await response.json()], [500, { error: 'backend_unavailable' }]);
  });
  const origin = process.env.KCE_API_ORIGIN, key = process.env.KCE_SITE_KEY;
  process.env.KCE_API_ORIGIN = await deadOrigin(); process.env.KCE_SITE_KEY = SITE_KEY;
  try {
    const response = await sendReport(post('/api/reports', valid));
    assert.deepEqual([response.status, await response.json()], [503, { error: 'backend_unavailable' }]);
  } finally {
    if (origin === undefined) delete process.env.KCE_API_ORIGIN; else process.env.KCE_API_ORIGIN = origin;
    if (key === undefined) delete process.env.KCE_SITE_KEY; else process.env.KCE_SITE_KEY = key;
  }
});

test('POST /api/admin/reports/resolve: session required, id and note checked, the backend status passed through', async () => {
  await withBackend(() => ({ status: 200, json: { ok: true, report: { id: 4 } } }), async stub => {
    let response = await resolveReport(post('/api/admin/reports/resolve', { id: 4, note: 'x' }));
    assert.deepEqual([response.status, await response.json()], [401, { error: 'session_required' }]);
    response = await resolveReport(post('/api/admin/reports/resolve', { id: '4', note: ' Checked, fixed in v5 ' }, { cookie: sessionCookieHeader() }));
    assert.deepEqual([response.status, await response.json()], [200, { ok: true }]);
    assert.deepEqual([stub.requests[0].path, stub.requests[0].body, stub.requests[0].headers['x-kce-session']], ['/admin/reports/resolve', { id: 4, note: 'Checked, fixed in v5' }, TOKEN]);
    for (const [body, error] of [[{ id: 0, note: 'n' }, 'invalid_id'], [{ id: 'x', note: 'n' }, 'invalid_id'], [{ id: 1.5, note: 'n' }, 'invalid_id'], [{ id: 4, note: ' ' }, 'invalid_note'], [{ id: 4, note: 'n'.repeat(501) }, 'invalid_note']]) {
      response = await resolveReport(post('/api/admin/reports/resolve', body, { cookie: sessionCookieHeader() }));
      assert.deepEqual([response.status, await response.json()], [400, { error }], JSON.stringify(body).slice(0, 60));
    }
    assert.equal(stub.requests.length, 1);
  });
  for (const [status, error] of [[409, 'already_resolved'], [404, 'not_found']])
    await withBackend(() => ({ status, json: { error } }), async () => {
      const response = await resolveReport(post('/api/admin/reports/resolve', { id: 4, note: 'n' }, { cookie: sessionCookieHeader() }));
      assert.deepEqual([response.status, await response.json()], [status, { error }]);
    });
});

test('admin overview: reports open first, links only for https, mailto only for a plain address', () => {
  const at = '2026-10-01T10:00:00.000Z';
  const view = parseOverview({ payments: [], unmatched: [], subscriptions: [], counts: { openReports: 2 }, reports: [
    { id: 3, indicator: 'tvl', description: 'Line one\nLine two', evidence: 'https://explorer.example/tx/1', evidenceUrl: 'https://explorer.example/tx/1', email: 'a@b.co', createdAt: at, resolved: true, resolvedNote: 'Fixed', resolvedBy: 'boss@example.com' },
    { id: 2, indicator: 'other', description: 'd', evidence: 'javascript:alert(1)', evidenceUrl: 'javascript:alert(1)', email: 'x?cc=evil@evil.example', createdAt: at, resolved: false },
    { id: 1, indicator: 'retired', description: 'd', evidence: 'tx 0xabc', evidenceUrl: null, email: null, createdAt: at, resolved: false },
    null, 'x',
  ] });
  assert.deepEqual(view.reports.map(r => [r.id, r.resolved]), [[2, false], [1, false], [3, true]]);
  assert.deepEqual(view.reports.map(r => r.indicator), ['Something else', 'retired', 'TVL (total value locked)']);
  assert.deepEqual(view.reports.map(r => r.evidenceUrl), [null, null, 'https://explorer.example/tx/1'], 'only an https link becomes an anchor');
  assert.deepEqual(view.reports.map(r => [r.email, r.mailto]), [['x?cc=evil@evil.example', null], [null, null], ['a@b.co', 'mailto:a@b.co']]);
  assert.deepEqual([view.reports[2].date, view.reports[2].note, view.reports[2].resolvedBy, view.reports[2].description], ['1 Oct 2026', 'Fixed', 'boss@example.com', 'Line one\nLine two']);
  assert.equal(view.counts.openReports, 2);
  const audited = parseOverview({ payments: [], unmatched: [], subscriptions: [], actions: [{ id: 1, adminEmail: 'boss@example.com', action: 'resolve_report', details: { reportId: 3, indicator: 'tvl', note: 'Fixed' }, createdAt: at }] });
  assert.deepEqual(audited.actions.map(a => [a.action, a.summary]), [['Resolved data report', 'Report #3 · “Fixed”']]);
});

test('the link sits beside every indicator a visitor can read: the score card, each Pro card and each methodology input', () => {
  const view = source('app/index-view.tsx'), methodology = source('app/methodology/page.tsx'), link = source('app/report-link.tsx');
  const scoreCard = view.slice(view.indexOf('function ScoreCard'), view.indexOf('function LockOverlay'));
  assert.match(scoreCard, /<ReportLink indicator="index"\/>/);
  const pro = view.slice(view.indexOf('function Breakdown'), view.indexOf('function AccessPanel'));
  assert.match(pro, /<ReportLink indicator=\{metric\.id\}\/>/, 'one per Pro card');
  const locked = view.slice(view.indexOf('function LockedBreakdown'), view.indexOf('function describe'));
  assert.doesNotMatch(locked, /ReportLink/, 'not inside the blurred teaser, where nothing can be read or clicked');
  const inside = view.slice(view.indexOf('aria-labelledby="inside-title"'), view.indexOf('<AccessPanel/>'));
  assert.match(inside, /\{!subscriber && <ReportLink\/>\}/, 'free visitors get one under the teaser');
  assert.deepEqual([...methodology.matchAll(/<ReportLink indicator="([a-z]+)"\/>/g)].map(m => m[1]), METRICS.map(m => m.id), 'one per input, in order');
  assert.match(link, /href=\{reportHref\(indicator\)\}/);
  assert.match(link, />Report a data issue<span className="sr-only"> about \{about\}<\/span>/, 'the visible text, plus which indicator for screen readers');
  assert.match(link, /!indicator \? 'an indicator'/);
});

test('the report page: anyone can open it, it is not indexed, and the form sends JSON with the hidden field', () => {
  const page = source('app/report/page.tsx'), form = source('app/report/report-form.tsx');
  assert.match(page, /robots: \{ index: false, follow: false \}/);
  assert.doesNotMatch(page, /redirect\(|notFound\(/, 'no sign-in needed');
  assert.match(page, /email=\{state\.state === 'signed-in' && isReportEmail\(state\.account\.email\) \? state\.account\.email : ''\}/, 'a signed-in visitor’s email is only a starting value, and only one the form accepts');
  assert.match(form, /postJson\('\/api\/reports', \{ \.\.\.fields, hp \}\)/);
  assert.match(form, /className="hp-field" aria-hidden="true"/);
  assert.match(form, /name="kce_hp" tabIndex=\{-1\} autoComplete="off"/, 'not a name autofill recognises, and out of the tab order');
  assert.doesNotMatch(form, /name="(website|url|homepage|company|email|name|phone)"/);
  for (const label of ['Indicator', 'Issue description', 'Supporting link or transaction ID', 'Email for follow-up <span className="field-optional">\\(optional\\)</span>'])
    assert.match(form, new RegExp(`>${label}</label>`), label);
});
