import test from 'node:test';
import assert from 'node:assert/strict';
import {acquireBrowserLease,closeBrowserLeases,browserLeaseStatus,BROWSER_LEASE_IDLE_MS,BROWSER_LEASE_MAX_TURNS} from '../src/browser-lease.js';
import type {BrowserPhysicalContext} from '../src/browser.js';
import {decideFollowup,type FollowupDecisionInput} from '../src/followup.js';
import type {evaluateStage} from '../src/evaluator.js';

function physical(){let isClosed=false;return{context:{} as never,page:{isClosed:()=>isClosed} as never,browser:{isConnected:()=>!isClosed,close:async()=>{isClosed=true;}} as never} satisfies BrowserPhysicalContext;}
test('browser leases enforce two active slots and cancellation while waiting',async()=>{
 try{const first=await acquireBrowserLease('a',undefined),second=await acquireBrowserLease('b',undefined);const controller=new AbortController();const third=acquireBrowserLease('c',undefined,controller.signal);assert.equal(browserLeaseStatus().activeCount,2);controller.abort();await assert.rejects(third,/cancelled/);await first.release(undefined,'r1',false);await second.release(undefined,'r2',false);assert.equal(browserLeaseStatus().activeCount,0);}finally{await closeBrowserLeases();}
});
test('physical context is retained only for its exact execution base and at most five turns',async()=>{
 try{const context=physical();let reservation=await acquireBrowserLease('a',undefined);await reservation.release(context,'r1',true);for(let turn=2;turn<=BROWSER_LEASE_MAX_TURNS;turn++){reservation=await acquireBrowserLease('a',`r${turn-1}`);assert.equal(reservation.physical,context);await reservation.release(context,`r${turn}`,true);}assert.equal(context.browser.isConnected(),false);assert.equal(browserLeaseStatus().idleCount,0);
 const newer=physical();reservation=await acquireBrowserLease('a',undefined);await reservation.release(newer,'current',true);const mismatch=await acquireBrowserLease('a','older');assert.equal(mismatch.physical,undefined);assert.equal(newer.browser.isConnected(),false);await mismatch.release(undefined,'next',false);
 }finally{await closeBrowserLeases();}
});
test('idle browser is reclaimed at the fixed sixty second TTL',async context=>{
 context.mock.timers.enable({apis:['setTimeout']});try{const browser=physical();const reservation=await acquireBrowserLease('idle',undefined);await reservation.release(browser,'run',true);context.mock.timers.tick(BROWSER_LEASE_IDLE_MS-1);assert(browser.browser.isConnected());context.mock.timers.tick(1);await Promise.resolve();await Promise.resolve();assert.equal(browser.browser.isConnected(),false);assert.equal(browserLeaseStatus().idleCount,0);}finally{await closeBrowserLeases();context.mock.timers.reset();}
});
test('model stage receives native public labels despite capture masking and rejects invented refs/options',async()=>{
 const input={spec:{evaluator:'openai-compatible',limits:{maxFindings:10},followup:{instruction:'Latest option',source:{runId:'old'},maxOptions:1}},observations:[],rules:[],actions:[],evidence:[],coverage:{},timeoutMs:5000,scopeMode:'related-screen',isRestoring:true,hasSettled:true,history:[],candidates:[{elementRef:'e7',role:'combobox',label:'Sort',options:['Default','Latest'],selectedLabels:['Default'],isSelected:false}]} as unknown as FollowupDecisionInput;
 const draft={phase:'act',reason:'명시된 옵션 선택',answer:'',isRestored:true,isSelectedRegionBound:true,isRequestedOptionMissing:false,scopeMode:'related-screen',scopeDescription:'필터와 결과',action:{elementRef:'e7',optionLabel:'Latest'},scopeSuggestion:{kind:'same-workspace',name:'Catalog',goal:'Filter',reason:'Same screen'}};
 const invoke=(output:unknown)=>decideFollowup(input,{evaluateStage:(async(_input,_deps,stage)=>{const prompt=JSON.parse(stage!.prompt!);assert.deepEqual(prompt.candidates[0].options,['Default','Latest']);assert.deepEqual(prompt.candidates[0].selectedLabels,['Default']);assert.equal(prompt.candidates[0].value,undefined);return stage!.validate!(output,{} as never);}) as typeof evaluateStage});
 assert.deepEqual((await invoke(draft)).decision?.action,{elementRef:'e7',optionLabel:'Latest'});assert.equal((await invoke({...draft,action:{elementRef:'e99',optionLabel:'Latest'}})).decision,undefined);assert.equal((await invoke({...draft,action:{elementRef:'e7',optionLabel:'Missing'}})).decision,undefined);
});
