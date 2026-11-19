import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {mkdtemp,readFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {test} from 'node:test';
import sharp from 'sharp';
import {inspect} from '../src/core.js';
import {closeBrowserLeases} from '../src/browser-lease.js';
import type {FollowupDecisionInput} from '../src/followup.js';
import type {FollowupReplayStep} from '../src/followup-types.js';
import type {EvaluationResult,RunSpec} from '../src/types.js';

const evaluation:EvaluationResult={status:'completed',findings:[],screenMap:[],interpretations:[],limitations:[]};
const replay:FollowupReplayStep={type:'click',role:'button',label:'Newest',scopeLabel:'Target catalog'};
const target='<section aria-label="Target catalog"><button onclick="document.querySelector(\'#result\').textContent=\'Expected catalog changed\'">Newest</button></section>';
const wrong='<section aria-label="Other catalog"><button onclick="document.querySelector(\'#result\').textContent=\'Wrong control clicked\'">Newest</button></section>';
const anchor='<output id="result">Initial catalog shown</output>';
const start='<!doctype html><html><body style="margin:0"><h1 style="margin:0">Review catalog</h1>';

async function fixture(html:string,run:(url:string,root:string)=>Promise<void>){
 const server=createServer((_req,res)=>res.setHeader('content-type','text/html').end(html));
 await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve));
 const address=server.address();assert(address&&typeof address!=='string');
 const root=await mkdtemp(join(tmpdir(),'replay-scroll-'));
 try{await run(`http://127.0.0.1:${address.port}/`,root);}finally{await closeBrowserLeases();server.closeAllConnections();await new Promise<void>(resolve=>server.close(()=>resolve()));await rm(root,{force:true,recursive:true});}
}
function spec(url:string,steps=[replay]):RunSpec{
 const viewport={width:800,height:600,deviceScaleFactor:1},workspaceId='replay-scroll';
 const source={reportId:'a'.repeat(64),reportSha256:'b'.repeat(64),runId:'old-run',targetUrl:url,viewport};
 return {targetUrl:url,workspaceId,viewport,mode:'quick',purpose:'Replay the stored filter',allowedActions:[],allowedOrigins:[new URL(url).origin],hasMutationPermission:false,isHeaded:false,shouldWaitForLogin:false,limits:{maxDurationMs:30000,maxObservations:9,maxActions:0,maxToolCalls:20,maxFindings:8},evaluator:'rules-only',followup:{requestId:'request',workspaceId,instruction:'Inspect restored catalog',source,maxOptions:1,executionBase:{...source,replay:steps}}};
}
const done=async(input:FollowupDecisionInput)=>{
 assert(input.observations.at(-1)?.accessibilitySnapshot.includes('Expected catalog changed'));
 return {evaluation,decision:{phase:'done' as const,reason:'Fixture',answer:'Fixture',isRestored:true,isSelectedRegionBound:true,isRequestedOptionMissing:false,scopeMode:input.scopeMode,scopeDescription:'Catalog',action:null,scopeSuggestion:{kind:'same-workspace' as const,name:'Catalog',goal:'Replay filter',reason:'Same section'}}};
};
test('a nested lazy section becomes replayable after three viewport moves without intermediate screenshots',async()=>{
 const html=start+anchor+wrong+`<main id="scroller" style="height:500px;overflow-y:auto;border:1px solid black"><div id="canvas" style="height:3600px;position:relative"></div></main>
 <script>const scroller=document.querySelector('#scroller'),canvas=document.querySelector('#canvas');
 scroller.addEventListener('scroll',()=>{if(scroller.scrollTop>=1750&&!canvas.querySelector('section')){
  const wrapper=document.createElement('div'); wrapper.style.cssText='position:absolute;top:1960px'; wrapper.innerHTML=${JSON.stringify(target)};
  canvas.appendChild(wrapper);
 }});</script></body></html>`;
 await fixture(html,async(url,root)=>{
  let modelTurns=0;
  const run=await inspect(spec(url),root,{evaluate:async()=>evaluation,decideFollowup:async input=>{modelTurns++;return done(input);}});
  const result=run.result.followup!;
  assert.equal(result.restoration.status,'replayed',JSON.stringify(result));
  assert.equal(modelTurns,1,'the search must not ask the planner again');
  assert.equal(result.history.length,1);assert.equal(result.history[0].label,'Newest');
  assert.equal(result.restoration.scroll?.maxDistancePx,2400);
  assert.equal(result.restoration.scroll?.usedDistancePx,1800);
  assert.equal(result.restoration.scroll?.searches[0].steps,3);
  assert.equal(result.restoration.scroll?.searches[0].outcome,'found');
  assert.equal(result.restoration.scroll?.searches[0].afterObservationId,result.history[0].beforeObservationId);
  const screenshots=run.result.evidence.filter(ref=>ref.kind==='screenshot');assert.equal(screenshots.length,6);
  for(const ref of screenshots){const {width,height}=await sharp(await readFile(ref.absolutePath)).metadata();assert.deepEqual([width,height],[800,600]);}
 });
});

test('known offscreen exact matching reveals one original control with counted movement; visible replay adds no scroll',async()=>{
 await fixture(start+anchor+target+'</body></html>',async(url,root)=>{
  const run=await inspect(spec(url),root,{evaluate:async()=>evaluation,decideFollowup:done});
  assert.equal(run.result.followup?.restoration.status,'replayed');
  assert.equal(run.result.followup?.restoration.scroll,undefined);
  assert.equal(run.result.evidence.filter(ref=>ref.kind==='screenshot').length,5);
 });
 await fixture(start+anchor+'<div style="height:1080px"></div>'+target+'<div style="height:400px"></div></body></html>',async(url,root)=>{
  const run=await inspect(spec(url),root,{evaluate:async()=>evaluation,decideFollowup:done});
  assert.equal(run.result.followup?.restoration.status,'replayed',JSON.stringify(run.result.followup));
  const search=run.result.followup?.restoration.scroll?.searches[0];
  assert(search&&search.distancePx>0&&search.distancePx<=2400,'direct reveal must count against the four-viewport cap');
  assert.equal(search.outcome,'found');
 });
});

test('same-scope duplicates stop before any scroll or click',async()=>{
 await fixture(start+anchor+target+'<div style="height:1100px"></div>'+target+'</body></html>',async(url,root)=>{
  const run=await inspect(spec(url),root,{decideFollowup:async()=>assert.fail('ambiguous replay must not reach the planner'),evaluate:async()=>assert.fail('ambiguous restoration cannot be evaluated')});
  assert.deepEqual(run.result.actions,[]);
  assert.equal(run.result.followup?.restoration.status,'failed');
  assert.match(run.result.followup!.reason,/여러 개.*0\/2400px/);
  assert.equal(run.result.evidence.filter(ref=>ref.kind==='screenshot').length,1);
 });
});

test('an absent filter in an extending nested list stops after exactly four viewport heights',async()=>{
 const html=start+`<main id="scroller" style="height:520px;overflow-y:auto"><div id="canvas" style="height:1400px">Extending catalog results</div></main><script>
 const scroller=document.querySelector('#scroller'),canvas=document.querySelector('#canvas');let height=1400;
 scroller.addEventListener('scroll',()=>{height+=600;canvas.style.height=height+'px'});
 </script></body></html>`;
 await fixture(html,async(url,root)=>{
  const run=await inspect(spec(url),root,{decideFollowup:async()=>assert.fail('absent replay must not reach planner')});
  const result=run.result.followup!;
  assert.equal(result.status,'partial');assert.equal(result.restoration.status,'failed');
  assert.equal(result.restoration.scroll?.usedDistancePx,2400);assert.equal(result.restoration.scroll?.searches[0].steps,4);
  assert.match(result.reason,/2400\/2400px/);assert.equal(result.needsImageHandoff,true);
  assert.equal(run.result.actions.length,0);assert.equal(run.result.evidence.filter(ref=>ref.kind==='screenshot').length,2);
  assert.equal(result.afterObservationId,result.restoration.scroll?.searches[0].afterObservationId);
 });
});

test('two replay searches share one four-viewport budget, without resetting at a later step',async()=>{
 const html=start+anchor+`<main id="scroller" style="height:500px;overflow-y:auto"><div id="canvas" style="height:4500px;position:relative"></div></main>
 <script>const scroller=document.querySelector('#scroller'),canvas=document.querySelector('#canvas');
 scroller.addEventListener('scroll',()=>{if(scroller.scrollTop>=1750&&!canvas.querySelector('section')){
  const wrapper=document.createElement('div'); wrapper.style.cssText='position:absolute;top:1960px'; wrapper.innerHTML=${JSON.stringify(target)};
  canvas.appendChild(wrapper);
 }});</script></body></html>`;
 await fixture(html,async(url,root)=>{
  const run=await inspect(spec(url,[replay,{...replay,label:'Different saved filter'}]),root,{decideFollowup:async()=>assert.fail('second replay cannot be skipped')});
  const result=run.result.followup!,scroll=result.restoration.scroll!;
  assert.equal(result.status,'partial');assert.equal(result.history.length,1);
  assert.deepEqual(scroll.searches.map(search=>[search.distancePx,search.outcome]),[[1800,'found'],[600,'limit']]);
  assert.equal(scroll.usedDistancePx,scroll.maxDistancePx);
  assert.equal(run.result.actions.length,1);
 });
});
