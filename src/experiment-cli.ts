#!/usr/bin/env node
import {parseArgs} from 'node:util';
import {readFile} from 'node:fs/promises';
import {runExperiment,parseExperimentCases} from './experiment.js';
import type {ReasoningEffort} from './types.js';
try{
 const {values}=parseArgs({options:{manifest:{type:'string'},output:{type:'string'},provider:{type:'string',default:'codex'},model:{type:'string',default:'gpt-6.1-sol'},'reasoning-effort':{type:'string',default:'medium'},'stage-timeout':{type:'string',default:'150'},concurrency:{type:'string',default:'2'},help:{type:'boolean',short:'h'}}});
 if(values.help){console.log('Usage: pnpm run experiment --manifest manifest.json --output new-directory [--provider codex|claude] [--model name] [--reasoning-effort low|medium|high] [--stage-timeout 150] [--concurrency 2]\nSix neutral cases, A/B/C, three independent repetitions = 54 reports. Evidence is collected once per case. Equal per-stage limits give A150/B450/C300 second report ceilings by default; total token budgets differ.');process.exit(0);}
 if(!values.manifest||!values.output)throw new Error('--manifest and a new --output directory are required.');
 if(!['codex','claude'].includes(values.provider!))throw new Error('Provider must be codex or claude.');
 const cases=parseExperimentCases(JSON.parse(await readFile(values.manifest,'utf8')));if(cases.length!==6)throw new Error('This experiment requires exactly six cases.');
 const result=await runExperiment({cases,outputDir:values.output,provider:values.provider as 'codex'|'claude',model:values.model!,reasoningEffort:values['reasoning-effort'] as ReasoningEffort,stageTimeoutMs:Number(values['stage-timeout'])*1000,concurrency:Number(values.concurrency),repetitions:3,strategies:['A','B','C']},{onProgress:record=>console.error(JSON.stringify({caseId:record.caseId,strategy:record.strategy,repetition:record.repetition,status:record.status,modelCalls:record.modelCallCount}))});console.log(JSON.stringify({summary:result.summaryPath,reports:result.records.length},null,2));
}catch(error){console.error(error instanceof Error?error.message:'Experiment failed.');process.exitCode=1;}
