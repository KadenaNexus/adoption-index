import {test} from 'node:test';
import assert from 'node:assert/strict';
import {eventful} from '../src/worker.mjs';
test('an idle pass with payments on (one new finalized chunk scanned, nothing found) is not logged',()=>{
 const idle={confirmPending:{checked:0,confirmed:0,underpaid:0,failed:0,pending:0,errors:0},
  reconcile:{finalized:124700000,from:124699800,chunks:1,transactions:0,credited:0,existing:0,unmatched:0,ignored:0,errors:0,retrying:0,next:124700001},
  processAlerts:{throughDay:'2026-09-28',days:0,queued:0},processRenewalReminders:{queued:0},sendOutbox:{sent:0,retrying:0,failed:0}};
 assert.equal(eventful(idle),false);
 assert.equal(eventful({...idle,reconcile:{...idle.reconcile,credited:1}}),true);
 assert.equal(eventful({...idle,sendOutbox:{sent:2,retrying:0,failed:0}}),true);
 assert.equal(eventful({...idle,reconcile:{failed:true}}),true);
});
