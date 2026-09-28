import {readFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {windowFor,addDays} from './window.mjs';

export function artifactStatus(chain, name, policy) {
  const id = `${chain}:${name}`;
  if (policy.includedModules.includes(id) && policy.excludedModules.includes(id)) throw new Error(`Conflicting artifact policy for ${id}`);
  if (policy.includedModules.includes(id)) return 'included';
  if (policy.excludedModules.includes(id)) return 'excluded';
  return policy.reviewNamePatterns.some(pattern => new RegExp(pattern, 'i').test(name)) ? 'review' : 'included';
}

/** Read on every check: a long-running indexer may have loaded an older policy. */
export async function loadModulePolicy() {
  const source = await readFile(new URL('../config/module-policy.json', import.meta.url), 'utf8');
  const policy = JSON.parse(source);
  if (typeof policy.version !== 'string' || !policy.version ||
      ['includedModules', 'excludedModules', 'reviewNamePatterns'].some(key =>
        !Array.isArray(policy[key]) || policy[key].some(value => typeof value !== 'string' || !value))) throw new Error('Invalid module artifact policy');
  for (const pattern of policy.reviewNamePatterns) new RegExp(pattern, 'i');
  for (const id of policy.includedModules) if (policy.excludedModules.includes(id)) throw new Error(`Conflicting artifact policy for ${id}`);
  return {policy, sha256: createHash('sha256').update(source).digest('hex')};
}

/** Compare decisions, not version stamps. This never reclassifies stored rows. */
export function evaluateArtifactPolicy(rows, policy) {
  let mismatches = 0, awaitingReview = 0;
  const issues = [];
  for (const row of rows) {
    if (!Number.isInteger(Number(row.chain)) || Number(row.chain) < 0 || Number(row.chain) > 19 ||
        typeof row.name !== 'string' || !row.name || !['included', 'excluded', 'review'].includes(row.artifact_status)) throw new Error('Module artifact classification could not be verified');
    const expected = artifactStatus(row.chain, row.name, policy);
    const mismatch = row.artifact_status !== expected;
    const review = row.artifact_status === 'review' || expected === 'review';
    if (mismatch) mismatches++;
    if (review) awaitingReview++;
    if ((mismatch || review) && issues.length < 50) issues.push({
      chain: Number(row.chain), name: row.name, height: row.height, requestKey: row.request_key,
      storedStatus: row.artifact_status, expectedStatus: expected, storedPolicyVersion: row.policy_version,
    });
  }
  return {passed: mismatches === 0 && awaitingReview === 0, policyVersion: policy.version,
    checked: rows.length, mismatches, awaitingReview, issues};
}

/** Only new deployments in the fixed collection period affect this metric. */
export async function moduleArtifactPolicyReport(db, cutoff) {
  if (typeof cutoff !== 'string' || !/^\d{4}-\d{2}-\d{2}T00:00:00(?:\.000)?Z$/.test(cutoff) ||
      !Number.isFinite(Date.parse(cutoff)) || new Date(cutoff).toISOString().slice(0, 10) !== cutoff.slice(0, 10)) throw new Error('Invalid module artifact policy cutoff');
  const {fromDay}=windowFor(addDays(cutoff.slice(0,10),-1));
  const {policy, sha256} = await loadModulePolicy();
  const {rows} = await db.query(`SELECT chain,name,height,request_key,artifact_status,policy_version
    FROM module_deployments WHERE kind='new' AND block_time>=$1 AND block_time<$2
    ORDER BY chain,height,request_key,name`, [fromDay + 'T00:00:00Z', cutoff]);
  return {...evaluateArtifactPolicy(rows, policy), policySha256: sha256, fromDay, cutoff};
}

export async function assertModuleArtifactPolicyCurrent(db, cutoff) {
  const report = await moduleArtifactPolicyReport(db, cutoff);
  if (!report.passed) throw Object.assign(new Error('New test-artifact classifications require review or reconciliation with the current policy before publication'),
    {code: 'MODULE_ARTIFACT_POLICY_REVIEW_REQUIRED', details: report});
  return report;
}
