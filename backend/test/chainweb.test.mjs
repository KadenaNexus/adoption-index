import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createChainwebClient } from '../src/chainweb.mjs';
import { pactCommandHash } from '../src/pact.mjs';

const hash = char => char.repeat(43);
const response = (value, status = 200, headers = {}) => new Response(JSON.stringify(value), { status, headers: { 'Content-Type': 'application/json', ...headers } });
const header = (height, letter, parent) => ({ chainId: 2, height, hash: hash(letter), parent: hash(parent),
  payloadHash: hash(letter.toUpperCase()), target: hash('t'), weight: hash('w'), creationTime: 1762574965741022 + height,
  chainwebVersion: 'mainnet01' });
const cut = (height = 15) => ({ instance: 'mainnet01', hashes: Object.fromEntries(Array.from({ length: 20 }, (_, chain) => [chain, { height, hash: hash('z') }])) });

test('canonical branch pagination is sorted, checks parent links, and never calls unrestricted header listing', async () => {
  const first = header(10, 'a', 'q'), second = header(11, 'b', 'a');
  const calls = [];
  const client = createChainwebClient({ pageSize: 1, fetchImpl: async (url, options) => {
    calls.push({ url, options });
    return response(calls.length === 1 ? { items: [second], next: 'exclusive:cursor' } : { items: [first], next: null });
  } });
  const result = await client.headersRange({ chain: 2, fromHeight: 10, toHeight: 11, tipHash: hash('z') });
  assert.deepEqual(result.map(x => x.height), [10, 11]);
  assert.ok(calls.every(x => x.url.includes('/header/branch?') && x.options.method === 'POST'));
  assert.deepEqual(JSON.parse(calls[0].options.body), { lower: [], upper: [hash('z')] });
  assert.match(calls[1].url, /next=exclusive%3Acursor/);
});

test('gaps, wrong network, and broken ancestry cannot become completed ranges', async () => {
  for (const items of [[header(10, 'a', 'q')], [header(11, 'b', 'x'), header(10, 'a', 'q')], [{ ...header(10, 'a', 'q'), chainwebVersion: 'testnet06' }]]) {
    const client = createChainwebClient({ fetchImpl: async () => response({ items, next: null }) });
    await assert.rejects(client.headersRange({ chain: 2, fromHeight: 10, toHeight: 11, tipHash: hash('z') }));
  }
});

test('missing payloads are rejected and batch body binds hashes to heights', async () => {
  let body;
  const client = createChainwebClient({ fetchImpl: async (url, options) => {
    assert.match(url, /\/payload\/outputs\/batch$/);
    body = JSON.parse(options.body);
    return response([]);
  } });
  await assert.rejects(client.payloadsForHeaders({ chain: 2, headers: [header(10, 'a', 'q')] }), /Incomplete payload/);
  assert.deepEqual(body, { hashes: [hash('A')], heights: [10] });
});

test('429 retries respect Retry-After; large Retry-After is returned to scheduler', async () => {
  const delays = [];
  let count = 0;
  const client = createChainwebClient({ sleep: async delay => delays.push(delay), fetchImpl: async () => ++count === 1 ? response({}, 429, { 'Retry-After': '2' }) : response(cut()) });
  await client.getCut();
  assert.deepEqual(delays, [2000]);
  const later = createChainwebClient({ fetchImpl: async () => response({}, 429, { 'Retry-After': '3600' }) });
  await assert.rejects(later.getCut(), error => error.retryAfterMs === 3600000);
});

test('streamed response bytes are capped even without Content-Length', async () => {
  const client = createChainwebClient({ maxResponseBytes: 20, fetchImpl: async () => response(cut()) });
  await assert.rejects(client.getCut(), /byte limit/);
});

test('network discovery requires exactly the 20 mainnet Pact chains', async () => {
  const client = createChainwebClient({ fetchImpl: async () => response({ nodeVersion: 'mainnet01', nodeApiVersion: '0.0', nodeChains: Array.from({ length: 20 }, (_, i) => String(i)) }) });
  assert.equal((await client.discoverNetwork()).nodeChains.length, 20);
  const bad = createChainwebClient({ fetchImpl: async () => response({ nodeVersion: 'mainnet01', nodeApiVersion: '0.0', nodeChains: Array.from({ length: 25 }, (_, i) => String(i)) }) });
  await assert.rejects(bad.discoverNetwork(), /20-chain/);
});

test('historical module inventory adjusts advancing head and pins hash, unsigned /local only', async () => {
  const target = header(10, 'a', 'q');
  const depths = [];
  let locals = 0;
  const client = createChainwebClient({ fetchImpl: async (url, options) => {
    if (url.includes('/header/branch?')) return response({ items: [target], next: null });
    if (url.endsWith('/cut')) return response(cut(15));
    assert.match(url, /\/pact\/api\/v1\/local\?/);
    depths.push(Number(new URL(url).searchParams.get('rewindDepth')));
    const envelope = JSON.parse(options.body), command = JSON.parse(envelope.cmd);
    assert.deepEqual(envelope.sigs, []); assert.deepEqual(command.signers, []);
    assert.equal(command.payload.exec.code, '(list-modules)');
    locals++;
    return response({ result: { status: 'success', data: ['free.x', 'coin'] }, metaData: locals === 1 ?
      { blockHeight: 12, prevBlockHash: hash('b') } : { blockHeight: 11, prevBlockHash: target.hash } });
  } });
  const result = await client.listModulesAt({ chain: 2, height: 10, tipHash: hash('z') });
  assert.deepEqual(depths, [5, 6]);
  assert.equal(result.blockHash, target.hash);
  assert.deepEqual(result.modules, ['coin', 'free.x']);
});

test('historical state at right height but wrong hash is rejected', async () => {
  const client = createChainwebClient({ fetchImpl: async url => {
    if (url.includes('/header/branch?')) return response({ items: [header(10, 'a', 'q')], next: null });
    if (url.endsWith('/cut')) return response(cut());
    return response({ result: { status: 'success', data: [] }, metaData: { blockHeight: 11, prevBlockHash: hash('x') } });
  } });
  await assert.rejects(client.listModulesAt({ chain: 2, height: 10, tipHash: hash('z') }), /different canonical/);
});

test('historical Pact timeout text is surfaced as a typed upstream error', async () => {
  const client = createChainwebClient({ fetchImpl: async url => {
    if (url.includes('/header/branch?')) return response({ items: [header(10, 'a', 'q')], next: null });
    if (url.endsWith('/cut')) return response(cut());
    return response('Transaction timed out');
  } });
  await assert.rejects(client.listModulesAt({ chain: 2, height: 10, tipHash: hash('z') }), error =>
    error.code === 'CHAINWEB_PACT_TIMEOUT' && /Transaction timed out/.test(error.message));
});

const encoded = value => Buffer.from(JSON.stringify(value)).toString('base64url');
const blockItem = h => ({ header: h, payloadWithOutputs: { payloadHash: h.payloadHash, transactions: [], coinbase: encoded({ result: { status: 'success', data: 'reward' } }), minerData: encoded({ account: 'miner' }) } });

test('combined block branch decodes canonical ordered blocks and validates payload identity', async () => {
  const first = blockItem(header(10, 'a', 'q')), second = blockItem(header(11, 'b', 'a'));
  const client = createChainwebClient({ fetchImpl: async (url, options) => {
    assert.match(url, /\/block\/branch\?/); assert.equal(options.method, 'POST');
    assert.equal(options.headers.Accept, 'application/json');
    return response({ items: [second, first], next: null });
  } });
  const blocks = await client.blocksRange({ chain: 2, fromHeight: 10, toHeight: 11, tipHash: hash('z') });
  assert.deepEqual(blocks.map(b => b.header.height), [10, 11]);
  first.payloadWithOutputs.payloadHash = hash('x');
  await assert.rejects(client.blocksRange({ chain: 2, fromHeight: 10, toHeight: 11, tipHash: hash('z') }), /Payload hash/);
});

test('oversized block pages halve bounded height ranges and still verify ancestry across halves', async () => {
  const calls = [];
  const first = blockItem(header(10, 'a', 'q')), second = blockItem(header(11, 'b', 'a'));
  const client = createChainwebClient({ maxResponseBytes: 900, fetchImpl: async url => {
    const query = new URL(url).searchParams, from = Number(query.get('minheight')), to = Number(query.get('maxheight'));
    calls.push([from, to]);
    return response({ items: from === 10 && to === 11 ? [second, first] : from === 10 ? [first] : [second], next: null });
  } });
  const blocks = await client.blocksRange({ chain: 2, fromHeight: 10, toHeight: 11, tipHash: hash('z') });
  assert.deepEqual(calls, [[10, 11], [10, 10], [11, 11]]);
  assert.equal(blocks.length, 2);
  second.header.parent = hash('x');
  await assert.rejects(client.blocksRange({ chain: 2, fromHeight: 10, toHeight: 11, tipHash: hash('z') }), /parent mismatch/);
});

test('combined block requests cap at 500 heights and never split identity errors or 429s', async () => {
  let calls = 0;
  const client = createChainwebClient({ retries: 0, fetchImpl: async () => { calls++; return response({}, 429); } });
  await assert.rejects(client.blocksRange({ chain: 2, fromHeight: 1, toHeight: 501, tipHash: hash('z') }), /1–500/);
  assert.equal(calls, 0);
  await assert.rejects(client.blocksRange({ chain: 2, fromHeight: 10, toHeight: 11, tipHash: hash('z') }), /HTTP 429/);
  assert.equal(calls, 1);
});

test('500-block branch honors a partial upstream page and its cursor without gaps', async () => {
  const id = value => createHash('sha256').update(String(value)).digest('base64url');
  const items = Array.from({ length: 500 }, (_, index) => {
    const height = 1000 + index;
    return blockItem({ ...header(height, 'a', 'b'), hash: id(height), parent: id(height - 1), payloadHash: id('payload:' + height) });
  });
  let calls = 0;
  const client = createChainwebClient({ blockPageSize: 500, fetchImpl: async url => {
    const query = new URL(url).searchParams;
    assert.equal(query.get('limit'), '500'); calls++;
    if (!query.has('next')) return response({ items: items.slice(200).reverse(), next: 'inclusive:continuation' });
    assert.equal(query.get('next'), 'inclusive:continuation');
    return response({ items: items.slice(0, 200).reverse(), next: null });
  } });
  const blocks = await client.blocksRange({ chain: 2, fromHeight: 1000, toHeight: 1499, tipHash: hash('z') });
  assert.equal(blocks.length, 500); assert.equal(calls, 2);
  assert.deepEqual(blocks.map(b => b.header.height), items.map(item => item.header.height));
});

function storedFixture(height = 10, letter = 'a') {
  const h = header(height, letter, 'q');
  const cmd = JSON.stringify({ networkId: 'mainnet01', meta: { chainId: '2', sender: 'gas-payer' },
    payload: { exec: { code: '(+ 1 2)', data: {} } }, signers: [] });
  const key = pactCommandHash(cmd);
  const payload = { ...blockItem(h).payloadWithOutputs, transactions: [[encoded({ cmd, hash: key, sigs: [] }),
    encoded({ reqKey: key, result: { status: 'success', data: true }, events: [{ name: 'TRANSFER',
      module: { name: 'ledger', namespace: 'marmalade' }, params: ['token-id-is-not-an-account', 'alice', 'bob', 1] }] })]] };
  const row = { chain: 2, height: String(height), hash: h.hash, parent: h.parent,
    creation_time: String(h.creationTime), block_time: new Date(h.creationTime / 1000), payload_hash: h.payloadHash,
    transaction_count: 1, source_digest: createHash('sha256').update(JSON.stringify(payload)).digest('hex') };
  return { row, payload };
}

test('stored payload repair verifies original digest and decodes accounts without inventing full header fields', async () => {
  const fixture = storedFixture();
  const client = createChainwebClient({ fetchImpl: async (url, options) => {
    assert.match(url, /\/payload\/outputs\/batch$/);
    assert.deepEqual(JSON.parse(options.body), { hashes: [fixture.row.payload_hash], heights: [10] });
    return response([fixture.payload]);
  } });
  const [decoded] = await client.payloadsForStoredBlocks({ chain: 2, blocks: [fixture.row] });
  assert.equal(decoded.header.weight, undefined); assert.equal(decoded.header.target, undefined);
  assert.deepEqual(decoded.transactions[0].participants, ['gas-payer', 'alice', 'bob']);
  assert.deepEqual(decoded.payload, fixture.payload);
});

test('stored payload repair fails closed on source digest, count, payload identity and command hash mismatch', async () => {
  for (const problem of ['digest', 'count', 'identity', 'command']) {
    const fixture = storedFixture();
    if (problem === 'digest') fixture.row.source_digest = '0'.repeat(64);
    if (problem === 'count') fixture.row.transaction_count = 2;
    if (problem === 'identity') fixture.payload.payloadHash = hash('x');
    if (problem === 'command') {
      const wrapper = JSON.parse(Buffer.from(fixture.payload.transactions[0][0], 'base64url'));
      wrapper.cmd += ' ';
      fixture.payload.transactions[0][0] = encoded(wrapper);
      fixture.row.source_digest = createHash('sha256').update(JSON.stringify(fixture.payload)).digest('hex');
    }
    const client = createChainwebClient({ fetchImpl: async () => response([fixture.payload]) });
    await assert.rejects(client.payloadsForStoredBlocks({ chain: 2, blocks: [fixture.row] }),
      problem === 'digest' ? /source digest mismatch/ : problem === 'count' ? /transaction count mismatch/ : problem === 'identity' ? /payload identity/ : /command hash/);
  }
});

test('stored payload repair only splits oversized responses and retains bounded retry behavior', async () => {
  const a = storedFixture(10, 'a'), b = storedFixture(11, 'b'), requests = [];
  const byHash = new Map([a, b].map(item => [item.row.payload_hash, item.payload]));
  const client = createChainwebClient({ payloadBatchSize: 100, maxResponseBytes: JSON.stringify([a.payload]).length + 100,
    fetchImpl: async (_, options) => { const body = JSON.parse(options.body); requests.push(body.heights); return response(body.hashes.map(value => byHash.get(value))); } });
  assert.equal((await client.payloadsForStoredBlocks({ chain: 2, blocks: [a.row, b.row] })).length, 2);
  assert.deepEqual(requests, [[10, 11], [10], [11]]);
  let calls = 0; const delays = [];
  const retry = createChainwebClient({ sleep: async delay => delays.push(delay), fetchImpl: async () => ++calls === 1 ? response({}, 429, { 'Retry-After': '1' }) : response([a.payload]) });
  assert.equal((await retry.payloadsForStoredBlocks({ chain: 2, blocks: [a.row] })).length, 1);
  assert.deepEqual(delays, [1000]);
});

test('binary date search returns adjacent canonical headers bracketing exact UTC boundary with logarithmic requests', async () => {
 const identify=value=>createHash('sha256').update(String(value)).digest('base64url');
 const origin=Date.parse('2026-07-01T00:00:00Z')*1000, boundary=origin+12345*30000000;
 const probes=[];
 const client=createChainwebClient({fetchImpl:async(url,options)=>{
  const query=new URL(url).searchParams,height=Number(query.get('minheight')); probes.push(height);
  assert.equal(query.get('maxheight'),String(height)); assert.deepEqual(JSON.parse(options.body),{lower:[],upper:[hash('z')]});
  return response({items:[{...header(height,'a','b'),hash:identify(height),parent:identify(height-1),creationTime:origin+height*30000000}],next:null});
 }});
 const result=await client.headerBeforeTime({chain:2,time:boundary,tipHash:hash('z'),tipHeight:100000,minHeight:0});
 assert.equal(result.before.height,12344); assert.equal(result.first.height,12345);
 assert.equal(result.first.parent,result.before.hash); assert.ok(probes.length<=20);
 await assert.rejects(client.headerBeforeTime({chain:2,time:origin,tipHash:hash('z'),tipHeight:100000}),/outside/);
 await assert.rejects(client.headerBeforeTime({chain:2,time:origin+100001*30000000,tipHash:hash('z'),tipHeight:100000}),/outside/);
});

test('date search refuses a boundary whose adjacent headers disagree about parent identity', async () => {
 const origin=Date.parse('2026-07-01T00:00:00Z')*1000;
 const client=createChainwebClient({fetchImpl:async url=>{
  const height=Number(new URL(url).searchParams.get('minheight'));
  return response({items:[{...header(height,height===1?'a':'b','x'),creationTime:origin+height*30000000}],next:null});
 }});
 await assert.rejects(client.headerBeforeTime({chain:2,time:origin+2*30000000,tipHash:hash('z'),minHeight:1,tipHeight:2}),/adjacent canonical/);
});
