import {createHash} from 'node:crypto';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {mkdir,readFile,writeFile,copyFile,readdir,realpath} from 'node:fs/promises';
import {dirname,resolve,relative,isAbsolute,sep,join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {inspect} from './core.js';
import {evaluate} from './evaluator.js';
import {renderReport} from './report.js';
import {validateSpec} from './policy.js';
import type {RunSpec,ReviewResult,EvaluationInput,EvaluationResult,EvaluationStrategy,ReasoningEffort} from './types.js';

export interface ExperimentCase {caseId:string;url:string;purpose:string;viewport:{width:number;height:number}}
export interface ExperimentOptions {cases:ExperimentCase[];outputDir:string;provider:'codex'|'claude';model:string;reasoningEffort:ReasoningEffort;repetitions:number;concurrency:number;stageTimeoutMs:number;strategies:EvaluationStrategy[]}
interface Snapshot {caseId:string;runDir:string;report:ReviewResult;evidenceDigest:string;observationDigest:string}
interface Job {caseId:string;strategy:EvaluationStrategy;repetition:number;order:number}
interface JobResult extends Job {runId:string;status:ReviewResult['status'];evaluationStatus:EvaluationResult['status'];plannedStageCount:number;executedStageCount:number;report:string;durationMs:number;modelCallCount:number;hasUnknownCost:boolean;hasUnknownTokenUsage:boolean;usage:EvaluationResult['usage'];evidenceDigest:string;observationDigest:string}
const hash=(bytes:Buffer|string)=>createHash('sha256').update(bytes).digest('hex');
const execFileAsync=promisify(execFile);
export function parseExperimentCases(raw:unknown):ExperimentCase[]{
 if(!Array.isArray(raw)||!raw.length)throw new Error('Experiment manifest must contain cases.');
 const seen=new Set<string>();
 return raw.map(value=>{
  if(!value||typeof value!=='object')throw new Error('Invalid experiment case.');
  const item=value as Record<string,unknown>;const viewport=item.viewport as Record<string,unknown>|undefined;
  if(typeof item.caseId!=='string'||!/^[a-zA-Z0-9_-]+$/.test(item.caseId)||seen.has(item.caseId))throw new Error('Case IDs must be unique safe identifiers.');
  if(typeof item.url!=='string'||typeof item.purpose!=='string'||!item.purpose.trim()||!viewport||!Number.isSafeInteger(viewport.width)||!Number.isSafeInteger(viewport.height))throw new Error('Case needs URL, neutral purpose and integer viewport.');
  if(Object.keys(item).some(key=>!['caseId','url','purpose','viewport'].includes(key)))throw new Error('Manifest must contain neutral caseId, URL, purpose and viewport only. Keep ground truth separate.');
  seen.add(item.caseId);return{caseId:item.caseId,url:item.url,purpose:item.purpose,viewport:{width:viewport.width as number,height:viewport.height as number}};
 });
}
function makeSpec(item:ExperimentCase,options:ExperimentOptions):RunSpec{return{targetUrl:item.url,purpose:item.purpose,mode:'quick',viewport:{...item.viewport,deviceScaleFactor:1},allowedActions:[],allowedOrigins:[new URL(item.url).origin],hasMutationPermission:false,isHeaded:false,shouldWaitForLogin:false,limits:{maxDurationMs:options.stageTimeoutMs,maxObservations:1,maxActions:0,maxToolCalls:20,maxFindings:10},evaluator:options.provider,model:options.model,reasoningEffort:options.reasoningEffort};}
async function runtimeHashes():Promise<Record<string,string>>{
 const runtimeDir=dirname(fileURLToPath(import.meta.url));const hashes:Record<string,string>={};
 for(const name of (await readdir(runtimeDir)).filter(name=>/\.(?:js|ts)$/.test(name)).sort())hashes[`runtime/${name}`]=hash(await readFile(join(runtimeDir,name)));
 for(const name of ['package.json','pnpm-lock.yaml','pnpm-workspace.yaml','tsconfig.json'])hashes[name]=hash(await readFile(resolve(runtimeDir,'..',name)));
 return hashes;
}
function evidenceDigest(report:ReviewResult):string{return hash(JSON.stringify(report.evidence.map(item=>({evidenceId:item.evidenceId,kind:item.kind,sha256:item.sha256})).sort((a,b)=>a.evidenceId.localeCompare(b.evidenceId))));}
function observationDigest(data:Pick<EvaluationInput,'observations'|'rules'|'actions'>):string{return hash(JSON.stringify({observations:data.observations.map(({runId:_runId,evidenceRefs,...observation})=>({...observation,evidenceRefs:evidenceRefs.map(({runId:_owner,absolutePath:_path,...ref})=>ref)})),rules:data.rules,actions:data.actions}));}
async function cloneSnapshot(snapshot:Snapshot,runId:string,runDir:string):Promise<Pick<EvaluationInput,'observations'|'rules'|'actions'|'evidence'>>{
 const root=await realpath(snapshot.runDir);const evidence=[];
 for(const item of snapshot.report.evidence){
  const source=await realpath(item.absolutePath);const sourceRelative=relative(root,source);const destination=resolve(runDir,item.relativePath);
  if(sourceRelative==='..'||sourceRelative.startsWith(`..${sep}`)||isAbsolute(sourceRelative)||!destination.startsWith(resolve(runDir)+sep))throw new Error('Snapshot evidence path escapes its run.');
  const bytes=await readFile(source);if(hash(bytes)!==item.sha256)throw new Error('Frozen snapshot evidence changed.');
  await mkdir(dirname(destination),{recursive:true});await copyFile(source,destination);
  evidence.push({...structuredClone(item),runId,absolutePath:destination});
 }
 const byId=new Map(evidence.map(item=>[item.evidenceId,item]));
 const observations=structuredClone(snapshot.report.observations).map(observation=>({...observation,runId,evidenceRefs:observation.evidenceRefs.map(ref=>{const item=byId.get(ref.evidenceId);if(!item)throw new Error('Missing snapshot reference.');return item;})}));
 return{observations,evidence,rules:structuredClone(snapshot.report.rules),actions:structuredClone(snapshot.report.actions)};
}
export async function runExperiment(options:ExperimentOptions,dependencies:{evaluate?:typeof evaluate;environment?:Record<string,unknown>;onProgress?:(result:JobResult)=>void}={}):Promise<{summaryPath:string;records:JobResult[]}>{
 const cases=parseExperimentCases(options.cases);
 if(!options.model?.trim())throw new Error('Experiment requires an explicit model.');
 if(!Number.isSafeInteger(options.repetitions)||options.repetitions<1||!Number.isSafeInteger(options.concurrency)||options.concurrency<1||options.concurrency>2)throw new Error('Positive repetitions and concurrency 1 or 2 are required.');
 if(!options.strategies.length||new Set(options.strategies).size!==options.strategies.length||options.strategies.some(strategy=>!['A','B','C'].includes(strategy)))throw new Error('Strategies must be unique A, B or C.');
 for(const item of cases)validateSpec(makeSpec(item,options));
 const outputDir=resolve(options.outputDir);await mkdir(outputDir,{recursive:true});
 const freezePath=join(outputDir,'experiment-manifest.json');
 const freeze=await runtimeHashes();const startedAt=new Date().toISOString();
 const environment=dependencies.environment??{node:process.version,platform:process.platform,architecture:process.arch,providerCliVersion:(await execFileAsync(options.provider,['--version'],{timeout:10000,maxBuffer:4096})).stdout.trim()};
 const jobs:Job[]=[];
 for(let repetition=1;repetition<=options.repetitions;repetition++)for(const [caseIndex,item] of cases.entries()){
  const shift=(caseIndex+repetition-1)%options.strategies.length;const ordered=[...options.strategies.slice(shift),...options.strategies.slice(0,shift)];
  for(const strategy of ordered)jobs.push({caseId:item.caseId,strategy,repetition,order:jobs.length+1});
 }
 const manifest={schemaVersion:'0.1',startedAt,provider:options.provider,requestedModel:options.model,requestedReasoningEffort:options.reasoningEffort,perStageTimeoutMs:options.stageTimeoutMs,plannedStageCounts:{A:1,B:3,C:2},repetitions:options.repetitions,concurrency:options.concurrency,cases,jobSchedule:jobs,runtimeHashes:freeze,environment,environmentHash:hash(JSON.stringify(environment)),caseManifestHash:hash(JSON.stringify(cases)),hasDynamicObservation:false,hasSeedControl:false,budgetPolicy:'Equal per-stage wall-clock limit and evidence. Report ceilings are A=1, B=3 and C=2 stage budgets. Repair shares its stage budget. Total report token and wall-clock budgets are not equalized. Repetitions are independent fresh calls, not reproducible seeded samples.'};
 await writeFile(freezePath,JSON.stringify(manifest,null,2),{mode:0o600,flag:'wx'});
 const snapshots=new Map<string,Snapshot>();
 for(const item of cases){
  const base=makeSpec(item,options);const {model:_model,reasoningEffort:_effort,...captureSpec}=base;
  const captured=await inspect({...captureSpec,evaluator:'rules-only'},join(outputDir,'snapshots',item.caseId));
  if(captured.result.status!=='completed'||!captured.result.observations.length||captured.result.observations.some(observation=>!observation.isStable))throw new Error(`Snapshot ${item.caseId} is incomplete or unstable; no strategy evaluation started.`);
  snapshots.set(item.caseId,{caseId:item.caseId,runDir:captured.runDir,report:captured.result,evidenceDigest:evidenceDigest(captured.result),observationDigest:observationDigest(captured.result)});
 }
 await writeFile(join(outputDir,'snapshot-manifest.json'),JSON.stringify([...snapshots.values()].map(snapshot=>({caseId:snapshot.caseId,runDir:snapshot.runDir,reportHash:hash(JSON.stringify(snapshot.report)),evidenceDigest:snapshot.evidenceDigest,observationDigest:snapshot.observationDigest,evidence:snapshot.report.evidence.map(item=>({evidenceId:item.evidenceId,sha256:item.sha256,relativePath:item.relativePath}))})),null,2),{mode:0o600,flag:'wx'});
 const records:JobResult[]=[];let nextIndex=0;
 const runJob=async(job:Job):Promise<JobResult>=>{
  const item=cases.find(item=>item.caseId===job.caseId)!;const snapshot=snapshots.get(item.caseId)!;const runId=`${item.caseId}-${job.strategy}-r${job.repetition}`;const runDir=join(outputDir,'reports',runId);await mkdir(runDir,{recursive:true});
  const plannedStageCount={A:1,B:3,C:2}[job.strategy];const totalTimeoutMs=plannedStageCount*options.stageTimeoutMs;const spec={...makeSpec(item,options),strategy:job.strategy};spec.limits.maxDurationMs=totalTimeoutMs;const startedAt=new Date().toISOString();const start=Date.now();
  let inputData:Pick<EvaluationInput,'observations'|'rules'|'actions'|'evidence'>={observations:[],rules:[],actions:[],evidence:[]};let evaluation:EvaluationResult={provider:options.provider,status:'failed',findings:[],screenMap:[],interpretations:[],limitations:[]};
  try{
   if(JSON.stringify(await runtimeHashes())!==JSON.stringify(freeze))throw new Error('Implementation changed after experiment freeze.');
   inputData=await cloneSnapshot(snapshot,runId,runDir);if(observationDigest(inputData)!==snapshot.observationDigest)throw new Error('Frozen observation context changed.');
   const controller=new AbortController();const timer=setTimeout(()=>controller.abort(),totalTimeoutMs);timer.unref();
   try{evaluation=await(dependencies.evaluate??evaluate)({runId,runDir,spec,...inputData,coverage:{...structuredClone(snapshot.report.coverage),canFinish:false,completionBlockers:['Evaluation incomplete.']},timeoutMs:totalTimeoutMs,stageTimeoutMs:options.stageTimeoutMs,canRequestObservation:false,signal:controller.signal});}finally{clearTimeout(timer);}
   if(evaluation.observationRequests?.length)evaluation={...evaluation,status:'partial',limitations:[...evaluation.limitations,'Frozen experiment forbids additional observation; requested observations were not executed.']};
  }catch(error){evaluation={...evaluation,status:'failed',limitations:[...evaluation.limitations,error instanceof Error?error.message:'Experiment job failed.']};}
  const endedAt=new Date().toISOString();const durationMs=Date.now()-start;const coverage=structuredClone(snapshot.report.coverage);coverage.canFinish=evaluation.status==='completed';if(!coverage.canFinish)coverage.completionBlockers.push('Evaluation incomplete.');
  const result:ReviewResult={schemaVersion:'0.1',provider:options.provider,runId,status:evaluation.status==='completed'?'completed':inputData.evidence.length?'partial':'failed',targetUrl:snapshot.report.targetUrl,startedAt,endedAt,findings:evaluation.findings.filter(item=>item.disposition==='confirmed'),verificationCandidates:evaluation.findings.filter(item=>item.disposition==='needs-verification'),coverage,...inputData,limitations:['Frozen evidence experiment; no browsing or new observations during evaluation.','Methods have equal per-stage limits, not equal total time or token budgets.',...evaluation.limitations],evaluation};
  await Promise.all([writeFile(join(runDir,'report.json'),JSON.stringify(result,null,2),{mode:0o600}),writeFile(join(runDir,'report.md'),renderReport(result),{mode:0o600}),writeFile(join(runDir,'manifest.json'),JSON.stringify({runId,...job,provider:options.provider,requestedModel:options.model,requestedReasoningEffort:options.reasoningEffort,spec,startedAt,endedAt,durationMs,plannedStageCount,perStageTimeoutMs:options.stageTimeoutMs,executedStageCount:new Set((evaluation.calls??[]).map(call=>call.stage)).size,skippedStages:evaluation.skippedStages??[],snapshotCaseId:snapshot.caseId,evidenceDigest:snapshot.evidenceDigest,observationDigest:snapshot.observationDigest,runtimeHashes:freeze,evaluationCalls:evaluation.calls??[],hasDynamicObservation:false,hasSeedControl:false},null,2),{mode:0o600})]);
  return{...job,runId,status:result.status,evaluationStatus:evaluation.status,plannedStageCount,executedStageCount:new Set((evaluation.calls??[]).map(call=>call.stage)).size,report:join(runDir,'report.json'),durationMs,modelCallCount:evaluation.calls?.length??0,usage:evaluation.usage,hasUnknownCost:(evaluation.calls??[]).some(call=>call.usage?.estimatedCost===undefined)||evaluation.calls===undefined,hasUnknownTokenUsage:(evaluation.calls??[]).some(call=>call.usage?.inputTokens===undefined||call.usage?.outputTokens===undefined)||evaluation.calls===undefined,evidenceDigest:snapshot.evidenceDigest,observationDigest:snapshot.observationDigest};
 };
 const workers=Array.from({length:Math.min(options.concurrency,jobs.length)},async()=>{while(nextIndex<jobs.length){const job=jobs[nextIndex++]!;const record=await runJob(job);records.push(record);dependencies.onProgress?.(record);await writeFile(join(outputDir,`progress-worker-${job.order}.json`),JSON.stringify(record,null,2),{mode:0o600});}});
 await Promise.all(workers);records.sort((a,b)=>a.order-b.order);
 const summaryPath=join(outputDir,'summary.json');
 await writeFile(summaryPath,JSON.stringify({startedAt,endedAt:new Date().toISOString(),plannedReports:jobs.length,producedReports:records.length,completed:records.filter(item=>item.status==='completed').length,partial:records.filter(item=>item.status==='partial').length,failed:records.filter(item=>item.status==='failed').length,modelCallCount:records.reduce((sum,item)=>sum+item.modelCallCount,0),knownCost:records.some(item=>item.usage?.estimatedCost!==undefined)?records.reduce((sum,item)=>sum+(item.usage?.estimatedCost??0),0):null,hasUnknownCost:records.some(item=>item.hasUnknownCost),hasUnknownTokenUsage:records.some(item=>item.hasUnknownTokenUsage),records},null,2),{mode:0o600,flag:'wx'});
 return{summaryPath,records};
}
