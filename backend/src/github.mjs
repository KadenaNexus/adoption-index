import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { openSourceCache, SourceCacheError } from './source-cache.mjs';

const API_ORIGIN = 'https://api.github.com';
const DAY_MS = 86_400_000;
const TRANSIENT = new Set([408, 429, 500, 502, 503, 504]);
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** Structured collection failure. Never substitute partial observations or missing days with zero. */
export class GithubCollectionError extends Error {
  constructor(code, message, details = {}, cause) {
    super(message, cause ? { cause } : undefined);
    this.name = 'GithubCollectionError';
    this.code = code;
    this.details = details;
  }
  toJSON() { return { name: this.name, code: this.code, message: this.message, details: this.details }; }
}

/** Audit persisted commit identities across incremental runs. SHA identity binds
 * the committer timestamp and exclusion decision; a later fork cannot count it
 * again on another day. Repeated observations may add evidence, never history. */
export function auditGithubHistory(result,priorLedger=[],coveredDays=[]){
  const read=(item)=>{
    if(!item||!validSha(item.sha)||!Number.isFinite(item.timestamp)||typeof item.merge!=='boolean'||typeof item.bot!=='boolean'||new Date(item.timestamp).toISOString().slice(0,10)!==item.day)fail('GITHUB_INVALID_LEDGER','Commit decision ledger is missing valid identity, date or exclusion evidence');
    return {sha:item.sha,day:item.day,timestamp:item.timestamp,merge:item.merge,bot:item.bot};
  };
  if(!Array.isArray(result.commitLedger)||!Array.isArray(result.days))fail('GITHUB_INVALID_LEDGER','Complete commit and daily ledgers are required');
  const known=new Map(),current=new Map();
  const equal=(a,b)=>a.day===b.day&&a.timestamp===b.timestamp&&a.merge===b.merge&&a.bot===b.bot;
  for(const input of priorLedger){const item=read(input),previous=known.get(item.sha);if(previous&&!equal(previous,item))fail('GITHUB_INCONSISTENT_COMMIT','Permanent history contains conflicting SHA evidence',{sha:item.sha});known.set(item.sha,item)}
  const counts=new Map(result.days.map(row=>[row.day,0]));
  for(const input of result.commitLedger){
    const item=read(input),previous=known.get(item.sha);
    if(current.has(item.sha))fail('GITHUB_INVALID_LEDGER','Commit ledger repeats an identity',{sha:item.sha});
    if(previous&&!equal(previous,item))fail('GITHUB_INCONSISTENT_COMMIT','The same SHA conflicts with a previous collection; historical dates and exclusions cannot change',{sha:item.sha,previousDay:previous.day,incomingDay:item.day});
    if(!counts.has(item.day))fail('GITHUB_INVALID_LEDGER','Commit ledger includes a day outside the collected suffix',{sha:item.sha,day:item.day});
    current.set(item.sha,item);if(!item.merge&&!item.bot)counts.set(item.day,counts.get(item.day)+1);
  }
  if(result.days.some(row=>!Number.isSafeInteger(row.commits)||row.commits<0||row.commits!==counts.get(row.day)))fail('GITHUB_LEDGER_COUNT_MISMATCH','Daily commit count does not reproduce from the unique eligible SHA ledger');
  const decisionsFor=(values,day)=>[...values].filter(item=>item.day===day).sort((a,b)=>a.sha.localeCompare(b.sha));
  for(const day of coveredDays){
    if(counts.has(day)&&JSON.stringify(decisionsFor(known.values(),day))!==JSON.stringify(decisionsFor(current.values(),day)))fail('GITHUB_HISTORICAL_LEDGER_CHANGED','An already collected day has a different commit decision ledger',{day});
  }
  return Object.fromEntries(result.days.map(row=>[row.day,createHash('sha256').update(JSON.stringify(decisionsFor(current.values(),row.day))).digest('hex')]));
}

function fail(code, message, details) { throw new GithubCollectionError(code, message, details); }
function parseDay(value, label) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) fail('INVALID_WINDOW', `${label} must be a UTC YYYY-MM-DD date`);
  const time = Date.parse(`${value}T00:00:00Z`);
  if (!Number.isFinite(time) || new Date(time).toISOString().slice(0, 10) !== value) fail('INVALID_WINDOW', `${label} is not a real UTC date`);
  return time;
}
function integerHeader(headers, name) {
  const value = headers.get(name);
  if (value == null || !/^\d+$/.test(value)) return null;
  return Number(value);
}
function retryAfterMs(value, now) {
  if (!value) return null;
  if (/^\d+(\.\d+)?$/.test(value)) return Number(value) * 1000;
  const date = Date.parse(value);
  return Number.isFinite(date) ? Math.max(0, date - now) : null;
}
function isBot(item) {
  if (item.author?.type === 'Bot' || item.committer?.type === 'Bot') return true;
  const fields = [item.author?.login, item.committer?.login, item.commit?.author?.name,
    item.commit?.author?.email, item.commit?.committer?.name, item.commit?.committer?.email];
  return fields.some((value) => typeof value === 'string' &&
    (/dependabot|renovate|\[bot\]/i.test(value) || /^(?:github-actions|kadena-bot|kda-bot)(?:$|@|\+)|\+(?:github-actions|kadena-bot|kda-bot)@/i.test(value)));
}
function validSha(value) { return typeof value === 'string' && /^[0-9a-f]{40,64}$/i.test(value); }
function nextPage(link, current, initial, canonicalPaths = []) {
  if (!link) return null;
  const entry = link.split(',').find((part) => /;\s*rel="next"(?:;|\s*$)/.test(part));
  if (!entry) return null;
  const match = entry.match(/^\s*<([^>]+)>/);
  if (!match) fail('INVALID_PAGINATION', 'Malformed GitHub next-page link');
  const target = new URL(match[1], API_ORIGIN);
  const frozen = new URL(initial);
  if (target.origin !== API_ORIGIN || target.username || target.password || (target.pathname !== frozen.pathname && !canonicalPaths.includes(target.pathname))) {
    fail('INVALID_PAGINATION', 'Refusing a next-page link outside the original GitHub endpoint');
  }
  for (const [key, value] of frozen.searchParams) {
    if (key !== 'page' && (target.searchParams.getAll(key).length !== 1 || target.searchParams.get(key) !== value)) {
      fail('INVALID_PAGINATION', `Next-page link changed frozen parameter ${key}`);
    }
  }
  for (const key of target.searchParams.keys()) {
    if (key !== 'page' && !frozen.searchParams.has(key)) fail('INVALID_PAGINATION', 'Next-page link introduced an unexpected parameter');
  }
  const page = target.searchParams.get('page');
  const currentPage = Number(new URL(current).searchParams.get('page') || 1);
  if (!/^\d+$/.test(page || '') || Number(page) <= currentPage) fail('INVALID_PAGINATION', 'Next-page link does not advance');
  return target.href;
}

/**
 * Collect the completed historical window directly from GitHub REST, including public forks.
 * Each nonempty repository's default-branch head is captured as a single
 * reference; only date-bounded history is paginated at that immutable
 * SHA. Counts use UTC committer dates and organization-wide SHA
 * deduplication; merges, API Bot actors and explicit bot identities are excluded.
 *
 * GITHUB_TOKEN is optional and server-only. The default on-disk cache resumes the same
 * window across hourly public quotas; rate-limit errors carry reset/cache information.
 * Repository pages and captured branch heads are immutable within one cached snapshot.
 * Set cacheDir:false for a stateless call, or a new snapshotId to deliberately recollect.
 * Git clones are not read by this collector; they may be independent cross-check evidence.
 * onPage(page) can durably persist every exact raw API response before collection proceeds.
 */
export async function collectGithub({
  fromDay, throughDay, fromTimestamp,
  organization = 'kda-community', token = process.env.GITHUB_TOKEN,
  cacheDir = process.env.GITHUB_CACHE_DIR || fileURLToPath(new URL('../data/github-cache/', import.meta.url)),
  snapshotId = 'default',
  onPage, fetchImpl = globalThis.fetch, sleepImpl = sleep, now = Date.now,
  maxRuntimeMs = 600_000, requestTimeoutMs = 30_000, maxRetries = 3,
  maxRetryWaitMs = 60_000, maxRequests = 5_000, maxPages = 1_000, requestIntervalMs = 100,
} = {}) {
  const startDay = parseDay(fromDay, 'fromDay');
  const lastDay = parseDay(throughDay, 'throughDay');
  if (fromTimestamp != null && typeof fromTimestamp !== 'string') fail('INVALID_WINDOW', 'fromTimestamp must be an ISO timestamp string');
  const start = fromTimestamp == null ? startDay : Date.parse(fromTimestamp);
  const end = lastDay + DAY_MS;
  if (lastDay < startDay || !Number.isFinite(start) || start < startDay || start >= startDay + DAY_MS) {
    fail('INVALID_WINDOW', 'fromTimestamp must fall within fromDay and throughDay must not precede it');
  }
  if (typeof fromTimestamp === 'string' && !/(?:Z|[+-]\d{2}:\d{2})$/.test(fromTimestamp)) fail('INVALID_WINDOW', 'fromTimestamp must include an explicit timezone');
  if (end > Math.floor(now() / DAY_MS) * DAY_MS) fail('INVALID_WINDOW', 'throughDay must be a completed UTC day');
  if (startDay < Date.parse('1970-01-01T00:00:00Z') || end > Date.parse('2100-01-01T00:00:00Z')) fail('INVALID_WINDOW', 'GitHub supports timestamps from 1970 through 2099');
  if (!/^[a-z0-9][a-z0-9-]{0,38}$/i.test(organization)) fail('INVALID_ORGANIZATION', 'Invalid GitHub organization name');
  if (typeof fetchImpl !== 'function') fail('INVALID_CONFIGURATION', 'A Fetch implementation is required');
  for (const [name, value] of Object.entries({ maxRuntimeMs, requestTimeoutMs, maxRetryWaitMs, maxRequests, maxPages })) {
    if (!Number.isFinite(value) || value <= 0) fail('INVALID_CONFIGURATION', `${name} must be positive`);
  }
  if (!Number.isInteger(maxRetries) || maxRetries < 0 || !Number.isFinite(requestIntervalMs) || requestIntervalMs < 0) fail('INVALID_CONFIGURATION', 'Invalid retry/interval budget');
  if (cacheDir !== false && (typeof cacheDir !== 'string' || !cacheDir.trim())) fail('INVALID_CONFIGURATION', 'cacheDir must be a nonempty path or false');
  if (typeof snapshotId !== 'string' || !snapshotId || snapshotId.length > 120) fail('INVALID_CONFIGURATION', 'snapshotId must be a nonempty label up to 120 characters');
  let cache = null;
  try {
  if (cacheDir !== false) {
    cache = await openSourceCache({ directory: cacheDir, now, config: {
      source: 'github-rest', apiOrigin: API_ORIGIN, apiVersion: '2022-11-28', policyVersion: 2,
      organization, fromTimestamp: new Date(start).toISOString(), throughDay,
      publicRepositoriesOnly: true, branchPolicy: 'captured-default-branch-head',
      datePolicy: 'committer-utc', deduplicationPolicy: 'unique-sha-across-organization', snapshotId,
    } });
  }
  const startedAt = now();
  const deadline = startedAt + maxRuntimeMs;
  const authenticated = typeof token === 'string' && token.trim().length > 0;
  const evidence = [];
  const sourceRefs = new Set();
  const repositories = [];
  const seenRepoIds = new Set();
  const seenCommits = new Map();
  let requests = 0;
  let cacheHits = 0;
  let rate = { limit: null, remaining: null, resetAt: null };

  const detail = (extra = {}) => ({ authenticated, requests, cacheHits, ...rate,
    resumable: Boolean(cache), ...(cache ? { cacheRunId: cache.runId, cacheDirectory: cache.directory,
      resumeWindow: { fromDay, throughDay, fromTimestamp: new Date(start).toISOString(), snapshotId } } : {}), ...extra });
  const budget = () => {
    if (now() >= deadline) fail('GITHUB_RUNTIME_BUDGET', 'GitHub collection reached its runtime budget', detail());
    if (requests >= maxRequests) fail('GITHUB_REQUEST_BUDGET', 'GitHub collection reached its request budget', detail());
  };
  const endpoint = (path, params) => {
    const url = new URL(path, API_ORIGIN);
    for (const [key, value] of Object.entries(params)) url.searchParams.set(key, String(value));
    return url.href;
  };
  const recordEvidence = async (page, cacheHit) => {
    const delivered = { ...page, cacheHit };
    evidence.push(delivered); sourceRefs.add(page.url);
    if (onPage) {
      try { await onPage(delivered); }
      catch (error) { throw new GithubCollectionError('GITHUB_EVIDENCE_PERSIST_FAILED', 'Persisting GitHub evidence failed; collection was not completed', detail({ url: page.url }), error); }
    }
  };
  const request = async (url, kind, repository) => {
    if (now() >= deadline) fail('GITHUB_RUNTIME_BUDGET', 'GitHub collection reached its runtime budget', detail());
    const cached = cache ? await cache.get({ url, kind, repository }) : null;
    if (cached) {
      let body;
      try { body = JSON.parse(cached.rawBody); }
      catch { fail('GITHUB_CACHE_CORRUPT', 'Cached GitHub body is not JSON', detail({ url })); }
      const empty = cached.status === 409 && kind === 'head' && /(?:repository|repo).*empty|empty.*(?:repository|repo)/i.test(body?.message || '');
      if (!(cached.status >= 200 && cached.status < 300 && Array.isArray(body)) && !empty) {
        fail('GITHUB_CACHE_CORRUPT', 'Cached response is not a reusable successful API page or verified empty repository', detail({ url }));
      }
      cacheHits += 1;
      await recordEvidence(cached, true);
      // Historical quota headers remain evidence only; never use them to block a new quota window.
      return { body, empty, headers: new Headers(cached.headers) };
    }
    for (let attempt = 0; attempt <= maxRetries; attempt += 1) {
      budget();
      if (rate.remaining === 0 && (!rate.resetAt || Date.parse(rate.resetAt) > now())) fail('GITHUB_RATE_LIMIT', 'GitHub quota is exhausted; resume after reset', detail());
      if (requests > 0 && requestIntervalMs) {
        if (requestIntervalMs >= deadline - now()) fail('GITHUB_RUNTIME_BUDGET', 'No runtime remains for the next GitHub request', detail());
        await sleepImpl(requestIntervalMs);
      }
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), Math.min(requestTimeoutMs, Math.max(1, deadline - now())));
      const requestedAt = new Date(now()).toISOString();
      let response;
      let rawBody;
      let networkError;
      requests += 1;
      try {
        const headers = { Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28', 'User-Agent': 'KCE-Adoption-Index' };
        if (authenticated) headers.Authorization = `Bearer ${token.trim()}`;
        response = await fetchImpl(url, { headers, signal: controller.signal, redirect: 'error' });
        rawBody = await response.text();
      } catch (error) { networkError = error; }
      finally { clearTimeout(timer); }
      if (networkError) {
        if (attempt === maxRetries) throw new GithubCollectionError('GITHUB_NETWORK_ERROR', 'GitHub request failed after bounded retries', detail({ url }), networkError);
        const delay = Math.min(8_000, 500 * 2 ** attempt);
        if (delay > maxRetryWaitMs || delay >= deadline - now()) fail('GITHUB_RUNTIME_BUDGET', 'No runtime remains for GitHub network retry', detail({ url }));
        await sleepImpl(delay);
        continue;
      }
      const reset = integerHeader(response.headers, 'x-ratelimit-reset');
      rate = { limit: integerHeader(response.headers, 'x-ratelimit-limit') ?? rate.limit,
        remaining: integerHeader(response.headers, 'x-ratelimit-remaining') ?? rate.remaining,
        resetAt: reset == null ? rate.resetAt : new Date(reset * 1000).toISOString() };
      const responseHeaders = {};
      for (const key of ['date', 'etag', 'link', 'retry-after', 'x-ratelimit-limit', 'x-ratelimit-remaining', 'x-ratelimit-reset', 'x-ratelimit-resource', 'x-github-request-id']) {
        if (response.headers.has(key)) responseHeaders[key] = response.headers.get(key);
      }
      const page = { kind, repository: repository ?? null, url, requestedAt, receivedAt: new Date(now()).toISOString(),
        status: response.status, headers: responseHeaders, bodySha256: createHash('sha256').update(rawBody).digest('hex'), rawBody };
      let body;
      try { body = JSON.parse(rawBody); }
      catch {
        await recordEvidence(page, false);
        fail('GITHUB_INVALID_RESPONSE', 'GitHub response is not JSON', detail({ url, status: response.status }));
      }
      const empty = response.status === 409 && kind === 'head' && /(?:repository|repo).*empty|empty.*(?:repository|repo)/i.test(body?.message || '');
      // Persist durable source evidence before any callback can fail. Failed HTTP attempts
      // are reported, but not cached as successful pages and never freeze a rate-limit error.
      if (cache && ((response.ok && Array.isArray(body)) || empty)) await cache.put(page);
      await recordEvidence(page, false);
      if (response.ok) return { body, headers: response.headers };
      if (empty) return { empty: true, body, headers: response.headers };
      const retryAfter = retryAfterMs(response.headers.get('retry-after'), now());
      const isRateLimit = response.status === 429 || (response.status === 403 && (rate.remaining === 0 || retryAfter != null));
      const retryable = TRANSIENT.has(response.status) || isRateLimit;
      const resetDelay = rate.remaining === 0 && rate.resetAt ? Math.max(0, Date.parse(rate.resetAt) - now()) : 0;
      const delay = Math.max(500 * 2 ** attempt, retryAfter ?? 0, resetDelay);
      if (!retryable) fail('GITHUB_HTTP_ERROR', `GitHub returned HTTP ${response.status}`, detail({ url, status: response.status }));
      if (attempt === maxRetries || delay > maxRetryWaitMs || delay >= deadline - now()) {
        fail(isRateLimit ? 'GITHUB_RATE_LIMIT' : 'GITHUB_RETRY_BUDGET', 'GitHub response cannot be retried within the bounded collection budget', detail({ url, status: response.status, retryAfterMs: retryAfter }));
      }
      await sleepImpl(delay);
    }
    fail('GITHUB_RETRY_BUDGET', 'GitHub retry loop ended unexpectedly', detail());
  };
  const paginate = async (initial, kind, repository, consume, canonicalPaths = []) => {
    let url = initial;
    let pages = 0;
    while (url) {
      if (++pages > maxPages) fail('GITHUB_PAGE_BUDGET', 'GitHub pagination exceeded its page budget', detail({ url, repository }));
      const result = await request(url, kind, repository);
      if (!Array.isArray(result.body)) fail('GITHUB_INVALID_RESPONSE', 'Expected a GitHub list response', detail({ url }));
      await consume(result.body);
      // GitHub Link headers canonicalize /orgs/:login to /organizations/:id and
      // /repos/:owner/:name to /repositories/:id. Only IDs proven by this API snapshot qualify.
      const paths = kind === 'repositories'
        ? [...new Set(result.body.map((item) => item.owner?.id).filter((id) => Number.isSafeInteger(id) && id > 0))]
          .map((id) => `/organizations/${id}/repos`)
        : canonicalPaths;
      url = nextPage(result.headers.get('link'), url, initial, paths);
    }
  };

  const organizationUrl = endpoint(`/orgs/${encodeURIComponent(organization)}/repos`,
    { type: 'public', per_page: 100, sort: 'full_name', direction: 'asc', page: 1 });
  await paginate(organizationUrl, 'repositories', null, (items) => {
    for (const repo of items) {
      if (!Number.isSafeInteger(repo.id) || typeof repo.name !== 'string' || typeof repo.full_name !== 'string' ||
          typeof repo.default_branch !== 'string' || !repo.default_branch || typeof repo.fork !== 'boolean' ||
          repo.full_name.toLowerCase() !== `${organization}/${repo.name}`.toLowerCase() || repo.private === true) {
        fail('GITHUB_INVALID_RESPONSE', 'Repository list contains an invalid or out-of-scope repository', detail());
      }
      if (seenRepoIds.has(repo.id)) fail('GITHUB_REPOSITORY_SNAPSHOT_CHANGED', 'Repository pagination repeated an identity; retry a fresh collection', detail({ repository: repo.full_name }));
      seenRepoIds.add(repo.id);
      repositories.push({ id: repo.id, name: repo.name, full_name: repo.full_name, default_branch: repo.default_branch,
        fork: repo.fork, archived: Boolean(repo.archived), html_url: repo.html_url,
        created_at: repo.created_at ?? null, pushed_at: repo.pushed_at ?? null });
    }
  });
  if (repositories.length === 0) fail('GITHUB_EMPTY_ORGANIZATION', 'No public repositories returned; refusing an unsupported all-zero activity history', detail());
  // Every repository must receive at least one API request; Git clone zeros cannot replace that proof.
  if (!cache && ((rate.remaining != null && rate.remaining < repositories.length) || (!authenticated && repositories.length > 60 && rate.remaining == null))) {
    fail(authenticated ? 'GITHUB_RATE_LIMIT_BUDGET' : 'GITHUB_AUTH_REQUIRED',
      authenticated ? 'Remaining GitHub quota cannot verify every repository' : 'Enable the on-disk response cache to resume across public quotas; a stateless unauthenticated run cannot verify every repository',
      detail({ repositoryCount: repositories.length, requiredMinimumRequests: repositories.length,
        estimatedRequestsIncludingHeadCapture: repositories.length * 2 }));
  }
  repositories.sort((a, b) => a.full_name.localeCompare(b.full_name));
  for (const repo of repositories) {
    const path = `/repos/${encodeURIComponent(organization)}/${encodeURIComponent(repo.name)}/commits`;
    // One head reference is the only out-of-window metadata fetched. Commit
    // bodies/ancestry are requested exclusively with the requested date bounds.
    const headUrl = endpoint(path, { sha: repo.default_branch, per_page: 1 });
    const head = await request(headUrl, 'head', repo.full_name);
    repo.collection = { complete: false, empty: Boolean(head.empty), headSha: null, windowCommitAppearances: 0,
      qualifyingCommitAppearances: 0, excludedMerges: 0, excludedBots: 0 };
    if (head.empty) { repo.collection.complete = true; continue; }
    if (!Array.isArray(head.body) || head.body.length !== 1 || !validSha(head.body[0]?.sha)) {
      fail('GITHUB_INVALID_RESPONSE', 'Default branch head could not be established', detail({ repository: repo.full_name }));
    }
    repo.collection.headSha = head.body[0].sha;
    const initial = endpoint(path, { sha: repo.collection.headSha, since: new Date(start).toISOString(),
      until: new Date(end - 1000).toISOString(), per_page: 100, page: 1 });
    const repoSeen = new Set();
    const consume = (items) => {
      for (const item of items) {
        const committerDate = item.commit?.committer?.date;
        const timestamp = Date.parse(committerDate);
        if (typeof committerDate !== 'string' || !/(?:Z|[+-]\d{2}:\d{2})$/.test(committerDate) || !validSha(item.sha) || !Array.isArray(item.parents) || item.parents.some((parent) => !validSha(parent.sha)) || !Number.isFinite(timestamp)) {
          fail('GITHUB_INVALID_RESPONSE', 'Commit lacks valid SHA, parent or committer timestamp evidence', detail({ repository: repo.full_name }));
        }
        // The API's boundary semantics can be inclusive; local UTC filtering is authoritative.
        if (timestamp < start || timestamp >= end) continue;
        if (repoSeen.has(item.sha)) fail('GITHUB_COMMIT_PAGINATION_CHANGED', 'A commit repeated across pages at the captured head', detail({ repository: repo.full_name, sha: item.sha }));
        repoSeen.add(item.sha);
        const day = new Date(timestamp).toISOString().slice(0, 10);
        const merge = item.parents.length > 1;
        const bot = isBot(item);
        repo.collection.windowCommitAppearances += 1;
        repo.collection.excludedMerges += Number(merge);
        repo.collection.excludedBots += Number(bot);
        repo.collection.qualifyingCommitAppearances += Number(!merge && !bot);
        const old = seenCommits.get(item.sha);
        if (old && (old.day !== day || old.timestamp !== timestamp || old.merge !== merge || old.bot !== bot)) {
          fail('GITHUB_INCONSISTENT_COMMIT', 'The same SHA has conflicting date or exclusion evidence', detail({ sha: item.sha }));
        }
        if (!old) seenCommits.set(item.sha, { day, timestamp, merge, bot });
      }
    };
    await paginate(initial, 'commits', repo.full_name, consume, [`/repositories/${repo.id}/commits`]);
    repo.collection.historyEvidence = 'frozen-head-filtered-pages';
    repo.collection.complete = true;
  }
  const daily = new Map();
  for (let date = startDay; date <= lastDay; date += DAY_MS) daily.set(new Date(date).toISOString().slice(0, 10), 0);
  for (const item of seenCommits.values()) if (!item.merge && !item.bot) daily.set(item.day, daily.get(item.day) + 1);
  return { days: [...daily].map(([day, commits]) => ({ day, commits })), repositories, evidence,
    commitLedger:[...seenCommits].map(([sha,decision])=>({sha,...decision})),
    sourceRefs: [...sourceRefs], collection: { complete: true, primarySource: 'github-rest', organization,
      publicRepositoriesOnly: true, includesForks: true, branchPolicy: 'captured-default-branch-head',
      datePolicy: 'committer-utc', deduplicationPolicy: 'unique-sha-across-organization',
      fromTimestamp: new Date(start).toISOString(), throughDay, partialFirstDay: start !== startDay,
      startedAt: new Date(startedAt).toISOString(), completedAt: new Date(now()).toISOString(),
      uniqueWindowCommits: seenCommits.size, qualifyingUniqueCommits: [...daily.values()].reduce((a, b) => a + b, 0),
      requests, authenticated, cache: cache ? { runId: cache.runId, directory: cache.directory, hits: cacheHits } : null } };
  } catch (error) {
    if (error instanceof SourceCacheError) throw new GithubCollectionError(error.code, error.message, error.details, error);
    throw error;
  } finally {
    if (cache) await cache.close();
  }
}
