import {test} from 'node:test';
import assert from 'node:assert/strict';
import {randomBytes} from 'node:crypto';
import {evidenceDigest} from '../src/acceptance.mjs';
import {database} from '../src/db.mjs';
import {migrate} from '../src/migrate.mjs';
import {publishIndex} from '../src/pipeline.mjs';
import {calculateSeries,METHOD_VERSION} from '../src/scoring.mjs';
import {loadRegistry} from '../src/tvl.mjs';
import {migrateTvlRegistry} from '../src/tvl-migration.mjs';
import {windowFor,addDays,COLLECTION_START} from '../src/window.mjs';
const connection=process.env.TEST_DATABASE_URL;
async function isolated(t){
 const url=new URL(connection);if(!url.pathname.endsWith('_test'))throw new Error('Integration tests require a dedicated *_test database');
 const schema='tvlmig_'+randomBytes(8).toString('hex'),admin=database(connection);
 await admin.query(`CREATE SCHEMA ${schema}`);url.searchParams.set('options',`-c search_path=${schema}`);const db=database(url.href);
 t.after(async()=>{await db.end();try{await admin.query(`DROP SCHEMA ${schema} CASCADE`)}finally{await admin.end()}});
 await migrate(db);return db;
}

test('a TVL registry migration recollects TVL, archives the scores it replaces and changes nothing else',{skip:!connection},async t=>{
 t.mock.timers.enable({apis:['Date'],now:Date.parse(addDays(COLLECTION_START,95)+'T12:00:00Z')});
 const db=await isolated(t),window=windowFor(),registry=await loadRegistry();
 const farFuture=addDays(window.throughDay,30)+'T00:00:00Z';
 for(let chain=0;chain<20;chain++)await db.query("INSERT INTO chain_checkpoints(chain,height,hash,block_time,anchor_hash,baseline_inventory,baseline_header,coverage_start) VALUES($1,1,'h','"+farFuture+"','a','{}','{}',$2)",[chain,COLLECTION_START]);
 const rows=Array.from({length:window.days},(_,i)=>({day:addDays(COLLECTION_START,i),addresses:100,contracts:0,tvlKda:1000+i,tvlUsd:10,kdaUsd:.01,hashratePh:10,commits:2,registryVersion:'fixture',coverage:{addresses:true,contracts:true,tvl:true,hashrate:true,commits:true}}));
 await publishIndex(db,rows,{throughDay:window.throughDay});
 const payloads=async()=>(await db.query('SELECT payload FROM index_snapshots ORDER BY day')).rows.map(row=>row.payload),before=await payloads();
 // The new registry leaves out protocols holding 100 KDA on every day.
 const recollected=rows.map(row=>({...row,tvlKda:row.tvlKda-100,tvlUsd:9,registryVersion:registry.version}));
 let collections=0;const collect=async(_db,{throughDay})=>{collections++;assert.equal(throughDay,window.throughDay);return recollected};
 await assert.rejects(migrateTvlRegistry(db,{from:registry.version,collect}),/previous registry version/);
 await assert.rejects(migrateTvlRegistry(db,{from:'2026-01-01.1',collect}),/record TVL registry fixture, not only 2026-01-01\.1/);
 // Any other input that differs stops the switch and leaves history as published.
 await assert.rejects(migrateTvlRegistry(db,{from:'fixture',collect:async()=>recollected.map((row,i)=>i===40?{...row,addresses:101}:row)}),
  error=>error.code==='NON_TVL_HISTORY_CHANGED'&&error.details.day===rows[40].day);
 assert.equal(evidenceDigest(await payloads()),evidenceDigest(before));
 // A daily job holding the publication lock blocks it.
 const job=await db.connect();
 try{
  await job.query("SELECT pg_advisory_lock(hashtext('kce-publication-job'))");
  await assert.rejects(migrateTvlRegistry(db,{from:'fixture',collect}),/stop kce-daily/);
  await job.query("SELECT pg_advisory_unlock(hashtext('kce-publication-job'))");
 }finally{job.release()}
 assert.equal(collections,0);
 const result=await migrateTvlRegistry(db,{from:'fixture',collect});
 assert.equal(collections,1);
 assert.equal(result.days,window.days);assert.equal(result.archivedScores,window.days);
 assert.equal(result.tvlBaselineKda.previous,1014.5);assert.equal(result.tvlBaselineKda.current,914.5);
 assert.deepEqual(result.latestTvlKda,{previous:1000+window.days-1,current:900+window.days-1});
 const stored=(await db.query('SELECT raw,registry_version FROM daily_metrics ORDER BY day')).rows;
 assert.ok(stored.every(row=>row.registry_version===registry.version));
 assert.equal(evidenceDigest(stored.map(row=>row.raw)),evidenceDigest(recollected));
 const after=await payloads();
 assert.equal(evidenceDigest(after),evidenceDigest(calculateSeries(recollected,{throughDay:window.throughDay})));
 assert.ok(after.every(payload=>payload.registryVersion===registry.version&&payload.methodVersion===METHOD_VERSION));
 const label=version=>`${METHOD_VERSION} with TVL registry ${version}`;
 const archived=(await db.query('SELECT payload FROM index_snapshot_archive WHERE method_version=$1 ORDER BY day',[label('fixture')])).rows.map(row=>row.payload);
 assert.equal(evidenceDigest(archived),evidenceDigest(before),'replaced scores are archived, not discarded');
 assert.deepEqual((await db.query('SELECT from_version,to_version,days FROM method_migrations')).rows,[{from_version:label('fixture'),to_version:label(registry.version),days:window.days}]);
 // Re-running is a no-op, and the next daily publication accepts the switched history unchanged.
 assert.deepEqual(await migrateTvlRegistry(db,{from:'fixture',collect}),{alreadyCurrent:true,registryVersion:registry.version});
 assert.equal(collections,1);
 await publishIndex(db,recollected,{throughDay:window.throughDay});
 assert.equal(evidenceDigest(await payloads()),evidenceDigest(after));
});
