import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { transaction } from './db.mjs';
import { assertAccountExtractionReady } from './account-extraction.mjs';
import { artifactStatus, assertModuleArtifactPolicyCurrent } from './module-policy.mjs';
export { artifactStatus } from './module-policy.mjs';
import { FORK_HEIGHT, METHOD_VERSION } from './scoring.mjs';
import { addDays, completedDay, windowFor, COLLECTION_START, INITIAL_HISTORY_DAYS } from './window.mjs';
export const REPLAY_TAIL_BLOCKS = 500;
import * as chainweb from './chainweb.mjs';

const digest = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const MAX_TARGET = (1n << 256n) - 1n;
export function workForTarget(target) {
  if (typeof target !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(target)) throw new Error('Invalid block target');
  const bytes = Buffer.from(target, 'base64url');
  if (bytes.length !== 32 || bytes.toString('base64url') !== target) throw new Error('Invalid block target');
  const value = BigInt('0x' + bytes.reverse().toString('hex'));
  if (value === 0n) throw new Error('Block target must be positive');
  return MAX_TARGET / value;
}

/** Collection identity is immutable once persisted. A new calendar day extends
 * coverage; it must never silently move the scoring baseline or delete history. */
export async function assertCollectionState(db) {
  const state = (await db.query('SELECT start_day,initial_history_days,method_version,history_policy FROM collection_state WHERE singleton=true')).rows[0];
  if (state?.start_day !== COLLECTION_START || state.initial_history_days !== INITIAL_HISTORY_DAYS ||
      state.method_version !== METHOD_VERSION || state.history_policy !== 'growing-permanent') {
    throw new Error('Collection start or method differs from persisted metadata; explicit backfill/method migration is required');
  }
  return state;
}

export async function saveEvidence(db, source, payload, day = null) {
  await db.query('INSERT INTO source_evidence(source,day,digest,payload) VALUES($1,$2,$3,$4) ON CONFLICT(source,digest) DO NOTHING', [source, day, digest(payload), payload]);
}

/** Module ordering is significant: classifications are provisional whenever an
 * unresolved declaration exists. The caller owns one atomic canonical batch. */
async function persistBlockTx(tx, block, policy, accounts) {
  const h = block.header, chain = Number(h.chainId), day = block.blockTime.slice(0, 10);
  for (const [transactionIndex, item] of block.transactions.entries()) {
    if (item.index != null && item.index !== transactionIndex) throw new Error('Invalid decoded transaction index');
    // Included failed gas payers and actual all-token TRANSFER participants are
    // supplied by the verified decoder; coinbase is never in this collection.
    for (const account of item.participants) {
      if (typeof account !== 'string' || account.length === 0) throw new Error('Invalid decoded account');
      accounts.set(JSON.stringify([day, chain, account]), { day, chain, account });
    }
    if (!item.success) continue;
    const seen = new Set();
    for (const [declarationIndex, declaration] of item.modules.entries()) {
      const evidence = { declaration, transactionIndex, declarationIndex, code: item.code, result: item.result,
        commandData: item.command?.payload?.exec?.data ?? null, command: item.command ?? null,
        output: item.output ?? null, signers: item.signers, sender: item.sender, sourceBlock: h.hash,
        sourceHeader: h, sourcePayloadDigest: digest(block.payload),
        sourceTransaction: block.payload?.transactions?.[transactionIndex] ?? null };
      if (!declaration.identityResolved || !declaration.qualifiedName) {
        // Keep the raw successful declaration while canonical blocks/accounts
        // advance. No guessed identity enters the module ledger. Full source
        // header/transaction proof survives the bounded replay-tail pruning.
        await tx.query(`INSERT INTO module_identity_reviews(chain,height,block_hash,block_time,request_key,
          transaction_index,declaration_index,literal_name,identity_source,source_start,source_end,policy_version,evidence_digest,evidence)
          VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)`,
        [chain, h.height, h.hash, block.blockTime, item.requestKey, transactionIndex, declarationIndex,
          declaration.literalName ?? null, declaration.identitySource ?? 'unresolved', declaration.sourceStart ?? null,
          declaration.sourceEnd ?? null, policy.version, digest(evidence), evidence]);
        continue;
      }
      const name = declaration.qualifiedName;
      if (seen.has(name)) continue;
      seen.add(name);
      const first = await tx.query('INSERT INTO modules(chain,name,existed_before_window,first_height,first_request_key) VALUES($1,$2,false,$3,$4) ON CONFLICT DO NOTHING RETURNING name', [chain, name, h.height, item.requestKey]);
      await tx.query('INSERT INTO module_deployments(chain,height,block_hash,block_time,request_key,name,kind,artifact_status,policy_version,evidence) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) ON CONFLICT DO NOTHING', [chain, h.height, h.hash, block.blockTime, item.requestKey, name, first.rowCount ? 'new' : 'upgrade', artifactStatus(chain, name, policy), policy.version, evidence]);
    }
  }
  return { chain, height: h.height, hash: h.hash, parent: h.parent,
    block_time: block.blockTime, creation_time: h.creationTime, payload_hash: h.payloadHash,
    work: workForTarget(h.target).toString(), transaction_count: block.transactions.length, source_digest: digest(block.payload) };
}

/** A bounded batch commits permanent daily summaries/evidence and checkpoint
 * together, retaining only a short disposable raw header tail. */
export async function persistBlocks(db, blocks, policy) {
  if (!Array.isArray(blocks) || blocks.length < 1 || blocks.length > 500) throw new Error('Invalid persistence batch');
  const chain = Number(blocks[0].header.chainId);
  for (let index = 0; index < blocks.length; index++) {
    const block = blocks[index], h = block.header;
    chainweb.validateHeader(h, chain);
    if (block.blockTime !== new Date(h.creationTime / 1000).toISOString()) throw new Error('Invalid indexed block height or time');
    if (index && (h.height !== blocks[index - 1].header.height + 1 || h.parent !== blocks[index - 1].header.hash || h.creationTime < blocks[index - 1].header.creationTime)) throw new Error('Block gap or canonical parent mismatch');
  }
  return transaction(db, async tx => {
    await assertCollectionState(tx);
    await assertAccountExtractionReady(tx);
    const checkpoint = (await tx.query('SELECT * FROM chain_checkpoints WHERE chain=$1 FOR UPDATE', [chain])).rows[0];
    if (!checkpoint) throw new Error('Historical module inventory is required before block ingestion');
    if (String(checkpoint.coverage_start).slice(0,10) !== COLLECTION_START) throw new Error('Chain coverage differs from fixed collection start');
    const startTime = Date.parse(String(checkpoint.coverage_start).slice(0, 10) + 'T00:00:00Z');
    if (!Number.isFinite(startTime) || blocks.some(block => Date.parse(block.blockTime) < startTime)) throw new Error('Block precedes collection start');
    const prefix = blocks.filter(block => block.header.height <= Number(checkpoint.height));
    if (prefix.length) {
      const existing = (await tx.query('SELECT height,hash FROM blocks WHERE chain=$1 AND height>=$2 AND height<=$3', [chain, prefix[0].header.height, prefix.at(-1).header.height])).rows;
      const hashes = new Map(existing.map(row => [Number(row.height), row.hash]));
      if (prefix.some(block => !hashes.has(block.header.height))) throw new Error('Replay exceeds the bounded header tail; resume from the stored checkpoint');
      if (prefix.some(block => hashes.get(block.header.height) !== block.header.hash)) throw new Error('Canonical chain changed; explicit reindex is required');
    }
    const remaining = blocks.slice(prefix.length);
    if (!remaining.length) return 0;
    if (remaining[0].header.height !== Number(checkpoint.height) + 1 || remaining[0].header.parent !== checkpoint.hash || Date.parse(remaining[0].blockTime) < Date.parse(checkpoint.block_time)) throw new Error('Block gap or canonical parent mismatch');
    const accounts = new Map(), rows = [];
    for (const block of remaining) rows.push(await persistBlockTx(tx, block, policy, accounts));
    if (accounts.size) await tx.query(`INSERT INTO daily_accounts(day,chain,account)
      SELECT day,chain,account FROM jsonb_to_recordset($1::jsonb) AS a(day date,chain integer,account text)
      ON CONFLICT DO NOTHING`, [JSON.stringify([...accounts.values()])]);
    // Original integer microseconds survive JSON/PostgreSQL exactly. Date is
    // intentionally used only for grouping into calendar days, never Pact pinning.
    await tx.query(`INSERT INTO blocks(chain,height,hash,parent,block_time,creation_time,payload_hash,work,transaction_count,source_digest)
      SELECT chain,height,hash,parent,block_time,creation_time,payload_hash,work,transaction_count,source_digest
      FROM jsonb_to_recordset($1::jsonb) AS b(chain integer,height bigint,hash text,parent text,block_time timestamptz,
      creation_time bigint,payload_hash text,work numeric(78,0),transaction_count integer,source_digest text)`, [JSON.stringify(rows)]);
    const summaries = new Map();
    for (let index = 0; index < rows.length; index++) {
      const row = rows[index], day = row.block_time.slice(0, 10), h = remaining[index].header;
      const current = summaries.get(day);
      if (!current) summaries.set(day, { day, chain, work: row.work, block_count: 1, transaction_count: row.transaction_count,
        first_height: row.height, last_height: row.height, first_parent: row.parent, first_creation_time: row.creation_time, last_header: h });
      else { current.work = (BigInt(current.work) + BigInt(row.work)).toString(); current.block_count++;
        current.transaction_count += row.transaction_count; current.last_height = row.height; current.last_header = h; }
    }
    const compact = await tx.query(`INSERT INTO daily_chain_stats(day,chain,work,block_count,transaction_count,first_height,last_height,first_parent,first_creation_time,last_header)
      SELECT day,chain,work,block_count,transaction_count,first_height,last_height,first_parent,first_creation_time,last_header
      FROM jsonb_to_recordset($1::jsonb) AS s(day date,chain integer,work numeric(90,0),block_count bigint,transaction_count bigint,
        first_height bigint,last_height bigint,first_parent text,first_creation_time bigint,last_header jsonb)
      ON CONFLICT(day,chain) DO UPDATE SET work=daily_chain_stats.work+excluded.work,
        block_count=daily_chain_stats.block_count+excluded.block_count,transaction_count=daily_chain_stats.transaction_count+excluded.transaction_count,
        last_height=excluded.last_height,last_header=excluded.last_header
      WHERE daily_chain_stats.last_height+1=excluded.first_height AND daily_chain_stats.last_header->>'hash'=excluded.first_parent`, [JSON.stringify([...summaries.values()])]);
    if (compact.rowCount !== summaries.size) throw new Error('Compact daily summary is not contiguous with the previous batch');
    const last = remaining.at(-1);
    await tx.query('DELETE FROM blocks WHERE chain=$1 AND height<=$2', [chain, last.header.height - REPLAY_TAIL_BLOCKS]);
    await tx.query('UPDATE chain_checkpoints SET height=$2,hash=$3,block_time=$4,updated_at=now() WHERE chain=$1', [chain, last.header.height, last.header.hash, last.blockTime]);
    return remaining.length;
  });
}

export async function persistBlock(db, block, policy) {
  return (await persistBlocks(db, [block], policy)) === 1;
}

export async function indexBlocks(db, { throughDay = completedDay(), maxBlocks = 2000, chunkSize = Number(process.env.INDEX_CHUNK_SIZE ?? 200), finalityDepth = 20, api = chainweb, onProgress = () => {}, signal } = {}) {
  if (!Number.isSafeInteger(maxBlocks) || maxBlocks < 1 || !Number.isSafeInteger(chunkSize) || chunkSize < 1 || chunkSize > 500 || !Number.isSafeInteger(finalityDepth) || finalityDepth < 0) throw new Error('Invalid collection budget or finality depth');
  const window = windowFor(throughDay);
  await assertCollectionState(db);
  await assertAccountExtractionReady(db);
  await api.discoverNetwork();
  const cut = await api.getCut();
  const policy = JSON.parse(await readFile(new URL('../config/module-policy.json', import.meta.url), 'utf8'));
  const lock = await db.connect();
  let acquired = false, count = 0;
  try {
    acquired = (await lock.query("SELECT pg_try_advisory_lock(hashtext('kce-raw-indexer')) AS locked")).rows[0].locked;
    if (!acquired) throw new Error('Another indexer is active');
    await assertAccountExtractionReady(lock);
    const checkpoints = new Map();
    async function initializeChain(chain) {
      signal?.throwIfAborted();
      let checkpoint = (await db.query('SELECT * FROM chain_checkpoints WHERE chain=$1', [chain])).rows[0];
      const tip = cut.hashes[String(chain)];
      if (checkpoint && String(checkpoint.coverage_start).slice(0,10) !== window.fromDay) throw new Error('Chain baseline differs from fixed collection start; explicit backfill is required');
      if (!checkpoint) {
        const { before } = await api.headerBeforeTime({ chain, time: window.startTime, tipHash: tip.hash,
          tipHeight: tip.height - finalityDepth, minHeight: FORK_HEIGHT - 1 });
        const inventory = await api.listModulesAt({ chain, height: before.height, tipHash: tip.hash });
        if (inventory.chain !== chain || inventory.height !== before.height || inventory.blockHash !== before.hash) throw new Error(`Chain ${chain} baseline inventory is not pinned to the pre-collection block`);
        await rebaseChain(db, { chain, before, inventory, window, tipHash: tip.hash });
        checkpoint = (await db.query('SELECT * FROM chain_checkpoints WHERE chain=$1', [chain])).rows[0];
        onProgress({ event: 'collection_inventory_saved', chain, fromDay: window.fromDay, modules: inventory.modules.length });
      }
      const [same] = await api.headersRange({ chain, fromHeight: Number(checkpoint.height), toHeight: Number(checkpoint.height), tipHash: tip.hash });
      if (same.hash !== checkpoint.hash) throw new Error(`Chain ${chain} reorg requires an explicit reindex; no score published`);
      return checkpoint;
    }
    for (let chain = 0; chain < 20; chain += 2) {
      const initialized = await Promise.allSettled([initializeChain(chain), initializeChain(chain + 1)]);
      for (let index = 0; index < initialized.length; index++) {
        if (initialized[index].status === 'rejected') throw initialized[index].reason;
        checkpoints.set(chain + index, initialized[index].value);
      }
    }
    let progressed = true;
    while (count < maxBlocks && progressed) {
      progressed = false;
      // Resume with the least advanced chain. Restarting at chain 0 would starve
      // later chains whenever a bounded invocation stops before a complete round.
      const order = [...checkpoints.keys()].sort((a, b) => Number(checkpoints.get(a).height) - Number(checkpoints.get(b).height) || a - b);
      for (let offset = 0; offset < order.length; offset += 2) {
        signal?.throwIfAborted();
        if (count >= maxBlocks) break;
        let reserved = 0;
        const ranges = [];
        for (const chain of order.slice(offset, offset + 2)) {
          const checkpoint = checkpoints.get(chain), tip = cut.hashes[String(chain)];
          if (Date.parse(checkpoint.block_time) >= Date.parse(window.cutoff)) continue;
          const fromHeight = Number(checkpoint.height) + 1;
          const toHeight = Math.min(tip.height - finalityDepth, fromHeight + chunkSize - 1, fromHeight + maxBlocks - count - reserved - 1);
          if (fromHeight > toHeight) continue;
          ranges.push({ chain, fromHeight, toHeight, tipHash: tip.hash });
          reserved += toHeight - fromHeight + 1;
        }
        // Only two independent chains may fetch concurrently. Await both even
        // after one fails, so retries cannot leave unobserved requests running.
        const fetched = await Promise.allSettled(ranges.map(async range => typeof api.blocksRange === 'function' ?
          api.blocksRange(range) : api.payloadsForHeaders({ chain: range.chain, headers: await api.headersRange(range) })));
        for (let index = 0; index < ranges.length; index++) {
          if (fetched[index].status === 'rejected') throw fetched[index].reason;
          const { chain, fromHeight, toHeight } = ranges[index];
          let blocks = fetched[index].value;
          if (blocks.length !== toHeight - fromHeight + 1 || blocks.some((block, blockIndex) => Number(block.header.chainId) !== chain || block.header.height !== fromHeight + blockIndex)) throw new Error('Incomplete or unordered block batch');
          // One next-day block per chain closes coverage and preserves its
          // summarized transactions for tomorrow. It never enters today's score.
          const boundary = blocks.findIndex(block => Date.parse(block.blockTime) >= Date.parse(window.cutoff));
          if (boundary >= 0) blocks = blocks.slice(0, boundary + 1);
          signal?.throwIfAborted();
          await persistBlocks(db, blocks, policy);
          count += blocks.length;
          const last = blocks.at(-1).header;
          checkpoints.set(chain, { height: last.height, hash: last.hash, block_time: new Date(last.creationTime / 1000).toISOString() });
          onProgress({ event: 'chain_chunk_indexed', chain, fromHeight, throughHeight: toHeight, blocksIndexed: count, budget: maxBlocks });
          progressed = true;
        }
      }
    }
    await saveEvidence(db, 'chainweb-index-anchor', cut, throughDay);
    return { blocksIndexed: count, anchor: cut.id, checkpoints: (await db.query('SELECT chain,height,hash,block_time FROM chain_checkpoints ORDER BY chain')).rows };
  } finally {
    try { if (acquired) await lock.query("SELECT pg_advisory_unlock(hashtext('kce-raw-indexer'))"); }
    finally { lock.release(); }
  }
}

/** Compatibility name: the only disposable records are raw replay headers.
 * Daily summaries, account evidence, module identities, sources and scores stay
 * permanently. Never run date-based DELETE against the collection history. */
export async function pruneRetention(db, throughDay = completedDay()) {
  const window = windowFor(throughDay);
  return transaction(db, async tx => {
    await assertCollectionState(tx);
    await tx.query(`DELETE FROM blocks b USING chain_checkpoints c
      WHERE b.chain=c.chain AND b.height<=c.height-$1`, [REPLAY_TAIL_BLOCKS]);
    return window;
  });
}

/** Initialize a chain once with the canonical inventory immediately before the
 * fixed collection start. The old exported name is kept for source compatibility;
 * an existing checkpoint can only be checked, never rebased or rewritten. */
export async function rebaseChain(db, { chain, before, inventory, window, tipHash }) {
  chainweb.validateHeader(before, chain);
  if (window.fromDay !== COLLECTION_START || window.startTime !== COLLECTION_START+'T00:00:00Z' ||
      before.creationTime >= Date.parse(window.startTime) * 1000 || inventory.chain !== chain || inventory.height !== before.height ||
      inventory.blockHash !== before.hash || !Array.isArray(inventory.modules) || inventory.modules.some(name => typeof name !== 'string' || !name) ||
      new Set(inventory.modules).size !== inventory.modules.length) throw new Error('Invalid fixed collection inventory');
  return transaction(db, async tx => {
    await assertCollectionState(tx);
    await tx.query("SELECT pg_advisory_xact_lock(hashtext('kce-snapshot-publication'))");
    const current = (await tx.query('SELECT * FROM chain_checkpoints WHERE chain=$1 FOR UPDATE', [chain])).rows[0];
    if (current) {
      const original=current.baseline_inventory;
      if (String(current.coverage_start).slice(0,10)!==window.fromDay || current.baseline_header?.hash!==before.hash ||
          original?.blockHash!==inventory.blockHash || JSON.stringify([...(original?.modules??[])].sort())!==JSON.stringify([...inventory.modules].sort())) {
        throw new Error('Fixed collection inventory cannot be replaced; explicit canonical replay or backfill is required');
      }
      return;
    }
    await tx.query('INSERT INTO modules(chain,name,existed_before_window) SELECT $1,unnest($2::text[]),true ON CONFLICT DO NOTHING', [chain, inventory.modules]);
    await tx.query(`INSERT INTO chain_checkpoints(chain,height,hash,block_time,anchor_hash,baseline_inventory,baseline_header,coverage_start)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8)`,
    [chain,before.height,before.hash,new Date(before.creationTime/1000).toISOString(),tipHash,inventory,before,window.fromDay]);
  });
}

export async function dailyChainMetrics(db, throughDay = completedDay()) {
  const window = windowFor(throughDay), cutoffTime = Date.parse(window.cutoff);
  await assertCollectionState(db);
  await assertAccountExtractionReady(db);
  await assertModuleIdentitiesReviewed(db, window.cutoff);
  const checkpoints = (await db.query('SELECT chain,height,hash,block_time,coverage_start,baseline_header FROM chain_checkpoints')).rows;
  const chains = new Set(checkpoints.map(c => Number(c.chain)));
  if (checkpoints.length !== 20 || Array.from({ length: 20 }, (_, chain) => chain).some(chain => !chains.has(chain)) || checkpoints.some(c =>
      !Number.isFinite(new Date(c.block_time).getTime()) || new Date(c.block_time).getTime() < cutoffTime || String(c.coverage_start).slice(0, 10) !== window.fromDay)) throw new Error('All 20 chains must cover the complete collection history and be indexed beyond the final UTC boundary');
  await assertModuleArtifactPolicyCurrent(db, window.cutoff);
  const [accounts, contracts, stats] = await Promise.all([
    db.query('SELECT day::text,count(*)::int AS n FROM daily_accounts WHERE day >= $1 AND day <= $2 GROUP BY day', [window.fromDay, throughDay]),
    db.query("SELECT (block_time AT TIME ZONE 'UTC')::date::text AS day,count(*) FILTER(WHERE kind='new' AND artifact_status='included')::int AS n,count(*) FILTER(WHERE kind='upgrade')::int AS upgrades FROM module_deployments WHERE block_time>=$1 AND block_time<$2 GROUP BY 1", [window.startTime, window.cutoff]),
    // Include the first next-day block: its persisted contiguous coverage closes
    // the final UTC boundary even when a chain had no blocks on the last day.
    db.query('SELECT day::text,chain,work::text,block_count::text,first_height::text,last_height::text,first_parent,first_creation_time::text,last_header FROM daily_chain_stats WHERE day>=$1 ORDER BY chain,day', [window.fromDay]),
  ]);
  const map = new Map();
  for (let day = window.fromDay; day <= throughDay; day = addDays(day, 1)) map.set(day, { day, addresses: 0, contracts: 0, upgrades: 0, hashratePh: 0, headers: {} });
  for (const r of accounts.rows) if (map.has(r.day)) map.get(r.day).addresses = r.n;
  for (const r of contracts.rows) if (map.has(r.day)) Object.assign(map.get(r.day), { contracts: r.n, upgrades: r.upgrades });
  const latest = new Map(checkpoints.map(c => {
    const h = chainweb.validateHeader(c.baseline_header, c.chain);
    if (h.creationTime >= Date.parse(window.startTime) * 1000) throw new Error('Invalid collection boundary header');
    return [Number(c.chain), h];
  }));
  for (const r of stats.rows) {
    const previous = latest.get(Number(r.chain)), h = chainweb.validateHeader(r.last_header, r.chain);
    if (Number(r.first_height) !== previous.height + 1 || r.first_parent !== previous.hash ||
        Number(r.block_count) !== Number(r.last_height) - Number(r.first_height) + 1 || h.height !== Number(r.last_height) ||
        new Date(h.creationTime / 1000).toISOString().slice(0, 10) !== r.day || new Date(Number(r.first_creation_time) / 1000).toISOString().slice(0, 10) !== r.day) throw new Error('Compact daily coverage has a gap or inconsistent source header');
    latest.set(Number(r.chain), h);
    if (!map.has(r.day)) continue;
    map.get(r.day).hashratePh += Number(BigInt(r.work)) / 86400 / 1e15;
    map.get(r.day).headers[String(r.chain)] = h;
  }
  for (const c of checkpoints) if (latest.get(Number(c.chain)).height !== Number(c.height) || latest.get(Number(c.chain)).hash !== c.hash) throw new Error('Compact daily coverage does not reach checkpoint');
  let previous = Object.fromEntries(checkpoints.map(c => [String(c.chain), c.baseline_header]));
  for (const row of map.values()) { row.headers = { ...previous, ...row.headers }; previous = row.headers; }
  return [...map.values()];
}

/** Fail closed before either aggregation or publication. An unresolved identity
 * can make a later declaration of that same module look incorrectly "new".
 *
 * Review policy: retain the queue until a parser-supported identity is obtained
 * by replaying the original command data/result at its canonical source block.
 * Verify its request hash, block/checkpoint identity and source offsets; then,
 * under the raw-indexer/publication locks and one transaction, rebuild affected
 * chains' module inventories and deployment kinds from their fixed collection-boundary inventory
 * in (height, transactionIndex, sourceStart/declarationIndex) order. Existing
 * evidence without that ordering must first be recovered from canonical payloads.
 * Recompute published history before clearing the corresponding queue entries.
 * There is deliberately no automatic/manual "mark resolved" operation here.
 */
export async function assertModuleIdentitiesReviewed(db, cutoff) {
  if (typeof cutoff !== 'string' || !/^\d{4}-\d{2}-\d{2}T00:00:00(?:\.000)?Z$/.test(cutoff) ||
      !Number.isFinite(Date.parse(cutoff)) || new Date(cutoff).toISOString().slice(0, 10) !== cutoff.slice(0, 10)) throw new Error('Invalid module review cutoff');
  const pending = await db.query('SELECT count(*)::int AS n FROM module_identity_reviews WHERE block_time<$1', [cutoff]);
  const count = pending.rows[0]?.n;
  if (!Number.isSafeInteger(count) || count < 0) throw new Error('Module identity review state could not be verified');
  if (count) throw Object.assign(new Error('Unresolved successful module identities require verified replay and chronological reclassification before publication'),
    { code: 'MODULE_IDENTITY_REVIEW_REQUIRED', details: { pending: count, cutoff } });
}
