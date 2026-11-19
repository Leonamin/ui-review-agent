import type {Request,Response} from 'playwright';
import type {BlockedTelemetryKind} from './blocked-telemetry.js';

const windowMs=5000;
const requestLimit=32;
const resourceTypes=['fetch','xhr','document','preflight'] as const;
const methods=['GET','HEAD','OPTIONS','POST','PUT','PATCH','DELETE','CONNECT','TRACE'];
const publicRouteWords=new Set(['api','rpc','rest','graphql','trpc','query','queries','mutation','mutations','search','list','feed','feeds','latest','popular','catalog','products','items','characters','categories','results','health','status','index','public','data','lookup','batch']);
export type NetworkBlockReason='read-only-method'|'navigation-origin'|'modal-navigation'|'project-post-address'|'project-post-redirect'|'project-post-revoked'|'project-post-size'|'project-post-cors';
export interface ActionNetworkRequest {
 method:string;
 origin:string;
 path:string;
 resourceType:typeof resourceTypes[number];
 startedAt:string;
 endedAt?:string;
 outcome:'blocked'|'failed'|'response'|'pending';
 blockReason?:NetworkBlockReason;
 telemetry?:BlockedTelemetryKind;
 policyAllowance?:'project-post-host';
 statusCode?:number;
 failureCode?:string;
}
export interface ActionNetworkDiagnostic {
 startedAt:string;
 endedAt:string;
 settledObservationId?:string;
 requests:ActionNetworkRequest[];
 droppedRequestCount:number;
}

/** Keep only known target/API host names, fixed route vocabulary and short API versions. */
function redactDestination(raw:string,targetUrl:string):{origin:string;path:string}|undefined {
 try{
  const url=new URL(raw),target=new URL(targetUrl);
  if(!['http:','https:'].includes(url.protocol))return;
  const baseHost=target.hostname.replace(/^(?:www|api)\./,'');
  const isKnownHost=[target.hostname,baseHost,`www.${baseHost}`,`api.${baseHost}`].includes(url.hostname);
  const origin=isKnownHost?url.origin:`${url.protocol}//[other-host]`;
  // Work with encoded segments. Decoding would turn parameter data into route text.
  const parts=url.pathname.split('/',14).slice(1);
  const path='/'+parts.slice(0,12).map(part=>!part||publicRouteWords.has(part)||/^v[1-9][0-9]?$/.test(part)?part:'[redacted]').join('/')+(parts.length>12?'/[redacted]':'');
  return {origin,path};
 }catch{return;}
}

interface Window {
 actionId:string;
 wallStart:number;
 monotonicStart:number;
 monotonicDeadline:number;
 records:ActionNetworkRequest[];
 identities:WeakMap<Request,ActionNetworkRequest>;
 droppedRequestCount:number;
}

/** One bounded window per session. Terminal events must match an admitted request object. */
export class ActionNetworkRecorder {
 private active?:Window;
 constructor(private readonly targetUrl:string){}
 begin(actionId:string,remainingMs:number){
  const monotonicStart=performance.now();
  this.active={actionId,wallStart:Date.now(),monotonicStart,monotonicDeadline:monotonicStart+Math.max(0,Math.min(windowMs,remainingMs)),records:[],identities:new WeakMap(),droppedRequestCount:0};
 }
 private live(now:number){
  return this.active&&now<this.active.monotonicDeadline?this.active:undefined;
 }
 private time(active:Window,now:number){return new Date(active.wallStart+now-active.monotonicStart).toISOString();}
 request(request:Request){
  const now=performance.now(),active=this.live(now);if(!active||active.identities.has(request))return;
  const resourceType=request.method()==='OPTIONS'&&request.headers()?.['access-control-request-method']?'preflight':resourceTypes.find(kind=>kind===request.resourceType());if(!resourceType)return;
  const redirect=request.redirectedFrom();
  if(redirect&&!active.identities.has(redirect))return;
  if(active.records.length>=requestLimit){active.droppedRequestCount++;return;}
  const destination=redactDestination(request.url(),this.targetUrl);if(!destination)return;
  const verb=request.method();
  const record:ActionNetworkRequest={...destination,method:methods.includes(verb)?verb:'OTHER',resourceType,startedAt:this.time(active,now),outcome:'pending'};
  active.identities.set(request,record);active.records.push(record);
 }
 response(response:Response){
  const now=performance.now(),active=this.live(now);if(!active)return;
  const record=active.identities.get(response.request());if(!record||record.outcome!=='pending')return;
  record.statusCode=response.status();record.outcome='response';record.endedAt=this.time(active,now);
 }
 failed(request:Request){
  const now=performance.now(),active=this.live(now);if(!active)return;
  const record=active.identities.get(request);if(!record||record.outcome==='blocked')return;
  const code=request.failure()?.errorText;
  if(code&&/^net::ERR_[A-Z0-9_]{1,42}$/.test(code))record.failureCode=code;
  // Preserve an observed HTTP status when the response body subsequently fails.
  record.outcome='failed';record.endedAt=this.time(active,now);
 }
 allowedProjectPost(request:Request){const record=this.live(performance.now())?.identities.get(request);if(record)record.policyAllowance='project-post-host';}
 blocked(request:Request,reason:NetworkBlockReason,statusCode?:number,telemetry?:BlockedTelemetryKind){
  const now=performance.now(),active=this.live(now);if(!active)return;
  const record=active.identities.get(request);if(!record)return;
  if(statusCode!==undefined)record.statusCode=statusCode;
  if(telemetry)record.telemetry=telemetry;
  record.blockReason=reason;record.outcome='blocked';record.endedAt=this.time(active,now);
 }
 finish(actionId:string,settledObservationId?:string):ActionNetworkDiagnostic|undefined {
  const active=this.active;if(!active||active.actionId!==actionId)return;
  this.active=undefined;
  return{startedAt:this.time(active,active.monotonicStart),endedAt:this.time(active,Math.min(performance.now(),active.monotonicDeadline)),
   ...(settledObservationId?{settledObservationId}:{}),requests:active.records,droppedRequestCount:active.droppedRequestCount};
 }
}
