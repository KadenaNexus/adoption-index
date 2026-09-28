import test from 'node:test';
import assert from 'node:assert/strict';
import {windowFor,validateDay,completedDay,addDays,INITIAL_HISTORY_DAYS,COLLECTION_START} from '../src/window.mjs';

test('initial history is ninety completed UTC days with a fixed start and exclusive midnight cutoff',()=>{
 assert.equal(INITIAL_HISTORY_DAYS,90);assert.equal(COLLECTION_START,'2026-06-29');
 assert.deepEqual(windowFor('2026-09-26'),{fromDay:'2026-06-29',throughDay:'2026-09-26',startTime:'2026-06-29T00:00:00Z',cutoff:'2026-09-27T00:00:00Z',days:90});
 assert.equal(windowFor(COLLECTION_START).days,1,'a staged prefix is supported without publication');
});
test('future additions grow history and never move the original collection baseline',()=>{
 const value=windowFor('2027-01-31',{now:new Date('2027-02-01T00:01:00Z')});
 assert.equal(value.fromDay,COLLECTION_START);assert.ok(value.days>200);
 assert.equal((Date.parse(value.cutoff)-Date.parse(value.startTime))/86400000,value.days);
});
test('invalid dates, pre-collection dates and incomplete UTC days fail without timezone coercion',()=>{
 for(const value of ['2026-02-29','2026-09-31','2026-9-01','2026-09-01T00:00:00Z',null])assert.throws(()=>validateDay(value),/Invalid UTC day/);
 assert.throws(()=>windowFor('2099-01-01'),/completed UTC day/);
 assert.throws(()=>windowFor('2025-11-08'),/fixed collection start/);
 assert.equal(completedDay(new Date('2026-09-27T00:15:00+05:00')),'2026-09-25');
 assert.equal(addDays('2024-02-28',1),'2024-02-29');
});
