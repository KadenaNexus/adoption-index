import { blake2b } from '@noble/hashes/blake2.js';

const HASH = /^[A-Za-z0-9_-]{43}$/;
// The Pact execution result already validates successful source identifiers.
// Do not silently drop valid symbols because of a narrower application regex.
const MODULE_NAME = /^[^\s()[\]{};"]+$/;
// Pact's quoted symbols are string literals, not evaluated identifiers.
// This matches the identifier characters in Pact.Types.Parser.style.
const SYMBOL_LITERAL = /^[\p{L}%#+\-_&$@<>=^?*!|/~][\p{L}\p{Nd}%#+\-_&$@<>=^?*!|/~]*/u;

export function pactCommandHash(command) {
  if (typeof command !== 'string') throw new TypeError('Pact command must be a string');
  return Buffer.from(blake2b(Buffer.from(command, 'utf8'), { dkLen: 32 })).toString('base64url');
}

export function decodeBase64Json(encoded, label = 'Pact value') {
  if (typeof encoded !== 'string' || !/^[A-Za-z0-9_-]+={0,2}$/.test(encoded)) {
    throw new Error(`${label}: invalid base64url`);
  }
  const bytes = Buffer.from(encoded, 'base64url');
  if (bytes.toString('base64url') !== encoded.replace(/=+$/, '')) throw new Error(`${label}: noncanonical base64url`);
  let decoded;
  try { decoded = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)); }
  catch (error) { throw new Error(`${label}: invalid UTF-8 JSON`, { cause: error }); }
  if (decoded === null || typeof decoded !== 'object' || Array.isArray(decoded)) throw new Error(`${label}: expected an object`);
  return decoded;
}

export function normalizeEvent(event, index) {
  if (!event || typeof event.name !== 'string' || !Array.isArray(event.params) ||
      !event.module || typeof event.module.name !== 'string' ||
      !(event.module.namespace == null || typeof event.module.namespace === 'string')) {
    throw new Error('Malformed Pact event');
  }
  const module = event.module.namespace ? `${event.module.namespace}.${event.module.name}` : event.module.name;
  return { index, name: event.name, module, qualifiedName: `${module}.${event.name}`,
    moduleHash: event.moduleHash ?? null, params: event.params };
}

/** Literal top-level declarations only. Comments and strings are never parsed as code. */
export function tokenizePact(code) {
  if (typeof code !== 'string') throw new TypeError('Pact source must be a string');
  const tokens = [];
  for (let i = 0; i < code.length;) {
    const start = i;
    const c = code[i];
    if (/\s/.test(c)) { i++; continue; }
    if (c === ';') { const end = code.indexOf('\n', i); i = end < 0 ? code.length : end + 1; continue; }
    if ('()[]{}'.includes(c)) { tokens.push({ type: 'delimiter', value: c, start, end: ++i }); continue; }
    if (c === "'") {
      i++;
      // Pact's symbolic quote consumes whitespace/comments before its identifier.
      for (;;) {
        if (i < code.length && /\s/.test(code[i])) { i++; continue; }
        if (code[i] === ';') { const end = code.indexOf('\n', i); i = end < 0 ? code.length : end + 1; continue; }
        break;
      }
      const symbol = SYMBOL_LITERAL.exec(code.slice(i));
      if (!symbol) throw new Error('Unsupported Pact symbol literal');
      i += symbol[0].length;
      tokens.push({ type: 'string', value: symbol[0], raw: code.slice(start, i), start, end: i });
      continue;
    }
    if (c === '"') {
      i++;
      let closed = false;
      while (i < code.length) {
        if (code[i] === '\\') { i += 2; continue; }
        if (code[i++] === '"') { closed = true; break; }
      }
      if (!closed) throw new Error('Unterminated Pact string');
      const raw = code.slice(start, i);
      let value = null;
      try { value = JSON.parse(raw); } catch { /* Pact multiline strings need no interpretation for declarations. */ }
      tokens.push({ type: 'string', value, raw, start, end: i });
      continue;
    }
    while (i < code.length && !/\s/.test(code[i]) && !'()[]{};"\''.includes(code[i])) i++;
    tokens.push({ type: 'atom', value: code.slice(start, i), start, end: i });
  }
  return tokens;
}

function loadedModuleNames(result) {
  const data = result && typeof result === 'object' && 'data' in result ? result.data : result;
  const strings = typeof data === 'string' ? [data] : Array.isArray(data) ? data.filter(x => typeof x === 'string') : [];
  const names = [];
  for (const value of strings) {
    // The execution result is provenance supplied by Pact, not a source-code comment.
    const match = /^Loaded module ([^\s,]+), hash [A-Za-z0-9_-]+$/.exec(value);
    if (match) names.push(match[1]);
  }
  return names;
}

function namespaceLiteral(form, code, data) {
  const tokens = tokenizePact(code.slice(form.start, form.end));
  // Only a literal argument, or a literal-key read from the verified command
  // body, is evaluated here. Computed keys and arbitrary Pact calls fail closed.
  if (tokens.length === 4 && tokens[2]?.type === 'string') {
    return { value: tokens[2].value, source: 'source-literal' };
  }
  if (tokens.length !== 7 || tokens[2]?.value !== '(' || tokens[3]?.type !== 'atom' ||
      !['read-msg', 'read-string'].includes(tokens[3].value) || tokens[4]?.type !== 'string' ||
      tokens[5]?.value !== ')' || data === null || typeof data !== 'object' || Array.isArray(data) ||
      !Object.hasOwn(data, tokens[4].value)) return { value: null, source: 'unresolved' };
  const value = data[tokens[4].value];
  // Do not coerce numbers/objects or infer a namespace from unrelated metadata.
  return { value: typeof value === 'string' ? value : null, source: 'command-data',
    evidence: { reader: tokens[3].value, key: tokens[4].value, value } };
}

/** Returns declarations; the database inventory decides new versus upgrade. */
export function parseModuleDeclarations({ code, result, success, data, chain = null, requestKey = null } = {}) {
  if (!success || typeof code !== 'string') return [];
  const tokens = tokenizePact(code);
  const forms = [];
  let depth = 0;
  let form = null;
  const stack = [];
  let previousToken = null;
  for (const token of tokens) {
    if (depth > 1 && token.type === 'atom' && token.value === 'module' && previousToken?.value === '(') {
      throw new Error('Unsupported nested module declaration; cannot silently skip a deployment');
    }
    if (token.type === 'delimiter' && '([{'.includes(token.value)) {
      if (depth === 0) form = { delimiter: token.value, values: [], start: token.start };
      stack.push(token.value); depth++;
    } else if (token.type === 'delimiter' && ')]}'.includes(token.value)) {
      const expected = { ')': '(', ']': '[', '}': '{' }[token.value];
      if (stack.pop() !== expected) throw new Error('Unbalanced Pact delimiters');
      depth--;
      if (depth === 0 && form) { form.end = token.end; forms.push(form); form = null; }
    } else if (depth === 1 && form) {
      form.values.push(token);
    }
    previousToken = token;
  }
  if (depth !== 0) throw new Error('Unbalanced Pact delimiters');
  let namespace = null;
  let namespaceKnown = true; // No namespace expression means root namespace.
  let namespaceSource = 'source-literal';
  let namespaceEvidence;
  const declarations = [];
  for (const current of forms) {
    if (current.delimiter !== '(') continue;
    const [head, name] = current.values;
    if (head?.type !== 'atom') continue;
    if (head.value === 'namespace') {
      const resolved = namespaceLiteral(current, code, data);
      namespaceKnown = typeof resolved.value === 'string' && resolved.value.length > 0;
      namespace = namespaceKnown ? resolved.value : null;
      namespaceSource = resolved.source;
      namespaceEvidence = namespaceKnown ? resolved.evidence : undefined;
    }
    if (head.value !== 'module') continue;
    if (name?.type !== 'atom' || !MODULE_NAME.test(name.value)) throw new Error('Unsupported successful module declaration');
    const qualifiedName = name.value.includes('.') ? name.value : namespaceKnown ? (namespace ? `${namespace}.${name.value}` : name.value) : null;
    declarations.push({ chain, requestKey, literalName: name.value, qualifiedName, namespace,
      identityResolved: qualifiedName !== null, identitySource: qualifiedName ? (name.value.includes('.') ? 'source-literal' : namespaceSource) : 'unresolved',
      ...(qualifiedName && !name.value.includes('.') && namespaceEvidence ? { namespaceEvidence } : {}),
      sourceStart: current.start, sourceEnd: current.end });
  }
  const loaded = loadedModuleNames(result);
  for (const declaration of declarations) {
    // A transaction can return a forged Loaded-module string after doing
    // something else. Only the final module expression itself produces trusted
    // engine identity evidence; trailing strings/calls are not that evidence.
    if (declaration.sourceEnd !== tokens.at(-1)?.end) continue;
    const matches = loaded.filter(name => name.split('.').at(-1) === declaration.literalName.split('.').at(-1));
    if (matches.length === 1) {
      if (declaration.qualifiedName && declaration.qualifiedName !== matches[0]) {
        throw new Error('Pact module result disagrees with source namespace');
      }
      declaration.qualifiedName = matches[0];
      declaration.namespace = matches[0].includes('.') ? matches[0].split('.')[0] : null;
      declaration.identityResolved = true;
      declaration.identitySource = 'execution-result';
    }
  }
  return declarations;
}

/** Exact registry only; suspicious-looking names must not silently disappear. */
export function isTestArtifact(identity, registry = []) {
  const entries = Array.isArray(registry) ? registry : registry.entries;
  if (!Array.isArray(entries)) throw new TypeError('Test-artifact registry must contain entries');
  return entries.some(entry => entry && entry.qualifiedName === identity.qualifiedName &&
    entry.chain != null && String(entry.chain) === String(identity.chain) &&
    typeof entry.reason === 'string' && entry.reason.trim() &&
    (!entry.requestKey || entry.requestKey === identity.requestKey));
}

function isPactAmount(value) {
  if (typeof value === 'number') return Number.isFinite(value);
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).length !== 1) return false;
  // Pact wraps integers and decimals which cannot safely use its JSON-number
  // representation. Account extraction must validate the type, not round it.
  if (Object.hasOwn(value, 'decimal')) return typeof value.decimal === 'string' && /^-?\d+(?:\.\d+)?$/.test(value.decimal);
  if (Object.hasOwn(value, 'int')) return typeof value.int === 'number' ? Number.isSafeInteger(value.int) :
    typeof value.int === 'string' && /^-?\d+$/.test(value.int);
  return false;
}

/** Published fungible-v2 and poly-fungible-v3 event layouts, with exact arity. */
export function transferAccounts(event) {
  if (event?.name !== 'TRANSFER' || !Array.isArray(event.params)) return null;
  const params = event.params;
  // coin/fungible-v2: [sender, receiver, amount].
  if (params.length === 3 && typeof params[0] === 'string' && typeof params[1] === 'string' && isPactAmount(params[2])) {
    return params.slice(0, 2).filter(account => account !== '');
  }
  // Marmalade/poly-fungible-v3 and Toucan LP tokens:
  // [token-id, sender, receiver, amount]. Token IDs are never accounts.
  // Empty endpoints mean mint/burn and are deliberately omitted.
  if (params.length === 4 && params.slice(0, 3).every(value => typeof value === 'string') && isPactAmount(params[3])) {
    return params.slice(1, 3).filter(account => account !== '');
  }
  return null;
}

export function isAccountTransfer(event) { return transferAccounts(event) !== null; }

export function transferParticipants(transaction) {
  const accounts = new Set();
  if (typeof transaction.sender === 'string' && transaction.sender !== '') accounts.add(transaction.sender);
  for (const event of transaction.events ?? []) {
    for (const account of transferAccounts(event) ?? []) accounts.add(account);
  }
  return [...accounts];
}

export const participantsForTransaction = transferParticipants;

export function decodeBlock(header, payload) {
  if (!header || !payload || payload.payloadHash !== header.payloadHash) throw new Error('Payload hash does not match header');
  if (!Array.isArray(payload.transactions)) throw new Error('Missing transaction/output pairs');
  if (!Number.isSafeInteger(header.creationTime) || header.creationTime < 0) throw new Error('Invalid block time');
  const blockTime = new Date(header.creationTime / 1000).toISOString();
  const seen = new Set();
  const transactions = payload.transactions.map((pair, index) => {
    if (!Array.isArray(pair) || pair.length !== 2) throw new Error('Missing transaction output');
    const wrapper = decodeBase64Json(pair[0], 'Transaction');
    const output = decodeBase64Json(pair[1], 'Transaction output');
    if (typeof wrapper.cmd !== 'string' || !HASH.test(wrapper.hash) ||
        pactCommandHash(wrapper.cmd) !== wrapper.hash || output.reqKey !== wrapper.hash) {
      throw new Error('Transaction command hash / output request key mismatch');
    }
    if (seen.has(wrapper.hash)) throw new Error('Duplicate transaction in block');
    seen.add(wrapper.hash);
    const command = JSON.parse(wrapper.cmd);
    if (!command.meta || String(command.meta.chainId) !== String(header.chainId)) throw new Error('Transaction chain does not match block');
    if (command.networkId != null && command.networkId !== 'mainnet01') throw new Error('Transaction network is not mainnet01');
    if (typeof command.meta.sender !== 'string') throw new Error('Missing transaction sender');
    if (!['success', 'failure'].includes(output.result?.status)) throw new Error('Invalid transaction result status');
    if (output.events != null && !Array.isArray(output.events)) throw new Error('Invalid transaction events');
    const transaction = {
      index, requestKey: wrapper.hash, chain: Number(header.chainId), height: header.height,
      blockHash: header.hash, blockTime, command, output, success: output.result.status === 'success',
      sender: command.meta.sender, code: command.payload?.exec?.code ?? null,
      signers: command.signers ?? [], events: (output.events ?? []).map(normalizeEvent),
      gas: output.gas ?? null, result: output.result,
    };
    transaction.participants = transferParticipants(transaction);
    transaction.unparsedTransferEvents = transaction.events.filter(event => event.name === 'TRANSFER' && !isAccountTransfer(event));
    if (transaction.unparsedTransferEvents.length) {
      const event = transaction.unparsedTransferEvents[0];
      // Unrecognized shapes cannot silently make an incomplete account set look
      // complete. Stop before persistence and retain an actionable source key.
      throw new Error(`Unsupported TRANSFER schema at chain ${transaction.chain}, height ${transaction.height}, request ${transaction.requestKey}, module ${event.module}, event ${event.index}, arity ${event.params.length}`);
    }
    transaction.modules = parseModuleDeclarations({ ...transaction, data: command.payload?.exec?.data, result: output.result });
    return transaction;
  });
  // Coinbase is retained separately and deliberately never enters DAA participants.
  const coinbase = decodeBase64Json(payload.coinbase, 'Coinbase');
  const miner = decodeBase64Json(payload.minerData, 'Miner data');
  return { header, payload, blockTime, transactions, coinbase, miner };
}
