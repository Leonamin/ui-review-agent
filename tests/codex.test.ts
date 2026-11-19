import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,writeFile,rm,access} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createHash} from 'node:crypto';
import {codexOutputSchema,normalizeCodexOutput,codexChildEnvironment,runCodex} from '../src/codex.js';
import type {EvaluationInput} from '../src/types.js';

test('Codex schema normalizes optional nulls without removing required null attribution',()=>{
 const schema={type:'object',properties:{failureAttribution:{type:['string','null']},optional:{type:'string'},nested:{type:'object',properties:{optional:{type:'string'}},required:[]}},required:['failureAttribution','nested'],additionalProperties:false};
 const transformed=codexOutputSchema(schema);assert.deepEqual(transformed.required,['failureAttribution','optional','nested']);
 assert.deepEqual(normalizeCodexOutput({failureAttribution:null,optional:null,nested:{optional:null}},schema),{failureAttribution:null,nested:{}});
 assert.deepEqual(normalizeCodexOutput({unexpected:null,failureAttribution:null,nested:{}},schema),{unexpected:null,failureAttribution:null,nested:{}});
});

test('Codex child preserves auth home but drops app bridges, secrets and session injection',()=>{
 const env=codexChildEnvironment({HOME:'/home/test',CODEX_HOME:'/home/auth',PATH:'/bin',CODEX_APP_TOOLS_PIPE_PATH:'private',CODEX_THREAD_ID:'thread',CODEX_FUTURE_BRIDGE:'future',OPENAI_API_KEY:'secret',UNRELATED_SECRET:'secret'});
 assert.deepEqual(env,{PATH:'/bin',HOME:'/home/test',CODEX_HOME:'/home/auth'});
});

test('Codex stops an unexpected tool event and removes evaluator temporary files', {skip:process.platform==='win32'},async()=>{
 const dir=await mkdtemp(join(tmpdir(),'codex-adapter-test-'));const oldPath=process.env.PATH;
 try{
  const imagePath=join(dir,'image.png');const bytes=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a/vQAAAAASUVORK5CYII=','base64');await writeFile(imagePath,bytes);
  const evidence={evidenceId:'image',runId:'r1',observationId:'o1',kind:'screenshot' as const,relativePath:'image.png',absolutePath:imagePath,mimeType:'image/png',sha256:createHash('sha256').update(bytes).digest('hex'),isRedacted:true};
  const input={runId:'r1',runDir:dir,spec:{evaluator:'codex'},timeoutMs:3000,observations:[{observationId:'o1',screenshotRefs:['image']}],evidence:[evidence]} as EvaluationInput;
  await writeFile(join(dir,'codex'),`#!${process.execPath}\nprocess.stdin.resume();process.stdout.write(JSON.stringify({type:'item.started',item:{type:'command_execution',command:'should-never-be-accepted',text:process.cwd()}})+'\\n');setInterval(()=>{},1000);`,{mode:0o700});
  process.env.PATH=`${dir}:${oldPath??''}`;
  const startedAt=Date.now();const result=await runCodex(input,{prompt:'Test',instructions:'Test',schema:{type:'object',properties:{},additionalProperties:false}});
  assert.equal(result.hasUnexpectedToolCall,true);assert.equal(result.structuredOutput,undefined);await assert.rejects(access(result.events[0]!.item!.text!));assert.ok(Date.now()-startedAt<2500);
 }finally{process.env.PATH=oldPath;await rm(dir,{recursive:true,force:true});}
});

test('Codex decodes UTF-8 and JSONL boundaries across arbitrary stdout chunks',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'codex-unicode-test-'));const oldPath=process.env.PATH;
 try{
  const imagePath=join(dir,'image.png');const bytes=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a/vQAAAAASUVORK5CYII=','base64');await writeFile(imagePath,bytes);
  const evidence={evidenceId:'image',runId:'r1',observationId:'o1',kind:'screenshot' as const,relativePath:'image.png',absolutePath:imagePath,mimeType:'image/png',sha256:createHash('sha256').update(bytes).digest('hex'),isRedacted:true};
  const input={runId:'r1',runDir:dir,spec:{evaluator:'codex'},timeoutMs:3000,observations:[{observationId:'o1',screenshotRefs:['image']}],evidence:[evidence]} as EvaluationInput;
  await writeFile(join(dir,'codex'),`#!${process.execPath}\nprocess.stdin.resume();const payload=Buffer.from(JSON.stringify({type:'item.completed',item:{type:'agent_message',text:JSON.stringify({heading:'가나다'})}})+'\\n'+JSON.stringify({type:'turn.completed'}));const split=payload.indexOf(Buffer.from('가'))+1;process.stdout.write(payload.subarray(0,split));setTimeout(()=>{process.stdout.write(payload.subarray(split,split+1));setTimeout(()=>process.stdout.end(payload.subarray(split+1)),15);},15);`,{mode:0o700});
  process.env.PATH=`${dir}:${oldPath??''}`;
  const result=await runCodex(input,{prompt:'Test',instructions:'Test',schema:{type:'object',properties:{heading:{type:'string'}},required:['heading'],additionalProperties:false}});
  assert.equal(result.exitCode,0);assert.deepEqual(result.structuredOutput,{heading:'가나다'});assert.equal(result.events.at(-1)?.type,'turn.completed');assert.deepEqual(result.rawStructuredOutput,{heading:'가나다'});
 }finally{process.env.PATH=oldPath;await rm(dir,{recursive:true,force:true});}
});
