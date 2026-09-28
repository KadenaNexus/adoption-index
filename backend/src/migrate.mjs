import {readFile} from 'node:fs/promises';
import {pathToFileURL} from 'node:url';
import {database,transaction} from './db.mjs';
import {COLLECTION_START,INITIAL_HISTORY_DAYS} from './window.mjs';
import {METHOD_VERSION,calculateSeries} from './scoring.mjs';
import {evidenceDigest} from './acceptance.mjs';
const schemaSql=()=>readFile(new URL('./schema.sql',import.meta.url),'utf8');
const methodHint=version=>`explicit method migration is required (npm run migrate-method -- --from ${version}); existing data has been preserved`;
export async function migrate(pool) {
 const sql=await schemaSql();
 await transaction(pool,async c=>{
  const existing=(await c.query("SELECT to_regclass('chain_checkpoints') AS table_name")).rows[0]?.table_name;
  if(existing){
   const columns=(await c.query("SELECT column_name FROM information_schema.columns WHERE table_schema=current_schema() AND table_name='chain_checkpoints'")).rows.map(row=>row.column_name);
   if(!columns.includes('coverage_start')) throw new Error('Legacy full-history schema requires an explicit compatible migration; collected data is never deleted implicitly');
   const mismatch=(await c.query('SELECT count(*)::int AS n FROM chain_checkpoints WHERE coverage_start<>$1',[COLLECTION_START])).rows[0].n;
   if(mismatch)throw new Error('Existing collection start differs from configured start; explicit backfill/method migration is required, and existing data has been preserved');
   const published=(await c.query('SELECT method_version FROM daily_metrics WHERE method_version<>$1 LIMIT 1',[METHOD_VERSION])).rows[0];
   if(published)throw new Error(`Existing published scoring method differs; ${methodHint(published.method_version)}`);
  }
  await c.query(sql);
  await c.query(`INSERT INTO collection_state(singleton,start_day,initial_history_days,method_version,history_policy)
    VALUES(true,$1,$2,$3,'growing-permanent') ON CONFLICT(singleton) DO NOTHING`,[COLLECTION_START,INITIAL_HISTORY_DAYS,METHOD_VERSION]);
  const state=(await c.query('SELECT start_day,initial_history_days,method_version,history_policy FROM collection_state WHERE singleton=true')).rows[0];
  if(state?.method_version!==METHOD_VERSION&&state?.start_day===COLLECTION_START)throw new Error(`Immutable collection metadata records method ${state.method_version}; ${methodHint(state.method_version)}`);
  if(state?.start_day!==COLLECTION_START || state.initial_history_days!==INITIAL_HISTORY_DAYS || state.method_version!==METHOD_VERSION || state.history_policy!=='growing-permanent')throw new Error('Immutable collection metadata differs from configuration; explicit backfill/method migration is required');
 });
}
/**
 * Explicit, audited switch of the derived scores to the current method. Raw daily
 * observations, source evidence, checkpoints and the collection start are untouched:
 * scores are recomputed from the stored raw rows, the previous scores are archived,
 * and the migration is recorded with checksums. Re-running it is a no-op.
 */
export async function migrateMethod(pool,{from}={}){
 if(typeof from!=='string'||!from)throw new Error('--from <recorded method version> is required');
 if(from===METHOD_VERSION)throw new Error('--from must name the previous method version, not the current one');
 const sql=await schemaSql();
 return transaction(pool,async c=>{
  if(!(await c.query("SELECT to_regclass('collection_state') AS t")).rows[0]?.t)throw new Error('No collected history to migrate; run npm run migrate for a new database');
  await c.query("SELECT pg_advisory_xact_lock(hashtext('kce-snapshot-publication'))");
  const state=(await c.query('SELECT start_day,method_version FROM collection_state WHERE singleton=true')).rows[0];
  if(state?.start_day!==COLLECTION_START)throw new Error('Collection start differs from configuration; method migration never moves the collection start');
  if(state.method_version===METHOD_VERSION){await c.query(sql);return {alreadyCurrent:true,methodVersion:METHOD_VERSION}}
  if(state.method_version!==from)throw new Error(`The database records method ${state.method_version}, not ${from}`);
  await c.query(sql);
  const methods=(await c.query('SELECT DISTINCT method_version FROM daily_metrics')).rows.map(row=>row.method_version);
  if(methods.some(method=>method!==from))throw new Error(`Daily metrics contain unexpected method versions: ${methods.join(', ')}`);
  const raws=(await c.query('SELECT raw FROM daily_metrics ORDER BY day')).rows.map(row=>row.raw);
  const snapshots=raws.length?calculateSeries(raws,{throughDay:raws.at(-1).day}):[];
  const previous=(await c.query('SELECT day::text AS day,score,payload FROM index_snapshots ORDER BY day')).rows;
  for(const row of previous)await c.query('INSERT INTO index_snapshot_archive(method_version,day,score,payload) VALUES($1,$2,$3,$4)',[from,row.day,row.score,row.payload]);
  await c.query('DELETE FROM index_snapshots');
  await c.query('UPDATE daily_metrics SET method_version=$1,updated_at=now()',[METHOD_VERSION]);
  for(const snapshot of snapshots)await c.query('INSERT INTO index_snapshots(day,score,payload) VALUES($1,$2,$3)',[snapshot.day,snapshot.score,snapshot]);
  await c.query('UPDATE collection_state SET method_version=$1',[METHOD_VERSION]);
  const after=(await c.query('SELECT raw FROM daily_metrics ORDER BY day')).rows.map(row=>row.raw);
  if(evidenceDigest(after)!==evidenceDigest(raws))throw new Error('Raw daily observations changed during the method migration');
  const record={from,to:METHOD_VERSION,days:snapshots.length,rawSha256:evidenceDigest(raws),archivedSha256:evidenceDigest(previous.map(row=>row.payload)),snapshotsSha256:evidenceDigest(snapshots)};
  await c.query('INSERT INTO method_migrations(from_version,to_version,days,raw_sha256,archived_sha256,snapshots_sha256) VALUES($1,$2,$3,$4,$5,$6)',[record.from,record.to,record.days,record.rawSha256,record.archivedSha256,record.snapshotsSha256]);
  return {...record,archivedScores:previous.length,fromDay:snapshots[0]?.day??null,throughDay:snapshots.at(-1)?.day??null,latestScore:snapshots.at(-1)?.score??null};
 });
}
if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href){
 const db=database(),fromIndex=process.argv.indexOf('--from');
 try{
  if(process.argv.includes('--method'))console.log(JSON.stringify(await migrateMethod(db,{from:fromIndex<0?undefined:process.argv[fromIndex+1]})));
  else{await migrate(db);console.log('PostgreSQL schema is ready.')}
 }catch(error){console.error(error.message);process.exitCode=1}finally{await db.end()}
}
