import test from 'node:test';
import assert from 'node:assert/strict';
import { amount, valuePools, valueDeposit, quoteCollateral, valueOrderbooks, aggregateProtocols, loadRegistry, nativeQueries, verifyEscrowPositions, collectTvl, activePairs, valueCustody } from '../src/tvl.mjs';
const token = name => ({ refName: { namespace: name.includes('.') ? name.slice(0, name.lastIndexOf('.')) : null, name: name.split('.').at(-1) } });
const pool = (account, kda, balance, name = 'test.token', reversed = false) => {
  const native = { token: token('coin'), reserve: kda }, other = { token: token(name), reserve: balance };
  return { account, leg0: reversed ? other : native, leg1: reversed ? native : other };
};
test('AMM balances include both distinct underlying sides regardless of leg order', () => {
  const valued = valuePools([pool('a', 20, 40), pool('b', 7, 2, 'second.token', true)], '2');
  assert.equal(valued.tvlKda, 54);
  assert.equal(valued.prices.get('test.token').price, 0.5);
  assert.equal(valueDeposit({ decimal: '6.25' }, 'test.token', valued.prices), 3.125);
  assert.equal(valued.ownership.length, 4);
});
test('Unpriceable nonzero assets and absent state fail instead of fabricated zeros', () => {
  assert.throws(() => valuePools([pool('a', 0, 40)], '2'), /Unpriced/);
  assert.throws(() => valueDeposit(4, 'unknown', new Map()), /Missing/);
  assert.throws(() => amount(null), /Invalid/);
  assert.throws(() => amount({ decimal: '' }), /Invalid/);
  assert.throws(() => amount({ int: false }), /Invalid/);
  assert.throws(() => valuePools([], '2'), /Missing/);
  assert.equal(valueDeposit(0, 'unknown', new Map()), 0);
  assert.equal(valuePools([pool('a', 0, 0)], '2').tvlKda, 0);
});
test('Duplicate ownership fails within and across protocols; other chains remain distinct', () => {
  assert.throws(() => valuePools([pool('same', 1, 1), pool('same', 1, 1)], '2'), /Duplicate/);
  assert.throws(() => aggregateProtocols([{ id: 'pool', tvlKda: 5, ownership: ['2:lp:coin'] }, { id: 'receipt', tvlKda: 5, ownership: ['2:lp:coin'] }]), /Double-counted/);
  assert.equal(aggregateProtocols([{ id: 'a', tvlKda: 5, ownership: ['1:pool:coin'] }, { id: 'b', tvlKda: 5, ownership: ['2:pool:coin'] }]), 10);
});
test('Bid collateral floors exact decimal multiplication to the actual quote precision', () => {
  assert.equal(quoteCollateral({ amount: { decimal: '0.123456789123' }, price: { decimal: '3.333333333333' } }, 6), 0.411522);
  assert.equal(quoteCollateral({ amount: 1e-7, price: 1e7 }, 12), 1);
  assert.equal(quoteCollateral({ amount: '0.1', price: '0.2' }, 2), 0.02);
});
test('Orderbooks count only deposited side, never base at a user-entered ask price', () => {
  const pairs = [{ name: 'X-Y', base: 'base', quote: 'quote' }], prices = new Map([['base', { price: 3 }], ['quote', { price: 2 }]]);
  const books = [{ pair: 'X-Y', side: 'ask', orders: [{ id: { int: '10000000000000000000001' }, state: { int: 1 }, 'is-ask': true, amount: 4, price: 999999999 }] },
    { pair: 'X-Y', side: 'bid', orders: [{ id: { int: '10000000000000000000002' }, state: 1, 'is-ask': false, amount: 2, price: 5.99999 }] }];
  const result = valueOrderbooks(books, pairs, prices, { quote: 2 });
  assert.equal(result.positions[0].tvlKda, 12);
  assert.equal(result.positions[1].balance, 11.99);
  assert.equal(result.tvlKda, 35.980000000000004);
  assert.throws(() => valueOrderbooks(books.slice(0, 1), pairs, prices, { quote: 2 }), /Incomplete/);
  books[1].orders[0].id = books[0].orders[0].id;
  assert.throws(() => valueOrderbooks(books, pairs, prices, { quote: 2 }), /Duplicate/);
});
test('Pool ratio selection for standalone deposits prefers deepest native pool', () => {
  const valued = valuePools([pool('thin', 1, 0.01), pool('deep', 100, 100)], '2');
  assert.equal(valueDeposit(10, 'test.token', valued.prices), 10);
});
test('Orderbook intents require actual funded escrow with the correct capability guard', () => {
  const positions = [{ id: '123456789012345678901', pair: 'X-Y', token: 'base', balance: 1, tvlKda: 3 }];
  const row = { id: positions[0].id, pair: 'X-Y', token: 'base', account: 'c:escrow', required: { decimal: '1.0' }, details: {
    balance: { decimal: '1.0' }, guard: { cgName: 'ns.bro-dex-core-X-Y.ORDER-ACCOUNT', cgArgs: [{ int: positions[0].id }], cgPactId: null },
  } };
  assert.equal(verifyEscrowPositions(positions, [row], 'ns')[0].account, 'c:escrow');
  row.details.balance = { decimal: '0.99999999999999999999999999' };
  assert.throws(() => verifyEscrowPositions(positions, [row], 'ns'), /underfunded/);
  row.details.balance = 1;
  row.details.guard = { keys: ['wallet'], pred: 'keys-all' };
  assert.throws(() => verifyEscrowPositions(positions, [row], 'ns'), /guard/);
  assert.throws(() => verifyEscrowPositions(positions, [], 'ns'), /Incomplete/);
});
test('Invalid and incomplete UTC dates fail before any source request', async () => {
  await assert.rejects(collectTvl({ day: '2026-02-31' }), /Invalid UTC day/);
  await assert.rejects(collectTvl({ day: '2099-01-01' }), /not yet complete/);
});
test('Versioned registry covers the active protocols, all on chain 2, with one native query', async () => {
  const registry = await loadRegistry();
  assert.deepEqual(registry.protocols.map(item => item.id), ['mercatus-amm', 'mercatus-staking', 'brodex', 'koberlusw']);
  assert.equal(registry.baselineHeight, 6335858);
  assert.ok(registry.protocols.every(item => item.chain === '2' && item.startHeight === registry.baselineHeight && item.endHeight === null));
  const queries = nativeQueries(registry, 7300000), ksw = registry.protocols.find(item => item.id === 'koberlusw');
  assert.deepEqual(Object.keys(queries), ['2']);
  assert.match(queries['2'], /quotePrecisions/);
  assert.equal(queries['2'].match(/\(try \{"exists": false\}/g).length, ksw.custody.length * ksw.assets.length);
  assert.ok(ksw.custody.every(item => queries['2'].includes(`.get-balance "${item.account}"`)));
  for (const removed of ['KDSwap', 'KDLaunch', 'Chips', 'Cabinet']) assert.ok(registry.exclusions.some(item => item.component.includes(removed) && /inactive/.test(item.reason)), removed);
  assert.ok(registry.exclusions.some(item => item.component.includes('LP receipt')));
});
test('BroDEX markets are read only from the block that completed their deployment', async () => {
  const bro = (await loadRegistry()).protocols.find(item => item.id === 'brodex'), names = height => activePairs(bro, height).map(pair => pair.name);
  assert.deepEqual(names(7081479), ['BRO-KDA-M', 'BRO-zUSD-M', 'BRO-HERON-M']);
  assert.deepEqual(names(7081480), ['BRO-KDA-M', 'BRO-zUSD-M', 'BRO-HERON-M', 'BRO-kbUSDC-M']);
  assert.deepEqual(names(7081490), ['BRO-KDA-M', 'BRO-zUSD-M', 'BRO-HERON-M', 'BRO-kbUSDC-M', 'KDA-kbUSDC-M']);
  assert.ok(bro.pairs.every(pair => bro.verifiedModuleHashes[`${bro.namespace}.bro-dex-core-${pair.name}`]));
  const before = nativeQueries({ protocols: [bro, (await loadRegistry()).protocols.find(item => item.id === 'koberlusw')] }, 7081479)['2'];
  assert.equal(before.match(/get-orderbook/g).length, 6);
  assert.doesNotMatch(before, /kbUSDC/);
  assert.throws(() => activePairs(bro, undefined), /height is required/);
});
test('KoberluSW custody: an absent account holds nothing, balances are valued once, any other read fails', () => {
  const protocol = { custody: [{ module: 'free.orders', account: 'c:orders' }, { module: 'free.dca', account: 'c:dca' }], assets: ['coin', 'test.usdc'] };
  const prices = new Map([['coin', { price: 1 }], ['test.usdc', { price: 100 }]]);
  const rows = [[{ exists: true, balance: { decimal: '32000.0' } }, { exists: false }], [{ exists: true, balance: 0 }, { exists: true, balance: 1.5 }]];
  const valued = valueCustody(rows, protocol, prices);
  assert.equal(valued.tvlKda, 32150);
  assert.deepEqual(valued.positions.map(p => [p.account, p.token, p.exists, p.balance, p.tvlKda]),
    [['c:orders', 'coin', true, 32000, 32000], ['c:orders', 'test.usdc', false, 0, 0], ['c:dca', 'coin', true, 0, 0], ['c:dca', 'test.usdc', true, 1.5, 150]]);
  assert.equal(new Set(valued.ownership).size, 4);
  assert.throws(() => valueCustody(rows.slice(0, 1), protocol, prices), /Incomplete/);
  assert.throws(() => valueCustody([[rows[0][0]], rows[1]], protocol, prices), /Incomplete/);
  assert.throws(() => valueCustody([[{ exists: false, balance: 5 }, rows[0][1]], rows[1]], protocol, prices), /Unexpected/);
  assert.throws(() => valueCustody([[null, rows[0][1]], rows[1]], protocol, prices), /Unexpected/);
  assert.throws(() => valueCustody([[{ exists: true, balance: -1 }, rows[0][1]], rows[1]], protocol, prices), /Invalid/);
  assert.throws(() => valueCustody(rows, protocol, new Map([['coin', { price: 1 }]])), /Missing positive native market price for test.usdc/);
});
