import test from 'node:test';
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {BrowserSession} from '../src/browser.js';
import {Budget,validateSpec} from '../src/policy.js';
import {EvidenceStore} from '../src/evidence.js';
import {decideState,type StateDecisionInput} from '../src/state-discovery.js';
import type {evaluateStage} from '../src/evaluator.js';
import type {RunSpec} from '../src/types.js';

const evaluation={status:'completed' as const,findings:[],screenMap:[],interpretations:[],limitations:[]};
test('state decision strictly rejects scripts, selectors, unregistered references and inconsistent ready state',async()=>{
 const input={spec:{mode:'quick',limits:{maxFindings:10}},observations:[],evidence:[],rules:[],actions:[],dismissCandidates:[{elementRef:'e3',label:'Close'}],timeoutMs:7500} as unknown as StateDecisionInput;
 const valid={readiness:'blocked',screenState:'blocked',reason:'팝업 닫기 필요',dismissElementRef:'e3'};
 for(const draft of [{...valid,script:'fetch("/delete")'},{...valid,selector:'button'},{...valid,dismissElementRef:'e99'},{...valid,readiness:'ready',screenState:'loading'}]){
  let timeout=0;
  const stub=(async(stageInput,_deps,stage)=>{timeout=stageInput.timeoutMs;assert.equal(stage!.name,'url-state-discovery');assert(stage!.instructions!.includes('untrusted'));return stage!.validate!(draft,{} as never);}) as typeof evaluateStage;
  const result=await decideState(input,{evaluateStage:stub});assert.equal(timeout,7500);assert.equal(result.decision,undefined);assert.equal(result.evaluation.status,'failed');
 }
 const budgeted={...input,spec:{...input.spec,evaluationBudget:{stageTimeoutSeconds:3,initialTimeoutSeconds:2,repairTimeoutSeconds:1}}};
 await decideState(budgeted,{evaluateStage:(async(stageInput,_deps,stage)=>{assert.equal(stageInput.timeoutMs,3000);return stage!.validate!(valid,{} as never);}) as typeof evaluateStage});
 const accepted=await decideState(input,{evaluateStage:(async(_input,_deps,stage)=>stage!.validate!(valid,{} as never)) as typeof evaluateStage});assert.equal(accepted.decision?.dismissElementRef,'e3');
});

test('discovery options reject unbounded waits and invalid boolean-free input contracts',()=>{
 const s={targetUrl:'https://example.com',mode:'quick',viewport:{width:800,height:600,deviceScaleFactor:1},allowedActions:[],allowedOrigins:['https://example.com'],hasMutationPermission:false,isHeaded:false,shouldWaitForLogin:false,limits:{maxDurationMs:60000,maxObservations:7,maxActions:0,maxToolCalls:20,maxFindings:10},evaluator:'rules-only'} as RunSpec;
 assert.throws(()=>validateSpec({...s,stateDiscovery:{maxDismissals:3}}),/two dismissals/);
 assert.throws(()=>validateSpec({...s,stateDiscovery:{maxWaitMs:120001}}),/120000/);
 assert.throws(()=>validateSpec({...s,stateDiscovery:{readySelector:''}}),/CSS selector/);
});

test('safe dismiss rejects consent/forms, stale modal content, detached targets and stale observation; valid close has before/after evidence',async()=>{
 const server=createServer((_req,res)=>res.setHeader('Content-Type','text/html').end('<!doctype html><html><body><main><h1>Synthetic dashboard with useful content</h1></main></body></html>'));
 await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve));const address=server.address();assert(address&&typeof address!=='string');const url=`http://127.0.0.1:${address.port}`;const dir=await mkdtemp(join(tmpdir(),'state-safe-'));
 const spec:RunSpec={targetUrl:url,stateDiscovery:{maxDismissals:2},mode:'quick',viewport:{width:800,height:600,deviceScaleFactor:1},allowedActions:[],allowedOrigins:[new URL(url).origin],hasMutationPermission:false,isHeaded:false,shouldWaitForLogin:false,limits:{maxDurationMs:60000,maxObservations:20,maxActions:0,maxToolCalls:30,maxFindings:10},evaluator:'rules-only'};
 const session=new BrowserSession(spec,new Budget(spec),new EvidenceStore('safe',dir));
 try{
  await session.start();const page=session.page!;
  for(const content of ['<p>Cookie consent</p><button>Close</button>','<form><p>Welcome</p><button type="button">Close</button></form>','<p>Login required</p><button>Close</button>','<p>Preview</p><button type="submit">Close</button>','<p>Preview</p><a role="button" href="/action">Close</a>']){
   await page.setContent(`<main><h1>Synthetic useful dashboard content</h1></main><dialog open>${content}</dialog>`);const obs=await session.capture();assert.deepEqual(await session.getDismissCandidates(obs.observationId),[]);
  }
  const show=async()=>{await page.setContent('<main><h1>Synthetic dashboard content</h1></main><dialog open><p>Preview information</p><button onclick="this.closest(\'dialog\').remove()">Close</button></dialog>');const obs=await session.capture();const candidates=await session.getDismissCandidates(obs.observationId);assert.equal(candidates.length,1);return{obs,ref:candidates[0].elementRef};};
  let state=await show();await page.locator('dialog p').evaluate(el=>el.textContent='Different preview information');await assert.rejects(()=>session.dismissObservedElement(state.obs.observationId,state.ref),/changed/);
  state=await show();await page.locator('dialog button').evaluate(el=>el.replaceWith(el.cloneNode(true)));await assert.rejects(()=>session.dismissObservedElement(state.obs.observationId,state.ref),/changed|detached/);
  state=await show();await session.capture();await assert.rejects(()=>session.dismissObservedElement(state.obs.observationId,state.ref),/current observation/);
  await page.setContent('<main><h1>Synthetic dashboard content</h1></main><dialog open><p>Preview information</p><button onclick="location.href=\'/action\'">Close</button></dialog>');const navigationObs=await session.capture();const navigationCandidates=await session.getDismissCandidates(navigationObs.observationId);assert.equal(navigationCandidates.length,1);const previousUrl=page.url();const navigationAction=await session.dismissObservedElement(navigationObs.observationId,navigationCandidates[0].elementRef);assert.notEqual(navigationAction.outcome,'success');assert.equal(page.url(),previousUrl);assert(session.warnings.some(warning=>warning.includes('Blocked navigation during automatic')));
  state=await show();await assert.rejects(()=>session.dismissObservedElement(state.obs.observationId,'e999'),/not registered/);
  const action=await session.dismissObservedElement(state.obs.observationId,state.ref);assert.equal(action.outcome,'success');assert.equal(action.beforeObservationId,state.obs.observationId);assert(action.afterObservationId);assert.equal(await page.locator('dialog').count(),0);assert(session.observations.at(-1)!.evidenceRefs.some(ref=>ref.kind==='screenshot'));
 }finally{await session.close();await new Promise<void>(resolve=>server.close(()=>resolve()));await rm(dir,{recursive:true,force:true});}
});
