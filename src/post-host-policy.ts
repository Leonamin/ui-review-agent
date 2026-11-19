import {brotliDecompress,inflate,gunzip} from 'node:zlib';
import {lookup} from 'node:dns/promises';
import {request} from 'node:https';
import {createRequire} from 'node:module';
import {dirname,join} from 'node:path';
import {readFile} from 'node:fs/promises';
import {BlockList,isIP} from 'node:net';
import type {LookupAddress} from 'node:dns';

export const PROJECT_POST_HOST_LIMIT=10;
export const NATIVE_REVIEW_CORS_CONTEXT='https://ui-review-native-cors.invalid';
export const NATIVE_SUPABASE_REVIEW_CORS_CONTEXT='https://ui-review-supabase-cors.invalid';
const nativeCorsPatchMarker='UI_REVIEW_NATIVE_CORS_V1';
export async function assertNativePreflightPatch(coreBundlePath?:string,marker=NATIVE_REVIEW_CORS_CONTEXT):Promise<void>{
 const req=createRequire(import.meta.url);
 const core=coreBundlePath??join(dirname(createRequire(req.resolve('playwright')).resolve('playwright-core/package.json')),'lib/coreBundle.js');
 const source=await readFile(core,'utf8').catch(()=>undefined);
 if(!source?.includes(nativeCorsPatchMarker)||!source.includes(marker))throw new Error('Project request policy requires the installed Playwright native CORS patch');
}
export interface ProjectPostPolicy {projectId:string;hosts:string[]}
export function normalizeProjectPostHost(raw:string):string|undefined {
 const host=raw.trim().toLowerCase();
 if(host.length>253||isIP(host)||!host.includes('.')||!host.split('.').every(label=>/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(label))||!/^[a-z]/.test(host.split('.').at(-1)!))return;
 if(/(?:^|\.)(?:localhost|localdomain|local|internal|onion)$|(?:^|\.)home\.arpa$/.test(host))return;
 return host;
}
export function permittedProjectPostUrl(raw:string,policy:ProjectPostPolicy):URL|undefined {
 try{const url=new URL(raw);if(url.protocol==='https:'&&!url.port&&!url.username&&!url.password&&normalizeProjectPostHost(url.hostname)===url.hostname&&policy.hosts.includes(url.hostname))return url;}catch{/* Deny malformed URLs. */}
}
export function projectPostLeaseKey(policy?:ProjectPostPolicy){
 return policy?JSON.stringify([policy.projectId,[...policy.hosts].sort()]):undefined;
}
const privateNetworks=new BlockList();
for(const [network,mask] of [['0.0.0.0',8],['10.0.0.0',8],['100.64.0.0',10],['127.0.0.0',8],['169.254.0.0',16],['172.16.0.0',12],['192.0.0.0',24],['192.0.2.0',24],['192.88.99.0',24],['192.168.0.0',16],['198.18.0.0',15],['198.51.100.0',24],['203.0.113.0',24],['224.0.0.0',3]] as const)privateNetworks.addSubnet(network,mask,'ipv4');
for(const [network,mask] of [['2001::',23],['2001:db8::',32],['2002::',16],['3fff::',20]] as const)privateNetworks.addSubnet(network,mask,'ipv6');
const globallyRoutedV6=new BlockList();globallyRoutedV6.addSubnet('2000::',3,'ipv6');
export function isPublicPostAddress({address,family}:LookupAddress):boolean {
 return isIP(address)===family&&(family===4?!privateNetworks.check(address,'ipv4'):globallyRoutedV6.check(address,'ipv6')&&!privateNetworks.check(address,'ipv6'));
}

export const PROJECT_POST_BODY_LIMIT=2*1024*1024;
const responseBodyLimit=8*1024*1024;
const hopByHop=['connection','keep-alive','proxy-authenticate','proxy-authorization','proxy-connection','te','trailer','transfer-encoding','upgrade'];
function cleanHeaders(headers:Record<string,string|string[]|undefined>,remove:string[]=[]):Record<string,string>{
 const namedByConnection=[headers.connection??''].flat().join(',').split(',').map(name=>name.trim().toLowerCase());
 const omit=new Set([...hopByHop,...namedByConnection,...remove]);
 return Object.fromEntries(Object.entries(headers).flatMap(([key,value])=>value!==undefined&&!omit.has(key.toLowerCase())?[[key,Array.isArray(value)?value.join(key==='set-cookie'?'\n':', '):value]]:[]));
}
async function browserResponseBody(body:Buffer,encoding:string|undefined):Promise<Buffer> {
 const kind=encoding?.trim().toLowerCase();
 if(!kind||kind==='identity'||body.length===0)return body;
 return new Promise((resolve,reject)=>{
  const options={maxOutputLength:responseBodyLimit};
  const callback=(error:Error|null,decoded:Buffer)=>error?reject(error):resolve(decoded);
  if(kind==='gzip'||kind==='x-gzip')gunzip(body,options,callback);
  else if(kind==='br')brotliDecompress(body,options,callback);
  else if(kind==='deflate')inflate(body,options,callback);
  else reject(new Error('Unsupported POST response encoding'));
 });
}
export type ProjectPostResponse={kind:'response';status:number;headers:Record<string,string>;body:Buffer}|{kind:'blocked';reason:'project-post-address'|'project-post-redirect'|'project-post-revoked'|'project-post-size'|'project-post-cors';statusCode?:number}|{kind:'failed'};
export interface ProjectPostRequest {method?:'POST'|'OPTIONS';url:URL;headers:Record<string,string>;body:Buffer|null;timeoutMs:number;signal:AbortSignal;canSend:()=>boolean;onDispatch?:()=>void}

/** One explicitly authorized HTTPS hop. DNS is checked and the actual socket uses that same address.
 * Never delegates redirects to an HTTP client or to the browser, and never retries a POST. */
export async function sendProjectPost(input:ProjectPostRequest,dependencies:{lookupAll?:(hostname:string)=>Promise<LookupAddress[]>;request?:typeof request}={}):Promise<ProjectPostResponse>{
 const {url,body,canSend,method='POST'}=input;
 const signal=AbortSignal.any([input.signal,AbortSignal.timeout(Math.max(1,input.timeoutMs))]);
 if((body?.length??0)>PROJECT_POST_BODY_LIMIT||body===null&&Number(input.headers['content-length']??0)>0)return {kind:'blocked',reason:'project-post-size'};
 if(!canSend()||signal.aborted)return {kind:'blocked',reason:'project-post-revoked'};
 let addresses:LookupAddress[];
 try{addresses=await new Promise<LookupAddress[]>((resolve,reject)=>{
  const onAbort=()=>reject(signal.reason);if(signal.aborted){onAbort();return;}signal.addEventListener('abort',onAbort,{once:true});
  (dependencies.lookupAll?.(url.hostname)??lookup(url.hostname,{all:true})).then(resolve,reject).finally(()=>signal.removeEventListener('abort',onAbort)).catch(()=>{});
 });}catch{return {kind:'failed'};}
 if(!addresses.length||addresses.some(address=>!isPublicPostAddress(address)))return {kind:'blocked',reason:'project-post-address'};
 if(!canSend()||signal.aborted)return {kind:'blocked',reason:'project-post-revoked'};
 const pinned=addresses.find(address=>address.family===4)??addresses[0],connector=dependencies.request??request;
 // Browser-native preflight credentials are never mirrored upstream.
 const headers=method==='OPTIONS'?Object.fromEntries(Object.entries(input.headers).filter(([key])=>['origin','access-control-request-method','access-control-request-headers'].includes(key))):cleanHeaders(input.headers,['host','content-length','expect','forwarded','x-forwarded-for','x-forwarded-host','x-forwarded-proto']);
 return new Promise<ProjectPostResponse>(resolve=>{
  if(method==='POST')headers['content-length']=String(body?.length??0);
  headers['accept-encoding']='identity';
  const outgoing=connector(url,{method,headers,agent:false,signal,family:pinned.family,servername:url.hostname,
    lookup:(hostname,_options,callback)=>{
     if(hostname!==url.hostname){callback(Object.assign(new Error('Unexpected POST destination'),{code:'EDESTADDRREQ'}),'',pinned.family);return;}
     callback(null,pinned.address,pinned.family);
    }},response=>{
    const status=response.statusCode??0;
    if(status>=300&&status<400){
     resolve({kind:'blocked',reason:'project-post-redirect',statusCode:status});response.destroy();return;
    }
    if(status<200){resolve({kind:'failed'});response.destroy();return;}
    if(method==='OPTIONS'&&status<300){
     const tokens=(value:string|undefined)=>String(value??'').split(',').map(item=>item.trim()).filter(Boolean);
     const explicitMethods=tokens(response.headers['access-control-allow-methods']);
     const requestedHeaders=tokens(headers['access-control-request-headers']).map(name=>name.toLowerCase());
     const explicitHeaders=tokens(response.headers['access-control-allow-headers']).map(name=>name.toLowerCase());
     // Only the browser decides whether this request's credentials mode needs ACAC.
     // Keep the review's exact-origin, explicitly permitted POST and headers boundary.
     if(!headers.origin||response.headers['access-control-allow-origin']!==headers.origin||!explicitMethods.includes('POST')||!requestedHeaders.every(name=>explicitHeaders.includes(name))){
      resolve({kind:'blocked',reason:'project-post-cors',statusCode:status});response.destroy();return;
     }
    }
    const chunks:Buffer[]=[];let size=0;
    response.on('data',(chunk:Buffer)=>{
     size+=chunk.length;
     if(size>responseBodyLimit){resolve({kind:'blocked',reason:'project-post-size',statusCode:status});response.destroy();return;}
     chunks.push(chunk);
    });
    response.on('error',()=>resolve({kind:'failed'}));
    response.on('aborted',()=>resolve({kind:'failed'}));
    response.on('end',()=>{void browserResponseBody(Buffer.concat(chunks),response.headers['content-encoding']).then(
     body=>resolve({kind:'response',status,headers:cleanHeaders(response.headers,['refresh','content-length','content-encoding',...(method==='OPTIONS'?['set-cookie','set-cookie2']:[])]),body}),
     ()=>resolve({kind:'failed'})
    );});
   });
  outgoing.on('error',()=>resolve({kind:'failed'}));
  // Evaluate the live grant again just before the first POST bytes leave this process.
  if(!canSend()||signal.aborted){resolve({kind:'blocked',reason:'project-post-revoked'});outgoing.destroy();return;}
  if(method==='POST')input.onDispatch?.();outgoing.end(method==='POST'?(body??undefined):undefined);
 });
}
