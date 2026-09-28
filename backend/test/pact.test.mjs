import test from 'node:test';
import assert from 'node:assert/strict';
import { pactCommandHash, parseModuleDeclarations, transferParticipants, transferAccounts, isAccountTransfer, isTestArtifact, decodeBlock } from '../src/pact.mjs';

const encode = value => Buffer.from(JSON.stringify(value)).toString('base64url');
const header = { chainId: 2, height: 6335858, hash: 'h'.repeat(43), payloadHash: 'p'.repeat(43), creationTime: 1762574965741022 };

function transactionPair({ chain = '2', sender = 'gas-station', code = '(coin.transfer "alice" "bob" 1.0)', status = 'success', events = [] } = {}) {
  const cmd = JSON.stringify({ networkId: 'mainnet01', payload: { exec: { code, data: {} } }, meta: { chainId: chain, sender }, signers: [] });
  const hash = pactCommandHash(cmd);
  return [encode({ hash, cmd, sigs: [] }), encode({ reqKey: hash, result: { status, data: 'ok' }, gas: 50, events })];
}

function payload(pair = transactionPair()) {
  return { payloadHash: header.payloadHash, transactions: [pair],
    minerData: encode({ account: 'miner' }), coinbase: encode({ result: { status: 'success', data: 'coinbase' } }) };
}

test('BLAKE2b-256 matches independent published empty-input vector, not truncated BLAKE2b-512', () => {
  assert.equal(Buffer.from(pactCommandHash(''), 'base64url').toString('hex'), '0e5751c026e543b2e8ab2eb06099daa1d1e5df47778f7787faab45cdf12fe3a8');
});

test('declarations ignore comments/strings and accept whitespace, literal namespaces, and multiple modules', () => {
  const code = '; (module evil ADMIN)\n(namespace "free")\n(\n module real ADMIN @doc "fake (module stolen A)" (defun x () "x"))\n(module second ADMIN)';
  const declarations = parseModuleDeclarations({ code, success: true, result: 'Loaded module free.second, hash abc', chain: 2 });
  assert.deepEqual(declarations.map(x => x.qualifiedName), ['free.real', 'free.second']);
  assert.equal(declarations[1].identitySource, 'execution-result');
  assert.deepEqual(parseModuleDeclarations({ code, success: false }), []);
});

test('dynamic namespace uses successful execution identity and preserves unresolved identity otherwise', () => {
  const code = '(namespace (read-string "ns")) (module module-name ADMIN)';
  assert.equal(parseModuleDeclarations({ code, success: true })[0].qualifiedName, null);
  const [found] = parseModuleDeclarations({ code, success: true, result: { status: 'success', data: 'Loaded module n_abc.module-name, hash abc' } });
  assert.equal(found.qualifiedName, 'n_abc.module-name');
  assert.equal(found.identitySource, 'execution-result');
  assert.throws(() => parseModuleDeclarations({ code: '(namespace "a") (module x A)', success: true, result: 'Loaded module b.x, hash abc' }), /disagrees/);
});

test('test artifacts require exact chain/module registry plus reason', () => {
  const identity = { chain: 2, qualifiedName: 'free.test-real-product', requestKey: 'key' };
  assert.equal(isTestArtifact(identity), false);
  assert.equal(isTestArtifact(identity, [{ chain: 1, qualifiedName: identity.qualifiedName, reason: 'fixture' }]), false);
  assert.equal(isTestArtifact(identity, [{ chain: 2, qualifiedName: identity.qualifiedName, reason: 'confirmed test fixture' }]), true);
  assert.equal(isTestArtifact(identity, [{ chain: 2, qualifiedName: identity.qualifiedName }]), false);
});

test('successful module symbols are not silently filtered by application naming conventions', () => {
  const [declaration] = parseModuleDeclarations({ code: '(namespace "free") (module _fixture ADMIN)', success: true });
  assert.equal(declaration.qualifiedName, 'free._fixture');
  assert.equal(isTestArtifact({ ...declaration, chain: 2 }), false);
});

test('DAA includes failed transaction gas sender; only actual token TRANSFER supplies recipients', () => {
  assert.deepEqual(transferParticipants({ sender: 'gas-station', success: false, events: [] }), ['gas-station']);
  const accounts = transferParticipants({ sender: 'alice', events: [
    { name: 'TRANSFER', module: 'coin', params: ['alice', 'bob', 1] },
    { name: 'TRANSFER', module: 'free.token', params: ['bob', 'carol', 3] },
    { name: 'TRANSFER', module: 'coin', params: ['', 'bob', 4] },
    { name: 'TRANSFER_XCHAIN_RECD', params: ['this-is-not-an-account-pair', '20', 'bob'] },
    { name: 'TRANSFER', module: 'free.custom', params: [1, { item: 'not-an-account' }] },
  ] });
  assert.deepEqual(accounts.sort(), ['alice', 'bob', 'carol']);
});

test('poly-fungible TRANSFER excludes token IDs and preserves sender, receiver, mint and burn endpoints', () => {
  // kda-community/marmalade commit 0404eb71ed980b37d07f569adbc3a740367c1632:
  // pact/kip/poly-fungible-v3.pact lines32-41 and pact/ledger/ledger.pact lines63-68.
  const events = [
    { name: 'TRANSFER', module: 'marmalade-v2.ledger', params: ['t:nft-id', 'alice', 'bob', 1] },
    { name: 'TRANSFER', module: 'free.toucan-dex-tokens-v2', params: ['coin:free.toucan', 'bob', 'carol', {decimal:'1.00000000000000000001'}] },
    { name: 'TRANSFER', module: 'marmalade-v2.ledger', params: ['t:mint', '', 'dave', {int:1}] },
    { name: 'TRANSFER', module: 'marmalade-v2.ledger', params: ['t:burn', 'erin', '', {int:'9007199254740993'}] },
  ];
  assert.deepEqual(transferParticipants({sender:'gas-station',events}), ['gas-station','alice','bob','carol','dave','erin']);
  assert.deepEqual(transferAccounts(events[0]), ['alice','bob']);
  assert.deepEqual(transferAccounts({name:'TRANSFER',params:['id','','',0]}), []);
  assert.ok(events.every(isAccountTransfer));
});

test('transfer schemas require exact arity, account strings, and valid Pact numeric amounts', () => {
  for (const amount of [0, 1.5, 1e-8, {decimal:'9007199254740993.000000000000001'}, {int:1}, {int:'9007199254740993'}]) {
    assert.equal(isAccountTransfer({name:'TRANSFER',params:['a','b',amount]}), true);
    assert.equal(isAccountTransfer({name:'TRANSFER',params:['id','a','b',amount]}), true);
  }
  for (const params of [
    ['a','b'], ['id','a','b',1,'unexpected'], ['a','b','1.0'], ['id','a','b','1.0'],
    ['a','b',NaN], ['a','b',Infinity], ['id','a',{},1], [{},'a','b',1],
    ['a','b',{decimal:'NaN'}], ['a','b',{decimal:1}], ['a','b',{int:1.5}],
    ['a','b',{int:'1.5'}], ['a','b',{decimal:'1',other:true}], ['a','b',null],
  ]) {
    assert.equal(isAccountTransfer({name:'TRANSFER',params}), false, JSON.stringify(params));
  }
  assert.equal(transferAccounts({name:'TRANSFER_XCHAIN_RECD',params:['a','b',1]}), null);
});

test('failed transactions retain only actual emitted transfers and gas sender with either supported layout', () => {
  const events = [
    {name:'TRANSFER',module:{namespace:null,name:'coin'},params:['payer','miner',0.000001]},
    {name:'TRANSFER',module:{namespace:'marmalade-v2',name:'ledger'},params:['t:asset','holder','recipient',1]},
  ];
  const block = decodeBlock(header,payload(transactionPair({sender:'gas-station',status:'failure',events})));
  assert.deepEqual(block.transactions[0].participants,['gas-station','payer','miner','holder','recipient']);
  assert.equal(block.transactions[0].success,false);
  assert.deepEqual(block.transactions[0].unparsedTransferEvents,[]);
});

test('unsupported TRANSFER schema stops decoding before an incomplete DAA set can be persisted', () => {
  const event = {name:'TRANSFER',module:{namespace:'free',name:'custom'},params:['item','status','unrelated-string']};
  assert.throws(() => decodeBlock(header,payload(transactionPair({events:[event]}))),
    /Unsupported TRANSFER schema at chain 2, height 6335858, request [A-Za-z0-9_-]{43}, module free.custom, event 0, arity 3/);
});

test('raw pairs preserve real included block time and exclude coinbase from DAA', () => {
  const transfer = { name: 'TRANSFER', module: { namespace: 'free', name: 'token' }, moduleHash: 'm'.repeat(43), params: ['alice', 'bob', 5] };
  const block = decodeBlock(header, payload(transactionPair({ events: [transfer] })));
  assert.equal(block.transactions[0].blockTime, '2025-11-08T04:09:25.741Z');
  assert.equal(block.transactions[0].events[0].qualifiedName, 'free.token.TRANSFER');
  assert.deepEqual(block.transactions[0].participants, ['gas-station', 'alice', 'bob']);
  assert.equal(block.miner.account, 'miner');
  assert.ok(!block.transactions[0].participants.includes('miner'));
});

test('invalid command/output/header identities and missing outputs fail closed', () => {
  const pair = transactionPair();
  const wrongOutput = JSON.parse(Buffer.from(pair[1], 'base64url'));
  wrongOutput.reqKey = 'x'.repeat(43);
  assert.throws(() => decodeBlock(header, payload([pair[0], encode(wrongOutput)])), /mismatch/);
  const wrongCommand = JSON.parse(Buffer.from(pair[0], 'base64url'));
  wrongCommand.cmd += ' ';
  assert.throws(() => decodeBlock(header, payload([encode(wrongCommand), pair[1]])), /mismatch/);
  assert.throws(() => decodeBlock(header, payload(transactionPair({ chain: '3' }))), /chain/);
  assert.throws(() => decodeBlock(header, { ...payload(), payloadHash: 'x'.repeat(43) }), /Payload hash/);
  assert.throws(() => decodeBlock(header, payload([pair[0]])), /Missing transaction output/);
});


test('real chain-1 deployment resolves quoted namespace when its final result is TableCreated', () => {
  // Canonical mainnet block 6349207, request YXjKA5EtrqL3_GEfQh6GEB3l21ur1-C97ozV3V8GTow.
  // Historical describe-module at this block independently confirms free.simple-token,
  // module hash 2RYqVme4yTYch8jomP5M-r-U5k2jJs61ZN4K9dBtPFA. Raw pair retains its real command hash.
  const fixture = {"header":{"nonce":"2352848016052144112","creationTime":1762978082189684,"parent":"8J0rlkh_rg2axmZoXbcZJSM5hcfWqhAVM9Az1qY8wf4","adjacents":{"6":"OZyt2NHR3p5NwVhf7zaWK-3_9ZuPTHoZy-5NAGHsYKI","11":"5m0-UnhZqvJbR4MRUn1Hs6Pwc01awRD0P_Em_27UixU","16":"SP0CEssJMipkwVujuW0v4F4sGkgsT0y_lXfzo5BMqvg"},"target":"3DTUWJD11vI8wErGdfKvV4fEXt08glIKgQAAAAAAAAA","payloadHash":"SkbaHZV-nBYkVS1NDj47xcJav1sm9VwCOduvEi9OtL4","chainId":1,"weight":"TSxwBHirWjwaUwIAAAAAAAAAAAAAAAAAAAAAAAAAAAA","height":6349207,"chainwebVersion":"mainnet01","epochStart":1762977812660334,"featureFlags":0,"hash":"oGSBOlTA3K_Uwj-V7CjtciHYxSh8hEq-66NrI4WYgq8"},"payload":{"transactions":[["eyJoYXNoIjoiWVhqS0E1RXRycUwzX0dFZlFoNkdFQjNsMjF1cjEtQzk3b3pWM1Y4R1RvdyIsInNpZ3MiOlt7InNpZyI6IjYzMDMyNTFhNGU1ZmIyMWVkNDVjOWUxZGRlYjg1M2Y5MDU3OWZjMWRjMTU0ZWJlYTQwNTE4NDg3YTFjYThjOWIzYjM5ZjVjZGI2ODQ0NTM3YzEzMzQxZDZhNmQ5MmMzZTU1NjRmYTJmMzQzMGI3ZWY5YzA4NWU3NWVmOTE1MjBjIn1dLCJjbWQiOiJ7XCJuZXR3b3JrSWRcIjpcIm1haW5uZXQwMVwiLFwicGF5bG9hZFwiOntcImV4ZWNcIjp7XCJkYXRhXCI6e1wibnNcIjpcImZyZWVcIixcImFkbWluLWtleXNldFwiOntcImtleXNcIjpbXCIyMzdiNjI4NjQzZTRlN2YwYzEwNmNlNGFkNmU2NGJiMmExNjViMWFiYTgxYTY0YTAyYjE1YzI3NGU5NDg4MTYzXCJdLFwicHJlZFwiOlwia2V5cy1hbGxcIn19LFwiY29kZVwiOlwiOzsgVWx0cmEtbWluaW1hbCB0ZXN0IHRva2VuIGZvciBkZXBsb3ltZW50IHZlcmlmaWNhdGlvblxcblxcbihuYW1lc3BhY2UgJ2ZyZWUpXFxuXFxuKG1vZHVsZSBzaW1wbGUtdG9rZW4gR09WRVJOQU5DRVxcbiAgQGRvYyBcXFwiVWx0cmEtc2ltcGxlIHRlc3QgdG9rZW5cXFwiXFxuXFxuICAoZGVmY2FwIEdPVkVSTkFOQ0UgKClcXG4gICAgKGVuZm9yY2UtZ3VhcmQgKGtleXNldC1yZWYtZ3VhcmQgJ2FkbWluLWtleXNldCkpKVxcblxcbiAgKGRlZnNjaGVtYSBhY2NvdW50LXNjaGVtYVxcbiAgICBiYWxhbmNlOmRlY2ltYWxcXG4gICAgZ3VhcmQ6Z3VhcmQpXFxuXFxuICAoZGVmdGFibGUgYWNjb3VudHM6e2FjY291bnQtc2NoZW1hfSlcXG5cXG4gIChkZWZ1biBjcmVhdGUtYWNjb3VudCAoYWNjb3VudDpzdHJpbmcgZ3VhcmQ6Z3VhcmQpXFxuICAgIChpbnNlcnQgYWNjb3VudHMgYWNjb3VudCB7IFxcXCJiYWxhbmNlXFxcIjogMC4wLCBcXFwiZ3VhcmRcXFwiOiBndWFyZCB9KSlcXG5cXG4gIChkZWZ1biBnZXQtYmFsYW5jZSAoYWNjb3VudDpzdHJpbmcpXFxuICAgICh3aXRoLXJlYWQgYWNjb3VudHMgYWNjb3VudCB7IFxcXCJiYWxhbmNlXFxcIiA6PSBiYWwgfVxcbiAgICAgIGJhbCkpXFxuKVxcblxcbihjcmVhdGUtdGFibGUgYWNjb3VudHMpXFxuXCJ9fSxcInNpZ25lcnNcIjpbe1wicHViS2V5XCI6XCIyMzdiNjI4NjQzZTRlN2YwYzEwNmNlNGFkNmU2NGJiMmExNjViMWFiYTgxYTY0YTAyYjE1YzI3NGU5NDg4MTYzXCIsXCJzY2hlbWVcIjpcIkVEMjU1MTlcIixcImNsaXN0XCI6W3tcIm5hbWVcIjpcImNvaW4uR0FTXCIsXCJhcmdzXCI6W119XX1dLFwibWV0YVwiOntcImNoYWluSWRcIjpcIjFcIixcImNyZWF0aW9uVGltZVwiOjE3NjI5NzgwNDUsXCJnYXNMaW1pdFwiOjE1MDAwLFwiZ2FzUHJpY2VcIjoxZS04LFwic2VuZGVyXCI6XCJrOjIzN2I2Mjg2NDNlNGU3ZjBjMTA2Y2U0YWQ2ZTY0YmIyYTE2NWIxYWJhODFhNjRhMDJiMTVjMjc0ZTk0ODgxNjNcIixcInR0bFwiOjI4ODAwfSxcIm5vbmNlXCI6XCIxNzYyOTc4MDQ1LXRlc3QtdG9rZW5cIn0ifQ","eyJnYXMiOjEwNDYsInJlc3VsdCI6eyJzdGF0dXMiOiJzdWNjZXNzIiwiZGF0YSI6IlRhYmxlQ3JlYXRlZCJ9LCJyZXFLZXkiOiJZWGpLQTVFdHJxTDNfR0VmUWg2R0VCM2wyMXVyMS1DOTdvelYzVjhHVG93IiwibG9ncyI6ImphZ2IwU25BWVNOZ0JHVFV4RkZWeGNYNmN2NlhyMUZSNTludUJ3UWVja00iLCJldmVudHMiOlt7InBhcmFtcyI6WyJrOjIzN2I2Mjg2NDNlNGU3ZjBjMTA2Y2U0YWQ2ZTY0YmIyYTE2NWIxYWJhODFhNjRhMDJiMTVjMjc0ZTk0ODgxNjMiLCJrOjI1MWVmYjA2ZjNiNzk4ZGJlN2JiM2Y1OGY1MzViNjdiMGE5ZWQyZGE5YWE0ZTIzNjdiZTRhYmMwN2NjOTI3ZmEiLDEuMDQ2ZS01XSwibmFtZSI6IlRSQU5TRkVSIiwibW9kdWxlIjp7Im5hbWVzcGFjZSI6bnVsbCwibmFtZSI6ImNvaW4ifSwibW9kdWxlSGFzaCI6ImtsRmtyTGZweUxXLU0zeGpWUFNkcVhFTWd4UFBKaWJSdF9ENnFpQndzNnMifV0sIm1ldGFEYXRhIjpudWxsLCJjb250aW51YXRpb24iOm51bGwsInR4SWQiOjE4OTkyMjA0fQ"]],"minerData":"eyJhY2NvdW50IjoiazoyNTFlZmIwNmYzYjc5OGRiZTdiYjNmNThmNTM1YjY3YjBhOWVkMmRhOWFhNGUyMzY3YmU0YWJjMDdjYzkyN2ZhIiwicHJlZGljYXRlIjoia2V5cy1hbGwiLCJwdWJsaWMta2V5cyI6WyIyNTFlZmIwNmYzYjc5OGRiZTdiYjNmNThmNTM1YjY3YjBhOWVkMmRhOWFhNGUyMzY3YmU0YWJjMDdjYzkyN2ZhIl19","transactionsHash":"6zqU8mJK3x0_Y7su24v5TSU2OmYgVNMvouQbp2dRgyw","outputsHash":"ogtyyA3cvZqGYmyMIYXZlhcxHFprtb7nzdvOZzc_1no","payloadHash":"SkbaHZV-nBYkVS1NDj47xcJav1sm9VwCOduvEi9OtL4","coinbase":"eyJnYXMiOjAsInJlc3VsdCI6eyJzdGF0dXMiOiJzdWNjZXNzIiwiZGF0YSI6IldyaXRlIHN1Y2NlZWRlZCJ9LCJyZXFLZXkiOiJPRW93Y214cmFGOXlaekpoZUcxYWIxaGlZMXBLVTAwMWFHTm1WM0ZvUVZaTk9VRjZNWEZaT0hkbU5BIiwibG9ncyI6ImMxWnhuVWxnSkpqXzJhSV9PdmlseWRISlBmNjNxb0RCSDhfR3ljZHhfWkkiLCJldmVudHMiOlt7InBhcmFtcyI6WyIiLCJrOjI1MWVmYjA2ZjNiNzk4ZGJlN2JiM2Y1OGY1MzViNjdiMGE5ZWQyZGE5YWE0ZTIzNjdiZTRhYmMwN2NjOTI3ZmEiLDAuOTM1OTI3NV0sIm5hbWUiOiJUUkFOU0ZFUiIsIm1vZHVsZSI6eyJuYW1lc3BhY2UiOm51bGwsIm5hbWUiOiJjb2luIn0sIm1vZHVsZUhhc2giOiJrbEZrckxmcHlMVy1NM3hqVlBTZHFYRU1neFBQSmliUnRfRDZxaUJ3czZzIn1dLCJtZXRhRGF0YSI6bnVsbCwiY29udGludWF0aW9uIjpudWxsLCJ0eElkIjoxODk5MjIwMn0"}};
  const decoded = decodeBlock(fixture.header, fixture.payload);
  const [transaction] = decoded.transactions;
  assert.equal(transaction.requestKey, 'YXjKA5EtrqL3_GEfQh6GEB3l21ur1-C97ozV3V8GTow');
  assert.equal(transaction.result.data, 'TableCreated');
  assert.equal(transaction.modules.length, 1);
  const [declaration] = transaction.modules;
  assert.equal(declaration.qualifiedName, 'free.simple-token');
  assert.equal(declaration.namespace, 'free');
  assert.equal(declaration.identityResolved, true);
  assert.equal(declaration.identitySource, 'source-literal');
  assert.ok(transaction.code.slice(declaration.sourceStart, declaration.sourceEnd).startsWith('(module simple-token GOVERNANCE'));
});

test('quoted namespace strings preserve scope switches without evaluating dynamic expressions', () => {
  const code = `(namespace'free) (module first ADMIN)
    (namespace ' ; a quoted symbol may follow a comment
      second-ns) (module second ADMIN)
    (namespace (read-string "ns")) (module unresolved ADMIN)`;
  const declarations = parseModuleDeclarations({code, success: true, result: 'TableCreated'});
  assert.deepEqual(declarations.map(declaration => declaration.qualifiedName), ['free.first', 'second-ns.second', null]);
  assert.equal(declarations[2].identityResolved, false);
  assert.throws(() => parseModuleDeclarations({code: "(namespace 'free) (module x ADMIN)", success: true, result: 'Loaded module other.x, hash abc'}), /disagrees/);
});


test('real toucan deployment derives namespace from the hashed execution data despite later table creation', () => {
  // Mainnet chain1 / 6349330 / lvPme53I1rfPvrpEKi5p35aEuNnjAI_63IEEfYqQUI8.
  // Exact canonical command uses (namespace (read-msg 'ns)) with data.ns = free.
  const fixture = {"header":{"nonce":"10536072341237606621","creationTime":1762981721170762,"parent":"piNWgc5TAu_59qqyz8I4mVnVxroRzzpgoRzNr2f03Hc","adjacents":{"6":"WVwyzltOa4p4MJTryGUqZ_AKnzJkFBM_LOY1joYLz4s","11":"qlv8WPDa7hCNwpfSGZBpvmJ76lEFQDuwsgdQNMFgODg","16":"GAOc57PB0FChvKvtwm7nTtmZYkcMheppBNcZtYGX4Pw"},"target":"DDr3e7-jtve5cHDm011LMEujdXmkOzxugAAAAAAAAAA","payloadHash":"k1F57mbxkashDzuTKR5w_UphnhaZ82i2CU4RuiwwDeU","chainId":1,"weight":"yKhrKOJ6eTAbUwIAAAAAAAAAAAAAAAAAAAAAAAAAAAA","height":6349330,"chainwebVersion":"mainnet01","epochStart":1762981400022022,"featureFlags":0,"hash":"DvocK_8kmagEuOSh0UW1_5FIlBv5kBcq8gblhOeSpUo"},"payload":{"transactions":[["eyJoYXNoIjoibHZQbWU1M0kxcmZQdnJwRUtpNXAzNWFFdU5uakFJXzYzSUVFZllxUVVJOCIsInNpZ3MiOlt7InNpZyI6IjIyYmFlZGU0ODkyMzAzOWFhMmNjZmE5MjA4NTVmZjg2MDFlNjc1YTM3NDQ5NzMwMzg4ZmNkNjA5NzVjMGIyYTE3NDVmYjUwOWFkNmIzNjYwZTU0YmU2NjMxMjk0ZWNiN2I5MjU0Yzk2YjM4Njc4YmM0YzA1ZjNkNzRiODhlNjA3In1dLCJjbWQiOiJ7XCJuZXR3b3JrSWRcIjpcIm1haW5uZXQwMVwiLFwicGF5bG9hZFwiOntcImV4ZWNcIjp7XCJkYXRhXCI6e1wibnNcIjpcImZyZWVcIixcImRleC1ucy11c2VyXCI6e1wia2V5c1wiOltcIjIzN2I2Mjg2NDNlNGU3ZjBjMTA2Y2U0YWQ2ZTY0YmIyYTE2NWIxYWJhODFhNjRhMDJiMTVjMjc0ZTk0ODgxNjNcIl0sXCJwcmVkXCI6XCJrZXlzLWFsbFwifSxcImRleC1ucy1hZG1pblwiOntcImtleXNcIjpbXCIyMzdiNjI4NjQzZTRlN2YwYzEwNmNlNGFkNmU2NGJiMmExNjViMWFiYTgxYTY0YTAyYjE1YzI3NGU5NDg4MTYzXCJdLFwicHJlZFwiOlwia2V5cy1hbGxcIn0sXCJkZXgtZXhjaGFuZ2UtYWRtaW5cIjp7XCJrZXlzXCI6W1wiMjM3YjYyODY0M2U0ZTdmMGMxMDZjZTRhZDZlNjRiYjJhMTY1YjFhYmE4MWE2NGEwMmIxNWMyNzRlOTQ4ODE2M1wiXSxcInByZWRcIjpcImtleXMtYWxsXCJ9LFwiZGV4LWV4Y2hhbmdlLW9wc1wiOntcImtleXNcIjpbXCIyMzdiNjI4NjQzZTRlN2YwYzEwNmNlNGFkNmU2NGJiMmExNjViMWFiYTgxYTY0YTAyYjE1YzI3NGU5NDg4MTYzXCJdLFwicHJlZFwiOlwia2V5cy1hbGxcIn0sXCJ1cGdyYWRlXCI6MH0sXCJjb2RlXCI6XCI7OyBUaGlzIG1vZHVsZSBtYW5hZ2VzIHRoZSBsaXF1aWRpdHkgdG9rZW5zIHVzZWQgYnkgYGV4Y2hhbmdlYC5cXG47O1xcbjs7IFRoZSBtb2R1bGUgZnVuY3Rpb25zIGFyZSBwcmV0dHkgbXVjaCB0aGUgc2FtZSBhcyBhIHJlZ3VsYXJcXG47OyBmdW5naWJsZS12MiB0b2tlbiwgYnV0IHdpdGggYW4gZXh0cmEgc3RyaW5nIHBhcmFtZXRlciB0aGF0XFxuOzsgaXMgdGhlIHBhaXIga2V5IHJlcHJlc2VudGluZyB3aGljaCBwYWlyIHRoZSBsaXF1aWRpdHkgdG9rZW5zXFxuOzsgYXJlIGZvciwgZS5nLiBcXFwiY29pbjpkZXgudG91Y2FuXFxcIi4gQ3Jvc3NjaGFpbiB0cmFuc2ZlcnMgYXJlIGRpc2FibGVkLlxcblxcbjs7KGVuZm9yY2UtcGFjdC12ZXJzaW9uIFxcXCI0LjNcXFwiKVxcblxcbihuYW1lc3BhY2UgKHJlYWQtbXNnICducykpXFxuXFxuKG1vZHVsZSB0b3VjYW4tdG9rZW5zIEdPVkVSTkFOQ0VcXG5cXG4gIEBtb2RlbFxcbiAgICBbXFxuICAgICA7OyBwcm9wLXN1cHBseS13cml0ZS1pc3N1ZXItZ3VhcmRcXG4gICAgIChwcm9wZXJ0eVxcbiAgICAgIChmb3JhbGwgKHRva2VuOnN0cmluZylcXG4gICAgICAgKHdoZW4gKHJvdy13cml0dGVuIHN1cHBsaWVzIHRva2VuKVxcbiAgICAgICAgKHJvdy1lbmZvcmNlZCBpc3N1ZXJzICdndWFyZCBJU1NVRVJfS0VZKSkpXFxuICAgICAgeyAnZXhjZXB0OlxcbiAgICAgICAgWyB0cmFuc2Zlci1jcm9zc2NoYWluIDs7IFZBQ1VPVVNcXG4gICAgICAgICAgZGViaXQgICAgICAgICAgICAgICA7OyBQUklWQVRFXFxuICAgICAgICAgIGNyZWRpdCAgICAgICAgICAgICAgOzsgUFJJVkFURVxcbiAgICAgICAgICB1cGRhdGUtc3VwcGx5ICAgICAgIDs7IFBSSVZBVEVcXG4gICAgICAgIF0gfSApXFxuXFxuICAgICA7OyBwcm9wLWxlZGdlci13cml0ZS1ndWFyZFxcbiAgICAgKHByb3BlcnR5XFxuICAgICAgKGZvcmFsbCAoa2V5OnN0cmluZylcXG4gICAgICAgKHdoZW4gKHJvdy13cml0dGVuIGxlZGdlciBrZXkpXFxuICAgICAgICAob3JcXG4gICAgICAgICAocm93LWVuZm9yY2VkIGlzc3VlcnMgJ2d1YXJkIElTU1VFUl9LRVkpICAgIDs7IGlzc3VlciB3cml0ZVxcbiAgICAgICAgIChyb3ctZW5mb3JjZWQgbGVkZ2VyICdndWFyZCBrZXkpKSkpICA7OyBvd25lciB3cml0ZVxcbiAgICAgIHsgJ2V4Y2VwdDpcXG4gICAgICAgIFsgdHJhbnNmZXItY3Jvc3NjaGFpbiA7OyBWQUNVT1VTXFxuICAgICAgICAgIGRlYml0ICAgICAgICAgICAgICAgOzsgUFJJVkFURVxcbiAgICAgICAgICBjcmVkaXQgICAgICAgICAgICAgIDs7IFBSSVZBVEVcXG4gICAgICAgICAgY3JlYXRlLWFjY291bnQgICAgICA7OyBwcm9wLWxlZGdlci1jb25zZXJ2ZXMtbWFzcywgcHJvcC1zdXBwbHktY29uc2VydmVzLW1hc3NcXG4gICAgICAgICAgdHJhbnNmZXIgICAgICAgICAgICA7OyBwcm9wLWxlZGdlci1jb25zZXJ2ZXMtbWFzcywgcHJvcC1zdXBwbHktY29uc2VydmVzLW1hc3NcXG4gICAgICAgICAgdHJhbnNmZXItY3JlYXRlICAgICA7OyBwcm9wLWxlZGdlci1jb25zZXJ2ZXMtbWFzcywgcHJvcC1zdXBwbHktY29uc2VydmVzLW1hc3NcXG4gICAgICAgIF0gfSApXFxuXFxuXFxuICAgICA7OyBwcm9wLWxlZGdlci1jb25zZXJ2ZXMtbWFzc1xcbiAgICAgKHByb3BlcnR5XFxuICAgICAgKD0gKGNvbHVtbi1kZWx0YSBsZWRnZXIgJ2JhbGFuY2UpIDAuMClcXG4gICAgICB7ICdleGNlcHQ6XFxuICAgICAgICAgWyB0cmFuc2Zlci1jcm9zc2NoYWluIDs7IFZBQ1VPVVNcXG4gICAgICAgICAgIGRlYml0ICAgICAgICAgICAgICAgOzsgUFJJVkFURVxcbiAgICAgICAgICAgY3JlZGl0ICAgICAgICAgICAgICA7OyBQUklWQVRFXFxuICAgICAgICAgICBidXJuICAgICAgICAgICAgICAgIDs7IHByb3AtbGVkZ2VyLXdyaXRlLWd1YXJkXFxuICAgICAgICAgICBtaW50ICAgICAgICAgICAgICAgIDs7IHByb3AtbGVkZ2VyLXdyaXRlLWd1YXJkXFxuICAgICAgICAgXSB9IClcXG5cXG4gICAgICA7OyBwcm9wLXN1cHBseS1jb25zZXJ2ZXMtbWFzc1xcbiAgICAgIChwcm9wZXJ0eVxcbiAgICAgICAoPSAoY29sdW1uLWRlbHRhIHN1cHBsaWVzICdzdXBwbHkpIDAuMClcXG4gICAgICAgeyAnZXhjZXB0OlxcbiAgICAgICAgWyB0cmFuc2Zlci1jcm9zc2NoYWluIDs7IFZBQ1VPVVNcXG4gICAgICAgICAgZGViaXQgICAgICAgICAgICAgICA7OyBQUklWQVRFXFxuICAgICAgICAgIGNyZWRpdCAgICAgICAgICAgICAgOzsgUFJJVkFURVxcbiAgICAgICAgICB1cGRhdGUtc3VwcGx5ICAgICAgIDs7IFBSSVZBVEVcXG4gICAgICAgICAgYnVybiAgICAgICAgICAgICAgICA7OyBwcm9wLWxlZGdlci13cml0ZS1ndWFyZFxcbiAgICAgICAgICBtaW50ICAgICAgICAgICAgICAgIDs7IHByb3AtbGVkZ2VyLXdyaXRlLWd1YXJkXFxuICAgICAgIF0gfSApXFxuICAgIF1cXG5cXG4gIChkZWZzY2hlbWEgZW50cnlcXG4gICAgICBcXFwiVG9rZW4gYmFsYW5jZSBsZWRnZXIuXFxcIlxcbiAgICB0b2tlbjpzdHJpbmdcXG4gICAgYWNjb3VudDpzdHJpbmdcXG4gICAgYmFsYW5jZTpkZWNpbWFsXFxuICAgIGd1YXJkOmd1YXJkKVxcbiAgKGRlZnRhYmxlIGxlZGdlcjp7ZW50cnl9KVxcblxcbiAgKHVzZSB0b3VjYW4tZnVuZ2libGUtdXRpbClcXG5cXG4gIChkZWZzY2hlbWEgaXNzdWVyXFxuICAgICAgXFxcIkd1YXJkIHByb3RlY3RpbmcgcHJpdmlsZWdlZCBvcGVyYXRpb25zLlxcXCJcXG4gICAgZ3VhcmQ6Z3VhcmQpXFxuICAoZGVmdGFibGUgaXNzdWVyczp7aXNzdWVyfSlcXG5cXG4gIChkZWZzY2hlbWEgc3VwcGx5XFxuICAgICAgXFxcIlNjaGVtYSBmb3IgdGFibGUgb2YgdG90YWwgc3VwcGxpZXMuXFxcIlxcbiAgICBzdXBwbHk6ZGVjaW1hbClcXG4gIChkZWZ0YWJsZSBzdXBwbGllczp7c3VwcGx5fSlcXG5cXG4gIChkZWZjb25zdCBJU1NVRVJfS0VZIFxcXCJJXFxcIilcXG5cXG4gIChkZWZjYXAgR09WRVJOQU5DRSAoKVxcbiAgICAoZW5mb3JjZS1ndWFyZCAoa2V5c2V0LXJlZi1ndWFyZCAnZGV4LWV4Y2hhbmdlLWFkbWluKSkpXFxuXFxuICAoZGVmY2FwIERFQklUICh0b2tlbjpzdHJpbmcgc2VuZGVyOnN0cmluZylcXG4gICAgKGVuZm9yY2UtZ3VhcmRcXG4gICAgICAoYXQgJ2d1YXJkXFxuICAgICAgICAocmVhZCBsZWRnZXIgKGtleSB0b2tlbiBzZW5kZXIpKSkpKVxcblxcbiAgKGRlZmNhcCBDUkVESVQgKHRva2VuOnN0cmluZyByZWNlaXZlcjpzdHJpbmcpIHRydWUpXFxuXFxuICAoZGVmY2FwIFVQREFURV9TVVBQTFkgKClcXG4gICAgXFxcInByaXZhdGUgY2FwIGZvciB1cGRhdGUtc3VwcGx5XFxcIlxcbiAgICB0cnVlKVxcblxcbiAgKGRlZmNhcCBJU1NVRSAoKVxcbiAgICAoZW5mb3JjZS1ndWFyZCAoYXQgJ2d1YXJkIChyZWFkIGlzc3VlcnMgSVNTVUVSX0tFWSkpKVxcbiAgKVxcblxcbiAgKGRlZmNhcCBNSU5UICh0b2tlbjpzdHJpbmcgYWNjb3VudDpzdHJpbmcgYW1vdW50OmRlY2ltYWwpXFxuICAgIEBtYW5hZ2VkIDs7IG9uZS1zaG90IGZvciBhIGdpdmVuIGFtb3VudFxcbiAgICAoY29tcG9zZS1jYXBhYmlsaXR5IChJU1NVRSkpXFxuICApXFxuXFxuICAoZGVmY2FwIEJVUk4gKHRva2VuOnN0cmluZyBhY2NvdW50OnN0cmluZyBhbW91bnQ6ZGVjaW1hbClcXG4gICAgQG1hbmFnZWQgOzsgb25lLXNob3QgZm9yIGEgZ2l2ZW4gYW1vdW50XFxuICAgIChjb21wb3NlLWNhcGFiaWxpdHkgKElTU1VFKSlcXG4gIClcXG5cXG4gIChkZWZ1biBpbml0LWlzc3VlciAoZ3VhcmQ6Z3VhcmQpXFxuICAgICh3aXRoLWNhcGFiaWxpdHkgKEdPVkVSTkFOQ0UpXFxuICAgICAgKGluc2VydCBpc3N1ZXJzIElTU1VFUl9LRVkgeydndWFyZDogZ3VhcmR9KSlcXG4gIClcXG5cXG4gIChkZWZ1biBvdmVycmlkZS1pc3N1ZXIgKGd1YXJkOmd1YXJkKVxcbiAgICAod2l0aC1jYXBhYmlsaXR5IChHT1ZFUk5BTkNFKVxcbiAgICAgICh1cGRhdGUgaXNzdWVycyBJU1NVRVJfS0VZIHsnZ3VhcmQ6IGd1YXJkfSkpXFxuICApXFxuXFxuICAoZGVmdW4ga2V5ICggdG9rZW46c3RyaW5nIGFjY291bnQ6c3RyaW5nIClcXG4gICAgKGZvcm1hdCBcXFwie306e31cXFwiIFt0b2tlbiBhY2NvdW50XSlcXG4gIClcXG5cXG4gIChkZWZ1biB0b3RhbC1zdXBwbHk6ZGVjaW1hbCAodG9rZW46c3RyaW5nKVxcbiAgICAod2l0aC1kZWZhdWx0LXJlYWQgc3VwcGxpZXMgdG9rZW5cXG4gICAgICB7ICdzdXBwbHkgOiAwLjAgfVxcbiAgICAgIHsgJ3N1cHBseSA6PSBzIH1cXG4gICAgICBzXFxuICAgIClcXG4gIClcXG5cXG4gIChkZWZjYXAgVFJBTlNGRVI6Ym9vbFxcbiAgICAoIHRva2VuOnN0cmluZ1xcbiAgICAgIHNlbmRlcjpzdHJpbmdcXG4gICAgICByZWNlaXZlcjpzdHJpbmdcXG4gICAgICBhbW91bnQ6ZGVjaW1hbFxcbiAgICApXFxuICAgIEBtYW5hZ2VkIGFtb3VudCBUUkFOU0ZFUi1tZ3JcXG4gICAgKGVuZm9yY2UtdW5pdCB0b2tlbiBhbW91bnQpXFxuICAgIChlbmZvcmNlICg-IGFtb3VudCAwLjApIFxcXCJQb3NpdGl2ZSBhbW91bnRcXFwiKVxcbiAgICAoY29tcG9zZS1jYXBhYmlsaXR5IChERUJJVCB0b2tlbiBzZW5kZXIpKVxcbiAgICAoY29tcG9zZS1jYXBhYmlsaXR5IChDUkVESVQgdG9rZW4gcmVjZWl2ZXIpKVxcbiAgKVxcblxcbiAgKGRlZnVuIFRSQU5TRkVSLW1ncjpkZWNpbWFsXFxuICAgICggbWFuYWdlZDpkZWNpbWFsXFxuICAgICAgcmVxdWVzdGVkOmRlY2ltYWxcXG4gICAgKVxcblxcbiAgICAobGV0ICgobmV3YmFsICgtIG1hbmFnZWQgcmVxdWVzdGVkKSkpXFxuICAgICAgKGVuZm9yY2UgKD49IG5ld2JhbCAwLjApXFxuICAgICAgICAoZm9ybWF0IFxcXCJUUkFOU0ZFUiBleGNlZWRlZCBmb3IgYmFsYW5jZSB7fVxcXCIgW21hbmFnZWRdKSlcXG4gICAgICBuZXdiYWwpXFxuICApXFxuXFxuICAoZGVmY29uc3QgTUlOSU1VTV9QUkVDSVNJT04gMTIpXFxuXFxuICAoZGVmdW4gZW5mb3JjZS11bml0OmJvb2wgKHRva2VuOnN0cmluZyBhbW91bnQ6ZGVjaW1hbClcXG4gICAgKGVuZm9yY2VcXG4gICAgICAoPSAoZmxvb3IgYW1vdW50IChwcmVjaXNpb24gdG9rZW4pKVxcbiAgICAgICAgIGFtb3VudClcXG4gICAgICBcXFwicHJlY2lzaW9uIHZpb2xhdGlvblxcXCIpXFxuICApXFxuXFxuICAoZGVmdW4gdHJ1bmNhdGU6ZGVjaW1hbCAodG9rZW46c3RyaW5nIGFtb3VudDpkZWNpbWFsKVxcbiAgICAoZmxvb3IgYW1vdW50IChwcmVjaXNpb24gdG9rZW4pKVxcbiAgKVxcblxcblxcbiAgKGRlZnVuIGNyZWF0ZS1hY2NvdW50OnN0cmluZ1xcbiAgICAoIHRva2VuOnN0cmluZ1xcbiAgICAgIGFjY291bnQ6c3RyaW5nXFxuICAgICAgZ3VhcmQ6Z3VhcmRcXG4gICAgKVxcbiAgICAoZW5mb3JjZS12YWxpZC1hY2NvdW50IGFjY291bnQpXFxuICAgIChlbmZvcmNlLXJlc2VydmVkIGFjY291bnQgZ3VhcmQpXFxuICAgIChpbnNlcnQgbGVkZ2VyIChrZXkgdG9rZW4gYWNjb3VudClcXG4gICAgICB7IFxcXCJiYWxhbmNlXFxcIiA6IDAuMFxcbiAgICAgICwgXFxcImd1YXJkXFxcIiAgIDogZ3VhcmRcXG4gICAgICAsIFxcXCJ0b2tlblxcXCIgOiB0b2tlblxcbiAgICAgICwgXFxcImFjY291bnRcXFwiIDogYWNjb3VudFxcbiAgICAgIH0pXFxuICAgIClcXG5cXG4gIChkZWZ1biBnZXQtYmFsYW5jZTpkZWNpbWFsICh0b2tlbjpzdHJpbmcgYWNjb3VudDpzdHJpbmcpXFxuICAgIChhdCAnYmFsYW5jZSAocmVhZCBsZWRnZXIgKGtleSB0b2tlbiBhY2NvdW50KSkpXFxuICApXFxuXFxuICAoZGVmdW4gZGV0YWlsc1xcbiAgICAoIHRva2VuOnN0cmluZyBhY2NvdW50OnN0cmluZyApXFxuICAgIChyZWFkIGxlZGdlciAoa2V5IHRva2VuIGFjY291bnQpKVxcbiAgKVxcblxcbiAgKGRlZnVuIHJvdGF0ZTpzdHJpbmcgKHRva2VuOnN0cmluZyBhY2NvdW50OnN0cmluZyBuZXctZ3VhcmQ6Z3VhcmQpXFxuICAgICh3aXRoLXJlYWQgbGVkZ2VyIChrZXkgdG9rZW4gYWNjb3VudClcXG4gICAgICB7IFxcXCJndWFyZFxcXCIgOj0gb2xkLWd1YXJkIH1cXG5cXG4gICAgICAoZW5mb3JjZS1ndWFyZCBvbGQtZ3VhcmQpXFxuXFxuICAgICAgKHVwZGF0ZSBsZWRnZXIgKGtleSB0b2tlbiBhY2NvdW50KVxcbiAgICAgICAgeyBcXFwiZ3VhcmRcXFwiIDogbmV3LWd1YXJkIH0pKVxcbiAgKVxcblxcblxcbiAgKGRlZnVuIHByZWNpc2lvbjppbnRlZ2VyICh0b2tlbjpzdHJpbmcpXFxuICAgIE1JTklNVU1fUFJFQ0lTSU9OKVxcblxcbiAgKGRlZnVuIHRyYW5zZmVyOnN0cmluZ1xcbiAgICAoIHRva2VuOnN0cmluZ1xcbiAgICAgIHNlbmRlcjpzdHJpbmdcXG4gICAgICByZWNlaXZlcjpzdHJpbmdcXG4gICAgICBhbW91bnQ6ZGVjaW1hbFxcbiAgICApXFxuXFxuICAgIChlbmZvcmNlICghPSBzZW5kZXIgcmVjZWl2ZXIpXFxuICAgICAgXFxcInNlbmRlciBjYW5ub3QgYmUgdGhlIHJlY2VpdmVyIG9mIGEgdHJhbnNmZXJcXFwiKVxcbiAgICAoZW5mb3JjZS12YWxpZC10cmFuc2ZlciBzZW5kZXIgcmVjZWl2ZXIgKHByZWNpc2lvbiB0b2tlbikgYW1vdW50KVxcblxcblxcbiAgICAod2l0aC1jYXBhYmlsaXR5IChUUkFOU0ZFUiB0b2tlbiBzZW5kZXIgcmVjZWl2ZXIgYW1vdW50KVxcbiAgICAgIChkZWJpdCB0b2tlbiBzZW5kZXIgYW1vdW50KVxcbiAgICAgICh3aXRoLXJlYWQgbGVkZ2VyIChrZXkgdG9rZW4gcmVjZWl2ZXIpXFxuICAgICAgICB7IFxcXCJndWFyZFxcXCIgOj0gZyB9XFxuICAgICAgICAoY3JlZGl0IHRva2VuIHJlY2VpdmVyIGcgYW1vdW50KSlcXG4gICAgICApXFxuICAgIClcXG5cXG4gIChkZWZ1biB0cmFuc2Zlci1jcmVhdGU6c3RyaW5nXFxuICAgICggdG9rZW46c3RyaW5nXFxuICAgICAgc2VuZGVyOnN0cmluZ1xcbiAgICAgIHJlY2VpdmVyOnN0cmluZ1xcbiAgICAgIHJlY2VpdmVyLWd1YXJkOmd1YXJkXFxuICAgICAgYW1vdW50OmRlY2ltYWxcXG4gICAgKVxcblxcbiAgICAoZW5mb3JjZSAoIT0gc2VuZGVyIHJlY2VpdmVyKVxcbiAgICAgIFxcXCJzZW5kZXIgY2Fubm90IGJlIHRoZSByZWNlaXZlciBvZiBhIHRyYW5zZmVyXFxcIilcXG4gICAgKGVuZm9yY2UtdmFsaWQtdHJhbnNmZXIgc2VuZGVyIHJlY2VpdmVyIChwcmVjaXNpb24gdG9rZW4pIGFtb3VudClcXG5cXG4gICAgKHdpdGgtY2FwYWJpbGl0eSAoVFJBTlNGRVIgdG9rZW4gc2VuZGVyIHJlY2VpdmVyIGFtb3VudClcXG4gICAgICAoZGViaXQgdG9rZW4gc2VuZGVyIGFtb3VudClcXG4gICAgICAoY3JlZGl0IHRva2VuIHJlY2VpdmVyIHJlY2VpdmVyLWd1YXJkIGFtb3VudCkpXFxuICApXFxuXFxuICAoZGVmdW4gbWludDpzdHJpbmdcXG4gICAgKCB0b2tlbjpzdHJpbmdcXG4gICAgICBhY2NvdW50OnN0cmluZ1xcbiAgICAgIGd1YXJkOmd1YXJkXFxuICAgICAgYW1vdW50OmRlY2ltYWxcXG4gICAgKVxcbiAgICAod2l0aC1jYXBhYmlsaXR5IChNSU5UIHRva2VuIGFjY291bnQgYW1vdW50KVxcbiAgICAgICh3aXRoLWNhcGFiaWxpdHkgKENSRURJVCB0b2tlbiBhY2NvdW50KVxcbiAgICAgICAgKGNyZWRpdCB0b2tlbiBhY2NvdW50IGd1YXJkIGFtb3VudCkpKVxcbiAgKVxcblxcbiAgKGRlZnVuIGJ1cm46c3RyaW5nXFxuICAgICggdG9rZW46c3RyaW5nXFxuICAgICAgYWNjb3VudDpzdHJpbmdcXG4gICAgICBhbW91bnQ6ZGVjaW1hbFxcbiAgICApXFxuICAgICh3aXRoLWNhcGFiaWxpdHkgKEJVUk4gdG9rZW4gYWNjb3VudCBhbW91bnQpXFxuICAgICAgKHdpdGgtY2FwYWJpbGl0eSAoREVCSVQgdG9rZW4gYWNjb3VudClcXG4gICAgICAgIChkZWJpdCB0b2tlbiBhY2NvdW50IGFtb3VudCkpKVxcbiAgKVxcblxcbiAgKGRlZnVuIGRlYml0OnN0cmluZ1xcbiAgICAoIHRva2VuOnN0cmluZ1xcbiAgICAgIGFjY291bnQ6c3RyaW5nXFxuICAgICAgYW1vdW50OmRlY2ltYWxcXG4gICAgKVxcblxcbiAgICAocmVxdWlyZS1jYXBhYmlsaXR5IChERUJJVCB0b2tlbiBhY2NvdW50KSlcXG5cXG4gICAgKGVuZm9yY2UtdW5pdCB0b2tlbiBhbW91bnQpXFxuXFxuICAgICh3aXRoLXJlYWQgbGVkZ2VyIChrZXkgdG9rZW4gYWNjb3VudClcXG4gICAgICB7IFxcXCJiYWxhbmNlXFxcIiA6PSBiYWxhbmNlIH1cXG5cXG4gICAgICAoZW5mb3JjZSAoPD0gYW1vdW50IGJhbGFuY2UpIFxcXCJJbnN1ZmZpY2llbnQgZnVuZHNcXFwiKVxcblxcbiAgICAgICh1cGRhdGUgbGVkZ2VyIChrZXkgdG9rZW4gYWNjb3VudClcXG4gICAgICAgIHsgXFxcImJhbGFuY2VcXFwiIDogKC0gYmFsYW5jZSBhbW91bnQpIH1cXG4gICAgICAgICkpXFxuICAgICh3aXRoLWNhcGFiaWxpdHkgKFVQREFURV9TVVBQTFkpXFxuICAgICAgKHVwZGF0ZS1zdXBwbHkgdG9rZW4gKC0gYW1vdW50KSkpXFxuICApXFxuXFxuXFxuICAoZGVmdW4gY3JlZGl0OnN0cmluZ1xcbiAgICAoIHRva2VuOnN0cmluZ1xcbiAgICAgIGFjY291bnQ6c3RyaW5nXFxuICAgICAgZ3VhcmQ6Z3VhcmRcXG4gICAgICBhbW91bnQ6ZGVjaW1hbFxcbiAgICApXFxuXFxuICAgIChyZXF1aXJlLWNhcGFiaWxpdHkgKENSRURJVCB0b2tlbiBhY2NvdW50KSlcXG5cXG4gICAgKGVuZm9yY2UtdW5pdCB0b2tlbiBhbW91bnQpXFxuXFxuICAgICh3aXRoLWRlZmF1bHQtcmVhZCBsZWRnZXIgKGtleSB0b2tlbiBhY2NvdW50KVxcbiAgICAgIHsgXFxcImJhbGFuY2VcXFwiIDogLTEuMCwgXFxcImd1YXJkXFxcIiA6IGd1YXJkIH1cXG4gICAgICB7IFxcXCJiYWxhbmNlXFxcIiA6PSBiYWxhbmNlLCBcXFwiZ3VhcmRcXFwiIDo9IHJldGcgfVxcbiAgICAgIChlbmZvcmNlICg9IHJldGcgZ3VhcmQpXFxuICAgICAgICBcXFwiYWNjb3VudCBndWFyZHMgZG8gbm90IG1hdGNoXFxcIilcXG5cXG4gICAgICAobGV0ICgoaXMtbmV3XFxuICAgICAgICAgICAgIChpZiAoPSBiYWxhbmNlIC0xLjApXFxuICAgICAgICAgICAgICAgICAoZW5mb3JjZS1yZXNlcnZlZCBhY2NvdW50IGd1YXJkKVxcbiAgICAgICAgICAgICAgICAgZmFsc2UpKSlcXG4gICAgICAgICh3cml0ZSBsZWRnZXIgKGtleSB0b2tlbiBhY2NvdW50KVxcbiAgICAgICAgICB7IFxcXCJiYWxhbmNlXFxcIiA6IChpZiBpcy1uZXcgYW1vdW50ICgrIGJhbGFuY2UgYW1vdW50KSlcXG4gICAgICAgICAgLCBcXFwiZ3VhcmRcXFwiICAgOiByZXRnXFxuICAgICAgICAgICwgXFxcInRva2VuXFxcIiAgIDogdG9rZW5cXG4gICAgICAgICAgLCBcXFwiYWNjb3VudFxcXCIgOiBhY2NvdW50XFxuICAgICAgICAgIH0pKVxcblxcbiAgICAgICh3aXRoLWNhcGFiaWxpdHkgKFVQREFURV9TVVBQTFkpXFxuICAgICAgICAodXBkYXRlLXN1cHBseSB0b2tlbiBhbW91bnQpKVxcbiAgICAgICkpXFxuXFxuICAoZGVmdW4gdXBkYXRlLXN1cHBseSAodG9rZW46c3RyaW5nIGFtb3VudDpkZWNpbWFsKVxcbiAgICAocmVxdWlyZS1jYXBhYmlsaXR5IChVUERBVEVfU1VQUExZKSlcXG4gICAgKHdpdGgtZGVmYXVsdC1yZWFkIHN1cHBsaWVzIHRva2VuXFxuICAgICAgeyAnc3VwcGx5OiAwLjAgfVxcbiAgICAgIHsgJ3N1cHBseSA6PSBzIH1cXG4gICAgICAod3JpdGUgc3VwcGxpZXMgdG9rZW4geydzdXBwbHk6ICgrIHMgYW1vdW50KX0pKVxcbiAgKVxcblxcbiAgKGRlZnBhY3QgdHJhbnNmZXItY3Jvc3NjaGFpbjpzdHJpbmdcXG4gICAgKCB0b2tlbjpzdHJpbmdcXG4gICAgICBzZW5kZXI6c3RyaW5nXFxuICAgICAgcmVjZWl2ZXI6c3RyaW5nXFxuICAgICAgcmVjZWl2ZXItZ3VhcmQ6Z3VhcmRcXG4gICAgICB0YXJnZXQtY2hhaW46c3RyaW5nXFxuICAgICAgYW1vdW50OmRlY2ltYWwgKVxcbiAgICAoc3RlcCAoZm9ybWF0IFxcXCJ7fVxcXCIgWyhlbmZvcmNlIGZhbHNlIFxcXCJjcm9zcyBjaGFpbiBub3Qgc3VwcG9ydGVkXFxcIildKSlcXG4gICAgKVxcblxcbiAgKGRlZnVuIGdldC10b2tlbnMgKClcXG4gICAgXFxcIkdldCBhbGwgdG9rZW4gaWRlbnRpZmllcnMuXFxcIlxcbiAgICAoa2V5cyBzdXBwbGllcykpXFxuXFxuKVxcblxcbihpZiAoPSAocmVhZC1pbnRlZ2VyICd1cGdyYWRlKSAwKVxcbiAgICBbIDs7IGRlcGxveWluZyBmcm9tIHNjcmF0Y2g6IGNyZWF0ZSBhbGwgdGFibGVzXFxuICAgICAgKGNyZWF0ZS10YWJsZSBsZWRnZXIpXFxuICAgICAgKGNyZWF0ZS10YWJsZSBpc3N1ZXJzKVxcbiAgICAgIChjcmVhdGUtdGFibGUgc3VwcGxpZXMpXFxuICAgIF1cXG4gICAgKGlmICg9IChyZWFkLWludGVnZXIgJ3VwZ3JhZGUpIDEpXFxuICAgICAgICBbIDs7IHVwZ3JhZGUgZnJvbSB2MSAoZGV2bmV0IGRlcGxveSkgdG8gdjIgLS0gbm8gc2NoZW1hIGNoYW5nZXNcXG4gICAgICAgICAgXFxcInVwZ3JhZGUgY29tcGxldGVcXFwiXFxuICAgICAgICBdXFxuICAgICAgICBbKGVuZm9yY2UgZmFsc2UgKGZvcm1hdCBcXFwiSW52YWxpZCB1cGdyYWRlIGZpZWxkOiB7fVxcXCIgWyhyZWFkLW1zZyAndXBncmFkZSldKSldKSlcXG5cIn19LFwic2lnbmVyc1wiOlt7XCJwdWJLZXlcIjpcIjIzN2I2Mjg2NDNlNGU3ZjBjMTA2Y2U0YWQ2ZTY0YmIyYTE2NWIxYWJhODFhNjRhMDJiMTVjMjc0ZTk0ODgxNjNcIixcInNjaGVtZVwiOlwiRUQyNTUxOVwiLFwiY2xpc3RcIjpbe1wibmFtZVwiOlwiY29pbi5HQVNcIixcImFyZ3NcIjpbXX1dfV0sXCJtZXRhXCI6e1wiY2hhaW5JZFwiOlwiMVwiLFwiY3JlYXRpb25UaW1lXCI6MTc2Mjk4MTY5NixcImdhc0xpbWl0XCI6NDAwMDAsXCJnYXNQcmljZVwiOjFlLTgsXCJzZW5kZXJcIjpcIms6MjM3YjYyODY0M2U0ZTdmMGMxMDZjZTRhZDZlNjRiYjJhMTY1YjFhYmE4MWE2NGEwMmIxNWMyNzRlOTQ4ODE2M1wiLFwidHRsXCI6Mjg4MDB9LFwibm9uY2VcIjpcIjE3NjI5ODE2OTYtdG91Y2FuLXRva2Vuc1wifSJ9","eyJnYXMiOjEyMjQyLCJyZXN1bHQiOnsic3RhdHVzIjoic3VjY2VzcyIsImRhdGEiOlsiVGFibGVDcmVhdGVkIiwiVGFibGVDcmVhdGVkIiwiVGFibGVDcmVhdGVkIl19LCJyZXFLZXkiOiJsdlBtZTUzSTFyZlB2cnBFS2k1cDM1YUV1Tm5qQUlfNjNJRUVmWXFRVUk4IiwibG9ncyI6IkxfbnNKX0JsRGZOd3dWcFJ1UHJRYlBHamJCSUJMcnR2Z1E1b2V3OVlTclUiLCJldmVudHMiOlt7InBhcmFtcyI6WyJrOjIzN2I2Mjg2NDNlNGU3ZjBjMTA2Y2U0YWQ2ZTY0YmIyYTE2NWIxYWJhODFhNjRhMDJiMTVjMjc0ZTk0ODgxNjMiLCJrOjI1MWVmYjA2ZjNiNzk4ZGJlN2JiM2Y1OGY1MzViNjdiMGE5ZWQyZGE5YWE0ZTIzNjdiZTRhYmMwN2NjOTI3ZmEiLDEuMjI0MmUtNF0sIm5hbWUiOiJUUkFOU0ZFUiIsIm1vZHVsZSI6eyJuYW1lc3BhY2UiOm51bGwsIm5hbWUiOiJjb2luIn0sIm1vZHVsZUhhc2giOiJrbEZrckxmcHlMVy1NM3hqVlBTZHFYRU1neFBQSmliUnRfRDZxaUJ3czZzIn1dLCJtZXRhRGF0YSI6bnVsbCwiY29udGludWF0aW9uIjpudWxsLCJ0eElkIjoxODk5MjQ4Mn0"]],"minerData":"eyJhY2NvdW50IjoiazoyNTFlZmIwNmYzYjc5OGRiZTdiYjNmNThmNTM1YjY3YjBhOWVkMmRhOWFhNGUyMzY3YmU0YWJjMDdjYzkyN2ZhIiwicHJlZGljYXRlIjoia2V5cy1hbGwiLCJwdWJsaWMta2V5cyI6WyIyNTFlZmIwNmYzYjc5OGRiZTdiYjNmNThmNTM1YjY3YjBhOWVkMmRhOWFhNGUyMzY3YmU0YWJjMDdjYzkyN2ZhIl19","transactionsHash":"8mcyX-1UHHVMdsDZPQfB_IIJhIstCvzzO3L2zO5eWWI","outputsHash":"F6k1v1FHFPjtQKuTAm1NcfWnNEsY2F5DQjy2BqG0oik","payloadHash":"k1F57mbxkashDzuTKR5w_UphnhaZ82i2CU4RuiwwDeU","coinbase":"eyJnYXMiOjAsInJlc3VsdCI6eyJzdGF0dXMiOiJzdWNjZXNzIiwiZGF0YSI6IldyaXRlIHN1Y2NlZWRlZCJ9LCJyZXFLZXkiOiJjR2xPVjJkak5WUkJkVjgxT1hGeGVYbzRTVFJ0Vm01V2VISnZVbnA2Y0dkdlVucE9jakptTUROSVl3IiwibG9ncyI6Ilh6RzBjVlAwbVlMQlhITVlBMUx6NVUzckFLMWlrQVdrNmViekQ5OGZuRzAiLCJldmVudHMiOlt7InBhcmFtcyI6WyIiLCJrOjI1MWVmYjA2ZjNiNzk4ZGJlN2JiM2Y1OGY1MzViNjdiMGE5ZWQyZGE5YWE0ZTIzNjdiZTRhYmMwN2NjOTI3ZmEiLDAuOTM1OTI3NV0sIm5hbWUiOiJUUkFOU0ZFUiIsIm1vZHVsZSI6eyJuYW1lc3BhY2UiOm51bGwsIm5hbWUiOiJjb2luIn0sIm1vZHVsZUhhc2giOiJrbEZrckxmcHlMVy1NM3hqVlBTZHFYRU1neFBQSmliUnRfRDZxaUJ3czZzIn1dLCJtZXRhRGF0YSI6bnVsbCwiY29udGludWF0aW9uIjpudWxsLCJ0eElkIjoxODk5MjQ4MH0"}};
  const block = decodeBlock(fixture.header, fixture.payload);
  const transaction = block.transactions.find(item => item.requestKey === 'lvPme53I1rfPvrpEKi5p35aEuNnjAI_63IEEfYqQUI8');
  assert.deepEqual(transaction.result.data, ['TableCreated', 'TableCreated', 'TableCreated']);
  assert.equal(transaction.modules.length, 1);
  const [declaration] = transaction.modules;
  assert.equal(declaration.qualifiedName, 'free.toucan-tokens');
  assert.equal(declaration.identitySource, 'command-data');
  assert.deepEqual(declaration.namespaceEvidence, {reader: 'read-msg', key: 'ns', value: 'free'});
});

test('literal-key message readers resolve string namespaces, never missing or coerced values', () => {
  for (const reader of ['read-msg', 'read-string']) {
    const code = `(namespace (${reader} 'ns)) (module x ADMIN) (create-table accounts)`;
    const resolve = data => parseModuleDeclarations({code, data, success: true, result: 'TableCreated'})[0];
    assert.equal(resolve({ns: 'free'}).qualifiedName, 'free.x');
    for (const data of [undefined, null, {}, {ns: ''}, {ns: 123}, {ns: false}, {ns: null}, {ns: []}, {ns: {value: 'free'}}, Object.create({ns: 'free'})]) {
      assert.equal(resolve(data).identityResolved, false);
      assert.equal(resolve(data).qualifiedName, null);
    }
  }
});

test('computed message keys and unknown namespace calls stay unresolved and later switches supersede earlier data', () => {
  for (const expression of ['(read-msg (+ "n" "s"))', "(at 'ns (read-msg))", '(some-state-dependent-name)']) {
    const [declaration] = parseModuleDeclarations({code: `(namespace ${expression}) (module x ADMIN) (create-table accounts)`, data: {ns: 'free'}, success: true, result: 'TableCreated'});
    assert.equal(declaration.qualifiedName, null);
  }
  const code = "(namespace (read-string 'ns)) (module first ADMIN) (namespace 'other) (module second ADMIN) (namespace (unknown)) (module third ADMIN) (create-table accounts)";
  const declarations = parseModuleDeclarations({code, data: {ns: 'free'}, success: true, result: 'TableCreated'});
  assert.deepEqual(declarations.map(item => item.qualifiedName), ['free.first', 'other.second', null]);
  assert.deepEqual(declarations.map(item => item.identitySource), ['command-data', 'source-literal', 'unresolved']);
});

test('arbitrary trailing Loaded-module text cannot manufacture a deployment identity', () => {
  const forged = 'Loaded module forged.x, hash abc';
  const [unknown] = parseModuleDeclarations({code: `(namespace (unknown)) (module x ADMIN) ${JSON.stringify(forged)}`, success: true, result: forged});
  assert.equal(unknown.qualifiedName, null);
  const [literal] = parseModuleDeclarations({code: `(namespace 'free) (module x ADMIN) ${JSON.stringify(forged)}`, success: true, result: forged});
  assert.equal(literal.qualifiedName, 'free.x');
  const [engine] = parseModuleDeclarations({code: '(namespace (unknown)) (module x ADMIN) ; trailing comment only', success: true, result: 'Loaded module verified.x, hash abc'});
  assert.equal(engine.qualifiedName, 'verified.x');
  assert.equal(engine.identitySource, 'execution-result');
  const sameNames = parseModuleDeclarations({code: "(namespace 'one) (module x ADMIN) (namespace 'two) (module x ADMIN)", success: true, result: 'Loaded module two.x, hash abc'});
  assert.deepEqual(sameNames.map(item => item.qualifiedName), ['one.x', 'two.x']);
});

test('unsupported nested module forms surface explicitly while comments and strings remain inert', () => {
  assert.throws(() => parseModuleDeclarations({code: '(let ((x 1)) (module hidden ADMIN))', success: true}), /nested module/);
  assert.throws(() => parseModuleDeclarations({code: '(begin (module hidden ADMIN))', success: true}), /nested module/);
  assert.deepEqual(parseModuleDeclarations({code: '(format "(module inert ADMIN)" []) ; (module comment ADMIN)', success: true}), []);
});
