import { createHash, randomUUID } from 'node:crypto';
import { mkdir, open, readFile, rename, unlink, readdir, rm } from 'node:fs/promises';
import { hostname } from 'node:os';
import path from 'node:path';

const VERSION = 1;
const hash = (value) => createHash('sha256').update(value).digest('hex');

export class SourceCacheError extends Error {
  constructor(code, message, details = {}, cause) {
    super(message, cause ? { cause } : undefined);
    this.name = 'SourceCacheError'; this.code = code; this.details = details;
  }
}

async function atomicJson(filename, value) {
  const temporary = `${filename}.${process.pid}.${randomUUID()}.tmp`;
  const file = await open(temporary, 'wx', 0o600);
  try { await file.writeFile(`${JSON.stringify(value)}\n`); await file.sync(); }
  finally { await file.close(); }
  await rename(temporary, filename);
  const directory = await open(path.dirname(filename), 'r');
  try { await directory.sync(); }
  finally { await directory.close(); }
}

async function parseFile(filename) {
  try { return JSON.parse(await readFile(filename, 'utf8')); }
  catch (error) {
    if (error.code === 'ENOENT') return null;
    throw new SourceCacheError('GITHUB_CACHE_CORRUPT', 'Cached source evidence is unreadable; refusing to refresh a frozen response silently', { path: filename }, error);
  }
}

/** A cache namespace is one frozen public-API run, never a token or an API credential. */
async function openRunSourceCache({ directory, config, now = Date.now }) {
  const configText = JSON.stringify(config);
  const runId = hash(configText);
  const runDirectory = path.resolve(directory, runId);
  await pruneSourceCachesUnlocked({directory,keepRunId:runId});
  const responsesDirectory = path.join(runDirectory, 'responses');
  const manifestPath = path.join(runDirectory, 'run.json');
  const lockPath = path.join(runDirectory, 'run.lock');
  await mkdir(responsesDirectory, { recursive: true, mode: 0o700 });
  const lockId = randomUUID();
  let lock;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try { lock = await open(lockPath, 'wx', 0o600); break; }
    catch (error) {
      if (error.code !== 'EEXIST') throw error;
      const previous = await parseFile(lockPath);
      let definitelyDead = false;
      if (previous?.hostname === hostname() && Number.isSafeInteger(previous.pid) && previous.pid > 0) {
        try { process.kill(previous.pid, 0); }
        catch (probeError) { definitelyDead = probeError.code === 'ESRCH'; }
      }
      if (definitelyDead && attempt === 0) { await unlink(lockPath); continue; }
      throw new SourceCacheError('GITHUB_CACHE_LOCKED', 'Another process owns this frozen GitHub collection',
        { cacheRunId: runId, cacheDirectory: runDirectory, ownerPid: previous?.pid ?? null });
    }
  }
  if (!lock) throw new SourceCacheError('GITHUB_CACHE_LOCKED', 'Could not acquire GitHub cache lock');
  await lock.writeFile(JSON.stringify({ pid: process.pid, hostname: hostname(), lockId, createdAt: new Date(now()).toISOString() }));
  await lock.sync(); await lock.close();
  let closed = false;
  const close = async () => {
    if (closed) return;
    const current = await parseFile(lockPath);
    if (current?.lockId !== lockId) throw new SourceCacheError('GITHUB_CACHE_LOCK_CHANGED', 'Cache ownership changed while collecting', { cacheRunId: runId });
    await unlink(lockPath); closed = true;
  };
  try {
    const manifest = await parseFile(manifestPath);
    if (manifest) {
      if (manifest.version !== VERSION || manifest.runId !== runId || JSON.stringify(manifest.config) !== configText) {
        throw new SourceCacheError('GITHUB_CACHE_CONFIG_MISMATCH', 'Frozen cache configuration does not match this collection', { cacheRunId: runId });
      }
    } else {
      await atomicJson(manifestPath, { version: VERSION, runId, config, createdAt: new Date(now()).toISOString() });
    }
    const requestIdentity = ({ url, kind, repository }) => ({ url, kind, repository: repository ?? null });
    const filenameFor = (request) => path.join(responsesDirectory, `${hash(JSON.stringify(requestIdentity(request)))}.json`);
    const verify = (record, request, filename) => {
      if (record.version !== VERSION || record.runId !== runId ||
          JSON.stringify(record.request) !== JSON.stringify(requestIdentity(request)) ||
          !record.response || record.responseSha256 !== hash(JSON.stringify(record.response)) || record.response.url !== request.url || record.response.kind !== request.kind ||
          record.response.repository !== (request.repository ?? null) || typeof record.response.rawBody !== 'string' ||
          record.response.bodySha256 !== hash(record.response.rawBody)) {
        throw new SourceCacheError('GITHUB_CACHE_CORRUPT', 'Cached response identity or SHA-256 verification failed', { path: filename, cacheRunId: runId });
      }
      return record.response;
    };
    return {
      runId, directory: runDirectory,
      async get(request) {
        const filename = filenameFor(request);
        const record = await parseFile(filename);
        return record ? verify(record, request, filename) : null;
      },
      async put(response) {
        const request = requestIdentity(response); const filename = filenameFor(request);
        const existing = await parseFile(filename);
        if (existing) {
          const saved = verify(existing, request, filename);
          if (saved.bodySha256 !== response.bodySha256 || saved.status !== response.status || JSON.stringify(saved.headers) !== JSON.stringify(response.headers)) {
            throw new SourceCacheError('GITHUB_CACHE_CONFLICT', 'Refusing to replace a frozen source response', { path: filename, cacheRunId: runId });
          }
          return;
        }
        if (response.bodySha256 !== hash(response.rawBody)) throw new SourceCacheError('GITHUB_CACHE_CORRUPT', 'Response hash is invalid before caching');
        await atomicJson(filename, { version: VERSION, runId, request, savedAt: new Date(now()).toISOString(), responseSha256: hash(JSON.stringify(response)), response });
      },
      close,
    };
  } catch (error) { await close(); throw error; }
}

/** One resumable window only. Never remove a live collector's cache. */
async function pruneSourceCachesUnlocked({directory,keepRunId=null}) {
 let entries;
 try{entries=await readdir(directory,{withFileTypes:true})}catch(error){if(error.code==='ENOENT')return;throw error}
 for(const entry of entries){
  if(!entry.isDirectory()||!/^[a-f0-9]{64}$/.test(entry.name)||entry.name===keepRunId)continue;
  const target=path.join(directory,entry.name),lock=await parseFile(path.join(target,'run.lock'));
  if(lock){
   let dead=false;
   if(lock.hostname===hostname()&&Number.isSafeInteger(lock.pid)&&lock.pid>0){try{process.kill(lock.pid,0)}catch(error){dead=error.code==='ESRCH'}}
   if(!dead)throw new SourceCacheError('GITHUB_CACHE_LOCKED','Another source collection is active',{cacheRunId:entry.name,ownerPid:lock.pid??null});
  }
  await rm(target,{recursive:true,force:true});
 }
}

async function lockDirectory(directory){
 await mkdir(directory,{recursive:true,mode:0o700});
 const filename=path.join(directory,'.collection.lock'),lockId=randomUUID();let handle;
 for(let attempt=0;attempt<2;attempt++){
  try{handle=await open(filename,'wx',0o600);break}catch(error){
   if(error.code!=='EEXIST')throw error;
   const old=await parseFile(filename);let dead=false;
   if(old?.hostname===hostname()&&Number.isSafeInteger(old.pid)&&old.pid>0){try{process.kill(old.pid,0)}catch(probe){dead=probe.code==='ESRCH'}}
   if(dead&&attempt===0){await unlink(filename);continue}
   throw new SourceCacheError('GITHUB_CACHE_LOCKED','Another GitHub cache operation is active',{ownerPid:old?.pid??null});
  }
 }
 if(!handle)throw new SourceCacheError('GITHUB_CACHE_LOCKED','Could not acquire GitHub cache directory lock');
 await handle.writeFile(JSON.stringify({hostname:hostname(),pid:process.pid,lockId}));await handle.sync();await handle.close();
 let released=false;
 return async()=>{if(released)return;const current=await parseFile(filename);if(current?.lockId!==lockId)throw new SourceCacheError('GITHUB_CACHE_LOCK_CHANGED','Cache directory lock ownership changed');await unlink(filename);released=true};
}
export async function openSourceCache(options){
 const release=await lockDirectory(options.directory);
 try{
  const cache=await openRunSourceCache(options);
  return {...cache,async close(){try{await cache.close()}finally{await release()}}};
 }catch(error){await release();throw error}
}
export async function pruneSourceCaches(options){
 const release=await lockDirectory(options.directory);
 try{await pruneSourceCachesUnlocked(options)}finally{await release()}
}
