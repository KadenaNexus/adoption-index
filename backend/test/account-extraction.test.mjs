import test from 'node:test';
import assert from 'node:assert/strict';
import { ACCOUNT_EXTRACTION_VERSION, assertAccountExtractionReady } from '../src/account-extraction.mjs';

test('missing, old and unfinished account extraction states prevent publication', async () => {
  for (const row of [undefined, {version:'old',status:'ready'}, {version:ACCOUNT_EXTRACTION_VERSION,status:'repair_required'}, {version:ACCOUNT_EXTRACTION_VERSION,status:'repairing'}]) {
    await assert.rejects(assertAccountExtractionReady({query:async()=>({rows:row?[row]:[]})}), error=>error.code==='ACCOUNT_REPAIR_REQUIRED');
  }
  assert.equal(await assertAccountExtractionReady({query:async()=>({rows:[{version:ACCOUNT_EXTRACTION_VERSION,status:'ready'}]})}), ACCOUNT_EXTRACTION_VERSION);
});
