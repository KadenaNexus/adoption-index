import {setTimeout as delay} from 'node:timers/promises';
import {completedDay} from './window.mjs';
const MINUTE=60000,DAY=1440*MINUTE;
/**
 * kce-daily. The run at 00:00 UTC publishes the day just completed. A run that does not succeed is tried again 30
 * minutes later, then at doubling intervals up to 2 hours, until one succeeds or the next midnight run takes over; a
 * scheduler that starts while that day is still unpublished (a restart during a deploy, say) catches up 10 minutes
 * later. Only the 00:00 run is a midnight run: acceptance.mjs goes by start time, so a retry never counts as one.
 */
export const SCHEDULE=Object.freeze({graceMs:2*MINUTE,startupDelayMs:10*MINUTE,retryMs:30*MINUTE,maxRetryMs:120*MINUTE});
const nextMidnight=at=>{const d=new Date(at);d.setUTCHours(24,0,0,0);return d};
export async function runScheduler({runDaily,latestPublishedDay,now=()=>new Date(),sleep=(ms,signal)=>delay(ms,undefined,{signal}),log=()=>{},signal,schedule=SCHEDULE}={}){
 // Behind: an earlier day is published but not the one just completed. A database still being filled has nothing to
 // catch up, and one that cannot be read counts as behind, so a later attempt tries again.
 const behind=async()=>{
  try{const day=await latestPublishedDay();return typeof day==='string'&&day<completedDay(now())}
  catch(error){log({event:'scheduler_check_failed',name:error?.name,message:String(error?.message??'').slice(0,200)});return true}
 };
 let midnight=nextMidnight(now()),retryAt=await behind()?new Date(now().getTime()+schedule.startupDelayMs):null,wait=schedule.retryMs;
 log({event:'scheduler_ready',nextRun:midnight.toISOString(),...(retryAt?{catchUpAt:retryAt.toISOString()}:{})});
 while(!signal?.aborted){
  const next=retryAt&&retryAt<midnight?retryAt:midnight;
  try{await sleep(Math.min(30000,Math.max(1,next-now())),signal)}catch{break}
  if(signal?.aborted)break;
  if(now()<next)continue;
  if(next===midnight){
   const scheduled=midnight;midnight=new Date(scheduled.getTime()+DAY);retryAt=null;wait=schedule.retryMs;
   // Woken too late to be the midnight run (a paused machine, say): it still runs, as a catch-up.
   if(now()-scheduled>schedule.graceMs)log({event:'missed_midnight',scheduled:scheduled.toISOString()});
  }
  let succeeded=false;
  try{const result=await runDaily();log(result);succeeded=result?.status==='succeeded'}
  catch(error){if(signal?.aborted)break;log({event:'scheduler_failure',name:error?.name,message:error?.message})}
  if(succeeded||!await behind()){retryAt=null;wait=schedule.retryMs;continue}
  retryAt=new Date(now().getTime()+wait);wait=Math.min(wait*2,schedule.maxRetryMs);
  log({event:'scheduler_retry',retryAt:retryAt.toISOString()});
 }
}
