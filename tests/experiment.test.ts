import test from 'node:test';
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {mkdtemp,readFile,rm} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {runExperiment,parseExperimentCases} from '../src/experiment.js';
import type {EvaluationCall} from '../src/types.js';

test('experiment rejects ground truth in its public case manifest',()=>{
 assert.throws(()=>parseExperimentCases([{caseId:'case1',url:'http://localhost',purpose:'Read',viewport:{width:390,height:844},expectedProblem:'secret answer'}]),/neutral/);
});

test('experiment freezes one real browser snapshot across balanced independent jobs and preserves partial usage',async()=>{
 const server=createServer((_req,res)=>{res.setHeader('Content-Type','text/html');res.end('<!doctype html><html lang="en"><head><title>Synthetic experiment</title></head><body><main><h1>Overview</h1><p>Read the overview.</p></main></body></html>');});
 await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve));const address=server.address();assert(address&&typeof address!=='string');const dir=await mkdtemp(join(tmpdir(),'inspector-experiment-'));
 let active=0,maxActive=0;const owners=new Set<string>();const fingerprints=new Set<string>();
 try{
  const options={cases:[{caseId:'case1',url:`http://127.0.0.1:${address.port}`,purpose:'Read the overview.',viewport:{width:390,height:844}}],outputDir:dir,provider:'codex' as const,model:'test-model',reasoningEffort:'medium' as const,repetitions:2,concurrency:2,stageTimeoutMs:10000,strategies:['A','B','C'] as ('A'|'B'|'C')[]};
  const result=await runExperiment(options,{environment:{providerCliVersion:'mock adapter, no paid model'},evaluate:async input=>{
   active++;maxActive=Math.max(maxActive,active);try{
    assert.equal(input.canRequestObservation,false);assert.equal(input.stageTimeoutMs,10000);assert.equal(input.timeoutMs,10000*{A:1,B:3,C:2}[input.spec.strategy!]);assert.equal(input.spec.limits.maxDurationMs,input.timeoutMs);assert.equal(input.spec.model,'test-model');assert.equal(input.spec.reasoningEffort,'medium');owners.add(input.runId);fingerprints.add(JSON.stringify(input.evidence.map(item=>item.sha256)));
    assert(input.evidence.every(item=>item.runId===input.runId&&item.absolutePath.startsWith(input.runDir)));for(const item of input.evidence)await readFile(item.absolutePath);
    await new Promise(resolve=>setTimeout(resolve,20));const startedAt=new Date().toISOString();const calls:EvaluationCall[]=[{callId:'call-1',stage:'discovery',provider:'codex',requestedModel:'test-model',requestedReasoningEffort:'medium',startedAt,endedAt:startedAt,durationMs:1,status:'completed',isRepair:false,usage:{inputTokens:20,outputTokens:10,estimatedCost:0.01}},{callId:'call-2',stage:'discovery',provider:'codex',startedAt,endedAt:startedAt,durationMs:1,status:'completed',isRepair:true,usage:{inputTokens:2,outputTokens:1}}];
    return{provider:'codex',status:input.runId.endsWith('B-r2')?'failed':'completed',findings:[],screenMap:[],interpretations:[],limitations:[],calls,usage:{inputTokens:22,outputTokens:11,estimatedCost:0.01}};
   }finally{active--;}
  }});
  assert.equal(result.records.length,6);assert.equal(owners.size,6);assert.equal(fingerprints.size,1);assert.equal(new Set(result.records.map(item=>item.observationDigest)).size,1);assert.equal(maxActive,2);assert.deepEqual(result.records.map(item=>item.strategy),['A','B','C','B','C','A']);assert.equal(result.records.filter(item=>item.status==='partial').length,1);assert(result.records.every(item=>item.hasUnknownCost));
  const summary=JSON.parse(await readFile(result.summaryPath,'utf8'));assert.equal(summary.hasUnknownCost,true);assert.equal(summary.modelCallCount,12);assert.equal(summary.hasUnknownTokenUsage,false);const manifest=JSON.parse(await readFile(join(dir,'experiment-manifest.json'),'utf8'));assert.equal(manifest.hasDynamicObservation,false);assert.equal(manifest.hasSeedControl,false);assert.equal(manifest.perStageTimeoutMs,10000);assert(manifest.environmentHash);for(const record of result.records){const report=JSON.parse(await readFile(record.report,'utf8'));assert.equal(report.observations.length,1);assert.equal(report.actions.length,0);}
  await assert.rejects(()=>runExperiment(options,{environment:{providerCliVersion:'mock'}}),/EEXIST/);
 }finally{await new Promise<void>(resolve=>server.close(()=>resolve()));await rm(dir,{recursive:true,force:true});}
});
