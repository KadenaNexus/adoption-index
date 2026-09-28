export const ACCOUNT_EXTRACTION_VERSION = 'pact-transfer-v2';

/** A decoder change cannot mix old and new account sets in a published day. */
export async function assertAccountExtractionReady(db) {
  const row = (await db.query('SELECT version,status FROM account_extraction_state WHERE singleton=true')).rows[0];
  if (row?.version !== ACCOUNT_EXTRACTION_VERSION || row.status !== 'ready') {
    throw Object.assign(new Error('Account history requires verified reconstruction with the current transfer decoder before indexing or publication'), {
      code: 'ACCOUNT_REPAIR_REQUIRED',
      details: { expectedVersion: ACCOUNT_EXTRACTION_VERSION, storedVersion: row?.version ?? null, status: row?.status ?? 'missing' },
    });
  }
  return row.version;
}
