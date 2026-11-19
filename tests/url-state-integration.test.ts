import test from 'node:test';
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {mkdtemp,rm,readFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {inspect} from '../src/core.js';
import type {RunSpec,EvaluationResult} from '../src/types.js';
import type {StateDecisionInput,StateDecision} from '../src/state-discovery.js';
const evaluation:EvaluationResult={status:'completed',findings:[],screenMap:[],interpretations:[],limitations:[]};
async function fixture(html:string,run:(url:string,root:string)=>Promise<void>){
 const server=createServer((_request,response)=>{response.setHeader('Content-Type','text/html; charset=utf-8');response.end(html);});
 await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve));const address=server.address();assert(address&&typeof address!=='string');const root=await mkdtemp(join(tmpdir(),'url-state-integration-'));
 try{await run(`http://127.0.0.1:${address.port}`,root);}finally{server.closeAllConnections();await new Promise<void>(resolve=>server.close(()=>resolve()));await rm(root,{recursive:true,force:true});}
}
function spec(url:string):RunSpec{return{targetUrl:url,mode:'quick',viewport:{width:700,height:700,deviceScaleFactor:1},allowedActions:[],allowedOrigins:[new URL(url).origin],hasMutationPermission:false,isHeaded:false,shouldWaitForLogin:false,limits:{maxDurationMs:30000,maxObservations:8,maxActions:0,maxToolCalls:30,maxFindings:10},evaluator:'rules-only',stateDiscovery:{maxWaitMs:5000,maxDismissals:1}};}
const select=(input:StateDecisionInput):StateDecision=>({readiness:input.readinessProbe.hasVisibleModal?'blocked':'ready',screenState:input.readinessProbe.hasVisibleModal?'blocked':'content',reason:'Synthetic state classifier',dismissElementRef:input.dismissCandidates[0]?.elementRef??null});

test('URL orchestration preserves initial loading and delayed real content as distinct evidence',async()=>fixture('<!doctype html><html lang="en"><title>Delayed</title><body><main><p role="status" id="loading">Loading…</p></main><script>setTimeout(()=>{document.querySelector("main").innerHTML="<h1 id=products>Actual products</h1><p>Product A</p>"},1400)</script></body></html>',async(url,root)=>{
 const runSpec=spec(url);runSpec.stateDiscovery!.readySelector='#products';runSpec.stateDiscovery!.loadingSelector='#loading';
 let decisionCalls=0;const {result,runDir}=await inspect(runSpec,root,{evaluate:async()=>evaluation,decideState:async input=>{decisionCalls++;assert(input.hasSettled);assert(input.observations[0].accessibilitySnapshot.includes('Actual products'));return{decision:select(input),evaluation};}});
 assert.equal(decisionCalls,1);assert.equal(result.stateDiscovery?.status,'completed');assert.equal(result.status,'completed');assert(result.observations[0].accessibilitySnapshot.includes('Loading'));assert(result.observations.at(-1)?.accessibilitySnapshot.includes('Product A'));assert.notEqual(result.observations[0].screenshotRefs[0],result.observations.at(-1)?.screenshotRefs[0]);
 const stored=JSON.parse(await readFile(join(runDir,'report.json'),'utf8'));assert.equal(stored.stateDiscovery.status,'completed');assert.equal(stored.observations[0].state.readiness,'loading');
}));

test('URL orchestration records the readiness deadline separately from a completed AI evaluation',async()=>fixture('<!doctype html><html lang="en"><title>Ready catalog</title><body><main><h1>Products</h1><p>All products are visible now.</p></main></body></html>',async(url,root)=>{
 const runSpec=spec(url);
 runSpec.stateDiscovery={readySelector:'main',maxWaitMs:1000};
 const {result,runDir}=await inspect(runSpec,root,{evaluate:async()=>evaluation,decideState:async input=>{
  assert.equal(input.hasSettled,false);
  assert.equal(input.readinessProbe.hasRequiredReadyHint,true);
  assert.equal(input.readinessProbe.hasLoadingSignal,false);
  return{decision:select(input),evaluation};
 }});
 assert.equal(result.status,'partial');
 assert.equal(result.evaluation.status,'completed');
 assert.equal(result.evaluation.failureCode,undefined);
 assert.equal(result.stateDiscovery?.reasonCode,'wait-limit');
 assert.equal(result.stateDiscovery?.maxWaitMs,1000);
 assert.deepEqual(result.coverage.unmetChecks.map(check=>check.checkId),['url-state-discovery']);
 const stored=JSON.parse(await readFile(join(runDir,'report.json'),'utf8'));
 assert.equal(stored.stateDiscovery.reasonCode,'wait-limit');
}));

test('URL orchestration lets AI select a current DOM close ref and records modal before and after',async()=>fixture('<!doctype html><html lang="en"><title>Modal</title><body><main><h1>Products</h1><p>Product A</p></main><dialog open><h2>Guide</h2><button type="button" onclick="this.closest(\'dialog\').remove()">닫기</button></dialog></body></html>',async(url,root)=>{
 const {result}=await inspect(spec(url),root,{evaluate:async()=>evaluation,decideState:async input=>({decision:select(input),evaluation})});
 assert.equal(result.stateDiscovery?.status,'completed',JSON.stringify({discovery:result.stateDiscovery,actions:result.actions}));assert.equal(result.stateDiscovery.dismissalCount,1);assert.equal(result.actions.length,1);assert.equal(result.actions[0].outcome,'success');assert(result.actions[0].beforeObservationId);assert(result.actions[0].afterObservationId);assert(result.observations.some(observation=>observation.state?.readiness==='blocked'));assert(result.observations.some(observation=>observation.state?.label==='팝업 닫기 직후'));assert.equal(result.stateDiscovery.modalExploration?.history[0].method,'close-button');assert(result.observations.at(-1)?.accessibilitySnapshot.includes('Products'));
}));

test('URL orchestration keeps read-only data failures partial despite a ready model answer',async()=>fixture('<!doctype html><html lang="en"><title>Blocked data</title><body><main><h1>Products</h1><p id="data">Waiting for data</p></main><script>fetch("/query",{method:"POST",body:"{}"}).catch(()=>{})</script></body></html>',async(url,root)=>{
 const {result}=await inspect(spec(url),root,{evaluate:async()=>evaluation,decideState:async input=>({decision:select(input),evaluation})});
 assert.equal(result.evaluation.status,'completed');assert.equal(result.stateDiscovery?.status,'partial');assert.equal(result.status,'partial');assert.equal(result.coverage.canFinish,false);assert(result.stateDiscovery.blockedRequests.some(request=>request.method==='POST'&&request.resourceType==='fetch'));assert.match(result.stateDiscovery.reason,/데이터 요청/);assert.equal(result.stateDiscovery.reasonCode,undefined);
}));

test('URL discovery keeps historical embedded-frame coverage unmet after the frame disappears',async()=>fixture('<!doctype html><html lang="en"><title>Transient frame</title><body><main><h1>Product overview</h1><p>Product catalog is available</p><iframe title="External widget" src="about:blank"></iframe></main><script>setTimeout(()=>document.querySelector("iframe").remove(),1400)</script></body></html>',async(url,root)=>{
 const {result}=await inspect(spec(url),root,{evaluate:async()=>evaluation,decideState:async input=>({decision:select(input),evaluation})});
 assert(result.observations[0].unsupportedFrames>0);assert.equal(result.observations.at(-1)?.unsupportedFrames,0);assert.equal(result.stateDiscovery?.status,'completed');assert.equal(result.status,'partial');assert(result.coverage.unmetChecks.some(check=>check.checkId==='embedded-frame-content'));
}));

test('state discovery refreshes same-size content changed during the model decision',async()=>fixture('<!doctype html><html lang="en"><title>Race</title><body><main style="width:600px;height:200px"><h1>Before product catalog</h1><p>Initial product content remains visible here</p></main></body></html>',async(url,root)=>{
 const {BrowserSession}=await import('../src/browser.js');const {Budget,computeCoverage}=await import('../src/policy.js');const {EvidenceStore}=await import('../src/evidence.js');const {discoverStates}=await import('../src/state-discovery.js');
 const runSpec=spec(url),store=new EvidenceStore('race',root),session=new BrowserSession(runSpec,new Budget(runSpec),store);let calls=0;
 try{await session.start();await session.capture();const collected=await discoverStates(session,()=>({runId:'race',runDir:root,spec:runSpec,observations:session.observations,rules:[],actions:session.actions,evidence:store.evidence,coverage:computeCoverage([],new Map(),new Map(),false),timeoutMs:20000,canRequestObservation:false}),async input=>{
  calls++;if(calls===1)await session.page!.locator('main').evaluate(element=>{element.innerHTML='<h1>Updated product catalog</h1><p>Changed product content remains visible here</p>';});else assert(input.observations[0].accessibilitySnapshot.includes('Updated product catalog'));
  return{decision:select(input),evaluation};
 });assert.equal(calls,2);assert.equal(collected.result.status,'completed');assert(session.observations[0].accessibilitySnapshot.includes('Before product catalog'));assert(session.observations.at(-1)?.accessibilitySnapshot.includes('Updated product catalog'));assert(session.observations.length>=3);
 }finally{await session.close();}
}));

test('modal environment executes fresh preference and continue refs while preserving test evidence',async()=>fixture('<!doctype html><html lang="en"><title>Test choice</title><body><main><h1>Product catalog overview</h1><p>Products are ready for inspection</p></main><div role="dialog" aria-label="Choose a category"><h2>Choose a category</h2><button type="button" onclick="this.setAttribute(\'aria-pressed\',\'true\');document.querySelector(\'#continue\').disabled=false">Both</button><button id="continue" type="button" disabled onclick="this.closest(\'[role=dialog]\').remove()">Start</button></div></body></html>',async(url,root)=>{
 const {BrowserSession}=await import('../src/browser.js');const {Budget}=await import('../src/policy.js');const {EvidenceStore}=await import('../src/evidence.js');
 const runSpec=spec(url);runSpec.limits.maxObservations=24;const session=new BrowserSession(runSpec,new Budget(runSpec),new EvidenceStore('test-choice',root));
 try{await session.start();const initial=await session.capture(),context=await session.getModalActionContext(initial.observationId);assert(context);const choice=context.actions.find(action=>action.label==='Both');assert(choice?.elementRef);assert(!context.actions.some(action=>action.type==='continue'),'Disabled continue is not offered');
 const selected=await session.performModalAction(initial.observationId,'preference',choice.elementRef,1);assert.equal(selected.outcome,'success');assert.equal(selected.modalInteraction?.buttonLabel,'Both');assert.equal(selected.modalInteraction?.hasModalDismissed,false);
 await assert.rejects(session.performModalAction(initial.observationId,'preference',choice.elementRef,1),/current registered observation/);
 const next=session.observations.at(-1)!,fresh=await session.getModalActionContext(next.observationId);const entry=fresh?.actions.find(action=>action.type==='continue');assert(entry?.elementRef);const entered=await session.performModalAction(next.observationId,'continue',entry.elementRef,1);assert.equal(entered.outcome,'success');assert.equal(entered.modalInteraction?.hasModalDismissed,true);assert(entered.afterObservationId);assert.equal(await session.page!.locator('[role=dialog]').count(),0);
 }finally{await session.close();}
}));

test('modal environment recovers the exact original query in a fresh context after rejected navigation',async()=>fixture('<!doctype html><html lang="en"><title>Recovery</title><body><main><h1>Catalog inspection context</h1><p>Original content remains available</p></main><div role="dialog" aria-label="Pick topic"><h2>Pick topic</h2><button type="button" onclick="localStorage.setItem(\'test-choice\',\'selected\');location.href=\'/unexpected\'">Start</button></div></body></html>',async(url,root)=>{
 const {BrowserSession}=await import('../src/browser.js');const {Budget}=await import('../src/policy.js');const {EvidenceStore}=await import('../src/evidence.js');const original=url+'/?scope=all';const runSpec=spec(original);const session=new BrowserSession(runSpec,new Budget(runSpec),new EvidenceStore('recover-choice',root));
 try{await session.start();const initial=await session.capture(),context=await session.getModalActionContext(initial.observationId),entry=context?.actions.find(action=>action.type==='continue');assert(entry?.elementRef);
 const action=await session.performModalAction(initial.observationId,'continue',entry.elementRef,1);assert.equal(action.modalInteraction?.hasRedirected,true);assert.equal(action.outcome,'rejected');const previousPage=session.page;
 const recovered=await session.recoverOriginalModalTarget();assert.notEqual(session.page,previousPage);assert.equal(session.page!.url(),original);assert.equal(await session.page!.evaluate(()=>localStorage.getItem('test-choice')),null);assert.equal(recovered.url,new URL(original).origin+'/','Recorded URL redaction is preserved');assert(session.observations.length>=3);
 }finally{await session.close();}
}));

test('AI modal discovery retries another current choice after redirect and reaches real content',async()=>fixture('<!doctype html><html lang="en"><title>AI exploration</title><body><main><h1>Catalog overview</h1><p>Real product information is available</p></main><div role="dialog" aria-label="Choose topic"><h2>Choose topic</h2><button type="button" onclick="window.testChoice=\'Both\';document.querySelector(\'#start\').disabled=false">Both</button><button type="button" onclick="window.testChoice=\'First\';document.querySelector(\'#start\').disabled=false">First</button><button id="start" type="button" disabled onclick="if(window.testChoice===\'Both\'){location.href=\'/other\'}else{this.closest(\'[role=dialog]\').remove()}">Start</button></div></body></html>',async(url,root)=>{
 const runSpec=spec(url+'/?scope=all');runSpec.limits.maxDurationMs=60000;runSpec.limits.maxObservations=24;runSpec.limits.maxToolCalls=40;runSpec.stateDiscovery={maxWaitMs:15000,modalExploration:{maxAttempts:3}};let hasSeenFailedChoice=false;
 const {result}=await inspect(runSpec,root,{evaluate:async()=>evaluation,decideState:async input=>{
  if(!input.modalContext)return{decision:select(input),evaluation};
  const actions=input.modalContext.actions,history=input.modalHistory??[];
  if(input.attempt===2){assert((input.failedChoices?.length??0)>0);hasSeenFailedChoice=true;assert(input.failedChoices!.some(choice=>JSON.parse(choice)[1].includes('Both')));if(actions.some(action=>action.type==='preference'))assert(actions.some(action=>action.type==='preference'&&action.label==='Both'));}
  const hasSelected=history.some(action=>action.attempt===input.attempt&&action.method==='preference');
  const action=actions.find(action=>action.type==='close-button'||action.type==='escape'||action.type==='backdrop')??(hasSelected?actions.find(action=>action.type==='continue'):actions.find(action=>action.type==='preference'&&(input.attempt!==2||action.label==='First')));
  assert(action,'A fresh registered action must be available');
  return{decision:{readiness:'blocked',screenState:'blocked',reason:'Synthetic model chooses minimal registered action',dismissElementRef:null,nextAction:{type:action.type,elementRef:action.elementRef,reason:'Use the next untried action'}},evaluation};
 }});
 assert(hasSeenFailedChoice);assert.equal(result.stateDiscovery?.modalExploration?.status,'completed',JSON.stringify(result.stateDiscovery));assert.equal(result.stateDiscovery.modalExploration.attempts,2);assert.equal(result.stateDiscovery.status,'completed',JSON.stringify(result.stateDiscovery));assert.equal(result.status,'partial','A rejected navigation remains an explicit environment limitation after recovery');assert(result.coverage.unmetChecks.some(check=>check.checkId==='unblocked-environment'));assert(result.stateDiscovery.modalExploration.history.some(action=>action.hasRedirected));assert.deepEqual(result.stateDiscovery.modalExploration.history.filter(action=>action.method==='preference').map(action=>action.buttonLabel),['Both','First']);assert(result.observations.some(observation=>observation.state?.label.includes('원래 URL 새 세션')));assert(result.observations.at(-1)?.accessibilitySnapshot.includes('Real product information'));assert(!result.observations.at(-1)?.accessibilitySnapshot.includes('Choose topic'));
}));

test('AI modal discovery gives up at the configured retry bound with redirect evidence',async()=>fixture('<!doctype html><html lang="en"><title>Bounded exploration</title><body><main><h1>Catalog overview</h1><p>Original product content</p></main><div role="dialog" aria-label="Choose topic"><h2>Choose topic</h2><button type="button" onclick="document.querySelector(\'#start\').disabled=false">First</button><button id="start" type="button" disabled onclick="location.href=\'/unexpected\'">Start</button></div></body></html>',async(url,root)=>{
 const runSpec=spec(url+'/?scope=all');runSpec.limits.maxObservations=24;runSpec.limits.maxToolCalls=40;runSpec.stateDiscovery={maxWaitMs:15000,modalExploration:{maxAttempts:1}};
 const {result}=await inspect(runSpec,root,{evaluate:async()=>evaluation,decideState:async input=>{
  const actions=input.modalContext?.actions??[],hasSelected=input.modalHistory?.some(action=>action.method==='preference');const action=actions.find(action=>action.type==='escape'||action.type==='backdrop')??(hasSelected?actions.find(action=>action.type==='continue'):actions.find(action=>action.type==='preference'));assert(action);
  return{decision:{readiness:'blocked',screenState:'blocked',reason:'Bounded test',dismissElementRef:null,nextAction:{type:action.type,elementRef:action.elementRef,reason:'Try next action'}},evaluation};
 }});
 assert.equal(result.status,'partial');assert.equal(result.stateDiscovery?.modalExploration?.status,'gave-up');assert.equal(result.stateDiscovery.modalExploration.attempts,1);assert.match(result.stateDiscovery.modalExploration.reason,/한도/);assert.equal(result.stateDiscovery.modalExploration.history.filter(action=>action.hasRedirected).length,1);assert(!result.observations.some(observation=>observation.state?.label.includes('원래 URL 새 세션')));assert(result.actions.every(action=>action.afterObservationId));
}));

test('modal preference opt-out removes selection and continue candidates while retaining Escape',async()=>fixture('<!doctype html><html lang="en"><title>Opt out</title><body><main><h1>Catalog overview</h1><p>Actual product content</p></main><div role="dialog" aria-label="Choose topic"><h2>Choose topic</h2><button type="button">First</button><button type="button">Start</button></div></body></html>',async(url,root)=>{
 const {BrowserSession}=await import('../src/browser.js');const {Budget}=await import('../src/policy.js');const {EvidenceStore}=await import('../src/evidence.js');const runSpec=spec(url);runSpec.stateDiscovery!.modalExploration={canChoosePreferences:false};const session=new BrowserSession(runSpec,new Budget(runSpec),new EvidenceStore('opt-out',root));
 try{await session.start();const observed=await session.capture(),context=await session.getModalActionContext(observed.observationId);assert(context);assert(context.actions.some(action=>action.type==='escape'));assert(!context.actions.some(action=>['preference','continue'].includes(action.type)));await assert.rejects(session.performModalAction(observed.observationId,'preference','e1',1),/not registered/);assert.equal(session.actions.length,0);}finally{await session.close();}
}));
