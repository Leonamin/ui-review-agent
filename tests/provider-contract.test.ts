import test from 'node:test';
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {mkdtemp,readFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {inspect} from '../src/core.js';
import {renderReport} from '../src/report.js';
import type {RunSpec} from '../src/types.js';

test('provider metadata preserves requested versus reported model and unknown cost through the core seam',async()=>{
 const server=createServer((_request,response)=>{response.setHeader('Content-Type','text/html');response.end('<!doctype html><html lang="en"><head><title>Provider contract</title></head><body><main><h1>Local review</h1></main></body></html>');});
 await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve));
 const address=server.address();assert(address&&typeof address!=='string');
 const targetUrl=`http://127.0.0.1:${address.port}`;
 const directory=await mkdtemp(join(tmpdir(),'inspector-provider-contract-'));
 try{
  for(const provider of ['codex','claude'] as const){
   const requestedModel=provider==='codex'?'requested-codex-model':'requested-claude-model';
   const spec:RunSpec={targetUrl,evaluator:provider,model:requestedModel,mode:'quick',viewport:{width:390,height:844,deviceScaleFactor:1},allowedActions:[],allowedOrigins:[targetUrl],hasMutationPermission:false,isHeaded:false,shouldWaitForLogin:false,limits:{maxDurationMs:60000,maxObservations:3,maxActions:0,maxToolCalls:20,maxFindings:10}};
   let callCount=0;
   const {result,runDir}=await inspect(spec,directory,{evaluate:async input=>{
    callCount++;assert.equal(input.spec.evaluator,provider);assert.equal(input.spec.model,requestedModel);
    // Stub only evaluation; browser capture, MCP and persisted metadata remain real.
    return {status:'completed',findings:[],screenMap:[],interpretations:[],limitations:[],model:provider==='claude'?'reported-claude-model':undefined,usage:{inputTokens:123,cacheReadInputTokens:100}};
   }});
   assert.equal(callCount,1);assert.equal(result.status,'completed');assert.equal(result.provider,provider);assert.equal(result.evaluation.provider,provider);
   assert.equal(result.evaluation.usage?.inputTokens,123);assert.equal(result.evaluation.usage?.estimatedCost,undefined);
   const manifest=JSON.parse(await readFile(join(runDir,'manifest.json'),'utf8'));
   assert.equal(manifest.provider,provider);assert.equal(manifest.requestedModel,requestedModel);assert.equal(manifest.evaluationCalls[0].provider,provider);
   const report=await readFile(join(runDir,'report.md'),'utf8');assert.match(report,/추정 비용\(USD\): 미확인/);
   if(provider==='codex'){
    assert.equal(result.evaluation.model,undefined);assert.equal(manifest.evaluationCalls[0].model,undefined);assert(!report.includes(requestedModel));
   }else{
    assert.equal(result.evaluation.model,'reported-claude-model');assert.equal(manifest.evaluationCalls[0].model,'reported-claude-model');
    const legacy=structuredClone(result);delete legacy.provider;delete legacy.evaluation.provider;
    const legacyReport=renderReport(legacy);assert.match(legacyReport,/공급자: 미확인/);assert(legacyReport.includes('reported-claude-model'));assert(!legacyReport.includes('codex'));
   }
  }
 }finally{await new Promise<void>(resolve=>server.close(()=>resolve()));await rm(directory,{recursive:true,force:true});}
});
