import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {mkdtemp, readFile, rm} from 'node:fs/promises';
import {createServer} from 'node:http';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {test} from 'node:test';
import {chromium} from 'playwright';
import {inspect} from '../src/core.js';
import {validateSpec} from '../src/policy.js';
import {sampleComputedStyle,styleComparisonSchema} from '../src/style-comparison.js';
import type {RunSpec} from '../src/types.js';
import {ReportRepository} from '../viewer/server/repository.js';

function spec(referenceUrl:URL):RunSpec {
 return {
  targetUrl:referenceUrl.href,
  styleComparison:{
   label:'목록 검색',
   comparisonUrl:new URL('/?view=comparison&private=private-route-value',referenceUrl).href,
   reference:{label:'프로젝트 검색',selector:'#search',expected:{'font-size':'16px','border-top-color':'rgb(20, 20, 20)'}},
   comparison:{label:'보고서 검색',selector:'#search',expected:{'font-size':'14px','border-top-color':'rgb(20, 20, 20)'}},
   properties:['height','border-top-left-radius','font-size','border-top-color'],
  },
  mode:'quick',evaluator:'rules-only',
  viewport:{width:800,height:600,deviceScaleFactor:1},
  allowedActions:[],allowedOrigins:[referenceUrl.origin],
  hasMutationPermission:false,isHeaded:false,shouldWaitForLogin:false,
  limits:{maxDurationMs:30_000,maxObservations:2,maxActions:0,maxToolCalls:10,maxFindings:10},
 };
}

test('compares two browser screenshots and preserves measured, approved and unverified results',async()=>{
 const root=await mkdtemp(join(tmpdir(),'style-comparison-'));
 const server=createServer((request,response)=>{
  const params=new URL(request.url??'/','http://localhost').searchParams;
  const isComparison=params.get('view')==='comparison';
  const style=isComparison?'border-radius:999px;font-size:14px;border-color:rgb(50,50,50)':
   'border-radius:16px;font-size:16px;border-color:rgb(20,20,20)';
  response.writeHead(params.has('httpError')?404:200,{'Content-Type':'text/html; charset=utf-8'}).end(`<!doctype html>
   <html lang="en"><head><title>Search fixture</title></head><body>
     <main><label for="search">Search</label>
     <input id="search" type="search" value="masked-search-value" style="height:44px;border:1px solid;${style}"></main>
   </body></html>`);
 });
 await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve));
 const address=server.address();
 assert(address&&typeof address!=='string');
 try{
  const runSpec=spec(new URL(`http://127.0.0.1:${address.port}/?view=reference`));
  const {result,runDir}=await inspect(runSpec,root);
  assert.equal(result.status,'completed',result.limitations.join('\n'));
  const [reference,comparison]=result.observations;
  assert(reference.isStable&&comparison.isStable);
  const measured=reference.deterministicChecks?.styleComparison;
  assert(measured);
  assert.deepEqual(measured.checks.map(({property,status,reference,comparison})=>[property,status,reference,comparison]),[
   ['height','passed','44px','44px'],
   ['border-top-left-radius','candidate','16px','999px'],
   ['font-size','passed','16px','14px'],
   ['border-top-color','violation','rgb(20, 20, 20)','rgb(50, 50, 50)'],
  ]);
  const screenshots=[reference.screenshotRefs[0],comparison.screenshotRefs[0]];
  for(const [index,side] of [measured.reference,measured.comparison].entries()){
   assert.equal(side.screenshotEvidenceId,screenshots[index]);
   assert.equal(side.observationId,result.observations[index].observationId);
   assert.equal(side.sample.status,'measured');
   assert(side.sample.bounds.height>0&&side.sample.bounds.width>0);
   const screenshot=result.evidence.find(item=>item.evidenceId===side.screenshotEvidenceId);
   assert(screenshot?.screenshot?.redactionRegions.some(region=>region.reason==='input-value'));
  }
  const coverage=result.coverage.observedChecks.find(check=>check.checkId==='style-comparison');
  assert.deepEqual(coverage?.evidenceIds,[measured.evidenceId,...screenshots]);
  const markdown=await readFile(join(runDir,'report.md'),'utf8');
  assert.match(markdown,/차이 후보 · border-top-left-radius · 16px \/ 999px/);
  assert.match(markdown,/승인 기준 위반 · border-top-color/);
  const manifest=await readFile(join(runDir,'manifest.json'),'utf8');
  assert.doesNotMatch(manifest,/private-route-value/);
  const persisted=await readFile(join(runDir,'report.json'),'utf8');
  assert.doesNotMatch(persisted,/private-route-value|masked-search-value/);
  const repository=new ReportRepository(root);
  const [entry]=(await repository.list()).reports;
  const detail=await repository.detail(entry.id);
  assert.equal(detail.captures?.[0].deterministicChecks?.styleComparison?.checks[0].status,'passed');
  for(const [index,id] of screenshots.entries()){
   const imageId=createHash('sha256').update(id).digest('hex');
   assert(detail.images.some(image=>image.id===imageId&&image.observationId===result.observations[index].observationId));
  }

  runSpec.styleComparison!.comparison.selector='#missing';
  const missing=await inspect(runSpec,root);
  assert.equal(missing.result.status,'partial');
  const unverified=missing.result.observations[0].deterministicChecks?.styleComparison;
  assert.deepEqual(unverified?.comparison.sample,{status:'unverified',reason:'missing'});
  assert(unverified.checks.every(check=>check.status==='unverified'&&check.reference&&check.comparison===undefined));
  assert.equal(unverified.comparison.screenshotEvidenceId,missing.result.observations[1].screenshotRefs[0]);

  const httpError=await inspect({
   ...runSpec,targetUrl:runSpec.targetUrl+'&httpError=1',
   styleComparison:{...runSpec.styleComparison!,comparisonUrl:runSpec.styleComparison!.comparisonUrl+'&httpError=1',
    comparison:{...runSpec.styleComparison!.comparison,selector:'#search'}},
  },root);
  assert.equal(httpError.result.status,'partial');
  const failed=httpError.result.observations[0].deterministicChecks?.styleComparison;
  assert(failed);
  for(const [index,side] of [failed.reference,failed.comparison].entries()){
   assert.deepEqual(side.sample,{status:'unverified',reason:'http-error'});
   assert.equal(side.screenshotEvidenceId,httpError.result.observations[index].screenshotRefs[0]);
  }
 }finally{
  server.closeAllConnections();
  await new Promise<void>(resolve=>server.close(()=>resolve()));
  await rm(root,{recursive:true,force:true});
 }
});

test('limits style comparisons to two same-origin quick screens and selected properties',()=>{
 const runSpec=spec(new URL('http://localhost/?view=reference'));
 assert.doesNotThrow(()=>validateSpec(runSpec));
 const config=runSpec.styleComparison!;
 assert.equal(styleComparisonSchema.safeParse({...config,comparisonUrl:'invalid-url'}).success,false);
 assert.equal(styleComparisonSchema.safeParse({...config,properties:['background-image']}).success,false);
 assert.equal(styleComparisonSchema.safeParse({...config,properties:['height','height']}).success,false);
 assert.equal(styleComparisonSchema.safeParse({...config,properties:['height']}).success,false);
 assert.throws(()=>validateSpec({...runSpec,evaluator:'codex'}),/quick rules-only/);
 assert.throws(()=>validateSpec({...runSpec,styleComparison:{...config,comparisonUrl:'http://example.test/'}}),/same origin/);
});

test('rejects a fully clipped target, an ambiguous selector and a different route',async()=>{
 const browser=await chromium.launch();
 try{
  const page=await browser.newPage();
  await page.setContent(`<div style="width:50px;height:50px;position:relative;overflow:hidden">
    <input id="clipped" style="position:absolute;left:100px">
   </div><input id="visible">`);
  assert.deepEqual(await sampleComputedStyle(page,page.url(),'#clipped',['height']),{status:'unverified',reason:'not-visible'});
  assert.deepEqual(await sampleComputedStyle(page,page.url(),'input',['height']),{status:'unverified',reason:'ambiguous'});
  assert.deepEqual(await sampleComputedStyle(page,'about:blank#other','#visible',['height']),{status:'unverified',reason:'different-url'});
 }finally{
  await browser.close();
 }
});
