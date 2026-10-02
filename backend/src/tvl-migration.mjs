import {isDeepStrictEqual} from 'node:util';
import {transaction} from './db.mjs';
import {evidenceDigest} from './acceptance.mjs';
import {collectMetricRows} from './pipeline.mjs';
import {calculateSeries,METHOD_VERSION} from './scoring.mjs';
import {loadRegistry} from './tvl.mjs';

// The fields a TVL registry decides. Every other input of a published day must stay exactly as published.
const TVL_FIELDS=new Set(['tvlKda','tvlUsd','kdaUsd','registryVersion']);
const otherInputs=row=>Object.fromEntries(Object.entries(row).filter(([key])=>!TVL_FIELDS.has(key)));
const seriesLabel=version=>`${METHOD_VERSION} with TVL registry ${version}`;

/**
 * Explicit, audited switch of published history to the current TVL registry. Every published day's TVL is collected
 * again from historical chain state and stored like any other observation, so an interrupted run resumes where it
 * stopped. In one transaction the previous scores are archived, the daily rows take the new TVL, the scores are
 * recomputed and the switch is recorded with checksums. Re-running it after success is a no-op.
 */
export async function migrateTvlRegistry(db,{from,collect=collectMetricRows,onProgress=()=>{}}={}){
 const registry=await loadRegistry();
 if(typeof from!=='string'||!from)throw new Error('--from <recorded registry version> is required');
 if(from===registry.version)throw new Error('--from must name the previous registry version, not the current one');
 const recorded=(await db.query('SELECT registry_version,max(day)::text AS through FROM daily_metrics GROUP BY 1')).rows;
 if(recorded.length===1&&recorded[0].registry_version===registry.version)return {alreadyCurrent:true,registryVersion:registry.version};
 if(recorded.length!==1||recorded[0].registry_version!==from)throw new Error(`Daily metrics record TVL registry ${recorded.map(row=>row.registry_version).join(', ')||'none'}, not only ${from}`);
 const throughDay=recorded[0].through,lock=await db.connect();
 let locked=false;
 try{
  // Held for the whole run: no daily job can publish between the collection and the switch.
  locked=(await lock.query("SELECT pg_try_advisory_lock(hashtext('kce-publication-job')) AS locked")).rows[0].locked;
  if(!locked)throw new Error('Another publication job is active; stop kce-daily and try again');
  const rows=await collect(db,{throughDay,onProgress});
  return await transaction(db,async tx=>{
   await tx.query("SELECT pg_advisory_xact_lock(hashtext('kce-snapshot-publication'))");
   const stored=(await tx.query('SELECT day::text AS day,raw,registry_version,method_version FROM daily_metrics ORDER BY day')).rows;
   if(stored.length!==rows.length||stored.some((row,i)=>row.day!==rows[i].day||row.registry_version!==from||row.method_version!==METHOD_VERSION))throw new Error('Published history changed during the TVL collection; run the migration again');
   for(const [i,row] of stored.entries())if(!isDeepStrictEqual(otherInputs(row.raw),otherInputs(rows[i])))throw Object.assign(new Error('A TVL registry migration may change TVL only; another daily input differs from published history'),{code:'NON_TVL_HISTORY_CHANGED',details:{day:row.day}});
   const previous=(await tx.query('SELECT day::text AS day,score,payload FROM index_snapshots ORDER BY day')).rows,snapshots=calculateSeries(rows,{throughDay});
   for(const row of previous)await tx.query('INSERT INTO index_snapshot_archive(method_version,day,score,payload) VALUES($1,$2,$3,$4)',[seriesLabel(from),row.day,row.score,row.payload]);
   await tx.query('DELETE FROM index_snapshots');
   for(const row of rows)await tx.query('UPDATE daily_metrics SET raw=$2,registry_version=$3,updated_at=now() WHERE day=$1',[row.day,row,registry.version]);
   for(const snapshot of snapshots)await tx.query('INSERT INTO index_snapshots(day,score,payload) VALUES($1,$2,$3)',[snapshot.day,snapshot.score,snapshot]);
   const after=(await tx.query('SELECT raw FROM daily_metrics ORDER BY day')).rows.map(row=>row.raw);
   if(evidenceDigest(after)!==evidenceDigest(rows))throw new Error('Stored daily rows differ from the recollected ones');
   const record={from:seriesLabel(from),to:seriesLabel(registry.version),days:snapshots.length,rawSha256:evidenceDigest(rows),archivedSha256:evidenceDigest(previous.map(row=>row.payload)),snapshotsSha256:evidenceDigest(snapshots)};
   await tx.query('INSERT INTO method_migrations(from_version,to_version,days,raw_sha256,archived_sha256,snapshots_sha256) VALUES($1,$2,$3,$4,$5,$6)',[record.from,record.to,record.days,record.rawSha256,record.archivedSha256,record.snapshotsSha256]);
   const tvl=payload=>payload?.components?.tvl,last=previous.at(-1)?.payload;
   return {...record,previousRawSha256:evidenceDigest(stored.map(row=>row.raw)),archivedScores:previous.length,fromDay:snapshots[0]?.day??null,throughDay,
    score:{previous:last?.score??null,current:snapshots.at(-1)?.score??null},
    tvlBaselineKda:{previous:tvl(last)?.baselineDailyMean??null,current:tvl(snapshots.at(-1))?.baselineDailyMean??null},
    latestTvlKda:{previous:stored.at(-1)?.raw.tvlKda??null,current:rows.at(-1)?.tvlKda??null}};
  });
 }finally{try{if(locked)await lock.query("SELECT pg_advisory_unlock(hashtext('kce-publication-job'))")}finally{lock.release()}}
}
