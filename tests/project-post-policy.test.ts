import assert from 'node:assert/strict';
import {createServer,request as httpRequest} from 'node:http';
import type {RequestOptions} from 'node:https';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {gzipSync} from 'node:zlib';
import {test} from 'node:test';
import {BrowserSession} from '../src/browser.js';
import {acquireBrowserLease,closeBrowserLeases} from '../src/browser-lease.js';
import {EvidenceStore} from '../src/evidence.js';
import {Budget,validateSpec} from '../src/policy.js';
import {assertNativePreflightPatch,isPublicPostAddress,normalizeProjectPostHost,projectPostLeaseKey,sendProjectPost} from '../src/post-host-policy.js';
import type {RunSpec} from '../src/types.js';

function spec(url:string):RunSpec {
 return {targetUrl:url,mode:'quick',purpose:'Synthetic HTTPS POST fixture',viewport:{width:800,height:600,deviceScaleFactor:1},allowedActions:[],allowedOrigins:[new URL(url).origin],hasMutationPermission:false,isHeaded:false,shouldWaitForLogin:false,limits:{maxDurationMs:30000,maxObservations:12,maxActions:0,maxToolCalls:30,maxFindings:10},evaluator:'rules-only'};
}
test('project hosts reject URL syntax, path, wildcard, address literals and private network ranges',()=>{
 assert.equal(normalizeProjectPostHost(' API.Example.com '),'api.example.com');
 for(const candidate of ['https://api.example.com','*.example.com','a..example.com','api.example.com.','api.example.com:443','api.example.com?test','api.example.com#x','api.example.com/users','10.1.1.1','127.1','[::1]','foo.local','host.internal','foo.home.arpa','user@api.example.com','localhost'])assert.equal(normalizeProjectPostHost(candidate),undefined,candidate);
 for(const [address,family] of [['127.0.0.1',4],['169.254.169.254',4],['100.100.100.200',4],['192.168.1.1',4],['::ffff:127.0.0.1',6],['fd00:ec2::254',6],['fe80::1234',6],['64:ff9b::7f00:1',6],['2001:db8::1',6]] as const)assert.equal(isPublicPostAddress({address,family}),false,address);
 assert.equal(isPublicPostAddress({address:'8.8.8.8',family:4}),true);
 assert.equal(isPublicPostAddress({address:'2606:4700::1111',family:6}),true);
 const base=spec('https://fixture.test/');validateSpec({...base,projectPostPolicy:{projectId:'a',hosts:['api.fixture.test']}});
 assert.throws(()=>validateSpec({...base,hasMutationPermission:true,projectPostPolicy:{projectId:'a',hosts:['api.fixture.test']}}),/canonical exact DNS/);
});

test('Chromium consumes real project CORS preflights and does not send denied POSTs',async()=>{
 const appOrigin='https://www.post-fixture.test',host='api.post-fixture.test';
 const received:{method?:string;path?:string;cookie?:string;body:string;headers:string|undefined;origin:string|undefined}[]=[];
 const server=createServer((req,res)=>{
  const chunks:Buffer[]=[];req.on('data',chunk=>chunks.push(chunk));req.on('end',()=>{
   received.push({method:req.method,path:req.url,cookie:req.headers.cookie,body:Buffer.concat(chunks).toString(),headers:req.headers['access-control-request-headers'] as string|undefined,origin:req.headers.origin});
   const hasAllowedResponse=req.url!=='/no-cors-response';
   if(hasAllowedResponse){res.setHeader('access-control-allow-origin',appOrigin);if(!req.url?.startsWith('/credentialless'))res.setHeader('access-control-allow-credentials','true');}
   if(req.method==='OPTIONS'){
    if(req.url==='/options-redirect'){res.writeHead(307,{location:'https://unapproved.post-fixture.test/writes'}).end();return;}
    if(req.url==='/wrong-origin')res.setHeader('access-control-allow-origin','https://foreign.test');
    if(req.url==='/wildcard-preflight')res.setHeader('access-control-allow-origin','*');
    if(req.url==='/no-origin-preflight')res.removeHeader('access-control-allow-origin');
    if(req.url!=='/no-preflight')res.setHeader('access-control-allow-headers',req.url==='/wildcard-header'?'*':'content-type, connect-protocol-version, x-filter');
    res.setHeader('access-control-allow-methods',req.url==='/no-post-method'?'GET':req.url==='/wildcard-method'?'*':'POST');res.writeHead(204).end();return;
   }
   if(req.url==='/redirect'){res.writeHead(307,{location:'https://unapproved.post-fixture.test/writes'}).end();return;}
   if(req.url==='/redirect-same'){res.writeHead(308,{location:`https://${host}/second-write`}).end();return;}
   if(req.url==='/hang')return;
   if(req.url==='/zip-limit'){res.setHeader('content-encoding','gzip');res.end(gzipSync(Buffer.alloc(9*1024*1024)));return;}
   res.setHeader('content-type','application/json');res.setHeader('content-encoding','gzip');
   res.setHeader('set-cookie',['new-cookie=one; Path=/; Secure; SameSite=Lax','another-cookie=two; Path=/; Secure; SameSite=Lax']);
   res.end(gzipSync(JSON.stringify({count:11})));
  });
 });
 await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve));const address=server.address();assert(address&&typeof address!=='string');
 const root=await mkdtemp(join(tmpdir(),'project-post-policy-'));const startup=`http://127.0.0.1:${address.port}/index`;
 const current={...spec(startup),allowedOrigins:[new URL(startup).origin,appOrigin],projectPostPolicy:{projectId:'project-test',hosts:[host,'private.post-fixture.test']}};
 let hasGrant=true;
 const transportRequest=(url:URL,options:RequestOptions,onResponse:Parameters<typeof httpRequest>[2])=>{
  assert.equal(url.hostname,host,'unapproved/auth redirects and private addresses must never reach the connector');
  assert.equal(options.servername,host);assert.equal(options.agent,false);assert.equal(options.family,4);
  (options.lookup as unknown as (host:string,options:object,callback:(error:Error|null,address:string,family:number)=>void)=>void)(host,{},(error,pinned,pinnedFamily)=>{assert.ifError(error);assert.equal(pinned,'8.8.8.8');assert.equal(pinnedFamily,4);});
  return httpRequest(`http://127.0.0.1:${address.port}${url.pathname}${url.search}`,{method:options.method,headers:options.headers,signal:options.signal},onResponse);
 };
 const session=new BrowserSession(current,new Budget(current),new EvidenceStore('project-post',root),undefined,{
  canSendProjectPost:(projectId,hostname)=>hasGrant&&projectId==='project-test'&&current.projectPostPolicy.hosts.includes(hostname),
  sendProjectPost:input=>sendProjectPost({...input,timeoutMs:input.url.pathname==='/hang'?150:input.timeoutMs},{lookupAll:async hostname=>hostname.startsWith('private.')?[{address:'8.8.8.8',family:4},{address:'127.0.0.1',family:4}]:[{address:'8.8.8.8',family:4}],request:transportRequest as typeof import('node:https').request}),
 });
 try{
  await session.start();
  await session.context!.route('https://**.post-fixture.test/**',async route=>{
   const url=new URL(route.request().url());
   if(url.origin===appOrigin&&route.request().method()==='GET'){await route.fulfill({body:'<!doctype html><title>Project fixture</title>',contentType:'text/html'});return;}
   await route.fallback();
  });
  await session.page!.goto(appOrigin);
  const fetchPost=(destination:string,method='POST',credentials:RequestCredentials='include')=>session.page!.evaluate(async({destination,method,credentials})=>{
   try{const result=await fetch(destination,{method,credentials,headers:{'content-type':'application/json','connect-protocol-version':'1','x-filter':'allowed'},body:'{"filter":"latest"}'});return {status:result.status,body:await result.json()};}catch{return null;}
  },{destination,method,credentials});
  session.actionNetwork.begin('credentialless',10000);
  assert.deepEqual(await fetchPost(`https://${host}/credentialless-read`,'POST','same-origin'),{status:200,body:{count:11}});
  assert.equal(await fetchPost(`https://${host}/credentialless-denied`),null,'include(empty) must fail before POST egress');
  assert.deepEqual(received.filter(item=>item.path?.startsWith('/credentialless')).map(item=>[item.path,item.method,item.cookie]),[['/credentialless-read','OPTIONS',undefined],['/credentialless-read','POST',undefined],['/credentialless-denied','OPTIONS',undefined]]);
  const native=session.actionNetwork.finish('credentialless')!;
  assert(native.requests.some(item=>item.resourceType==='preflight'&&item.statusCode===204));
  assert.equal(native.requests.filter(item=>item.method==='POST'&&item.policyAllowance==='project-post-host').length,1);
  // The credentialless cross-site response must not set cookies. Test a separately valid include next.
  assert.equal((await session.context!.cookies(`https://${host}`)).length,0);
  await session.context!.addCookies([{name:'fixture-session',value:'browser-only',url:`https://${host}/`,sameSite:'Lax',secure:true}]);
  session.actionNetwork.begin('action-1',10000);
  assert.deepEqual(await fetchPost(`https://${host}/api/products?filter=latest`),{status:200,body:{count:11}});
  const cookies=await session.context!.cookies(`https://${host}`);
  assert(cookies.some(cookie=>cookie.name==='new-cookie'&&cookie.value==='one'));
  assert(cookies.some(cookie=>cookie.name==='another-cookie'&&cookie.value==='two'));
  const ok=session.actionNetwork.finish('action-1')!;
  assert.equal(ok.requests.find(item=>item.method==='POST')?.policyAllowance,'project-post-host');
  assert.equal(ok.requests.find(item=>item.method==='POST')?.statusCode,200);
  assert.doesNotMatch(JSON.stringify(ok),/browser-only|latest|x-filter|new-cookie|another-cookie/);
  const sentPost=received.find(item=>item.method==='POST'&&item.path==='/api/products?filter=latest')!;
  assert.equal(sentPost.cookie,'fixture-session=browser-only');assert.equal(sentPost.body,'{"filter":"latest"}');
  assert.deepEqual(received.filter(item=>item.method==='OPTIONS'&&item.path==='/api/products?filter=latest').map(item=>[item.path,item.headers,item.cookie]),[['/api/products?filter=latest','connect-protocol-version,content-type,x-filter',undefined]]);
  for(const path of ['no-preflight','wrong-origin','no-origin-preflight','wildcard-preflight','no-post-method','wildcard-method','wildcard-header','options-redirect']){
   assert.equal(await fetchPost(`https://${host}/${path}`),null,path);
   assert(!received.some(item=>item.path===`/${path}`&&item.method==='POST'),path);
  }
  assert.equal(await fetchPost(`https://${host}/zip-limit`),null);
  assert.equal(await fetchPost(`https://${host}/hang`),null);
  assert.equal(received.filter(item=>item.path==='/hang'&&item.method==='POST').length,1,'a timed out POST must not be retried');

  assert.equal(await fetchPost(`https://${host}/no-cors-response`),null,'fulfill must not invent upstream CORS headers');
  for(const path of ['redirect','redirect-same']){
   session.actionNetwork.begin(path,10000);
   assert.equal(await fetchPost(`https://${host}/${path}`),null,path);
   const redirect=session.actionNetwork.finish(path)!.requests.find(item=>item.method==='POST')!;
   assert.equal(redirect.outcome,'blocked');assert.equal(redirect.blockReason,'project-post-redirect');assert([307,308].includes(redirect.statusCode??0));
  }
  assert(!received.some(item=>item.path==='/writes'||item.path==='/second-write'));
  const postCount=received.filter(item=>item.method==='POST').length;
  assert.equal(await fetchPost('https://unapproved.post-fixture.test/api/products'),null);
  assert.equal(await fetchPost('https://private.post-fixture.test/api/products'),null);
  assert.equal(await fetchPost(`https://${host}/api/products`,'PUT'),null);
  assert.equal(await fetchPost(`https://${host}:444/api/products`),null);
  hasGrant=false;assert.equal(await fetchPost(`https://${host}/api/products`),null);
  assert.equal(received.filter(item=>item.method==='POST').length,postCount);
  await assert.rejects(assertNativePreflightPatch(join(root,'missing-coreBundle.js')),/installed Playwright native CORS patch/);
 }finally{await session.close();server.closeAllConnections();await new Promise<void>(resolve=>server.close(()=>resolve()));await rm(root,{force:true,recursive:true});}
});

test('a warm browser lease does not cross a changed project policy or mode',async()=>{
 let isClosed=false;
 const physical={browser:{isConnected:()=>!isClosed,close:async()=>{isClosed=true;}},page:{isClosed:()=>isClosed}} as unknown as NonNullable<Awaited<ReturnType<typeof acquireBrowserLease>>['physical']>;
 const key=(projectId:string,hosts:string[])=>projectPostLeaseKey({projectId,hosts});
 assert.equal(key('a',['a.example.com','b.example.com']),key('a',['b.example.com','a.example.com']));
 assert.notEqual(key('a',['api.fixture.test']),key('b',['api.fixture.test']));
 try{
  const first=await acquireBrowserLease('screen',undefined,undefined,key('a',['api.fixture.test']));
  await first.release(physical,'run-a',true);
  const second=await acquireBrowserLease('screen','run-a',undefined,key('b',['api.fixture.test']));
  assert.equal(second.physical,undefined);assert.equal(isClosed,true);await second.release(undefined,'run-b',false);
 }finally{await closeBrowserLeases();}
});
