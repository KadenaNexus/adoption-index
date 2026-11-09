import test from 'node:test';
import assert from 'node:assert/strict';
import {artifactStatus, evaluateArtifactPolicy, moduleArtifactPolicyReport, assertModuleArtifactPolicyCurrent, loadModulePolicy} from '../src/module-policy.mjs';
import {windowFor,addDays} from '../src/window.mjs';

const policy = {version:'current', includedModules:['1:free.test-released'], excludedModules:['1:free.bench-fixture'], reviewNamePatterns:['(^|[._-])(test|bench)([._-]|$)']};
const row = (name, artifact_status = 'included') => ({chain:1, name, height:'6471718', request_key:'retained-source-request', artifact_status, policy_version:'historical'});

test('newly recognized review names and source-resolved exclusions invalidate old included classifications', () => {
  const result = evaluateArtifactPolicy([row('free.test-unresolved'), row('free.bench-fixture')], policy);
  assert.equal(result.passed, false);
  assert.equal(result.mismatches, 2);
  assert.equal(result.awaitingReview, 1);
  assert.deepEqual(result.issues.map(issue => [issue.storedStatus, issue.expectedStatus]), [['included','review'], ['included','excluded']]);
});

test('explicit reviewed inclusion overrides a name pattern, but a stale review row must still be reconciled', () => {
  assert.equal(artifactStatus(1, 'free.test-released', policy), 'included');
  assert.equal(evaluateArtifactPolicy([row('free.test-released')], policy).passed, true);
  const stale = evaluateArtifactPolicy([row('free.test-released', 'review')], policy);
  assert.equal(stale.passed, false);
  assert.equal(stale.mismatches, 1);
  assert.equal(stale.awaitingReview, 1);
});

test('unchanged historical included and excluded decisions pass, while matching review decisions remain blocked', () => {
  const rows = [row('free.product'), row('free.test-released'), row('free.bench-fixture', 'excluded')];
  assert.equal(evaluateArtifactPolicy(rows, policy).passed, true);
  assert.ok(rows.every(item => item.policy_version !== policy.version));
  const reviewed = evaluateArtifactPolicy([row('free.test-unresolved', 'review')], policy);
  assert.equal(reviewed.passed, false);
  assert.equal(reviewed.mismatches, 0);
  assert.equal(reviewed.awaitingReview, 1);
});

test('guard scopes its SQL to new fixed-start deployments before the exclusive cutoff and reports current policy evidence', async () => {
  const cutoff = '2026-08-30T00:00:00Z';
  const db = {query: async (sql, values) => {
    assert.match(sql, /WHERE kind='new' AND block_time>=\$1 AND block_time<\$2/);
    assert.deepEqual(values, [windowFor(addDays(cutoff.slice(0,10),-1)).startTime, cutoff]);
    return {rows:[row('free.product')]};
  }};
  const expected = await loadModulePolicy();
  const result = await assertModuleArtifactPolicyCurrent(db, cutoff);
  assert.equal(result.passed, true);
  assert.equal(result.policyVersion, expected.policy.version);
  assert.equal(result.policySha256, expected.sha256);
  for (const invalid of ['2025-11-31T00:00:00Z', '2025-11-09T12:00:00Z']) {
    await assert.rejects(moduleArtifactPolicyReport(db, invalid), /Invalid module artifact policy cutoff/);
  }
});

test('a current review-pattern match blocks historical inclusion even with no stored review rows', async () => {
  const rows = [row('free.bench-verification-a1247acc'), row('free.bench-lottery-a1247acc')];
  await assert.rejects(assertModuleArtifactPolicyCurrent({query:async()=>({rows})}, '2026-09-25T00:00:00Z'), error => {
    assert.equal(error.code, 'MODULE_ARTIFACT_POLICY_REVIEW_REQUIRED');
    assert.equal(error.details.mismatches, 2);
    assert.equal(error.details.awaitingReview, 2);
    assert.ok(error.details.issues.every(issue => issue.expectedStatus === 'review'));
    return true;
  });
});

test('reviewed SPT throwaway copies exclude only verified chain identities and still require stored reconciliation', async () => {
  const {policy} = await loadModulePolicy();
  const namespace = 'n_8dd4aff253ea2f5d2032d20fe63d166959050009';
  const name = `${namespace}.SPT-TEST`;
  const launch = `${namespace}.SPT-launch-TEST`;
  for (const chain of [0,1,2]) assert.equal(artifactStatus(chain,name,policy),'excluded');
  assert.equal(artifactStatus(0,launch,policy),'excluded');
  // A similar name or a deployment on another chain has not received this review.
  assert.equal(artifactStatus(3,name,policy),'review');
  assert.equal(artifactStatus(1,launch,policy),'review');
  assert.equal(artifactStatus(0,'free.SPT-TEST',policy),'review');
  assert.equal(artifactStatus(0,`${namespace}.SPT`,policy),'included');
  assert.equal(artifactStatus(0,`${namespace}.SPT-launch`,policy),'included');
  const unresolved = evaluateArtifactPolicy([row(name,'review')],policy);
  assert.equal(unresolved.passed,false);
  assert.equal(unresolved.mismatches,1);
  assert.equal(evaluateArtifactPolicy([row(name,'excluded')],policy).passed,true);
});

test('reviewed decisions in the committed policy reconcile only matching review rows and record the review', async () => {
  const {applyReviewedModuleDecisions, loadModulePolicy: load} = await import('../src/module-policy.mjs');
  const {policy} = await load();
  const id = '2:n_f5d322747da08693718b6d25e48b087c58b40f8e.linx-test', decision = policy.decisions[id];
  assert.equal(decision.status, 'excluded');
  assert.ok(policy.excludedModules.includes(id));
  const reviewRows = [
    {chain:2, name:'n_f5d322747da08693718b6d25e48b087c58b40f8e.linx-test', height:decision.sourceHeight, request_key:decision.sourceRequestKey, day:'2026-11-04'},
    // Same name pattern but different request key: must stay under review.
    {chain:2, name:'n_f5d322747da08693718b6d25e48b087c58b40f8e.linx-test', height:'7374999', request_key:'other-request', day:'2026-11-05'},
    // No decision at all: must stay under review.
    {chain:3, name:'free.test-unreviewed', height:'7380000', request_key:'unreviewed', day:'2026-11-06'},
  ];
  const calls = [];
  const db = {query: async (sql, values) => {
    calls.push([sql, values]);
    if (/^SELECT/.test(sql.trim())) { assert.match(sql, /artifact_status='review'/); return {rows: reviewRows}; }
    if (/^UPDATE/.test(sql.trim())) { assert.match(sql, /AND artifact_status='review'/); return {rowCount: 1}; }
    if (/^INSERT INTO source_evidence/.test(sql.trim())) return {rowCount: 1};
    throw new Error('unexpected SQL ' + sql);
  }};
  const applied = await applyReviewedModuleDecisions(db, {now: new Date('2026-11-09T05:00:00Z')});
  assert.deepEqual(applied, [{id, status:'excluded'}]);
  const updates = calls.filter(([sql]) => /^UPDATE/.test(sql.trim()));
  assert.equal(updates.length, 1);
  assert.deepEqual(updates[0][1], ['excluded', policy.version, 2, decision.sourceRequestKey, 'n_f5d322747da08693718b6d25e48b087c58b40f8e.linx-test']);
  const evidence = calls.filter(([sql]) => /^INSERT INTO source_evidence/.test(sql.trim()));
  assert.equal(evidence.length, 1);
  assert.equal(evidence[0][1][0], '2026-11-04');
  assert.equal(evidence[0][1][2].previousStatus, 'review');
  // After reconciliation the policy check passes for the reconciled row.
  assert.equal(evaluateArtifactPolicy([{chain:2, name:'n_f5d322747da08693718b6d25e48b087c58b40f8e.linx-test', height:decision.sourceHeight, request_key:decision.sourceRequestKey, artifact_status:'excluded', policy_version:policy.version}], policy).passed, true);
});

test('applying reviewed decisions never touches rows that are not under review', async () => {
  const {applyReviewedModuleDecisions} = await import('../src/module-policy.mjs');
  const db = {query: async sql => {
    if (/^SELECT/.test(sql.trim())) return {rows: []};
    throw new Error('no writes expected');
  }};
  assert.deepEqual(await applyReviewedModuleDecisions(db), []);
});
