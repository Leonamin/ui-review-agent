import type {BrowserPhysicalContext} from './browser.js';

export const BROWSER_LEASE_LIMIT=2;
export const BROWSER_LEASE_IDLE_MS=60000;
export const BROWSER_LEASE_MAX_TURNS=5;
interface Slot {workspaceId?:string;policyKey?:string;runId?:string;turns:number;isActive:boolean;physical?:BrowserPhysicalContext;timer?:NodeJS.Timeout}
const slots=new Set<Slot>();
const waiters=new Set<()=>void>();
const wake=()=>{for(const waiter of waiters)waiter();waiters.clear();};
async function discard(slot:Slot){if(slot.timer)clearTimeout(slot.timer);slot.isActive=true;await slot.physical?.browser.close().catch(()=>{});slots.delete(slot);wake();}
export interface BrowserLeaseReservation {physical?:BrowserPhysicalContext;release:(physical:BrowserPhysicalContext|undefined,runId:string,canReuse:boolean)=>Promise<void>}
/** Only physical contexts survive a turn. Evidence, refs, cancellation and budgets never do. */
export async function acquireBrowserLease(workspaceId:string|undefined,baseRunId:string|undefined,signal?:AbortSignal,policyKey?:string):Promise<BrowserLeaseReservation>{
 for(;;){
  if(signal?.aborted)throw new Error('Browser lease acquisition cancelled');
  if(workspaceId&&[...slots].some(slot=>slot.workspaceId===workspaceId&&slot.isActive))throw new Error('This workspace already has a browser operation');
  let slot=workspaceId?[...slots].find(slot=>slot.workspaceId===workspaceId&&!slot.isActive):undefined;
  if(slot&&(slot.runId!==baseRunId||slot.policyKey!==policyKey||!slot.physical?.browser.isConnected()||slot.physical.page.isClosed()||slot.turns>=BROWSER_LEASE_MAX_TURNS)){await discard(slot);slot=undefined;}
  if(!slot&&slots.size>=BROWSER_LEASE_LIMIT){const idle=[...slots].find(item=>!item.isActive);if(idle){await discard(idle);continue;}await new Promise<void>((resolve,reject)=>{const resume=()=>{signal?.removeEventListener('abort',cancel);resolve();};const cancel=()=>{waiters.delete(resume);reject(new Error('Browser lease acquisition cancelled'));};waiters.add(resume);signal?.addEventListener('abort',cancel,{once:true});});continue;}
  if(!slot){slot={workspaceId,policyKey,turns:0,isActive:true};slots.add(slot);}else{if(slot.timer)clearTimeout(slot.timer);slot.isActive=true;}
  const reserved=slot;let hasReleased=false;
  return{physical:reserved.physical,release:async(physical,runId,canReuse)=>{
   if(hasReleased)return;hasReleased=true;if(!slots.has(reserved)){await physical?.browser.close().catch(()=>{});return;}
   reserved.physical=physical;reserved.runId=runId;reserved.turns++;reserved.isActive=false;
   if(!canReuse||!workspaceId||!physical?.browser.isConnected()||physical.page.isClosed()||reserved.turns>=BROWSER_LEASE_MAX_TURNS){await discard(reserved);return;}
   reserved.timer=setTimeout(()=>{void discard(reserved);},BROWSER_LEASE_IDLE_MS);reserved.timer.unref();wake();
  }};
 }
}
export async function closeBrowserLeases():Promise<void>{await Promise.all([...slots].map(discard));}
export function browserLeaseStatus(){return{limit:BROWSER_LEASE_LIMIT,idleMs:BROWSER_LEASE_IDLE_MS,maxTurns:BROWSER_LEASE_MAX_TURNS,activeCount:[...slots].filter(slot=>slot.isActive).length,idleCount:[...slots].filter(slot=>!slot.isActive).length};}
