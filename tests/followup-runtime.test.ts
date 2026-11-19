import test,{type TestContext} from 'node:test';
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {mkdtemp,readdir,readFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createHash} from 'node:crypto';
import {chromium} from 'playwright';
import {inspect} from '../src/core.js';
import {BrowserSession} from '../src/browser.js';
import {closeBrowserLeases,browserLeaseStatus} from '../src/browser-lease.js';
import type {RunSpec,EvaluationResult} from '../src/types.js';
import type {decideFollowup,FollowupDecisionInput,FollowupDecision} from '../src/followup.js';
import type {decideState} from '../src/state-discovery.js';
import {activeReplayModal,deriveReplayDismissalEvidence} from '../src/replay-dismissal.js';
import {runWithOpenAiCompatible} from '../src/review-settings-runtime.js';
import type {FollowupReplayStep} from '../src/followup-types.js';
const evaluation:EvaluationResult={status:'completed',findings:[],screenMap:[],interpretations:[],limitations:[]};
const ready:typeof decideState=async()=>({evaluation,decision:{readiness:'ready',screenState:'content',reason:'Synthetic ready classifier',dismissElementRef:null}});
const page='<!doctype html><html lang="en"><title>Catalog</title><body><main><h1>Product catalog overview</h1><label for="filter">Sort</label><select id="filter" onchange="document.querySelector(\'output\').textContent=this.value===\'Latest\'?\'Newest products ready\':\'Popular products ready\'"><option>Default</option><option>Latest</option><option>Popular</option></select><output>Default</output><p>Products are available for review</p></main><script>window.turnToken=crypto.randomUUID()</script></body></html>';
async function fixture(run:(url:string,root:string)=>Promise<void>,html=page){const server=createServer((_req,res)=>res.setHeader('Content-Type','text/html').end(html));await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve));const address=server.address();assert(address&&typeof address!=='string');const root=await mkdtemp(join(tmpdir(),'followup-runtime-'));try{await run(`http://127.0.0.1:${address.port}/?scope=all#catalog`,root);}finally{await closeBrowserLeases();server.closeAllConnections();await new Promise<void>(resolve=>server.close(()=>resolve()));await rm(root,{recursive:true,force:true});}}
function spec(url:string):RunSpec{return{targetUrl:url,workspaceId:'workspace-one',stateDiscovery:{maxWaitMs:2000},mode:'quick',purpose:'Inspect catalog filters',viewport:{width:800,height:600,deviceScaleFactor:1},allowedActions:[],allowedOrigins:[new URL(url).origin],hasMutationPermission:false,isHeaded:false,shouldWaitForLogin:false,limits:{maxDurationMs:60000,maxObservations:24,maxActions:0,maxToolCalls:40,maxFindings:10},evaluator:'rules-only'};}
function decision(input:FollowupDecisionInput,partial:Partial<FollowupDecision>={}):FollowupDecision{return{phase:'done',reason:'현재 선택 상태와 목록의 전후 근거를 확인했습니다.',answer:'선택한 옵션의 결과를 확인했습니다.',isRestored:true,isSelectedRegionBound:true,isRequestedOptionMissing:false,scopeMode:input.scopeMode,scopeDescription:'필터와 연결된 결과 목록',action:null,scopeSuggestion:{kind:'same-workspace',name:'Catalog',goal:'Inspect catalog filters',reason:'필터 상태 변경'},...partial};}
function followup(base:RunSpec,sourceRunId:string,overrides:Partial<NonNullable<RunSpec['followup']>>={}):RunSpec{return{...base,followup:{requestId:'request-one',workspaceId:'workspace-one',instruction:'Latest 옵션으로 전환한 상태를 확인해줘',source:{reportId:'a'.repeat(64),reportSha256:'b'.repeat(64),runId:sourceRunId,targetUrl:base.targetUrl,viewport:base.viewport},maxOptions:1,...overrides}};}

const dismissReplay:FollowupReplayStep[]=[
 {type:'click',role:'button',label:'Close',dismissMethod:'close-button'},
 {type:'press-escape',role:'dialog',label:'Close modal (Escape)',dismissMethod:'escape'},
 {type:'select-option',role:'combobox',label:'Sort',optionLabel:'Latest'},
];
function dismissExecutionBase(url:string){
 const evidence=dismissReplay.slice(0,2).map((_,replayIndex)=>({replayIndex,modalFingerprint:activeReplayModal(`- dialog "${replayIndex?'Preferences':'Sign-up information'}":`)!.fingerprint}));
 return {reportId:'a'.repeat(64),reportSha256:'b'.repeat(64),runId:'old-run',targetUrl:url,replay:dismissReplay,dismissalEvidence:evidence};
}

test('replay dismissal evidence requires exact saved semantics and one recorded active dialog',()=>{
 const archive={followup:{replay:dismissReplay,history:[
  {type:'click',label:'Close',outcome:'success',beforeObservationId:'signup'},
  {type:'restore-press-escape',label:'Close modal (Escape)',outcome:'success',beforeObservationId:'preferences'},
 ]},observations:[
  {observationId:'signup',accessibilitySnapshot:'- dialog "Sign-up information":\n  - button "Close"'},
  {observationId:'preferences',accessibilitySnapshot:'- dialog "Preferences":'},
 ]};
 assert.deepEqual(deriveReplayDismissalEvidence(archive,dismissReplay),dismissExecutionBase('unused').dismissalEvidence);
 const changed=[{...dismissReplay[0],scopeLabel:'Different panel'},...dismissReplay.slice(1)];
 const ambiguous=structuredClone(archive);
 ambiguous.observations[1].accessibilitySnapshot+='\n- dialog "Another dialog":';
 assert.deepEqual(deriveReplayDismissalEvidence(ambiguous,changed),[]);
});

const replayModalPage=(firstTitle:string,options:{hasSignup?:boolean;hasStuckEscape?:boolean}={})=>page.replace('</body>',`
 <div id="preference" role="dialog" aria-label="${firstTitle}" tabindex="-1" style="position:fixed;z-index:2;top:140px;left:200px;width:320px;background:white;padding:40px">
  <p>${firstTitle}</p><button type="button" onclick="document.querySelector('output').textContent='Wrong preference clicked'">Continue</button>
 </div>
 ${options.hasSignup?'<div id="signup" aria-hidden="true" role="dialog" aria-label="Sign-up information" style="position:fixed;top:140px;left:200px;width:320px;background:white;padding:40px"><p>Sign-up information</p><button type="button" aria-label="Close" onclick="this.parentElement.remove()">×</button></div>':''}
 <script>document.addEventListener('keydown',event=>{
  if(event.key!=='Escape'||${Boolean(options.hasStuckEscape)})return;
  document.getElementById('preference')?.remove();
  document.getElementById('signup')?.removeAttribute('aria-hidden');
 });</script></body>`);

test('replay dismissals restore named popups in current order in Chromium and keep ordinary actions in order',async()=>fixture(async(url,root)=>{
 const base=spec(url);
 const result=await inspect(followup(base,'old-run',{executionBase:dismissExecutionBase(url)}),root,{evaluate:async()=>evaluation,decideState:ready,decideFollowup:async input=>{
  assert(input.candidates.find(candidate=>candidate.label==='Sort')?.selectedLabels.includes('Latest'));
  return{evaluation,decision:decision(input)};
 }});
 const reviewed=result.result.followup!;
 assert.equal(reviewed.status,'completed',JSON.stringify(reviewed));
 assert.deepEqual(reviewed.history.map(item=>item.type),['restore-press-escape','restore-click','restore-select-option']);
 assert.deepEqual(reviewed.restoration.dismissals?.map(({replayIndex,outcome})=>[replayIndex,outcome]),[[1,'dismissed'],[0,'dismissed']]);
 assert.deepEqual(reviewed.replay,dismissReplay);
 assert.equal(reviewed.history[0].beforeObservationId,result.result.observations[0].observationId);
 assert(result.result.observations.at(-1)?.accessibilitySnapshot.includes('Newest products ready'));
},replayModalPage('Preferences',{hasSignup:true})));

const backgroundLoading='<div role="progressbar" aria-label="Background activity">Please wait</div>';
const withEscapeHandler=(html:string,listener:string)=>html.replace('</body>',`<script>document.addEventListener('keydown',event=>{if(event.key==='Escape'){${listener}}});</script></body>`);

test('post-Escape replay skips proven obsolete Close while unrelated loading is still visible',async()=>fixture(async(url,root)=>{
 const result=await inspect(followup(spec(url),'old-run',{executionBase:dismissExecutionBase(url)}),root,{evaluate:async()=>evaluation,decideState:async()=>assert.fail('No preliminary model call'),decideFollowup:async input=>({evaluation,decision:decision(input)})});
 const reviewed=result.result.followup!;
 assert.equal(reviewed.status,'completed',JSON.stringify(reviewed));
 assert.deepEqual(reviewed.history.map(item=>item.type),['restore-press-escape','restore-select-option']);
 const escape=reviewed.history[0];
 const after=result.result.observations.find(item=>item.observationId===escape.afterObservationId);
 assert(after?.accessibilitySnapshot.includes('progressbar "Background activity"'));
 assert.deepEqual(reviewed.restoration.dismissals?.map(({replayIndex,outcome,observationId})=>[replayIndex,outcome,observationId]),[[1,'dismissed',escape.afterObservationId],[0,'obsolete',escape.afterObservationId]]);
 assert(result.result.observations.at(-1)?.accessibilitySnapshot.includes('Newest products ready'));
},withEscapeHandler(replayModalPage('Preferences'),`
 document.body.insertAdjacentHTML('beforeend',${JSON.stringify(backgroundLoading)});
 document.querySelector('select').addEventListener('change',()=>document.querySelector('[role="progressbar"]').remove());
`)));

test('post-Escape replay does not skip Close when a new unnamed popup appears during settling',async t=>fixture(async(url,root)=>{
 const perform=BrowserSession.prototype.performModalAction;
 t.mock.method(BrowserSession.prototype,'performModalAction',async function(this:BrowserSession,...args:Parameters<typeof perform>){
  const record=await perform.apply(this,args);
  await this.page!.locator('body').evaluate(node=>node.insertAdjacentHTML('beforeend','<div role="dialog" style="position:fixed;top:140px;left:200px;width:320px;background:white;padding:40px">Another popup</div>'));
  return record;
 });
 const result=await inspect(followup(spec(url),'old-run',{executionBase:dismissExecutionBase(url)}),root,{decideState:async()=>assert.fail('No preliminary model call'),decideFollowup:async()=>assert.fail('Remaining visible popup must stop replay')});
 const reviewed=result.result.followup!;
 assert.equal(reviewed.status,'partial');
 assert.deepEqual(reviewed.history.map(item=>item.type),['restore-press-escape']);
 assert.deepEqual(reviewed.restoration.dismissals?.map(({replayIndex,outcome})=>[replayIndex,outcome]),[[1,'dismissed'],[0,'blocked']]);
 assert(result.result.observations.at(-1)?.accessibilitySnapshot.includes('Another popup'));
},replayModalPage('Preferences')));

test('post-Escape replay keeps the initial unsettled-absence guard without a successful Escape',async()=>fixture(async(url,root)=>{
 const result=await inspect(followup(spec(url),'old-run',{executionBase:dismissExecutionBase(url)}),root,{decideState:async()=>assert.fail('No preliminary model call'),decideFollowup:async()=>assert.fail('Initial unsettled absence must stop replay')});
 const reviewed=result.result.followup!;
 assert.equal(reviewed.status,'partial');
 assert.deepEqual(reviewed.restoration.dismissals?.map(item=>item.outcome),['blocked']);
 assert.equal(result.result.actions.length,0);
},page.replace('</body>',`${backgroundLoading}</body>`)));

test('post-Escape replay keeps waiting for a Close recorded after Escape',async()=>fixture(async(url,root)=>{
 const base=dismissExecutionBase(url);
 const executionBase={...base,replay:[base.replay[1],base.replay[0],base.replay[2]],dismissalEvidence:base.dismissalEvidence.map(item=>({...item,replayIndex:1-item.replayIndex}))};
 const result=await inspect(followup(spec(url),'old-run',{executionBase}),root,{decideState:async()=>assert.fail('No preliminary model call'),decideFollowup:async()=>assert.fail('A later Close is not obsolete while loading')});
 const reviewed=result.result.followup!;
 assert.equal(reviewed.status,'partial');
 assert.deepEqual(reviewed.history.map(item=>item.type),['restore-press-escape']);
 assert.deepEqual(reviewed.restoration.dismissals?.map(item=>item.outcome),['dismissed','blocked']);
},withEscapeHandler(replayModalPage('Preferences'),`document.body.insertAdjacentHTML('beforeend',${JSON.stringify(backgroundLoading)});`)));

function changePopupDuringCapture(t:TestContext,mode:'transient'|'persistent'|'replaced'){
 const capture=BrowserSession.prototype.capture;
 const probe=BrowserSession.prototype.probeReadiness;
 let hasPendingChange=false;
 t.mock.method(BrowserSession.prototype,'probeReadiness',async function(this:BrowserSession){
  const before=await probe.call(this);
  if(hasPendingChange){
   hasPendingChange=false;
   await this.page!.locator('#preference p').evaluate(node=>node.append(' loading update'));
  }
  return before;
 });
 t.mock.method(BrowserSession.prototype,'capture',async function(this:BrowserSession,...args:Parameters<typeof capture>){
  const isFirstCapture=this.observations.length===0;
  hasPendingChange=isFirstCapture||mode==='persistent';
  const observation=await capture.apply(this,args);
  if(isFirstCapture&&mode==='replaced')await this.page!.locator('#preference').evaluate(node=>node.setAttribute('aria-label','A different popup'));
  return observation;
 });
}

test('popup stability re-observes one transient Chromium layout change before using the same popup',async t=>fixture(async(url,root)=>{
 changePopupDuringCapture(t,'transient');
 const result=await inspect(followup(spec(url),'old-run',{executionBase:dismissExecutionBase(url)}),root,{evaluate:async()=>evaluation,decideState:async()=>assert.fail('No preliminary model call'),decideFollowup:async input=>({evaluation,decision:decision(input)})});
 const reviewed=result.result.followup!;
 const [first,reobserved]=result.result.observations;
 assert.equal(reviewed.status,'completed',JSON.stringify(reviewed));
 assert.deepEqual([first.isStable,reobserved.isStable],[false,true]);
 assert.equal(reviewed.history[0].type,'restore-press-escape');
 assert.equal(reviewed.history[0].beforeObservationId,reobserved.observationId);
},replayModalPage('Preferences')));

for(const mode of ['persistent','replaced'] as const){
 test(`popup stability stops after one failed Chromium re-observation (${mode})`,async t=>fixture(async(url,root)=>{
  changePopupDuringCapture(t,mode);
  const result=await inspect(followup(spec(url),'old-run',{executionBase:dismissExecutionBase(url)}),root,{decideState:async()=>assert.fail('No preliminary model call'),decideFollowup:async()=>assert.fail('No planning after unstable or changed popup')});
  const reviewed=result.result.followup!;
  const [first,reobserved]=result.result.observations;
  assert.equal(reviewed.status,'partial');
  assert.equal(result.result.observations.length,2);
  assert.deepEqual([first.isStable,reobserved.isStable],[false,mode==='replaced']);
  assert.equal(reviewed.afterObservationId,reobserved.observationId);
  assert.equal(reviewed.restoration.dismissals?.[0].observationId,reobserved.observationId);
  assert.equal(result.result.actions.length,0);
  assert.match(reviewed.reason,mode==='replaced'?/팝업이 이전 기록과 일치하지 않아/:/한 번 더 관찰했지만 안정성을/);
 },replayModalPage('Preferences')));
}

test('replay dismissals do not press generic Escape on an unverified visible popup',async()=>fixture(async(url,root)=>{
 const result=await inspect(followup(spec(url),'old-run',{executionBase:dismissExecutionBase(url)}),root,{decideState:async()=>assert.fail('Replay owns the first modal interaction'),decideFollowup:async()=>assert.fail('Unknown modal must stop replay before planning')});
 const reviewed=result.result.followup!;
 assert.equal(reviewed.status,'partial');
 assert.equal(reviewed.needsImageHandoff,true);
 assert.equal(reviewed.restoration.dismissals?.[0].outcome,'blocked');
 assert.equal(result.result.actions.length,0);
 assert(result.result.observations.at(-1)?.accessibilitySnapshot.includes('A different popup'));
},replayModalPage('A different popup')));

test('replay dismissals stop when the exact stored Escape leaves the known popup open',async()=>fixture(async(url,root)=>{
 const result=await inspect(followup(spec(url),'old-run',{executionBase:dismissExecutionBase(url)}),root,{decideState:ready,decideFollowup:async()=>assert.fail('The ordinary action requires successful modal resolution')});
 const reviewed=result.result.followup!;
 assert.equal(reviewed.status,'partial');
 assert.equal(reviewed.needsImageHandoff,true);
 assert.equal(reviewed.restoration.dismissals?.[0].outcome,'blocked');
 assert.equal(reviewed.restoration.dismissals?.[0].replayIndex,1);
 assert.deepEqual(reviewed.history.map(item=>item.type),['restore-press-escape']);
 assert.equal(reviewed.history[0].outcome,'rejected');
 assert.equal(result.result.actions[0].modalInteraction?.hasModalDismissed,false);
},replayModalPage('Preferences',{hasStuckEscape:true})));

test('replay dismissals record absent popups before the unchanged ordinary action',async()=>fixture(async(url,root)=>{
 const result=await inspect(followup(spec(url),'old-run',{executionBase:dismissExecutionBase(url)}),root,{evaluate:async()=>evaluation,decideState:ready,decideFollowup:async input=>({evaluation,decision:decision(input)})});
 const reviewed=result.result.followup!;
 assert.equal(reviewed.status,'completed',JSON.stringify(reviewed));
 assert.deepEqual(reviewed.history.map(item=>item.type),['restore-select-option']);
 assert.deepEqual(reviewed.restoration.dismissals?.map(item=>item.outcome),['obsolete','obsolete']);
}));

test('replay dismissals keep the legacy exact path when no historical evidence is available',async()=>fixture(async(url,root)=>{
 const base={...spec(url),stateDiscovery:undefined};
 const result=await inspect(followup(base,'old-run',{executionBase:{...dismissExecutionBase(url),replay:dismissReplay.slice(1),dismissalEvidence:undefined}}),root,{evaluate:async()=>evaluation,decideFollowup:async input=>({evaluation,decision:decision(input)})});
 const reviewed=result.result.followup!;
 assert.equal(reviewed.status,'completed',JSON.stringify(reviewed));
 assert.deepEqual(reviewed.history.map(item=>item.type),['restore-press-escape','restore-select-option']);
 assert.equal(reviewed.restoration.dismissals,undefined);
},replayModalPage('Preferences')));

test('replay dismissals block exact legacy Escape when conflicting proof is explicitly recorded',async()=>fixture(async(url,root)=>{
 const executionBase={...dismissExecutionBase(url),replay:dismissReplay.slice(1),dismissalEvidence:undefined,dismissalConflicts:[0]};
 const result=await inspect(followup(spec(url),'old-run',{executionBase}),root,{decideState:async()=>assert.fail('Conflicting history must also suppress preliminary modal actions'),decideFollowup:async()=>assert.fail('Conflicting history must stop before ordinary action')});
 const reviewed=result.result.followup!;
 assert.equal(reviewed.status,'partial');
 assert.equal(reviewed.needsImageHandoff,true);
 assert.deepEqual(reviewed.restoration.dismissals,[{replayIndex:0,outcome:'blocked',observationId:reviewed.afterObservationId}]);
 assert.match(reviewed.reason,/일치하지 않아/);
 assert.equal(result.result.actions.length,0);
},replayModalPage('Preferences')));

for(const hasBlockedBackground of [false,true]){
test(`follow-up repairs one unreadable HTTP 200 output and independently evaluates restored selection${hasBlockedBackground?' with blocked background traffic':''}`,async()=>fixture(async(url,root)=>{
 const plannerDone={phase:'done',reason:'최신 결과 확인',answer:'최신 결과가 준비되었습니다.',isRestored:true,isSelectedRegionBound:true,isRequestedOptionMissing:false,scopeMode:'related-screen',scopeDescription:'최신 필터 결과',action:null,scopeSuggestion:{kind:'same-workspace',name:'Catalog',goal:'Review catalog',reason:'같은 목록'}};
 const requests:{stage:string;content:string;instructions:string}[]=[];
 const server=createServer(async(req,res)=>{
  const chunks:Buffer[]=[];for await(const part of req)chunks.push(part);
  const body=JSON.parse(Buffer.concat(chunks).toString('utf8'));
  const content:string=body.messages[1].content[0].text;
  const stage=body.response_format.json_schema.schema.properties.phase?'planner':'review';
  requests.push({stage,content,instructions:body.messages[0].content});
  const observed=JSON.parse(content.split('\n')[0]).observations;
  const text=requests.length===1?'fixture-private-malformed {"phase":':JSON.stringify(stage==='planner'?plannerDone:{
   findings:[],screenMap:observed.map((observation:{observationId:string;screenshotRefs:string[]})=>({observationId:observation.observationId,sections:[{sectionId:'catalog',label:'Catalog',elementRefs:[],evidenceIds:observation.screenshotRefs,visibleSummary:'The latest state of the catalog shows product results.'}]})),interpretations:[],limitations:[],
  });
  res.setHeader('Content-Type','application/json').end(JSON.stringify({model:'fixture-model',choices:[{finish_reason:'stop',message:{content:text}}],usage:{prompt_tokens:20,completion_tokens:5}}));
 });
 await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve));
 try{
  const address=server.address();assert(address&&typeof address!=='string');
  const base:RunSpec={...spec(url),stateDiscovery:undefined,evaluator:'openai-compatible',model:'fixture-model',strategy:'A',evaluationBudget:{initialTimeoutSeconds:10,repairTimeoutSeconds:2,stageTimeoutSeconds:20}};
  const executionBase={reportId:'a'.repeat(64),reportSha256:'b'.repeat(64),runId:'old-run',targetUrl:url,replay:[dismissReplay[2]]};
  const {result,runDir}=await runWithOpenAiCompatible({baseUrl:`http://127.0.0.1:${address.port}/v1`,apiFormat:'chat',apiKey:'fixture-private-key'},()=>inspect(followup(base,'old-run',{executionBase}),root));
  assert.equal(result.status,hasBlockedBackground?'partial':'completed',JSON.stringify(result.followup));
  assert.equal(result.evaluation.status,'completed');
  if(hasBlockedBackground)assert.match(result.followup!.reason,/데이터 요청이 차단되어/);
  assert.equal(result.followup?.restoration.hasReplayedSavedSteps,true);
  assert.deepEqual(result.followup?.history.map(item=>item.type),['restore-select-option']);
  assert.deepEqual(requests.map(item=>item.stage),['planner','planner','review']);
  assert.match(requests[0].instructions,/phase=done and action=null without taking another action/);
  assert.match(requests[1].content,/previous response did not contain a usable structured object/);
  assert(requests[2].content.includes('Newest products ready'));
  const calls=result.evaluation.calls!;
  assert.deepEqual(calls.map(call=>[call.stage,call.status,call.failureCode,call.isRepair]),[['followup-action','failed','invalid-output-json',false],['followup-action','completed',undefined,true],['A-discovery','completed',undefined,false]]);
  assert.equal(result.evaluation.usage?.outputTokens,15);
  const transport=await readFile(join(runDir,`provider-transport-${calls[0].callId}.json`),'utf8');
  assert.equal(JSON.parse(transport).responseOutcome,'invalid-output-json');
  assert.doesNotMatch(transport,/fixture-private/);
  const candidateFiles=(await readdir(runDir)).filter(name=>name.startsWith('candidates-'));
  assert.equal(candidateFiles.length,1);
  assert.equal(JSON.parse(await readFile(join(runDir,candidateFiles[0]),'utf8')).stage,'A-discovery');
 }finally{
  server.closeAllConnections();
  await new Promise<void>(resolve=>server.close(()=>resolve()));
 }
},hasBlockedBackground?page.replace('</body>',`<script>document.querySelector('select').addEventListener('change',()=>{fetch('/analytics',{method:'POST',body:'fixture'}).catch(()=>{});});</script></body>`):page));
}

for(const hasExtraUnknownBlock of [false,true]){
 test(`blocked telemetry stays unsent and keeps its action evidence${hasExtraUnknownBlock?' while a later unknown request still blocks completion':''}`,async t=>fixture(async(url,root)=>{
  // A test-only denying proxy guarantees the synthetic traffic cannot reach a public endpoint.
  let vendorConnections=0;
  const proxy=createServer((_req,res)=>res.writeHead(502).end());
  proxy.on('connect',(req,socket)=>{if(req.url?.startsWith('browser-intake-us5-datadoghq.com:'))vendorConnections++;socket.destroy();});
  await new Promise<void>(resolve=>proxy.listen(0,'127.0.0.1',resolve));
  try{
   const address=proxy.address();assert(address&&typeof address!=='string');
   const launch=chromium.launch.bind(chromium);
   t.mock.method(chromium,'launch',(options?:Parameters<typeof launch>[0])=>launch({...options,proxy:{server:`http://127.0.0.1:${address.port}`,bypass:'127.0.0.1'}}));
   const base={...spec(url),stateDiscovery:undefined,projectPostPolicy:{projectId:'fixture-project',hosts:['api.fixture.test']}};
   const executionBase={reportId:'a'.repeat(64),reportSha256:'b'.repeat(64),runId:'old-run',targetUrl:url,replay:[dismissReplay[2]]};
   const result=await inspect(followup(base,'old-run',{executionBase}),root,{evaluate:async()=>evaluation,decideFollowup:async input=>({evaluation,decision:decision(input)})});
   const reviewed=result.result.followup!;
   assert.equal(result.result.status,hasExtraUnknownBlock?'partial':'completed',JSON.stringify(reviewed));
   assert.equal(result.result.evaluation.status,'completed');
   assert.equal(vendorConnections,0);
   assert(result.result.limitations.some(item=>/Telemetry request blocked.*datadog-rum/.test(item)));
   const network=reviewed.history[0].network!;
   assert(network.requests.some(item=>item.method==='POST'&&item.telemetry==='datadog-rum'&&item.outcome==='blocked'));
   assert(network.requests.some(item=>item.method==='OPTIONS'&&item.telemetry==='datadog-rum'&&item.outcome==='blocked'));
   assert(!JSON.stringify(network).includes('private-fixture'));
   if(hasExtraUnknownBlock){
    assert.match(reviewed.reason,/데이터 요청이 차단되어/);
    assert(result.result.coverage.unmetChecks.some(check=>check.checkId==='unblocked-environment'));
   }
  }finally{
   proxy.closeAllConnections();
   await new Promise<void>(resolve=>proxy.close(()=>resolve()));
  }
 },page.replace('</body>',`
 <script>
 document.querySelector('select').addEventListener('change',async()=>{
  const send=(url,type)=>fetch(url,{method:'POST',headers:{'Content-Type':type},body:'{}'}).catch(()=>{});
  const rum='https://browser-intake-us5-datadoghq.com/api/v2/rum?value=private-fixture';
  await send(rum,'text/plain');
  await send(rum,'application/json');
  if(${hasExtraUnknownBlock}){
   await Promise.all(Array.from({length:32},()=>send(rum,'text/plain')));
   await send('https://browser-intake-us5-datadoghq.com/api/v2/unrecognized','text/plain');
  }
 });
 </script></body>`)));
}

test('follow-up uses retained physical context, current refs and fresh run evidence for a real select',async()=>fixture(async(url,root)=>{
 const base=spec(url);base.limits.maxDurationMs=1200000;base.evaluator='openai-compatible';base.strategy='A';base.evaluationBudget={initialTimeoutSeconds:960,repairTimeoutSeconds:180,stageTimeoutSeconds:1170};const initial=await inspect(base,root,{evaluate:async()=>evaluation,decideState:ready});const original=await readFile(join(initial.runDir,'report.json'));let calls=0;let plannerRemaining=0;
 const planner:typeof decideFollowup=async input=>{calls++;plannerRemaining=input.timeoutMs;const candidate=input.candidates.find(candidate=>candidate.label==='Sort');assert(candidate);if(calls===1){assert(candidate.options.includes('Latest'));return{evaluation,decision:decision(input,{phase:'act',action:{elementRef:candidate.elementRef,optionLabel:'Latest'}})};}assert(candidate.selectedLabels.includes('Latest'));assert(input.observations.at(-1)!.accessibilitySnapshot.includes('Newest products ready'));return{evaluation,decision:decision(input)};};
 let hasReviewed=false;const result=await inspect(followup(base,initial.result.runId),root,{evaluate:async input=>{hasReviewed=true;assert(plannerRemaining<=1200000);assert(input.timeoutMs<plannerRemaining);assert(input.timeoutMs>0);assert.equal(input.observations.length,1);const current=input.observations[0];assert(current.accessibilitySnapshot.includes('Newest products ready'));assert(input.evidence.every(ref=>ref.runId===input.runId));const finding={issueId:'actual-screen-finding',layer:'L1',category:'feedback',title:'Synthetic finding from final screen review',disposition:'confirmed',observedFacts:[],expectations:[],reasoning:'Fixture',userImpact:'Fixture',severity:'minor',confidence:'high',confidenceRationale:'Fixture',evidenceIds:[current.screenshotRefs[0]],observationIds:[current.observationId],reproductionSteps:[],recommendation:'Fixture',hasFailureObservation:false,failureAttribution:null,attributionEvidenceIds:[],needsFurtherVerification:false,claimEvidenceLinks:[]} as const;return{...evaluation,findings:[{...finding,observedFacts:[],expectations:[],evidenceIds:[...finding.evidenceIds],observationIds:[...finding.observationIds],reproductionSteps:[],attributionEvidenceIds:[],claimEvidenceLinks:[]}]};},decideState:ready,decideFollowup:planner});assert(hasReviewed);assert.equal(result.result.findings[0]?.issueId,'actual-screen-finding');assert.equal(JSON.parse(await readFile(join(result.runDir,'report.json'),'utf8')).findings[0].issueId,'actual-screen-finding');assert.equal(result.result.followup?.status,'completed',JSON.stringify(result.result.followup));assert.equal(result.result.followup.restoration.status,'reused');assert.equal(result.result.followup.history.length,1);assert.equal(result.result.followup.history[0].type,'select-option');assert.equal(result.result.followup.state?.url,url);assert(result.result.observations.at(-1)!.accessibilitySnapshot.includes('Newest products ready'));assert.deepEqual(await readFile(join(initial.runDir,'report.json')),original);assert(result.result.evidence.every(item=>item.runId===result.result.runId));assert.notEqual(initial.result.runId,result.result.runId);assert.equal(browserLeaseStatus().idleCount,1);
}));
test('missing explicitly requested option stops without substitution or browser actions',async()=>fixture(async(url,root)=>{
 const base=spec(url);const initial=await inspect(base,root,{evaluate:async()=>evaluation,decideState:ready});const result=await inspect(followup(base,initial.result.runId,{instruction:'Choose Missing option'}),root,{evaluate:async()=>evaluation,decideState:ready,decideFollowup:async input=>{assert(!input.candidates.some(candidate=>candidate.options.includes('Missing')));return{evaluation,decision:decision(input,{phase:'stop',isRequestedOptionMissing:true,reason:'명시한 Missing 옵션이 없어 중단했습니다.'})};}});assert.equal(result.result.followup?.status,'partial');assert.equal(result.result.followup.history.length,0);assert.match(result.result.followup.reason,/옵션/);assert.equal(result.result.actions.length,0);
}));
test('a recovered browser replays semantic choices after eviction, never old element refs',async()=>fixture(async(url,root)=>{
 const base=spec(url);const initial=await inspect(base,root,{evaluate:async()=>evaluation,decideState:ready});await closeBrowserLeases();const result=await inspect(followup(base,initial.result.runId,{executionBase:{reportId:'a'.repeat(64),reportSha256:'b'.repeat(64),runId:initial.result.runId,targetUrl:url,replay:[{type:'select-option',role:'combobox',label:'Sort',optionLabel:'Popular'}]}}),root,{evaluate:async()=>evaluation,decideState:ready,decideFollowup:async input=>{assert(input.candidates.find(candidate=>candidate.label==='Sort')?.selectedLabels.includes('Popular'));return{evaluation,decision:decision(input)};}});assert.equal(result.result.followup?.restoration.status,'replayed');assert.equal(result.result.followup.status,'completed');assert.equal(result.result.followup.history[0].type,'restore-select-option');
}));
test('restoration failure stops and requests image handoff without downstream clicks',async()=>fixture(async(url,root)=>{
 const base=spec(url);const result=await inspect(followup(base,'old-run',{executionBase:{reportId:'a'.repeat(64),reportSha256:'b'.repeat(64),runId:'old-run',targetUrl:url,replay:[{type:'click',role:'button',label:'Missing old control'}]}}),root,{evaluate:async()=>evaluation,decideState:ready,decideFollowup:async()=>{assert.fail('No model action is allowed after replay failure');}});assert.equal(result.result.followup?.restoration.status,'failed');assert.equal(result.result.followup.needsImageHandoff,true);assert.equal(result.result.followup.status,'partial');assert.equal(result.result.actions.length,0);assert.equal(browserLeaseStatus().idleCount,0);
}));
test('external cancellation aborts a pending planner and closes its physical browser',async()=>fixture(async(url,root)=>{
 const controller=new AbortController();const base=spec(url);const result=await inspect(followup(base,'old-run'),root,{signal:controller.signal,decideState:ready,decideFollowup:async input=>{controller.abort();assert.equal(input.signal?.aborted,true);return{evaluation,decision:decision(input)};}});assert.equal(result.result.status,'cancelled');assert.equal(result.result.followup?.status,'cancelled');assert.equal(browserLeaseStatus().activeCount,0);assert.equal(browserLeaseStatus().idleCount,0);
}));

test('real controls exclude dangerous options, account links and sensitive forms while retaining ordinary filters',async()=>fixture(async(url,root)=>{
 const {BrowserSession}=await import('../src/browser.js');const {Budget}=await import('../src/policy.js');const {EvidenceStore}=await import('../src/evidence.js');const {FollowupBrowser}=await import('../src/followup-browser.js');const config=spec(url);const session=new BrowserSession(config,new Budget(config),new EvidenceStore('safety',root));const browser=new FollowupBrowser(session);
 try{await session.start();const observation=await session.capture();const candidates=await browser.candidates(observation);assert.deepEqual(candidates.find(candidate=>candidate.label==='Filter')?.options,['All','Latest']);assert(candidates.some(candidate=>candidate.label==='Category A'));assert(candidates.some(candidate=>candidate.label==='Available'&&candidate.role==='checkbox'));for(const label of ['Log out','Sign out','Continue','Proceed'])assert(!candidates.some(candidate=>candidate.label===label),label);
 const filter=candidates.find(candidate=>candidate.label==='Filter')!;await session.page!.locator('option').nth(1).evaluate(element=>element.textContent='Delete account');await assert.rejects(browser.perform(observation,filter.elementRef,'Latest'),/changed|exist/);
 }finally{await browser.clear();await session.close();}
},'<!doctype html><html><body><h1>Catalog</h1><label>Filter<select><option>All</option><option>Latest</option><option>Delete account</option><option>Payment</option></select></label><button>Category A</button><label><input type="checkbox">Available</label><a href="/logout">Log out</a><a href="/sign-out">Sign out</a><form action="/consent"><p>Privacy consent</p><button type="button">Continue</button></form><form><button>Proceed</button></form></body></html>'));

test('ordinary button filters cannot exceed the representative option limit',async()=>fixture(async(url,root)=>{
 let calls=0;const result=await inspect(followup(spec(url),'old-run'),root,{evaluate:async()=>evaluation,decideState:ready,decideFollowup:async input=>{const label=++calls===1?'Category A':'Category B';const candidate=input.candidates.find(candidate=>candidate.label===label)!;return{evaluation,decision:decision(input,{phase:'act',action:{elementRef:candidate.elementRef,optionLabel:null}})};}});assert.equal(result.result.followup?.history.length,1);assert.equal(result.result.followup.status,'partial');assert.match(result.result.followup.reason,/옵션/);assert.equal(result.result.actions.length,1);
},'<!doctype html><html><body><h1>Catalog</h1><button aria-controls="results" onclick="document.querySelector(\'output\').textContent=\'A results\'">Category A</button><button onclick="document.querySelector(\'output\').textContent=\'B results\'">Category B</button><output id="results">All results</output></body></html>'));

test('explicit selected-only review sends a crop without outside text or original baseline to final evaluation',async()=>fixture(async(url,root)=>{
 const base=spec(url);const initial=await inspect(base,root,{evaluate:async()=>evaluation,decideState:ready});const image=initial.result.evidence.find(ref=>ref.kind==='screenshot')!;let hasReviewed=false;
 assert(initial.result.rules.some(rule=>rule.ruleVersion==='form-row-1'));
 const configured=followup(base,initial.result.runId,{instruction:'선택 영역만 검토해줘',sourceImagePath:image.absolutePath,source:{reportId:'a'.repeat(64),reportSha256:'b'.repeat(64),runId:initial.result.runId,targetUrl:url,viewport:base.viewport,image:{reportId:'a'.repeat(64),runId:initial.result.runId,observationId:image.observationId,evidenceId:image.evidenceId,sha256:image.sha256,width:800,height:600,screenshot:{coordinateSpace:'viewport-css-pixels',clip:{x:0,y:0,width:800,height:600},deviceScaleFactor:1}}},region:{x:0,y:0,width:300,height:120}});
 const result=await inspect(configured,root,{evaluate:async input=>{hasReviewed=true;assert.equal(input.observations.length,1);assert(!JSON.stringify(input.observations).includes('Outside secret unrelated section'));assert(input.evidence.every(ref=>ref.observationId!=='source-baseline'));assert(input.evidence.every(ref=>ref.kind==='screenshot'&&ref.screenshot?.clip.width===300));assert.equal(input.canRequestObservation,false);return evaluation;},decideState:ready,decideFollowup:async input=>({evaluation,decision:decision(input,{scopeDescription:'선택 영역만'})})});assert(hasReviewed);assert.equal(result.result.followup?.scopeMode,'selected-only');const unbound=await inspect({...configured,followup:{...configured.followup!,requestId:'unbound'}},root,{evaluate:async()=>{assert.fail('Unbound selected region must not be evaluated');},decideState:ready,decideFollowup:async input=>({evaluation,decision:decision(input,{isSelectedRegionBound:false})})});assert.equal(unbound.result.followup?.status,'partial');assert.equal(unbound.result.followup.needsImageHandoff,true);assert.equal(unbound.result.actions.length,0);
 assert(!result.result.rules.some(rule=>rule.ruleVersion==='form-row-1'));
 assert(!result.result.observations.some(observation=>observation.deterministicChecks?.alignment?.checks.some(check=>check.formPair)));
},`<!doctype html><html><body>
 <section style="position:absolute;left:10px;top:10px;width:200px;height:80px">Selected content</section>
 <section style="position:absolute;left:400px;top:200px">Outside secret unrelated section
 <form style="display:flex;align-items:start;gap:12px;font:16px/1.6 sans-serif">
 <label style="display:grid;gap:8px">Key <input type="password" value="private" style="box-sizing:border-box;height:44px;border:1px solid #777;background:white"></label>
 <button type="button" style="margin-top:25px;height:44px;border:1px solid #777;background:white">Delete</button>
 </form></section>
 </body></html>`));

test('a restored URL or heading mismatch stops before any new planner decision',async()=>fixture(async(url,root)=>{
 const base=spec(url);const result=await inspect(followup(base,'old-run',{executionBase:{reportId:'a'.repeat(64),reportSha256:'b'.repeat(64),runId:'old-run',targetUrl:url,state:{url:url.replace('scope=all','scope=missing'),anchors:['Product catalog overview']}}}),root,{decideState:ready,decideFollowup:async()=>{assert.fail('A different restored query is not the requested execution base');}});assert.equal(result.result.followup?.restoration.status,'failed');assert.equal(result.result.followup.needsImageHandoff,true);assert.equal(result.result.actions.length,0);
}));
test('cancellation during final screen review remains cancelled and closes retained resources',async()=>fixture(async(url,root)=>{
 const controller=new AbortController();const result=await inspect(followup(spec(url),'old-run'),root,{signal:controller.signal,decideState:ready,decideFollowup:async input=>({evaluation,decision:decision(input)}),evaluate:async input=>{controller.abort();assert(input.signal?.aborted);return evaluation;}});assert.equal(result.result.followup?.status,'cancelled');assert.equal(result.result.status,'cancelled');assert.equal(browserLeaseStatus().activeCount,0);assert.equal(browserLeaseStatus().idleCount,0);
}));
test('an unexpected final evaluator exception releases the browser rather than caching an interrupted context',async()=>fixture(async(url,root)=>{
 const result=await inspect(followup(spec(url),'old-run'),root,{decideState:ready,decideFollowup:async input=>({evaluation,decision:decision(input)}),evaluate:async()=>{throw new Error('Synthetic provider exception');}});assert.equal(result.result.status,'partial');assert.equal(result.result.followup?.status,'partial');assert.equal(browserLeaseStatus().activeCount,0);assert.equal(browserLeaseStatus().idleCount,0);assert.match(result.result.terminationReason!,/Synthetic provider/);
}));

test('current explicit Close is allowed inside a signup dialog and does not consume the one option budget',async()=>fixture(async(url,root)=>{
 const base=spec(url);delete base.stateDiscovery;let calls=0;const result=await inspect(followup(base,'old-run'),root,{evaluate:async()=>evaluation,decideFollowup:async input=>{calls++;assert(!input.candidates.some(candidate=>candidate.label==='가입하고 혜택 받기'));assert(!input.candidates.some(candidate=>candidate.label==='취소'));if(calls===1){const close=input.candidates.find(candidate=>candidate.label==='Close'&&candidate.dismissMethod==='close-button');assert(close);return{evaluation,decision:decision(input,{isRestored:false,phase:'act',action:{elementRef:close.elementRef,optionLabel:null}})};}if(calls===2){const latest=input.candidates.find(candidate=>candidate.label==='Latest');assert(latest);return{evaluation,decision:decision(input,{phase:'act',action:{elementRef:latest.elementRef,optionLabel:null}})};}assert(input.observations.at(-1)!.accessibilitySnapshot.includes('Newest results'));return{evaluation,decision:decision(input)};}});assert.equal(result.result.followup?.status,'completed',JSON.stringify(result.result.followup));assert.equal(result.result.followup.history.length,2);assert.deepEqual(result.result.followup.history.map(step=>step.label),['Close','Latest']);assert.equal(result.result.actions.length,2);assert.equal(result.result.followup.replay[0].dismissMethod,'close-button');
},'<!doctype html><html><body><h1>Catalog</h1><button onclick="document.querySelector(\'output\').textContent=\'Newest results\'">Latest</button><output>Default results</output><p>Product catalog content is prepared and available for review.</p><div role="dialog" style="position:fixed;inset:0;background:white"><p>회원가입 안내, 첫 결제, 친구 초대</p><button aria-label="Close" onclick="this.parentElement.remove()">×</button><button>가입하고 혜택 받기</button><button>취소</button></div></body></html>'));

test('registered current dialog Escape dismisses safely while stale Close and account actions stay denied',async()=>fixture(async(url,root)=>{
 const {BrowserSession}=await import('../src/browser.js');const {Budget}=await import('../src/policy.js');const {EvidenceStore}=await import('../src/evidence.js');const {FollowupBrowser}=await import('../src/followup-browser.js');const config=spec(url),session=new BrowserSession(config,new Budget(config),new EvidenceStore('dismiss',root)),browser=new FollowupBrowser(session);
 try{await session.start();const observation=await session.capture();let candidates=await browser.candidates(observation);assert(candidates.some(candidate=>candidate.dismissMethod==='escape'));assert(!candidates.some(candidate=>candidate.label==='Join'));const close=candidates.find(candidate=>candidate.dismissMethod==='close-button')!;await session.page!.getByRole('button',{name:'Close',exact:true}).evaluate(element=>element.setAttribute('aria-label','Delete account'));await assert.rejects(browser.perform(observation,close.elementRef),/changed/);candidates=await browser.candidates(observation);const escape=candidates.find(candidate=>candidate.dismissMethod==='escape')!;const action=await browser.perform(observation,escape.elementRef);assert.equal(action.record.outcome,'success');assert.equal(action.record.type,'press');assert.equal(action.replay.type,'press-escape');assert.equal(await session.page!.getByRole('dialog').count(),0);
 }finally{await browser.clear();await session.close();}
},'<!doctype html><html><body><h1>Catalog</h1><div role="dialog" style="position:fixed;inset:0;background:white"><p>Account payment consent</p><button aria-label="Close">×</button><button>Join</button></div><script>document.addEventListener("keydown",e=>{if(e.key==="Escape")document.querySelector("[role=dialog]").remove()})</script></body></html>'));
