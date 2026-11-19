import assert from 'node:assert/strict';
import {createServer,type ServerResponse} from 'node:http';
import {mkdtemp,readFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {test} from 'node:test';
import type {Request,Response} from 'playwright';
import {ActionNetworkRecorder} from '../src/action-network.js';
import {inspect} from '../src/core.js';
import {closeBrowserLeases} from '../src/browser-lease.js';
import type {FollowupDecision} from '../src/followup.js';
import type {EvaluationResult,RunSpec} from '../src/types.js';

const evaluation:EvaluationResult={status:'completed',findings:[],screenMap:[],interpretations:[],limitations:[]};

test('follow-up records a blocked POST and distinguishes HTTP and transport failure from older in-flight requests',async()=>{
 let oldResponse:ServerResponse|undefined,receivedPosts=0,completedOld=false;
 const server=createServer((req,res)=>{
  const path=new URL(req.url!,'http://localhost').pathname;
  if(req.method==='POST')receivedPosts++;
  switch(path){
   case '/api/feed':oldResponse=res;return;
   case '/api/catalog':oldResponse?.end('old request completed after action');completedOld=Boolean(oldResponse);res.writeHead(503).end('temporary error');return;
   case '/api/latest':res.socket!.destroy();return;
   case '/api/data':return; // request deliberately never receives a response
   default:res.setHeader('Content-Type','text/html').end(`<!doctype html><html><body><main>
   <h1>Catalog fixtures</h1><button>Latest</button><output>Initial products are available</output>
   </main><script>
   const run=(path,init)=>fetch(path,init).catch(()=>{});
   run('/api/feed');
   document.querySelector('button').onclick=()=>{
    document.querySelector('output').textContent='Newest products are selected';
    run('/api/v1/graphql/97e07b9d-0df1-4be7-b7cc-8e08a3a84bb2/alice/%73ecret/sess_PersonalToken?apiKey=privateQuery#privateFragment',{method:'POST',headers:{Authorization:'Bearer privateHeader'},body:'privateBody'});
    run('/api/catalog?token=privateToken');
    setTimeout(()=>run('/api/latest?token=privateToken'),400);
    run('/api/data');
   };
   </script></body></html>`);
  }
 });
 await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve));const address=server.address();assert(address&&typeof address!=='string');
 const root=await mkdtemp(join(tmpdir(),'action-network-'));
 try{
  const targetUrl=`http://127.0.0.1:${address.port}/`,workspaceId='network-fixture';
  const spec:RunSpec={targetUrl,workspaceId,mode:'quick',purpose:'Inspect a filter',viewport:{width:800,height:600,deviceScaleFactor:1},allowedActions:[],allowedOrigins:[new URL(targetUrl).origin],hasMutationPermission:false,isHeaded:false,shouldWaitForLogin:false,limits:{maxDurationMs:30000,maxObservations:12,maxActions:0,maxToolCalls:30,maxFindings:10},evaluator:'rules-only',followup:{requestId:'request',workspaceId,instruction:'Choose Latest',source:{reportId:'a'.repeat(64),reportSha256:'b'.repeat(64),runId:'parent',targetUrl},maxOptions:1}};
  let decisions=0;
  const run=await inspect(spec,root,{evaluate:async()=>evaluation,decideFollowup:async input=>{
   const isFirst=++decisions===1;const latest=input.candidates.find(item=>item.label==='Latest')!;
   assert(latest);assert(input.history.every(step=>step.network===undefined),'diagnostics are not included in the model prompt');
   const decision:FollowupDecision={phase:isFirst?'act':'stop',reason:'Fixture',answer:'Fixture',isRestored:true,isSelectedRegionBound:true,isRequestedOptionMissing:false,scopeMode:'related-screen',scopeDescription:'Catalog',action:isFirst?{elementRef:latest.elementRef,optionLabel:null}:null,scopeSuggestion:{kind:'same-workspace',name:'Catalog',goal:'Catalog filter',reason:'Same screen'}};
   return {decision,evaluation};
  }});
  assert.equal(receivedPosts,0,'diagnostics must not relax the existing POST policy');assert.equal(completedOld,true);
  const step=run.result.followup?.history[0];assert.equal(step?.outcome,'success');
  const network=step?.network;assert(network);assert(network.settledObservationId);assert.notEqual(network.settledObservationId,step.afterObservationId);
  assert.equal(network.droppedRequestCount,0);assert.equal(network.requests.length,4);
  for(const item of network.requests){
   assert(item.startedAt>=network.startedAt&&item.startedAt<=network.endedAt);
   if(item.endedAt)assert(item.endedAt>=item.startedAt&&item.endedAt<=network.endedAt);
  }
  const blocked=network.requests.find(item=>item.method==='POST')!;
  assert.equal(blocked.outcome,'blocked');assert.equal(blocked.blockReason,'read-only-method');assert.equal(blocked.statusCode,undefined);
  assert.equal(blocked.origin,new URL(targetUrl).origin);assert.equal(blocked.path,'/api/v1/graphql/[redacted]/[redacted]/[redacted]/[redacted]');
  assert.equal(network.requests.find(item=>item.path==='/api/catalog')?.outcome,'response');assert.equal(network.requests.find(item=>item.path==='/api/catalog')?.statusCode,503);
  const failed=network.requests.find(item=>item.path==='/api/latest');
  assert.equal(failed?.outcome,'failed');assert.match(failed?.failureCode??'',/^net::ERR_/);
  assert.equal(network.requests.find(item=>item.path==='/api/data')?.outcome,'pending');
  const persisted=JSON.parse(await readFile(join(run.runDir,'report.json'),'utf8')).followup.history[0].network;
  assert.deepEqual(persisted,network);assert.doesNotMatch(JSON.stringify(persisted),/97e07b9d|alice|%73ecret|PersonalToken|private|\/api\/feed/);
 }finally{await closeBrowserLeases();server.closeAllConnections();await new Promise<void>(resolve=>server.close(()=>resolve()));await rm(root,{force:true,recursive:true});}
});

test('recorder bounds evidence and ignores late replies and redirects from prior action windows',()=>{
 const make=(url:string,redirectedFrom?:Request)=>({url:()=>url,method:()=> 'GET',resourceType:()=> 'fetch',redirectedFrom:()=>redirectedFrom??null}) as unknown as Request;
 const reply=(request:Request,status=200)=>({request:()=>request,status:()=>status}) as unknown as Response;
 const recorder=new ActionNetworkRecorder('https://www.example.test/');
 recorder.begin('first',5000);
 const earlier=make('https://api.example.test/api/feed');
 recorder.request(earlier);const first=recorder.finish('first')!;
 recorder.begin('second',5000);
 recorder.response(reply(earlier));
 recorder.request(make('https://api.example.test/api/latest',earlier));
 const current=make('https://private-tenant.third.test/api/%61pi/users/alice?auth=very-secret');
 recorder.request(current);recorder.response(reply(current,404));
 for(let i=0;i<34;i++)recorder.request(make('https://api.example.test/api/graphql'));
 const second=recorder.finish('second')!;
 assert.equal(first.requests[0].outcome,'pending');assert.equal(second.requests.length,32);assert.equal(second.droppedRequestCount,3);
 assert.equal(second.requests[0].origin,'https://[other-host]');assert.equal(second.requests[0].path,'/api/[redacted]/[redacted]/[redacted]');assert.equal(second.requests[0].statusCode,404);
 assert.equal(second.requests[1].origin,'https://api.example.test');
 assert.doesNotMatch(JSON.stringify(second),/third\.test|alice|very-secret|\/api\/(feed|latest)/);
});
