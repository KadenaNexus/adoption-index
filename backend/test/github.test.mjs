import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { collectGithub, GithubCollectionError, auditGithubHistory } from '../src/github.mjs';
import { pruneSourceCaches } from '../src/source-cache.mjs';

const sha = (n) => n.toString(16).padStart(40, '0');
const fixedNow = Date.parse('2026-09-26T18:00:00Z');
const repo = (id, name, extra = {}) => ({ id, name, full_name: `kda-community/${name}`,
  default_branch: 'main', fork: false, archived: false, private: false,
  html_url: `https://github.com/kda-community/${name}`, owner: { id: 42 }, ...extra });
const commit = (id, time = '2026-01-01T15:00:00Z', extra = {}) => ({ sha: sha(id), parents: [{ sha: sha(999) }],
  author: { login: 'human', type: 'User' }, committer: { login: 'web-flow', type: 'User' },
  commit: { author: { name: 'Human', email: 'human@example.org', date: time },
    committer: { name: 'GitHub', email: 'noreply@github.com', date: time } }, ...extra });
function response(body, options = {}) {
  return new Response(JSON.stringify(body), { status: options.status || 200,
    headers: { 'Content-Type': 'application/json', 'x-ratelimit-limit': '5000',
      'x-ratelimit-remaining': '4999', 'x-ratelimit-reset': String((fixedNow + 3600_000) / 1000), ...options.headers } });
}
const base = { cacheDir: false, fromDay: '2026-01-01', throughDay: '2026-01-02', token: 'fixture-token',
  now: () => fixedNow, requestIntervalMs: 0, sleepImpl: async () => {} };
function nextLink(url, path) { const next = new URL(url); if (path) next.pathname = path; next.searchParams.set('page', '2'); return `<${next}>; rel="next"`; }

// A short API page with Link is deliberately used: length cannot imply pagination completion.
test('REST pagination includes forks, freezes heads, filters merges/bots and deduplicates SHA with partial first day', async () => {
  const requests = []; const saved = [];
  const first = commit(1);
  const merge = commit(2, undefined, { parents: [{ sha: sha(900) }, { sha: sha(901) }] });
  const bot = commit(3, undefined, { author: { login: 'custom-automation', type: 'Bot' } });
  const dependencyBot = commit(4, undefined, { author: { login: 'renovate[bot]', type: 'User' } });
  const beforeWindow = commit(5, '2025-12-31T23:00:00Z');
  const beforeFork = commit(6, '2026-01-01T03:00:00Z');
  const secondDay = commit(7, '2026-01-01T23:30:00-02:00');
  const fetchImpl = async (url, options) => {
    requests.push({ url, options });
    assert.equal(options.headers.Authorization, 'Bearer fixture-token');
    const u = new URL(url);
    if (u.pathname.includes('/orgs/') || u.pathname.startsWith('/organizations/')) {
      if (u.searchParams.get('page') === '1') return response([repo(1, 'alpha'), repo(2, 'beta', { fork: true, default_branch: 'develop' })], { headers: { Link: nextLink(url, '/organizations/42/repos') } });
      return response([repo(3, 'empty')]);
    }
    const name = u.pathname.startsWith('/repositories/') ? 'alpha' : u.pathname.split('/')[3];
    if (!u.searchParams.has('since')) {
      if (name === 'empty') return response({ message: 'Git Repository is empty.' }, { status: 409 });
      assert.equal(u.searchParams.get('sha'), name === 'beta' ? 'develop' : 'main');
      return response([commit(name === 'alpha' ? 101 : 102)], { headers: { Link: nextLink(url) } });
    }
    assert.equal(u.searchParams.get('sha'), sha(name === 'alpha' ? 101 : 102));
    assert.equal(u.searchParams.get('since'), '2026-01-01T12:00:00.000Z');
    assert.equal(u.searchParams.get('until'), '2026-01-02T23:59:59.000Z');
    if (name === 'alpha' && u.searchParams.get('page') === '1') return response([first, merge], { headers: { Link: nextLink(url, '/repositories/1/commits') } });
    if (name === 'alpha') return response([bot, dependencyBot, beforeWindow]);
    return response([first, beforeFork, secondDay]);
  };
  const result = await collectGithub({ ...base, fromTimestamp: '2026-01-01T12:00:00Z', fetchImpl, onPage: async (page) => saved.push(page) });
  assert.deepEqual(result.days, [{ day: '2026-01-01', commits: 1 }, { day: '2026-01-02', commits: 1 }]);
  assert.equal(result.repositories.length, 3);
  assert.equal(result.repositories.find((r) => r.name === 'beta').fork, true);
  assert.equal(result.repositories.find((r) => r.name === 'empty').collection.empty, true);
  assert.equal(result.repositories.find((r) => r.name === 'alpha').collection.excludedMerges, 1);
  assert.equal(result.repositories.find((r) => r.name === 'alpha').collection.excludedBots, 2);
  assert.equal(result.collection.partialFirstDay, true);
  assert.equal(result.collection.primarySource, 'github-rest');
  assert.equal(result.collection.complete, true);
  assert.equal(result.collection.qualifyingUniqueCommits, 2);
  assert.equal(requests.length, 8);
  assert.equal(result.evidence.length, saved.length);
  for (const page of result.evidence) {
    assert.equal(page.bodySha256, createHash('sha256').update(page.rawBody).digest('hex'));
    assert.equal(JSON.stringify(page).includes('fixture-token'), false);
  }
});

test('insufficient unauthenticated quota throws structured auth/reset details without claiming zero days', async () => {
  let calls = 0; const saved = [];
  await assert.rejects(collectGithub({ ...base, token: '', onPage: (p) => saved.push(p), fetchImpl: async () => {
    calls += 1;
    return response(Array.from({ length: 61 }, (_, i) => repo(i + 1, `repo-${i}`)), { headers: { 'x-ratelimit-limit': '60', 'x-ratelimit-remaining': '58' } });
  } }), (error) => {
    assert.ok(error instanceof GithubCollectionError);
    assert.equal(error.code, 'GITHUB_AUTH_REQUIRED');
    assert.equal(error.details.authenticated, false);
    assert.equal(error.details.repositoryCount, 61);
    assert.equal(error.details.remaining, 58);
    assert.equal(error.details.resetAt, '2026-09-26T19:00:00.000Z');
    assert.equal(error.toJSON().code, 'GITHUB_AUTH_REQUIRED');
    return true;
  });
  assert.equal(calls, 1); assert.equal(saved.length, 1);
});

test('409 must explicitly confirm an empty repository; unrelated conflicts are failures', async () => {
  await assert.rejects(collectGithub({ ...base, fetchImpl: async (url) => new URL(url).pathname.includes('/orgs/')
    ? response([repo(1, 'broken')]) : response({ message: 'Repository conflict' }, { status: 409 }) }),
  (error) => error.code === 'GITHUB_HTTP_ERROR' && error.details.status === 409);
});

test('Retry-After beyond budget is not retried early and includes quota reset', async () => {
  let calls = 0; const delays = [];
  await assert.rejects(collectGithub({ ...base, maxRetryWaitMs: 1000, sleepImpl: async (ms) => delays.push(ms), fetchImpl: async () => {
    calls += 1; return response({ message: 'Too many requests' }, { status: 429,
      headers: { 'Retry-After': '120', 'x-ratelimit-remaining': '0' } });
  } }), (error) => error.code === 'GITHUB_RATE_LIMIT' && error.details.retryAfterMs === 120_000);
  assert.equal(calls, 1); assert.deepEqual(delays, []);
});

test('transient response retries are bounded and confirmed empty repositories yield real zero observations', async () => {
  let calls = 0; const delays = [];
  const result = await collectGithub({ ...base, sleepImpl: async (ms) => delays.push(ms), fetchImpl: async (url) => {
    calls += 1;
    if (calls === 1) return response({ message: 'Temporary unavailable' }, { status: 503 });
    if (new URL(url).pathname.includes('/orgs/')) return response([repo(1, 'empty')]);
    return response({ message: 'Git Repository is empty.' }, { status: 409 });
  } });
  assert.deepEqual(delays, [500]);
  assert.equal(calls, 3);
  assert.deepEqual(result.days, [{ day: '2026-01-01', commits: 0 }, { day: '2026-01-02', commits: 0 }]);
  assert.equal(result.evidence[0].status, 503);
});

test('pagination cannot leak authorization to another origin or alter frozen parameters', async () => {
  for (const link of ['<https://attacker.invalid/next?page=2>; rel="next"',
    '<https://api.github.com/orgs/kda-community/repos?type=public&per_page=100&sort=full_name&direction=desc&page=2>; rel="next"']) {
    let calls = 0;
    await assert.rejects(collectGithub({ ...base, fetchImpl: async () => {
      calls += 1; return response([repo(1, 'alpha')], { headers: { Link: link } });
    } }), (error) => error.code === 'INVALID_PAGINATION');
    assert.equal(calls, 1);
  }
});

test('failed evidence persistence aborts collection before another request', async () => {
  let calls = 0;
  await assert.rejects(collectGithub({ ...base, onPage: async () => { throw new Error('disk full'); },
    fetchImpl: async () => { calls += 1; return response([repo(1, 'alpha')]); } }),
  (error) => error.code === 'GITHUB_EVIDENCE_PERSIST_FAILED');
  assert.equal(calls, 1);
});

test('invalid/unfinished UTC windows fail before network access', async () => {
  let calls = 0;
  for (const override of [{ fromDay: '2026-02-30' }, { throughDay: '2026-09-26' },
    { fromTimestamp: '2026-01-02T00:00:00Z' }, { fromTimestamp: '2026-01-01T12:00:00' }]) {
    await assert.rejects(collectGithub({ ...base, ...override, fetchImpl: async () => { calls += 1; } }),
      (error) => error.code === 'INVALID_WINDOW');
  }
  assert.equal(calls, 0);
});

test('bounded pagination fails instead of returning partially populated days', async () => {
  let calls = 0;
  await assert.rejects(collectGithub({ ...base, maxPages: 1, fetchImpl: async (url) => {
    calls += 1; return response([repo(1, 'alpha')], { headers: { Link: nextLink(url) } });
  } }), (error) => error.code === 'GITHUB_PAGE_BUDGET');
  assert.equal(calls, 1);
});

async function withCache(work) {
  const directory = await mkdtemp(path.join(tmpdir(), 'kce-github-cache-'));
  try { await work(directory); }
  finally { await rm(directory, { recursive: true, force: true }); }
}

test('unauthenticated collection resumes after quota reset without repeating repository/head requests or changing captured heads', async () => withCache(async (cacheDir) => {
  let firstCalls = 0;
  const oldHead = sha(101);
  let resumeDetails;
  await assert.rejects(collectGithub({ ...base, token: '', cacheDir, fetchImpl: async (url) => {
    firstCalls += 1;
    if (new URL(url).pathname.includes('/orgs/')) return response([repo(1, 'alpha')], { headers: { 'x-ratelimit-limit': '60', 'x-ratelimit-remaining': '1' } });
    assert.equal(new URL(url).searchParams.has('since'), false);
    return response([commit(101)], { headers: { Link: nextLink(url), 'x-ratelimit-limit': '60', 'x-ratelimit-remaining': '0' } });
  } }), (error) => {
    assert.equal(error.code, 'GITHUB_RATE_LIMIT');
    assert.equal(error.details.resumable, true);
    assert.equal(error.details.requests, 2);
    resumeDetails = error.details;
    return true;
  });
  assert.equal(firstCalls, 2);
  assert.equal(resumeDetails.resumeWindow.fromDay, '2026-01-01');
  let secondCalls = 0; const replayed = [];
  const result = await collectGithub({ ...base, token: '', cacheDir, now: () => fixedNow + 7200_000,
    onPage: (page) => replayed.push(page.cacheHit), fetchImpl: async (url) => {
      secondCalls += 1; const u = new URL(url);
      assert.ok(u.searchParams.has('since'), 'organization and head endpoints must use cache');
      assert.equal(u.searchParams.get('sha'), oldHead, 'a moved live default branch must not replace the original head');
      return response([commit(1)], { headers: { 'x-ratelimit-limit': '60', 'x-ratelimit-remaining': '59' } });
    } });
  assert.equal(secondCalls, 1);
  assert.deepEqual(replayed, [true, true, false]);
  assert.equal(result.collection.cache.runId, resumeDetails.cacheRunId);
  assert.equal(result.collection.cache.hits, 2);
  assert.equal(result.collection.requests, 1);
  assert.deepEqual(result.days, [{ day: '2026-01-01', commits: 1 }, { day: '2026-01-02', commits: 0 }]);
  const replay = await collectGithub({ ...base, token: '', cacheDir, maxRequests: 1,
    fetchImpl: async () => { assert.fail('completed cached collection must not make network requests'); } });
  assert.deepEqual(replay.days, result.days);
  assert.equal(replay.collection.requests, 0);
  assert.equal(replay.collection.cache.hits, 3);
}));

test('switching to a configured token resumes the same public snapshot and never stores the credential', async () => withCache(async (cacheDir) => {
  await assert.rejects(collectGithub({ ...base, token: '', cacheDir, maxRequests: 2, fetchImpl: async (url) =>
    new URL(url).pathname.includes('/orgs/') ? response([repo(1, 'alpha')]) : response([commit(101)], { headers: { Link: nextLink(url) } }) }),
  (error) => error.code === 'GITHUB_REQUEST_BUDGET' && error.details.resumable);
  const result = await collectGithub({ ...base, token: 'new-private-fixture-token', cacheDir, fetchImpl: async (url, options) => {
    assert.equal(options.headers.Authorization, 'Bearer new-private-fixture-token');
    assert.equal(new URL(url).searchParams.get('sha'), sha(101));
    return response([commit(1)]);
  } });
  assert.equal(result.collection.cache.hits, 2);
  const directory = result.collection.cache.directory;
  const files = [path.join(directory, 'run.json'), ...(await readdir(path.join(directory, 'responses'))).map((f) => path.join(directory, 'responses', f))];
  for (const file of files) assert.equal((await readFile(file, 'utf8')).includes('new-private-fixture-token'), false);
}));

test('corrupt cache fails closed without silently refetching a frozen head', async () => withCache(async (cacheDir) => {
  const result = await collectGithub({ ...base, cacheDir, fetchImpl: async (url) => {
    const u = new URL(url);
    if (u.pathname.includes('/orgs/')) return response([repo(1, 'alpha')]);
    return response([commit(u.searchParams.has('since') ? 1 : 101)], {
      headers: u.searchParams.has('since') ? {} : { Link: nextLink(url) },
    });
  } });
  const directory = path.join(result.collection.cache.directory, 'responses');
  for (const file of await readdir(directory)) {
    const filename = path.join(directory, file); const record = JSON.parse(await readFile(filename, 'utf8'));
    if (record.response.kind === 'head') {
      record.response.rawBody = JSON.stringify([commit(999)]);
      await writeFile(filename, JSON.stringify(record));
    }
  }
  let calls = 0;
  await assert.rejects(collectGithub({ ...base, cacheDir, fetchImpl: async () => { calls += 1; assert.fail('corrupt snapshot must not refresh'); } }),
    (error) => error.code === 'GITHUB_CACHE_CORRUPT');
  assert.equal(calls, 0);
  assert.equal((await readdir(result.collection.cache.directory)).includes('run.lock'), false, 'failed runs release their process lock');
}));

test('different historical windows and explicit snapshot IDs cannot reuse another run inventory', async () => withCache(async (cacheDir) => {
  let calls = 0;
  const fetchImpl = async (url) => {
    calls += 1;
    return new URL(url).pathname.includes('/orgs/') ? response([repo(1, 'empty')]) : response({ message: 'Git Repository is empty.' }, { status: 409 });
  };
  const first = await collectGithub({ ...base, cacheDir, fetchImpl });
  const second = await collectGithub({ ...base, cacheDir, fetchImpl, throughDay: '2026-01-03' });
  const third = await collectGithub({ ...base, cacheDir, fetchImpl, snapshotId: 'independent-review' });
  assert.equal(calls, 6);
  assert.equal(new Set([first, second, third].map((r) => r.collection.cache.runId)).size, 3);
  assert.equal(second.days.length, 3);
  assert.deepEqual(await readdir(cacheDir),[third.collection.cache.runId], 'only the current frozen response cache may remain');
}));

test('exclusive cache lock prevents concurrent snapshots from overwriting a captured head', async () => withCache(async (cacheDir) => {
  let entered; const hasEntered = new Promise((resolve) => { entered = resolve; });
  let release; const barrier = new Promise((resolve) => { release = resolve; });
  const pending = collectGithub({ ...base, cacheDir, fetchImpl: async (url) => {
    if (new URL(url).pathname.includes('/orgs/')) { entered(); await barrier; return response([repo(1, 'empty')]); }
    return response({ message: 'Git Repository is empty.' }, { status: 409 });
  } });
  await hasEntered;
  try {
    await assert.rejects(collectGithub({ ...base, cacheDir, fetchImpl: async () => { assert.fail('locked collector must not call GitHub'); } }),
      (error) => error.code === 'GITHUB_CACHE_LOCKED');
  } finally { release(); }
  const first = await pending;
  const replay = await collectGithub({ ...base, cacheDir, fetchImpl: async () => { assert.fail('all source pages were cached'); } });
  assert.deepEqual(replay.days, first.days);
}));

test('durable cache survives an external evidence callback failure and avoids redoing that API request', async () => withCache(async (cacheDir) => {
  await assert.rejects(collectGithub({ ...base, cacheDir, onPage: async () => { throw new Error('downstream unavailable'); },
    fetchImpl: async () => response([repo(1, 'empty')]) }),
  (error) => error.code === 'GITHUB_EVIDENCE_PERSIST_FAILED');
  let calls = 0;
  const result = await collectGithub({ ...base, cacheDir, fetchImpl: async (url) => {
    calls += 1; assert.equal(new URL(url).pathname.includes('/orgs/'), false);
    return response({ message: 'Git Repository is empty.' }, { status: 409 });
  } });
  assert.equal(calls, 1);
  assert.equal(result.collection.cache.hits, 1);
}));


test('one bounded head reference freezes only date-filtered pages and preserves the in-window decision ledger',async()=>{
 const requested=[];
 const result=await collectGithub({...base,fetchImpl:async url=>{
  const u=new URL(url);requested.push(u);
  if(u.pathname.includes('/orgs/'))return response([repo(1,'alpha')]);
  if(!u.searchParams.has('since')){assert.equal(u.searchParams.get('per_page'),'1');return response([commit(101,'2020-01-01T00:00:00Z')])}
  assert.equal(u.searchParams.get('sha'),sha(101));assert.equal(u.searchParams.get('since'),'2026-01-01T00:00:00.000Z');
  assert.equal(u.searchParams.get('until'),'2026-01-02T23:59:59.000Z');
  if(u.searchParams.get('page')==='1')return response([commit(1),commit(2,undefined,{parents:[{sha:sha(3)},{sha:sha(4)}]})],{headers:{Link:nextLink(url)}});
  return response([commit(3,'2026-01-02T01:00:00Z'),commit(4,'2025-12-31T23:59:59Z')]);
 }});
 assert.equal(requested.length,4);assert.equal(result.commitLedger.length,3);assert.equal(result.commitLedger.filter(row=>row.merge).length,1);
 assert.ok(result.commitLedger.every(row=>row.day>='2026-01-01'&&row.day<='2026-01-02'));
 assert.deepEqual(result.days,[{day:'2026-01-01',commits:1},{day:'2026-01-02',commits:1}]);
});
test('growing history can exceed ninety days without truncation',async()=>{
 const result=await collectGithub({...base,throughDay:'2026-04-10',fetchImpl:async url=>new URL(url).pathname.includes('/orgs/')?response([repo(1,'empty')]):response({message:'Git Repository is empty.'},{status:409})});
 assert.equal(result.days.length,100);assert.equal(result.days[0].day,'2026-01-01');assert.equal(result.days.at(-1).day,'2026-04-10');
});
test('successful cache bodies can be removed, while active collection cache is protected',async()=>withCache(async cacheDir=>{
 let entered,release;const ready=new Promise(resolve=>entered=resolve),barrier=new Promise(resolve=>release=resolve);
 const pending=collectGithub({...base,cacheDir,fetchImpl:async url=>{
  if(new URL(url).pathname.includes('/orgs/')){entered();await barrier;return response([repo(1,'empty')])}
  return response({message:'Git Repository is empty.'},{status:409});
 }});
 await ready;
 try{await assert.rejects(pruneSourceCaches({directory:cacheDir}),error=>error.code==='GITHUB_CACHE_LOCKED');
 await assert.rejects(collectGithub({...base,cacheDir,throughDay:'2026-01-03',fetchImpl:async()=>assert.fail('another window must not fetch')}),error=>error.code==='GITHUB_CACHE_LOCKED');}
 finally{release()}
 await pending;await pruneSourceCaches({directory:cacheDir});assert.deepEqual(await readdir(cacheDir),[]);
}));


test('cross-run SHA audit rejects a reused identity moved into a later day and conflicting bot decisions',()=>{
 const previous={sha:sha(1),day:'2026-01-01',timestamp:Date.parse('2026-01-01T12:00:00Z'),merge:false,bot:false};
 for(const changed of [{...previous,day:'2026-01-02',timestamp:Date.parse('2026-01-02T12:00:00Z')},{...previous,bot:true}]){
  assert.throws(()=>auditGithubHistory({days:[{day:changed.day,commits:changed.bot?0:1}],commitLedger:[changed]},[previous]),error=>error.code==='GITHUB_INCONSISTENT_COMMIT');
 }
});
test('cross-run SHA audit reproduces daily counts and rejects same-count replacements in an already collected day',()=>{
 const previous={sha:sha(1),day:'2026-01-01',timestamp:Date.parse('2026-01-01T12:00:00Z'),merge:false,bot:false};
 const result={days:[{day:previous.day,commits:1}],commitLedger:[previous]};
 assert.match(auditGithubHistory(result,[previous],[previous.day])[previous.day],/^[a-f0-9]{64}$/);
 assert.throws(()=>auditGithubHistory({...result,days:[{day:previous.day,commits:2}]}),error=>error.code==='GITHUB_LEDGER_COUNT_MISMATCH');
 assert.throws(()=>auditGithubHistory({...result,commitLedger:[{...previous,sha:sha(2)}]},[previous],[previous.day]),error=>error.code==='GITHUB_HISTORICAL_LEDGER_CHANGED');
});
test('author timestamps never override the committer UTC day even when the commit appears in another fork',async()=>{
 const item=commit(1,'2026-01-02T12:00:00Z');item.commit.author.date='2026-01-01T12:00:00Z';
 const result=await collectGithub({...base,fetchImpl:async url=>{
  const u=new URL(url);
  if(u.pathname.includes('/orgs/'))return response([repo(1,'alpha'),repo(2,'fork',{fork:true})]);
  return response([u.searchParams.has('since')?item:commit(99)]);
 }});
 assert.deepEqual(result.days,[{day:'2026-01-01',commits:0},{day:'2026-01-02',commits:1}]);
 assert.equal(result.commitLedger.length,1);assert.equal(result.commitLedger[0].day,'2026-01-02');
});
