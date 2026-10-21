import { readFile } from 'node:fs/promises';
import { localAt } from './chainweb.mjs';

export class TvlDataError extends Error { constructor(message) { super(message); this.name = 'TvlDataError'; } }
export const registryPath = new URL('../config/protocol-registry.json', import.meta.url);
export async function loadRegistry() {
  const registry = JSON.parse(await readFile(registryPath, 'utf8'));
  const supported = { 'mercatus-amm': '2', 'mercatus-staking': '2', brodex: '2', koberlusw: '2' };
  if (registry.network !== 'mainnet01' || registry.baselineHeight !== 6335858 || typeof registry.version !== 'string' ||
      registry.protocols?.length !== Object.keys(supported).length || new Set(registry.protocols.map(protocol => protocol.id)).size !== registry.protocols.length ||
      registry.protocols.some(protocol => supported[protocol.id] !== protocol.chain || protocol.status !== 'included' || protocol.startHeight !== registry.baselineHeight || protocol.endHeight !== null)) {
    throw new TvlDataError('Registry coverage or activation changed; update the native adapter and backfill for this registry version');
  }
  const find = id => registry.protocols.find(item => item.id === id), bro = find('brodex'), ksw = find('koberlusw');
  // A BroDEX market is read from the block that completed its deployment, and only with a reviewed core hash.
  if (!bro.pairs?.length || new Set(bro.pairs.map(pair => pair.name)).size !== bro.pairs.length ||
      bro.pairs.some(pair => !/^[A-Za-z0-9-]+$/.test(pair.name ?? '') || !pair.base || !pair.quote || pair.base === pair.quote ||
        !Number.isSafeInteger(pair.startHeight) || pair.startHeight < registry.baselineHeight || !bro.verifiedModuleHashes?.[`${bro.namespace}.bro-dex-core-${pair.name}`])) {
    throw new TvlDataError('Invalid BroDEX market list');
  }
  const accounts = ksw.custody?.map(item => item.account) ?? [];
  if (!accounts.length || new Set(accounts).size !== accounts.length || accounts.some(account => !/^c:[A-Za-z0-9_-]{43}$/.test(account)) ||
      !ksw.assets?.length || new Set(ksw.assets).size !== ksw.assets.length || ksw.assets.some(asset => !/^[A-Za-z0-9_.-]+$/.test(asset))) {
    throw new TvlDataError('Invalid KoberluSW custody list');
  }
  return registry;
}
/** BroDEX markets deployed by the given chain 2 height. */
export function activePairs(bro, height) {
  if (!Number.isSafeInteger(height)) throw new TvlDataError('A chain 2 height is required to select BroDEX markets');
  return bro.pairs.filter(pair => pair.startHeight <= height);
}
export function amount(value, label = 'amount') {
  const raw = typeof value === 'object' && value !== null ? value.decimal ?? value.int : value;
  if (typeof raw !== 'number' && (typeof raw !== 'string' || !/^(?:\d+(?:\.\d*)?|\.\d+)(?:e[+-]?\d+)?$/i.test(raw))) throw new TvlDataError(`Invalid ${label}`);
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed < 0) throw new TvlDataError(`Invalid ${label}`);
  return parsed;
}
function moduleName(ref) {
  const name = ref?.refName;
  if (!name || typeof name.name !== 'string') throw new TvlDataError('Invalid pool token module');
  return name.namespace ? `${name.namespace}.${name.name}` : name.name;
}
export function valuePools(pools, chain) {
  if (!Array.isArray(pools) || !pools.length) throw new TvlDataError(`Missing expected pools on chain ${chain}`);
  const prices = new Map([['coin', { price: 1, liquidity: Infinity }]]);
  const positions = [], ownership = new Set();
  let tvlKda = 0;
  for (const pool of pools) {
    if (typeof pool.account !== 'string' || !pool.account) throw new TvlDataError('Missing pool ownership account');
    const legs = ['leg0', 'leg1'].map(key => ({ token: moduleName(pool[key]?.token), balance: amount(pool[key]?.reserve, 'pool reserve') }));
    if (legs[0].token === legs[1].token) throw new TvlDataError('A pool cannot have two identical asset legs');
    const native = legs.find(leg => leg.token === 'coin'), other = legs.find(leg => leg.token !== 'coin');
    if (!native || !other) throw new TvlDataError(`Pool ${pool.account} needs a verified non-native pricing adapter`);
    for (const leg of legs) {
      const key = `${chain}:${pool.account}:${leg.token}`;
      if (ownership.has(key)) throw new TvlDataError(`Duplicate pool ownership ${key}`);
      ownership.add(key);
    }
    if (other.balance > 0 && native.balance === 0) throw new TvlDataError(`Unpriced nonzero pool balance ${other.token}`);
    const price = other.balance > 0 ? native.balance / other.balance : null;
    const value = native.balance + (price === null ? 0 : other.balance * price);
    if (price !== null && price > 0 && (!prices.has(other.token) || prices.get(other.token).liquidity < native.balance)) prices.set(other.token, { price, liquidity: native.balance, account: pool.account });
    tvlKda += value;
    positions.push({ account: pool.account, legs, tokenKdaPrice: price, tvlKda: value });
  }
  return { tvlKda, prices, positions, ownership: [...ownership] };
}
export function valueDeposit(balance, token, prices) {
  const value = amount(balance, `${token} balance`);
  if (value === 0) return 0; // A successful explicit zero balance needs no price.
  const price = prices.get(token)?.price;
  if (!Number.isFinite(price) || price <= 0) throw new TvlDataError(`Missing positive native market price for ${token}`);
  return value * price;
}
function scaledDecimal(value) {
  const input = typeof value === 'object' && value !== null ? value.decimal ?? value.int : value;
  if (input === undefined || input === null) throw new TvlDataError('Missing decimal');
  const match = String(input).match(/^(\d+)(?:\.(\d*))?(?:[eE]([+-]?\d+))?$/);
  if (!match) throw new TvlDataError('Invalid nonnegative decimal');
  let digits = BigInt(match[1] + (match[2] || '')), scale = (match[2] || '').length - Number(match[3] || 0);
  if (Math.abs(scale) > 1000) throw new TvlDataError('Decimal exponent exceeds limit');
  if (scale < 0) { digits *= 10n ** BigInt(-scale); scale = 0; }
  return { digits, scale };
}
function pactDecimal(value) {
  const { digits, scale } = scaledDecimal(value);
  if (!scale) return digits.toString() + '.0';
  const text = digits.toString().padStart(scale + 1, '0');
  return text.slice(0, -scale) + '.' + text.slice(-scale);
}
function decimalAtLeast(actual, required) {
  const a = scaledDecimal(actual), b = scaledDecimal(required), scale = Math.max(a.scale, b.scale);
  return a.digits * 10n ** BigInt(scale - a.scale) >= b.digits * 10n ** BigInt(scale - b.scale);
}
export function quoteCollateral(order, precision) {
  if (!Number.isSafeInteger(precision) || precision < 0 || precision > 18) throw new TvlDataError('Invalid quote precision');
  const left = scaledDecimal(order.amount), right = scaledDecimal(order.price);
  let product = left.digits * right.digits, scale = left.scale + right.scale;
  product = scale > precision ? product / (10n ** BigInt(scale - precision)) : product * (10n ** BigInt(precision - scale));
  return Number(product) / 10 ** precision;
}
export function valueOrderbooks(books, pairs, prices, quotePrecisions) {
  const seen = new Set(), positions = [];
  let tvlKda = 0;
  for (const book of books) {
    const pair = pairs.find(item => item.name === book.pair);
    if (!pair || !['ask', 'bid'].includes(book.side) || !Array.isArray(book.orders)) throw new TvlDataError('Unexpected orderbook');
    for (const order of book.orders) {
      const id = String(order.id?.int ?? order.id), key = `${book.pair}:${id}`;
      if (id === 'undefined' || seen.has(key)) throw new TvlDataError('Duplicate or missing open order ID');
      seen.add(key);
      if (amount(order.state, 'order state') !== 1 || order['is-ask'] !== (book.side === 'ask')) throw new TvlDataError('Non-open or mismatched orderbook row');
      const token = book.side === 'ask' ? pair.base : pair.quote;
      const balance = book.side === 'ask' ? amount(order.amount) : quoteCollateral(order, quotePrecisions[pair.quote]);
      const value = valueDeposit(balance, token, prices);
      positions.push({ id, pair: pair.name, side: book.side, token, balance, tvlKda: value });
      tvlKda += value;
    }
  }
  if (books.length !== pairs.length * 2 || new Set(books.map(book => `${book.pair}:${book.side}`)).size !== books.length) throw new TvlDataError('Incomplete orderbook coverage');
  return { tvlKda, positions };
}
export function aggregateProtocols(protocols) {
  const ownership = new Set(), ids = new Set();
  let total = 0;
  for (const protocol of protocols) {
    if (ids.has(protocol.id)) throw new TvlDataError(`Duplicate protocol ${protocol.id}`);
    ids.add(protocol.id);
    for (const key of protocol.ownership) {
      if (ownership.has(key)) throw new TvlDataError(`Double-counted locked position ${key}`);
      ownership.add(key);
    }
    total += amount(protocol.tvlKda, 'protocol TVL');
  }
  if (!Number.isFinite(total)) throw new TvlDataError('Nonfinite aggregate TVL');
  return total;
}
export function verifyEscrowPositions(positions, escrows, namespace) {
  if (!Array.isArray(escrows) || escrows.length !== positions.length) throw new TvlDataError('Incomplete order escrow verification');
  const rows = new Map();
  for (const row of escrows) {
    const key = `${row.pair}:${row.id}`;
    if (rows.has(key)) throw new TvlDataError('Duplicate escrow proof');
    rows.set(key, row);
  }
  return positions.map(position => {
    const row = rows.get(`${position.pair}:${position.id}`), guard = row?.details?.guard;
    const arg = guard?.cgArgs?.[0];
    if (!row || row.token !== position.token || typeof row.account !== 'string' || !row.account.startsWith('c:') ||
        guard?.cgName !== `${namespace}.bro-dex-core-${position.pair}.ORDER-ACCOUNT` ||
        guard?.cgArgs?.length !== 1 || String(arg?.int ?? arg) !== position.id || guard.cgPactId !== null) throw new TvlDataError('Unexpected order escrow ownership or guard');
    if (!decimalAtLeast(row.details.balance, row.required)) throw new TvlDataError('Open order collateral is underfunded');
    if (Math.abs(amount(row.required) - position.balance) > Math.max(1, position.balance) * 1e-12) throw new TvlDataError('Order collateral computation disagrees with Pact');
    return { ...position, account: row.account, escrowBalance: amount(row.details.balance), escrowGuard: guard };
  });
}
/** Build bounded chain 2 reads, all pinned to the same daily header. */
export function nativeQueries(registry, height) {
  const find = id => registry.protocols.find(item => item.id === id), bro = find('brodex'), ksw = find('koberlusw'), pairs = activePairs(bro, height);
  // Keep each orderbook page in its own read-only Pact request. Bundling every
  // market into one local command grows past the public node's transaction
  // execution budget as markets and order counts increase.
  const books = pairs.flatMap(pair => ['true', 'false'].map(side => ({
    pair: pair.name,
    side: side === 'true' ? 'ask' : 'bid',
    code: `(${bro.namespace}.bro-dex-view-${pair.name}.get-orderbook ${side} 0 100)`,
  })));
  const precisions = '{' + [...new Set(pairs.map(pair => pair.quote))].map(token => `${JSON.stringify(token)}: (${token}.precision)`).join(', ') + '}';
  const hashes = '{' + pairs.map(pair => {
    const module = `${bro.namespace}.bro-dex-core-${pair.name}`;
    return `${JSON.stringify(module)}: (at "hash" (describe-module ${JSON.stringify(module)}))`;
  }).join(', ') + '}';
  // A custody account not yet created in an asset's ledger is the one read that may come back empty.
  const custody = '[' + ksw.custody.map(item => '[' + ksw.assets.map(asset =>
    `(try {"exists": false} {"exists": true, "balance": (${asset}.get-balance ${JSON.stringify(item.account)})})`).join(' ') + ']').join(' ') + ']';
  return {
    '2': {
      pools: '(select kaddex.exchange.pairs (constantly true))',
      staking: '(kaddex.staking.get-pool-state)',
      books,
      quotePrecisions: precisions,
      broModuleHashes: hashes,
      custody,
    },
  };
}
/** KoberluSW: each listed asset held by each custody account. An absent account holds nothing; every other read must be a balance. */
export function valueCustody(rows, protocol, prices) {
  if (!Array.isArray(rows) || rows.length !== protocol.custody.length || rows.some(row => !Array.isArray(row) || row.length !== protocol.assets.length)) {
    throw new TvlDataError('Incomplete KoberluSW custody coverage');
  }
  const positions = [];
  let tvlKda = 0;
  protocol.custody.forEach((item, i) => protocol.assets.forEach((token, j) => {
    const read = rows[i][j];
    if (read?.exists === false && Object.keys(read).length === 1) return void positions.push({ module: item.module, account: item.account, token, exists: false, balance: 0, tvlKda: 0 });
    if (read?.exists !== true) throw new TvlDataError('Unexpected KoberluSW custody read');
    const balance = amount(read.balance, `${token} custody balance`), value = valueDeposit(read.balance, token, prices);
    positions.push({ module: item.module, account: item.account, token, exists: true, balance, tvlKda: value });
    tvlKda += value;
  }));
  return { tvlKda, positions, ownership: positions.map(position => `2:${position.account}:${position.token}`) };
}
export function valueNativeState(state, registry, books, height) {
  const chain2 = valuePools(state['2'].pools, '2');
  const find = id => registry.protocols.find(item => item.id === id), bro = find('brodex');
  const precisions = Object.fromEntries(Object.entries(state['2'].quotePrecisions).map(([token, value]) => [token, amount(value, 'precision')]));
  const orders = valueOrderbooks(books, activePairs(bro, height), chain2.prices, precisions);
  const protocols = [
    { id: 'mercatus-amm', chain: '2', tvlKda: chain2.tvlKda, ownership: chain2.ownership, positions: chain2.positions },
    { id: 'mercatus-staking', chain: '2', tvlKda: valueDeposit(state['2'].staking['staked-kdx'], 'kaddex.kdx', chain2.prices), ownership: ['2:kaddex.staking:staked-kdx'], balance: amount(state['2'].staking['staked-kdx']) },
    { id: 'brodex', chain: '2', ...orders, ownership: orders.positions.map(order => `2:${bro.namespace}:order:${order.pair}:${order.id}`) },
    { id: 'koberlusw', chain: '2', ...valueCustody(state['2'].custody, find('koberlusw'), chain2.prices) },
  ];
  return { tvlKda: aggregateProtocols(protocols), protocols };
}
async function marketPrice(day) {
  const url = `https://dexapi.kadena.fun/candles?currency=USDT&asset=KDA&dateStart=${day}&dateEnd=${day}`;
  const response = await fetch(url, { redirect: 'error', signal: AbortSignal.timeout(45000) });
  if (!response.ok) throw new TvlDataError(`KDA display-price provider HTTP ${response.status}`);
  const rows = await response.json(), matching = Array.isArray(rows) ? rows.filter(row => row.dayString === day) : [];
  if (matching.length !== 1) throw new TvlDataError(`Missing or ambiguous KDA display price for ${day}`);
  const kdaUsd = amount(matching[0].usdPrice?.close, 'KDA display price');
  if (!kdaUsd) throw new TvlDataError('KDA display price must be positive');
  return { kdaUsd, url, raw: matching[0], convention: 'Provider final five-minute OHLC mean in KDA/USDT; USDT=USD display approximation' };
}
export async function collectTvl({ day, cut, headers }) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(day) || !Number.isFinite(Date.parse(day)) || new Date(day).toISOString().slice(0, 10) !== day) throw new TvlDataError('Invalid UTC day');
  if (Date.parse(day + 'T00:00:00Z') + 86400000 > Date.now()) throw new TvlDataError('UTC day is not yet complete');
  const registry = await loadRegistry(), endHeaders = Array.isArray(headers) ? Object.fromEntries(headers.map(header => [String(header.chainId), header])) : headers;
  const height = endHeaders?.['2']?.height;
  if (!Number.isSafeInteger(height)) throw new TvlDataError('Missing post-fork canonical end header for chain 2');
  const queries = nativeQueries(registry, height), evidence = { reads: [], registry, price: null }, state = {};
  async function read(chain, code) {
    const target = endHeaders?.[chain];
    if (!target || !Number.isSafeInteger(target.height) || !target.hash || target.height < registry.baselineHeight) throw new TvlDataError(`Missing post-fork canonical end header for chain ${chain}`);
    const end = Date.parse(`${day}T00:00:00Z`) + 86400000;
    const creationTime = amount(target.creationTime, 'header creation time');
    if (!Number.isSafeInteger(creationTime)) throw new TvlDataError('Unsafe header microsecond timestamp');
    const blockTime = creationTime / 1000;
    if (blockTime >= end) throw new TvlDataError(`Chain ${chain} header is after the requested UTC day`);
    const result = await localAt({ chain, tipHash: cut?.hashes?.[chain]?.hash, height: target.height, code, gasLimit: 200000 });
    if (result.blockHash !== target.hash || result.metadata?.prevBlockHash !== target.hash || result.metadata?.blockHeight !== target.height + 1 || result.metadata?.blockTime !== creationTime) throw new TvlDataError(`Historical state hash mismatch on chain ${chain}`);
    evidence.reads.push({ chain, header: target, query: code, metadata: result.metadata, raw: result.raw });
    return result.data ?? result.result?.data;
  }
  for (const [chain, components] of Object.entries(queries)) {
    const chainState = {};
    for (const [name, query] of Object.entries(components)) {
      if (name === 'books') {
        chainState.books = [];
        for (const book of query) chainState.books.push(await read(chain, book.code));
      } else chainState[name] = await read(chain, query);
    }
    state[chain] = chainState;
  }
  const bro = registry.protocols.find(item => item.id === 'brodex'), pairs = activePairs(bro, height), books = [];
  for (const pair of pairs) {
    const module = `${bro.namespace}.bro-dex-core-${pair.name}`;
    if (state['2'].broModuleHashes?.[module] !== bro.verifiedModuleHashes[module]) throw new TvlDataError(`BroDEX source changed; registry review required for ${module}`);
  }
  if (!Array.isArray(state['2'].books) || state['2'].books.length !== pairs.length * 2) throw new TvlDataError('Missing orderbook result');
  for (let i = 0; i < state['2'].books.length; i++) {
    const pair = pairs[Math.floor(i / 2)], side = i % 2 === 0 ? 'ask' : 'bid';
    let page = state['2'].books[i], orders = [...page], pages = 1;
    while (page.length === 100) {
      if (pages++ >= 1000) throw new TvlDataError('Orderbook pagination safety limit reached');
      const id = String(page.at(-1).id?.int ?? page.at(-1).id);
      if (!/^\d+$/.test(id)) throw new TvlDataError('Invalid orderbook pagination cursor');
      page = await read('2', `(${bro.namespace}.bro-dex-view-${pair.name}.get-orderbook ${side === 'ask'} ${id} 100)`);
      if (!Array.isArray(page)) throw new TvlDataError('Invalid orderbook page');
      orders.push(...page);
    }
    books.push({ pair: pair.name, side, orders });
  }
  const valuation = valueNativeState(state, registry, books, height);
  const orderProtocol = valuation.protocols.find(protocol => protocol.id === 'brodex'), rows = new Map();
  for (const book of books) for (const order of book.orders) rows.set(`${book.pair}:${order.id?.int ?? order.id}`, order);
  const escrow = [];
  for (let offset = 0; offset < orderProtocol.positions.length; offset += 100) {
    const expressions = orderProtocol.positions.slice(offset, offset + 100).map(position => {
      const core = `${bro.namespace}.bro-dex-core-${position.pair}`, account = `(${core}.order-account ${position.id})`;
      const order = rows.get(`${position.pair}:${position.id}`);
      const required = position.side === 'ask' ? pactDecimal(order.amount) : `(${core}.total-quote ${pactDecimal(order.price)} ${pactDecimal(order.amount)})`;
      return `{"id": ${JSON.stringify(position.id)}, "pair": ${JSON.stringify(position.pair)}, "token": ${JSON.stringify(position.token)}, "account": ${account}, "required": ${required}, "details": (${position.token}.details ${account})}`;
    });
    const batch = await read('2', '[' + expressions.join(' ') + ']');
    if (!Array.isArray(batch)) throw new TvlDataError('Missing escrow balance response');
    escrow.push(...batch);
  }
  orderProtocol.positions = verifyEscrowPositions(orderProtocol.positions, escrow, bro.namespace);
  orderProtocol.ownership = orderProtocol.positions.map(position => `2:${position.account}:${position.token}`);
  valuation.tvlKda = aggregateProtocols(valuation.protocols);
  const price = await marketPrice(day);
  evidence.price = price;
  return { ...valuation, tvlUsd: valuation.tvlKda * price.kdaUsd, kdaUsd: price.kdaUsd, registryVersion: registry.version,
    sourceRefs: ['https://api.chainweb-community.org/chainweb/0.0/mainnet01', 'config/protocol-registry.json', price.url], evidence };
}
