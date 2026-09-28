import { createHash } from 'node:crypto';
import { decodeBlock, pactCommandHash } from './pact.mjs';

const PREFIX = '/chainweb/0.0/mainnet01';
const HASH = /^[A-Za-z0-9_-]{43}$/;
const DEFAULT_URL = 'https://api.chainweb-community.org';
const sleepDefault = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds));

function integer(value, name, min = 0, max = Number.MAX_SAFE_INTEGER) {
  if (!Number.isSafeInteger(value) || value < min || value > max) throw new Error(`Invalid ${name}`);
  return value;
}

function chainNumber(chain) { return integer(Number(chain), 'Pact chain', 0, 19); }
function hash(value, name = 'hash') { if (!HASH.test(value ?? '')) throw new Error(`Invalid ${name}`); return value; }

export function validateHeader(header, chain) {
  if (!header || Number(header.chainId) !== chainNumber(chain)) throw new Error('Header chain identity mismatch');
  integer(header.height, 'block height');
  integer(header.creationTime, 'block creation time');
  if (header.chainwebVersion !== 'mainnet01') throw new Error('Header network identity mismatch');
  for (const key of ['hash', 'parent', 'payloadHash', 'target', 'weight']) hash(header[key], `header ${key}`);
  return header;
}

async function readBounded(response, maxBytes) {
  const tooLarge = () => Object.assign(new Error('Chainweb response exceeds configured byte limit'), { code: 'CHAINWEB_RESPONSE_TOO_LARGE' });
  const stated = response.headers.get('content-length');
  if (stated && Number(stated) > maxBytes) {
    await response.body?.cancel();
    throw tooLarge();
  }
  const reader = response.body?.getReader();
  if (!reader) throw new Error('Empty Chainweb response');
  let bytes = 0;
  const chunks = [];
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      bytes += value.byteLength;
      if (bytes > maxBytes) { await reader.cancel(); throw tooLarge(); }
      chunks.push(value);
    }
  } finally { reader.releaseLock(); }
  return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks)));
}

export function createChainwebClient(options = {}) {
  const baseUrl = new URL(options.baseUrl ?? process.env.CHAINWEB_URL ?? DEFAULT_URL);
  if (!['http:', 'https:'].includes(baseUrl.protocol) || baseUrl.username || baseUrl.password || baseUrl.search || baseUrl.hash) {
    throw new Error('CHAINWEB_URL must be an HTTP(S) node origin without credentials');
  }
  if (baseUrl.pathname !== '/' && baseUrl.pathname !== '') throw new Error('CHAINWEB_URL must be the node origin, without an API path');
  const origin = baseUrl.origin;
  const fetchImpl = options.fetchImpl ?? globalThis.fetch;
  const sleep = options.sleep ?? sleepDefault;
  const timeoutMs = integer(options.timeoutMs ?? Number(process.env.CHAINWEB_TIMEOUT_MS ?? 30000), 'timeout', 1, 120000);
  const retries = integer(options.retries ?? 3, 'retry count', 0, 5);
  const maxResponseBytes = integer(options.maxResponseBytes ?? 32 * 1024 * 1024, 'response byte limit', 1);
  const maxHeaders = integer(options.maxHeaders ?? 1000, 'maximum header range', 1, 10000);
  const pageSize = integer(options.pageSize ?? 250, 'header page size', 1, 1000);
  const payloadBatchSize = integer(options.payloadBatchSize ?? 10, 'payload batch size', 1, 100);
  const blockPageSize = integer(options.blockPageSize ?? Number(process.env.CHAINWEB_BLOCK_PAGE_SIZE ?? 500), 'block page size', 1, 500);

  async function request(path, { body, headers = {} } = {}) {
    for (let attempt = 0; attempt <= retries; attempt++) {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(new Error('Chainweb request timed out')), timeoutMs);
      let response;
      try {
        response = await fetchImpl(origin + path, {
          method: body === undefined ? 'GET' : 'POST', redirect: 'error', signal: controller.signal,
          headers: { Accept: 'application/json', 'Content-Type': 'application/json', ...headers },
          ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        });
        if (!response.ok) {
          await response.body?.cancel();
          const retryable = [408, 429, 500, 502, 503, 504].includes(response.status);
          const error = new Error(`Chainweb HTTP ${response.status} for ${path.split('?')[0]}`);
          error.status = response.status;
          if (!retryable || attempt === retries) throw error;
          const after = response.headers.get('retry-after');
          const retryAfterMs = after ? (/^\d+(\.\d+)?$/.test(after) ? Number(after) * 1000 : Math.max(0, Date.parse(after) - Date.now())) : 0;
          if (retryAfterMs > 60000) { error.retryAfterMs = retryAfterMs; throw error; }
          clearTimeout(timeout);
          await sleep(Math.max(Number.isFinite(retryAfterMs) ? retryAfterMs : 0, 250 * 2 ** attempt));
          continue;
        }
        return await readBounded(response, maxResponseBytes);
      } catch (error) {
        // HTTP errors and invalid/oversized JSON are explicit failures, not transport retries.
        if (response || attempt === retries) throw error;
        clearTimeout(timeout);
        await sleep(250 * 2 ** attempt);
      } finally { clearTimeout(timeout); }
    }
    throw new Error('Chainweb retry budget exhausted');
  }

  async function discoverNetwork() {
    const info = await request('/info');
    const chains = (info.nodeChains ?? []).map(Number).sort((a, b) => a - b);
    if (info.nodeVersion !== 'mainnet01' || info.nodeApiVersion !== '0.0' || chains.length !== 20 ||
        chains.some((value, index) => value !== index)) throw new Error('Node is not the 20-chain Pact mainnet01 network');
    return info;
  }

  async function getCut() {
    const cut = await request(`${PREFIX}/cut`);
    if (cut.instance !== 'mainnet01' || !cut.hashes || Object.keys(cut.hashes).length !== 20) throw new Error('Invalid community mainnet cut');
    for (let chain = 0; chain < 20; chain++) {
      const tip = cut.hashes[String(chain)];
      if (!tip) throw new Error(`Cut missing chain ${chain}`);
      integer(tip.height, 'cut height'); hash(tip.hash, 'cut hash');
    }
    return cut;
  }

  async function headersRange({ chain, fromHeight, toHeight, tipHash }) {
    chain = chainNumber(chain);
    integer(fromHeight, 'fromHeight'); integer(toHeight, 'toHeight'); hash(tipHash, 'tipHash');
    const count = toHeight - fromHeight + 1;
    if (count < 1 || count > maxHeaders) throw new Error(`Header range must contain 1–${maxHeaders} heights`);
    const query = new URLSearchParams({ minheight: String(fromHeight), maxheight: String(toHeight), limit: String(Math.min(pageSize, count)) });
    const collected = new Map();
    const cursors = new Set();
    for (let page = 0; page <= count; page++) {
      const result = await request(`${PREFIX}/chain/${chain}/header/branch?${query}`, {
        body: { lower: [], upper: [tipHash] },
        headers: { Accept: 'application/json;blockheader-encoding=object' },
      });
      if (!Array.isArray(result.items)) throw new Error('Invalid header page');
      for (const header of result.items) {
        validateHeader(header, chain);
        if (header.height < fromHeight || header.height > toHeight || collected.has(header.height)) throw new Error('Duplicate or out-of-range header');
        collected.set(header.height, header);
      }
      if (!result.next) break;
      if (typeof result.next !== 'string' || cursors.has(result.next)) throw new Error('Repeated or invalid header cursor');
      cursors.add(result.next); query.set('next', result.next);
      if (page === count) throw new Error('Header pagination budget exhausted');
    }
    const headers = [...collected.values()].sort((a, b) => a.height - b.height);
    if (headers.length !== count) throw new Error(`Incomplete canonical header range: ${headers.length}/${count}`);
    headers.forEach((header, index) => {
      if (header.height !== fromHeight + index || (index > 0 && header.parent !== headers[index - 1].hash)) {
        throw new Error('Canonical header range contains a gap or parent mismatch');
      }
    });
    return headers;
  }

  /** Find adjacent canonical headers straddling a UTC boundary. The same tip
   * anchors every binary-search probe; adjacent parent verification proves the
   * returned lower header is immediately before the first collection block. */
  async function headerBeforeTime({ chain, time, tipHash, tipHeight, minHeight = 0 }) {
    chain = chainNumber(chain); integer(tipHeight, 'tipHeight'); integer(minHeight, 'minHeight'); hash(tipHash, 'tipHash');
    const boundary = typeof time === 'string' ? Date.parse(time) * 1000 : time;
    integer(boundary, 'boundary microseconds');
    if (minHeight >= tipHeight) throw new Error('Date search requires a nonempty canonical height interval');
    const at = async height => (await headersRange({ chain, fromHeight: height, toHeight: height, tipHash }))[0];
    let lower = await at(minHeight), upper = await at(tipHeight);
    if (lower.creationTime >= boundary || upper.creationTime < boundary) throw new Error('UTC boundary is outside the canonical search interval');
    while (upper.height - lower.height > 1) {
      const middle = await at(Math.floor((lower.height + upper.height) / 2));
      if (middle.creationTime < lower.creationTime || middle.creationTime > upper.creationTime) throw new Error('Canonical timestamp order is invalid');
      if (middle.creationTime < boundary) lower = middle; else upper = middle;
    }
    if (upper.parent !== lower.hash || lower.creationTime >= boundary || upper.creationTime < boundary) throw new Error('UTC boundary does not have adjacent canonical headers');
    return { before: lower, first: upper };
  }

  async function payloadsForHeaders({ chain, headers }) {
    chain = chainNumber(chain);
    if (!Array.isArray(headers) || headers.length > maxHeaders) throw new Error('Invalid payload header batch');
    headers.forEach(header => validateHeader(header, chain));
    const blocks = [];
    for (let offset = 0; offset < headers.length; offset += payloadBatchSize) {
      const batch = headers.slice(offset, offset + payloadBatchSize);
      const unique = [...new Map(batch.map(header => [header.payloadHash, header])).values()];
      const payloads = await request(`${PREFIX}/chain/${chain}/payload/outputs/batch`, {
        body: { hashes: unique.map(header => header.payloadHash), heights: unique.map(header => header.height) },
      });
      if (!Array.isArray(payloads)) throw new Error('Invalid payload batch response');
      const expected = new Set(unique.map(header => header.payloadHash));
      const found = new Map();
      for (const payload of payloads) {
        if (!expected.has(payload?.payloadHash) || found.has(payload.payloadHash)) throw new Error('Unexpected or duplicate payload identity');
        found.set(payload.payloadHash, payload);
      }
      if (found.size !== expected.size) throw new Error('Incomplete payload batch; no coverage may be marked complete');
      for (const header of batch) blocks.push(decodeBlock(header, found.get(header.payloadHash)));
    }
    return blocks;
  }

  /** Re-read canonical stored payloads without fabricating a full block header.
   * These fields come from previously verified indexed headers. Exact payload
   * digests bind repair to the originally observed source, not merely its label. */
  async function payloadsForStoredBlocks({ chain, blocks }) {
    chain = chainNumber(chain);
    if (!Array.isArray(blocks) || blocks.length < 1 || blocks.length > 100) throw new Error('Stored payload batch must contain 1–100 blocks');
    const heights = new Set();
    const entries = blocks.map(row => {
      if (Number(row.chain) !== chain) throw new Error('Stored block chain mismatch');
      const height = integer(Number(row.height), 'stored height');
      if (heights.has(height)) throw new Error('Duplicate stored block height');
      heights.add(height);
      const creationTime = integer(Number(row.creation_time), 'stored creation time');
      const transactionCount = integer(Number(row.transaction_count), 'stored transaction count', 1);
      if (!/^[0-9a-f]{64}$/.test(row.source_digest ?? '')) throw new Error('Invalid stored source digest');
      const header = { chainId: chain, height, hash: hash(row.hash, 'stored block hash'),
        parent: hash(row.parent, 'stored parent hash'), creationTime, payloadHash: hash(row.payload_hash, 'stored payload hash') };
      if (row.block_time != null && new Date(row.block_time).toISOString() !== new Date(creationTime / 1000).toISOString()) throw new Error('Stored block timestamp mismatch');
      return { row, header, transactionCount };
    });
    async function batch(items) {
      const unique = [...new Map(items.map(item => [item.header.payloadHash, item])).values()];
      let payloads;
      try {
        payloads = await request(`${PREFIX}/chain/${chain}/payload/outputs/batch`, {
          body: { hashes: unique.map(item => item.header.payloadHash), heights: unique.map(item => item.header.height) },
        });
      } catch (error) {
        if (items.length > 1 && (error.code === 'CHAINWEB_RESPONSE_TOO_LARGE' || error.status === 413)) {
          const middle = Math.floor(items.length / 2);
          return [...await batch(items.slice(0, middle)), ...await batch(items.slice(middle))];
        }
        throw error;
      }
      if (!Array.isArray(payloads)) throw new Error('Invalid stored payload batch response');
      const expected = new Set(unique.map(item => item.header.payloadHash)), found = new Map();
      for (const payload of payloads) {
        if (!expected.has(payload?.payloadHash) || found.has(payload.payloadHash)) throw new Error('Unexpected or duplicate stored payload identity');
        found.set(payload.payloadHash, payload);
      }
      if (found.size !== expected.size) throw new Error('Incomplete stored payload batch');
      return items.map(({ row, header, transactionCount }) => {
        const payload = found.get(header.payloadHash);
        if (!Array.isArray(payload.transactions) || payload.transactions.length !== transactionCount) throw new Error(`Stored transaction count mismatch at chain ${chain}, height ${header.height}`);
        const sourceDigest = createHash('sha256').update(JSON.stringify(payload)).digest('hex');
        if (sourceDigest !== row.source_digest) throw Object.assign(new Error(`Original source digest mismatch at chain ${chain}, height ${header.height}; investigate source serialization before repair`),
          { code: 'ACCOUNT_REPAIR_SOURCE_MISMATCH', details: { chain, height: header.height, expectedDigest: row.source_digest, receivedDigest: sourceDigest } });
        return decodeBlock(header, payload);
      });
    }
    const decoded = [];
    for (let offset = 0; offset < entries.length; offset += payloadBatchSize) decoded.push(...await batch(entries.slice(offset, offset + payloadBatchSize)));
    return decoded;
  }

  /** Canonical headers and their transaction outputs in the same bounded call. */
  async function blocksRange({ chain, fromHeight, toHeight, tipHash }) {
    chain = chainNumber(chain);
    integer(fromHeight, 'fromHeight'); integer(toHeight, 'toHeight'); hash(tipHash, 'tipHash');
    const count = toHeight - fromHeight + 1;
    if (count < 1 || count > 500) throw new Error('Block range must contain 1–500 heights');
    async function segment(from, through) {
      const size = through - from + 1;
      const query = new URLSearchParams({ minheight: String(from), maxheight: String(through), limit: String(Math.min(blockPageSize, size)) });
      const collected = new Map(), cursors = new Set();
      try {
        for (let page = 0; page <= size; page++) {
          const result = await request(`${PREFIX}/chain/${chain}/block/branch?${query}`, {
            body: { lower: [], upper: [tipHash] },
          });
          if (!Array.isArray(result.items)) throw new Error('Invalid block page');
          for (const item of result.items) {
            const header = validateHeader(item?.header, chain);
            if (header.height < from || header.height > through || collected.has(header.height)) throw new Error('Duplicate or out-of-range block');
            collected.set(header.height, decodeBlock(header, item.payloadWithOutputs));
          }
          if (!result.next) break;
          if (typeof result.next !== 'string' || cursors.has(result.next)) throw new Error('Repeated or invalid block cursor');
          cursors.add(result.next); query.set('next', result.next);
          if (page === size) throw new Error('Block pagination budget exhausted');
        }
      } catch (error) {
        // Splitting only oversized responses avoids multiplying requests after
        // rate limits or identity failures. One oversized block fails explicitly.
        if (size > 1 && (error.code === 'CHAINWEB_RESPONSE_TOO_LARGE' || error.status === 413)) {
          const middle = Math.floor((from + through) / 2);
          const left = await segment(from, middle);
          const right = await segment(middle + 1, through);
          return [...left, ...right];
        }
        throw error;
      }
      if (collected.size !== size) throw new Error(`Incomplete canonical block range: ${collected.size}/${size}`);
      return [...collected.values()].sort((a, b) => a.header.height - b.header.height);
    }
    const blocks = await segment(fromHeight, toHeight);
    blocks.forEach((block, index) => {
      if (block.header.height !== fromHeight + index || (index > 0 && block.header.parent !== blocks[index - 1].header.hash)) throw new Error('Canonical block range contains a gap or parent mismatch');
    });
    return blocks;
  }

  async function localAt({ chain, tipHash, height, code, data = {}, gasLimit = 200000 }) {
    chain = chainNumber(chain); integer(height, 'historical height');
    integer(gasLimit, 'local gas limit', 1, 1000000);
    if (typeof code !== 'string' || code.length > 200000) throw new Error('Invalid read-only Pact query');
    const [target] = await headersRange({ chain, fromHeight: height, toHeight: height, tipHash });
    const current = await getCut();
    let depth = current.hashes[String(chain)].height - height;
    if (depth < 0) throw new Error('Historical state is ahead of node');
    for (let attempt = 0; attempt < 5; attempt++) {
      integer(depth, 'rewind depth');
      const command = JSON.stringify({ networkId: 'mainnet01', payload: { exec: { code, data } }, signers: [],
        meta: { chainId: String(chain), sender: '', gasLimit, gasPrice: 0.00000001, ttl: 600, creationTime: Math.floor(Date.now() / 1000) - 10 },
        nonce: `kce-index-read-only-${Date.now()}-${attempt}` });
      const raw = await request(`${PREFIX}/chain/${chain}/pact/api/v1/local?rewindDepth=${depth}`, {
        body: { cmd: command, hash: pactCommandHash(command), sigs: [] },
      });
      const metadata = raw.metaData;
      if (!metadata || !Number.isSafeInteger(metadata.blockHeight)) throw new Error('Historical Pact response lacks state metadata');
      if (metadata.blockHeight === height + 1 && metadata.prevBlockHash === target.hash) {
        if (raw.result?.status !== 'success') throw new Error('Read-only historical Pact query failed');
        return { chain, height, blockHash: target.hash, result: raw.result, data: raw.result.data, metadata, raw };
      }
      if (metadata.blockHeight === height + 1) throw new Error('Historical Pact state is on a different canonical block');
      depth += metadata.blockHeight - (height + 1);
    }
    throw new Error('Could not pin historical Pact state after 5 attempts');
  }

  async function listModulesAt(options) {
    const pinned = await localAt({ ...options, code: '(list-modules)', data: {} });
    if (!Array.isArray(pinned.data) || pinned.data.some(name => typeof name !== 'string') || new Set(pinned.data).size !== pinned.data.length) {
      throw new Error('Invalid historical module inventory');
    }
    return { ...pinned, modules: [...pinned.data].sort() };
  }

  return { discoverNetwork, getCut, headersRange, headerBeforeTime, payloadsForHeaders, payloadsForStoredBlocks, blocksRange, localAt, listModulesAt };
}

let defaultClient;
const client = () => defaultClient ??= createChainwebClient();
export const discoverNetwork = (...args) => client().discoverNetwork(...args);
export const getCut = (...args) => client().getCut(...args);
export const headersRange = (...args) => client().headersRange(...args);
export const payloadsForHeaders = (...args) => client().payloadsForHeaders(...args);
export const payloadsForStoredBlocks = (...args) => client().payloadsForStoredBlocks(...args);
export const blocksRange = (...args) => client().blocksRange(...args);
export const localAt = (...args) => client().localAt(...args);
export const listModulesAt = (...args) => client().listModulesAt(...args);

export const headerBeforeTime = (...args) => client().headerBeforeTime(...args);
