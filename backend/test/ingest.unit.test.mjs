import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { artifactStatus, assertModuleIdentitiesReviewed, dailyChainMetrics, indexBlocks, persistBlock, persistBlocks, workForTarget, assertCollectionState, rebaseChain, pruneRetention } from '../src/ingest.mjs';
import { decodeBlock, pactCommandHash } from '../src/pact.mjs';
import { FORK_HEIGHT, METHOD_VERSION, addDays } from '../src/scoring.mjs';
import {COLLECTION_START as FORK_DAY, INITIAL_HISTORY_DAYS, windowFor} from '../src/window.mjs';

const hash = value => createHash('sha256').update(String(value)).digest('base64url');
const target = Buffer.alloc(32, 255).toString('base64url');
const THROUGH_DAY = addDays(FORK_DAY, 89);
const originTime = Date.parse(FORK_DAY + 'T00:00:10Z') * 1000 + 123;
const header = (chain = 0, height = FORK_HEIGHT) => ({ chainId: chain, height,
  hash: hash(`${chain}:${height}`), parent: hash(`${chain}:${height - 1}`), payloadHash: hash(`payload:${chain}:${height}`),
  target, weight: hash('weight'), creationTime: originTime + (height - FORK_HEIGHT) * 30000000 + chain,
  chainwebVersion: 'mainnet01' });
const encode = value => Buffer.from(JSON.stringify(value)).toString('base64url');
const policy = { version: 'unit-test', includedModules: [], excludedModules: [], reviewNamePatterns: ['(^|\\.)(test|demo)($|-)'] };
function block(chain = 0, height = FORK_HEIGHT, commands = []) {
  const h = header(chain, height);
  const transactions = commands.map(({ sender, code = '(+ 1 2)', status = 'success', events = [], data = 'ok', commandData = {}, signers = [] }) => {
    const cmd = JSON.stringify({ networkId: 'mainnet01', meta: { chainId: String(chain), sender }, payload: { exec: { code, data: commandData } }, signers });
    const requestKey = pactCommandHash(cmd);
    return [encode({ cmd, hash: requestKey, sigs: [] }), encode({ reqKey: requestKey, result: { status, data }, events })];
  });
  return decodeBlock(h, { payloadHash: h.payloadHash, transactions,
    coinbase: encode({ result: { status: 'success', data: 'miner reward' }, events: [{ name: 'TRANSFER', params: ['', 'coinbase-only', 1], module: { name: 'coin', namespace: null } }] }),
    minerData: encode({ account: 'coinbase-only' }) });
}

function memoryDatabase(initial = true) {
  let state = { checkpoints: new Map(), blocks: new Map(), modules: new Set(), deployments: [], reviews: new Map(), accounts: new Set(), stats: new Map() };
  if (initial) for (let chain = 0; chain < 20; chain++) state.checkpoints.set(chain, { chain, coverage_start: FORK_DAY, height: FORK_HEIGHT - 1, hash: header(chain, FORK_HEIGHT - 1).hash, block_time: new Date((originTime - 30000000) / 1000).toISOString() });
  let rollback;
  const calls = [];
  let released = 0;
  async function query(sql, values = []) {
    calls.push({ sql, values });
    const result = (rows = [], rowCount = rows.length) => ({ rows, rowCount });
    if (sql === 'BEGIN') { rollback = structuredClone(state); return result(); }
    if (sql === 'ROLLBACK') { state = rollback; return result(); }
    if (sql === 'COMMIT') { rollback = null; return result(); }
    if (sql.includes('pg_try_advisory_lock')) return result([{ locked: true }]);
    if (sql.includes('pg_advisory_unlock') || sql.includes('pg_advisory_xact_lock')) return result();
    if (sql.includes('FROM collection_state')) return result([{start_day:FORK_DAY,initial_history_days:INITIAL_HISTORY_DAYS,method_version:METHOD_VERSION,history_policy:'growing-permanent'}]);
    if (sql.includes('FROM account_extraction_state')) return result([{ version: 'pact-transfer-v2', status: 'ready' }]);
    if (sql.startsWith('SELECT * FROM chain_checkpoints')) return result(state.checkpoints.has(values[0]) ? [state.checkpoints.get(values[0])] : []);
    if (sql.startsWith('SELECT chain,height,hash,block_time FROM chain_checkpoints')) return result([...state.checkpoints.values()]);
    if (sql.startsWith('SELECT height,hash FROM blocks')) return result([...state.blocks.values()].filter(block => block.chain === values[0] && block.height >= values[1] && block.height <= values[2]));
    if (sql.startsWith('INSERT INTO chain_checkpoints')) { state.checkpoints.set(values[0], { chain: values[0], height: values[1], hash: values[2], block_time: values[3],baseline_inventory:values[5],baseline_header:values[6],coverage_start:values[7] }); return result(); }
    if (sql.startsWith('INSERT INTO modules') && sql.includes('unnest')) { for (const name of values[1]) state.modules.add(`${values[0]}:${name}`); return result(); }
    if (sql.startsWith('INSERT INTO modules')) { const id = `${values[0]}:${values[1]}`; if (state.modules.has(id)) return result(); state.modules.add(id); return result([{ name: values[1] }]); }
    if (sql.startsWith('INSERT INTO module_deployments')) { state.deployments.push({ chain: values[0], name: values[5], kind: values[6], status: values[7], evidence: values[9] }); return result(); }
    if (sql.startsWith('INSERT INTO module_identity_reviews')) {
      const key = JSON.stringify([values[0], values[4], values[6]]);
      if (state.reviews.has(key)) throw new Error('Duplicate review identity');
      state.reviews.set(key, { chain: values[0], height: values[1], blockTime: values[3], requestKey: values[4],
        transactionIndex: values[5], declarationIndex: values[6], literalName: values[7], evidenceDigest: values[12], evidence: values[13] });
      return result();
    }
    if (sql.startsWith('INSERT INTO daily_accounts')) { for (const row of JSON.parse(values[0])) state.accounts.add(`${row.day}:${row.chain}:${row.account}`); return result(); }
    if (sql.startsWith('DELETE FROM blocks')) { for (const [key,row] of state.blocks) if (row.chain===values[0] && row.height<=values[1]) state.blocks.delete(key); return result(); }
    if (sql.startsWith('DELETE FROM source_evidence')) return result();
    if (sql.startsWith('INSERT INTO daily_chain_stats')) { const rows=JSON.parse(values[0]); for (const row of rows) { const key=`${row.day}:${row.chain}`,prev=state.stats.get(key); state.stats.set(key,prev?{...row,work:String(BigInt(row.work)+BigInt(prev.work)),block_count:row.block_count+prev.block_count,transaction_count:row.transaction_count+prev.transaction_count,first_height:prev.first_height,first_parent:prev.first_parent,first_creation_time:prev.first_creation_time}:row); } return result([],rows.length); }
    if (sql.startsWith('INSERT INTO blocks')) { for (const row of JSON.parse(values[0])) state.blocks.set(`${row.chain}:${row.height}`, row); return result(); }
    if (sql.startsWith('UPDATE chain_checkpoints')) { state.checkpoints.set(values[0], { ...state.checkpoints.get(values[0]), chain: values[0], height: values[1], hash: values[2], block_time: values[3] }); return result(); }
    if (sql.startsWith('INSERT INTO source_evidence')) return result();
    throw new Error('Unexpected SQL: ' + sql);
  }
  return { query, connect: async () => ({ query, release: () => released++ }), get state() { return state; }, calls, get released() { return released; } };
}

test('included failed senders and all-token transfer endpoints count; coinbase never counts; original microseconds survive', async () => {
  const db = memoryDatabase();
  const b = block(0, FORK_HEIGHT, [
    { sender: 'failed-gas-payer', status: 'failure' },
    { sender: 'alice', events: [{ name: 'TRANSFER', module: { name: 'token', namespace: 'free' }, params: ['alice', 'bob', 2] }] },
    { sender: 'alice', code: '(+ 1 3)', events: [{ name: 'TRANSFER', module: { name: 'coin', namespace: null }, params: ['', 'carol', 2] }] },
  ]);
  assert.equal(await persistBlock(db, b, policy), true);
  assert.deepEqual([...db.state.accounts].sort(), ['alice', 'bob', 'carol', 'failed-gas-payer'].map(account => `${FORK_DAY}:0:${account}`).sort());
  assert.equal(db.state.blocks.get(`0:${FORK_HEIGHT}`).creation_time, originTime);
  assert.equal(await persistBlock(db, b, policy), false);
  assert.equal(db.state.accounts.size, 4);
  await persistBlock(db, block(1, FORK_HEIGHT, [{ sender: 'alice' }]), policy);
  assert.equal(db.state.accounts.size, 5, 'same address on another Pact chain is a separate chain/account');
});

test('fixed collection inventory separates upgrades, successful new identities, and failed declarations', async () => {
  const db = memoryDatabase(); db.state.modules.add('0:free.existing');
  await persistBlock(db, block(0, FORK_HEIGHT, [
    { sender: 'a', code: '(namespace "free") (module existing G (defcap G () true))' },
    { sender: 'b', code: '(namespace "free") (module fresh G (defcap G () true))' },
    { sender: 'c', code: '(namespace "free") (module fresh G (defcap G () false))' },
    { sender: 'd', code: '(namespace "free") (module failed G (defcap G () true))', status: 'failure' },
  ]), policy);
  assert.deepEqual(db.state.deployments.map(x => [x.name, x.kind]), [['free.existing', 'upgrade'], ['free.fresh', 'new'], ['free.fresh', 'upgrade']]);
  assert.ok(!db.state.modules.has('0:free.failed'));
});

test('unresolved successful declarations preserve raw evidence and accounts while known identities continue; replay is idempotent', async () => {
  const db = memoryDatabase();
  const b = block(0, FORK_HEIGHT, [
    { sender: 'failed', status: 'failure', code: '(namespace (read-string "ns")) (module ignored G (defcap G () true))' },
    { sender: 'a', commandData: { retained: 'original data' }, signers: [{ pubKey: 'fixture-key' }],
      code: '(namespace (read-string "ns")) (module x G (defcap G () true)) (namespace "free") (module known G (defcap G () true))' },
  ]);
  assert.equal(await persistBlock(db, b, policy), true);
  assert.equal(db.state.checkpoints.get(0).height, FORK_HEIGHT);
  assert.equal(db.state.blocks.size, 1); assert.equal(db.state.accounts.size, 2);
  assert.equal(db.state.reviews.size, 1); assert.ok(!db.state.modules.has('0:x'));
  assert.deepEqual(db.state.deployments.map(row => row.name), ['free.known']);
  const queued = [...db.state.reviews.values()][0];
  assert.equal(queued.transactionIndex, 1); assert.equal(queued.declarationIndex, 0); assert.equal(queued.literalName, 'x');
  assert.deepEqual(queued.evidence.commandData, { retained: 'original data' });
  assert.deepEqual(queued.evidence.signers, [{ pubKey: 'fixture-key' }]);
  assert.equal(queued.evidence.code, b.transactions[1].code);
  assert.deepEqual(queued.evidence.result, b.transactions[1].result);
  assert.deepEqual(queued.evidence.sourceTransaction, b.payload.transactions[1]);
  assert.deepEqual(queued.evidence.sourceHeader, b.header);
  assert.equal(queued.evidenceDigest, createHash('sha256').update(JSON.stringify(queued.evidence)).digest('hex'));
  assert.equal(db.state.deployments[0].evidence.transactionIndex, 1);
  assert.equal(db.state.deployments[0].evidence.declarationIndex, 1);
  assert.equal(await persistBlock(db, b, policy), false);
  assert.equal(db.state.reviews.size, 1); assert.equal(db.state.deployments.length, 1);
});

test('canonical gaps and malformed account data still roll back without advancing coverage', async () => {
  const db = memoryDatabase();
  const b = block(0, FORK_HEIGHT, [{ sender: 'a' }]);
  b.transactions[0].participants.push('');
  await assert.rejects(persistBlock(db, b, policy), /Invalid decoded account/);
  assert.equal(db.state.checkpoints.get(0).height, FORK_HEIGHT - 1); assert.equal(db.state.accounts.size, 0);
  await assert.rejects(persistBlock(db, block(0, FORK_HEIGHT + 1), policy), /gap/);
  const different = block(); different.header.parent = hash('wrong-parent');
  await assert.rejects(persistBlock(db, different, policy), /parent mismatch/);
});

test('target arithmetic decodes little endian and rejects zero/noncanonical targets', () => {
  const bytes = Buffer.alloc(32); bytes[0] = 2;
  assert.equal(workForTarget(bytes.toString('base64url')), ((1n << 256n) - 1n) / 2n);
  assert.equal(workForTarget(target), 1n);
  assert.throws(() => workForTarget(Buffer.alloc(32).toString('base64url')), /positive/);
  assert.throws(() => workForTarget('x'.repeat(43)), /Invalid/);
});

test('artifact exclusions are explicit; review patterns never silently exclude; contradictory registries fail', () => {
  assert.equal(artifactStatus(0, 'free.test', policy), 'review');
  assert.equal(artifactStatus(0, 'free.real', policy), 'included');
  assert.equal(artifactStatus(0, 'free.test', { ...policy, includedModules: ['0:free.test'] }), 'included');
  assert.equal(artifactStatus(0, 'free.real', { ...policy, excludedModules: ['0:free.real'] }), 'excluded');
  assert.throws(() => artifactStatus(0, 'free.x', { ...policy, includedModules: ['0:free.x'], excludedModules: ['0:free.x'] }), /Conflicting/);
});

function fakeApi() {
  const requested = [];
  return { requested, headerBeforeTime: async ({chain})=>({before:header(chain,FORK_HEIGHT-1),first:header(chain)}), discoverNetwork: async () => ({}), getCut: async () => ({ id: 'anchor', hashes: Object.fromEntries(Array.from({ length: 20 }, (_, chain) => [chain, { hash: header(chain, FORK_HEIGHT + 100).hash, height: FORK_HEIGHT + 100 }])) }),
    headersRange: async ({ chain, fromHeight, toHeight }) => Array.from({ length: toHeight - fromHeight + 1 }, (_, i) => header(chain, fromHeight + i)),
    blocksRange: async ({ chain, fromHeight, toHeight }) => { requested.push(chain); return Array.from({ length: toHeight - fromHeight + 1 }, (_, i) => block(chain, fromHeight + i)); },
    listModulesAt: async ({ chain, height }) => ({ chain, height, blockHash: header(chain, height).hash, modules: ['coin'] }) };
}

test('tiny bounded invocations resume the least advanced chain instead of starving chains 1–19', async () => {
  const db = memoryDatabase(), api = fakeApi(), progress = [];
  for (let i = 0; i < 3; i++) {
    const result = await indexBlocks(db, { throughDay: THROUGH_DAY, maxBlocks: 1, api, onProgress: event => progress.push(event) });
    assert.equal(result.blocksIndexed, 1);
  }
  assert.deepEqual(api.requested, [0, 1, 2]);
  assert.equal(progress.filter(x => x.event === 'chain_chunk_indexed').length, 3);
});

test('parallel fetching never exceeds two chains or the remaining block budget', async () => {
  const db = memoryDatabase(), api = fakeApi(), original = api.blocksRange;
  let active = 0, maximum = 0;
  api.blocksRange = async range => {
    active++; maximum = Math.max(maximum, active);
    await new Promise(resolve => setImmediate(resolve));
    try { return await original(range); } finally { active--; }
  };
  const result = await indexBlocks(db, { throughDay: THROUGH_DAY, maxBlocks: 17, chunkSize: 5, api });
  assert.equal(result.blocksIndexed, 17); assert.equal(db.state.blocks.size, 17);
  assert.equal(maximum, 2); assert.equal(active, 0);
  assert.deepEqual(api.requested, [0, 1, 2, 3]);
  assert.equal(db.state.checkpoints.get(3).height, FORK_HEIGHT + 1);
});

test('new checkpoint requires inventory at the exact canonical pre-collection block', async () => {
  const db = memoryDatabase(false), api = fakeApi();
  api.listModulesAt = async ({ chain, height }) => ({ chain, height, blockHash: hash('wrong-state'), modules: ['coin'] });
  await assert.rejects(indexBlocks(db, { throughDay: THROUGH_DAY, maxBlocks: 1, api }), /not pinned/);
  assert.equal(db.state.checkpoints.size, 0); assert.equal(db.released, 1);
});

test('collection parameters fail before any network or database call', async () => {
  const api = { discoverNetwork: () => assert.fail('must validate first') };
  for (const options of [{ finalityDepth: -1 }, { finalityDepth: .5 }, { maxBlocks: 0 }, { chunkSize: 501 }]) await assert.rejects(indexBlocks({}, { ...options, api }), /Invalid collection/);
});

function dailyDatabase({ checkpoints, pending = 0, unresolved = 0, stats, accounts = [], contracts = [], deployments, throughDay = THROUGH_DAY } = {}) {
  const cutoff = addDays(throughDay, 1) + 'T00:00:00Z';
  const final = chain => ({...header(chain,FORK_HEIGHT+1),creationTime:Date.parse(cutoff)*1000+chain});
  const allStats = Array.from({length:20},(_,chain)=>[
    {day:FORK_DAY,chain,work:'1000000000000000',block_count:'1',first_height:String(FORK_HEIGHT),last_height:String(FORK_HEIGHT),first_parent:header(chain).parent,first_creation_time:String(header(chain).creationTime),last_header:header(chain)},
    {day:cutoff.slice(0,10),chain,work:'1',block_count:'1',first_height:String(FORK_HEIGHT+1),last_height:String(FORK_HEIGHT+1),first_parent:header(chain).hash,first_creation_time:String(final(chain).creationTime),last_header:final(chain)}
  ]).flat();
  return { query: async sql => {
    if (sql.includes('FROM collection_state')) return {rows:[{start_day:FORK_DAY,initial_history_days:INITIAL_HISTORY_DAYS,method_version:METHOD_VERSION,history_policy:'growing-permanent'}]};
    if (sql.includes('FROM account_extraction_state')) return { rows: [{ version: 'pact-transfer-v2', status: 'ready' }] };
    if (sql.includes('FROM module_identity_reviews')) return { rows: [{ n: unresolved }] };
    if (sql.includes('FROM chain_checkpoints')) return { rows: checkpoints ?? Array.from({ length: 20 }, (_, chain) => ({ chain, height: FORK_HEIGHT + 1, hash:final(chain).hash, block_time: cutoff, coverage_start:FORK_DAY,baseline_header:header(chain,FORK_HEIGHT-1) })) };
    if (sql.startsWith('SELECT chain,name,height,request_key,artifact_status,policy_version')) {
      assert.match(sql, /kind='new'/);
      return { rows: deployments ?? Array.from({length:pending}, (_,i)=>({chain:1,name:`free.test-held-${i}`,artifact_status:'review',policy_version:'old'})) };
    }
    if (sql.includes('FROM daily_accounts')) return { rows: accounts };
    if (sql.includes('FROM module_deployments')) return { rows: contracts };
    if (sql.includes('FROM daily_chain_stats')) return { rows: stats ?? allStats };
    assert.fail('Unexpected aggregate SQL: ' + sql);
  } };
}

test('compact daily aggregation covers initial90days, preserves microseconds and carries state across blockless days', async () => {
  const rows = await dailyChainMetrics(dailyDatabase({ accounts: [{ day: FORK_DAY, n: 4 }], contracts: [{ day: FORK_DAY, n: 2, upgrades: 3 }] }), THROUGH_DAY);
  assert.equal(rows.length,90); assert.equal(rows[0].day,FORK_DAY); assert.equal(rows.at(-1).day,THROUGH_DAY);
  assert.equal(rows[0].addresses, 4); assert.equal(rows[0].contracts, 2); assert.equal(rows[0].upgrades, 3);
  assert.equal(rows[0].headers['0'].creationTime, originTime);
  assert.ok(Math.abs(rows[0].hashratePh - 20 / 86400) < 1e-15);
  assert.equal(rows[1].hashratePh, 0); assert.equal(rows[1].addresses, 0);
  assert.deepEqual(rows[1].headers, rows[0].headers);
});

test('invalid cutoff, missing chain, incomplete boundary, compact gaps and pending module classification prevent publication', async () => {
  await assert.rejects(dailyChainMetrics({}, '2025-11-31'), /Invalid UTC day/);
  const checkpoints = Array.from({ length: 20 }, (_, chain) => ({ chain, block_time: addDays(THROUGH_DAY,1),coverage_start:FORK_DAY }));
  checkpoints[19].chain = 18;
  await assert.rejects(dailyChainMetrics(dailyDatabase({ checkpoints }), THROUGH_DAY), /All 20 chains/);
  checkpoints[19] = { chain: 19, block_time: 'not-a-date' };
  await assert.rejects(dailyChainMetrics(dailyDatabase({ checkpoints }), THROUGH_DAY), /All 20 chains/);
  await assert.rejects(dailyChainMetrics(dailyDatabase({ pending: 1 }), THROUGH_DAY), /New test-artifact/);
  await assert.rejects(dailyChainMetrics(dailyDatabase({ unresolved: 1 }), THROUGH_DAY), error => error.code === 'MODULE_IDENTITY_REVIEW_REQUIRED');
  await assert.rejects(dailyChainMetrics(dailyDatabase({ stats:[] }), THROUGH_DAY), /does not reach checkpoint/);
});

test('identity review barrier covers all earlier evidence but does not block a cutoff before the unresolved block', async () => {
  const unresolvedTime = `${addDays(FORK_DAY, 1)}T12:00:00Z`;
  const db = { query: async (sql, values) => {
    assert.match(sql, /FROM module_identity_reviews WHERE block_time<\$1/);
    return { rows: [{ n: Date.parse(unresolvedTime) < Date.parse(values[0]) ? 1 : 0 }] };
  } };
  await assertModuleIdentitiesReviewed(db, `${addDays(FORK_DAY, 1)}T00:00:00Z`);
  await assert.rejects(assertModuleIdentitiesReviewed(db, `${addDays(FORK_DAY, 2)}T00:00:00Z`), /chronological reclassification/);
});

test('daily aggregation rejects stale included classifications even when no stored review row remains', async () => {
  for (const name of ['free.test-policy-drift-fixture', 'free.bench-lottery-a1247acc']) {
    const deployments = [{chain:1,name,artifact_status:'included',policy_version:'old'}];
    await assert.rejects(dailyChainMetrics(dailyDatabase({deployments}), THROUGH_DAY),
      error => error.code === 'MODULE_ARTIFACT_POLICY_REVIEW_REQUIRED' && error.details.mismatches === 1);
  }
});

test('500-block persistence uses one atomic transaction, one block insert and one checkpoint update', async () => {
  const db = memoryDatabase();
  const blocks = Array.from({ length: 500 }, (_, i) => block(0, FORK_HEIGHT + i, i % 100 === 0 ? [{ sender: 'same-account', code: `(+ ${i} 1)` }] : []));
  assert.equal(await persistBlocks(db, blocks, policy), 500);
  assert.equal(db.state.blocks.size, 500); assert.equal(db.state.accounts.size, 1);
  assert.equal(db.calls.filter(c => c.sql === 'BEGIN').length, 1);
  assert.equal(db.calls.filter(c => c.sql === 'COMMIT').length, 1);
  assert.equal(db.calls.filter(c => c.sql.startsWith('INSERT INTO blocks')).length, 1);
  assert.equal(db.calls.filter(c => c.sql.startsWith('UPDATE chain_checkpoints')).length, 1);
  assert.equal(db.state.checkpoints.get(0).height, FORK_HEIGHT + 499);
  assert.equal(await persistBlocks(db, blocks, policy), 0);
});

test('late malformed account rolls back the entire batch including earlier identities and queued evidence', async () => {
  const db = memoryDatabase();
  const blocks = [
    block(0, FORK_HEIGHT, [{ sender: 'alice', code: '(module good G (defcap G () true))' }]),
    block(0, FORK_HEIGHT + 1, [{ sender: 'bob', code: '(namespace (read-string "ns")) (module unresolved G (defcap G () true))' }]),
    block(0, FORK_HEIGHT + 2, [{ sender: 'carol' }]),
  ];
  blocks[2].transactions[0].participants.push(null);
  await assert.rejects(persistBlocks(db, blocks, policy), /Invalid decoded account/);
  assert.equal(db.state.modules.size, 0); assert.equal(db.state.deployments.length, 0);
  assert.equal(db.state.reviews.size, 0);
  assert.equal(db.state.blocks.size, 0); assert.equal(db.state.accounts.size, 0);
  assert.equal(db.state.checkpoints.get(0).height, FORK_HEIGHT - 1);
});

test('batch resume verifies stored prefix and classifies later declarations as upgrades in order', async () => {
  const db = memoryDatabase();
  const first = block(0, FORK_HEIGHT, [{ sender: 'alice', code: '(module same G (defcap G () true))' }]);
  const second = block(0, FORK_HEIGHT + 1, [{ sender: 'bob', code: '(module same G (defcap G () false))' }]);
  await persistBlock(db, first, policy);
  assert.equal(await persistBlocks(db, [first, second], policy), 1);
  assert.deepEqual(db.state.deployments.map(row => row.kind), ['new', 'upgrade']);
  assert.equal(db.state.blocks.size, 2);
  const bad = block(0, FORK_HEIGHT); bad.header.hash = hash('reorg');
  await assert.rejects(persistBlocks(db, [bad], policy), /Canonical chain changed/);
});


test('compact work equals every input block while replay storage stays bounded and review proof survives', async () => {
  const db=memoryDatabase();
  const first=block(0,FORK_HEIGHT,[{sender:'alice',code:'(namespace (read-string "ns")) (module unresolved G (defcap G () true))'}]);
  await persistBlock(db,first,policy);
  await persistBlocks(db,Array.from({length:500},(_,i)=>block(0,FORK_HEIGHT+1+i)),policy);
  await persistBlocks(db,Array.from({length:200},(_,i)=>block(0,FORK_HEIGHT+501+i)),policy);
  assert.equal(db.state.blocks.size,500);
  const summary=db.state.stats.get(`${FORK_DAY}:0`);
  assert.equal(summary.work,'701'); assert.equal(summary.block_count,701);
  assert.equal(summary.first_height,FORK_HEIGHT); assert.equal(summary.last_height,FORK_HEIGHT+700);
  assert.equal(db.state.reviews.size,1); assert.deepEqual([...db.state.reviews.values()][0].evidence.sourceHeader,first.header);
  await assert.rejects(persistBlock(db,first,policy),/bounded header tail/);
  const tail=Array.from({length:200},(_,i)=>block(0,FORK_HEIGHT+501+i));
  assert.equal(await persistBlocks(db,tail,policy),0); assert.equal(db.state.stats.get(`${FORK_DAY}:0`).work,'701');
});


test('collection boundary metadata rejects changed dates or methods before network collection', async()=>{
  for(const state of [undefined,{start_day:addDays(FORK_DAY,1),initial_history_days:90,method_version:METHOD_VERSION,history_policy:'growing-permanent'},
    {start_day:FORK_DAY,initial_history_days:90,method_version:'rolling',history_policy:'growing-permanent'}]){
    const db={query:async()=>({rows:state?[state]:[]})};
    await assert.rejects(indexBlocks(db,{throughDay:THROUGH_DAY,api:{discoverNetwork:()=>assert.fail('metadata must fail before network')}}),/persisted metadata/);
  }
});

test('fixed collection inventory initializes once and resumes without another inventory lookup',async()=>{
  const db=memoryDatabase(false),api=fakeApi();let lookups=0;const original=api.listModulesAt;
  api.listModulesAt=async args=>{lookups++;return original(args)};
  await indexBlocks(db,{throughDay:THROUGH_DAY,maxBlocks:1,api});
  assert.equal(lookups,20);
  await indexBlocks(db,{throughDay:THROUGH_DAY,maxBlocks:1,api});
  assert.equal(lookups,20);
  const checkpoint=db.state.checkpoints.get(0),baseline=checkpoint.baseline_header;
  await rebaseChain(db,{chain:0,before:baseline,inventory:checkpoint.baseline_inventory,window:windowFor(THROUGH_DAY),tipHash:'new-tip'});
  assert.equal(db.state.checkpoints.get(0).height,checkpoint.height);
  await assert.rejects(rebaseChain(db,{chain:0,before:baseline,inventory:{...checkpoint.baseline_inventory,modules:['coin','new']},window:windowFor(THROUGH_DAY),tipHash:'tip'}),/cannot be replaced/);
  assert.equal(db.state.checkpoints.get(0).height,checkpoint.height);
});

test('maintenance prunes only bounded raw headers and never collected daily history',async()=>{
  const calls=[];
  const db={connect:async()=>({release(){},query:async(sql)=>{calls.push(sql);return {rows:sql.includes('FROM collection_state')?[{start_day:FORK_DAY,initial_history_days:90,method_version:METHOD_VERSION,history_policy:'growing-permanent'}]:[]}}})};
  await pruneRetention(db,THROUGH_DAY);
  const deletions=calls.filter(sql=>/^DELETE /.test(sql));
  assert.equal(deletions.length,1);assert.match(deletions[0],/^DELETE FROM blocks b USING chain_checkpoints c/);
});
