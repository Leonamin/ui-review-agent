import {mkdir,writeFile,readFile,readdir} from 'node:fs/promises';
import {resolve,dirname} from 'node:path';
import {fileURLToPath} from 'node:url';
import {randomUUID,createHash} from 'node:crypto';
import {EvidenceStore} from './evidence.js';
import {importImage,IMAGE_UNAVAILABLE_CHECKS} from './image-input.js';
import {computeCoverage} from './policy.js';
import {evaluate} from './evaluator.js';
import {renderReport} from './report.js';
import sharp from 'sharp';
import {decideImageFollowup} from './followup-image.js';
import {hasExplicitRegionRestriction} from './followup.js';
import type {FollowupResult,FollowupProgress} from './followup-types.js';
import type {RunSpec,ReviewResult,EvaluationResult,Observation,Check} from './types.js';

/** Image source adapter for the same evaluator and report contract as URL inspections. */
export async function inspectImage(spec:RunSpec,outputRoot:string,dependencies:{evaluate?:typeof evaluate;decideImageFollowup?:typeof decideImageFollowup;signal?:AbortSignal;onProgress?:(progress:FollowupProgress)=>void}={}):Promise<{result:ReviewResult;runDir:string}>{
 const runtimeDir=dirname(fileURLToPath(import.meta.url));const runtimeHashes:Record<string,string>={};
 for(const name of (await readdir(runtimeDir)).filter(name=>/\.(?:js|ts)$/.test(name)))runtimeHashes[name]=createHash('sha256').update(await readFile(resolve(runtimeDir,name))).digest('hex');
 const runId=`${new Date().toISOString().replace(/[:.]/g,'-')}-${randomUUID().slice(0,8)}`;
 const runDir=resolve(outputRoot,runId);await mkdir(runDir,{recursive:true,mode:0o700});
 const startedAt=new Date().toISOString();const start=Date.now();const controller=new AbortController();
 const store=new EvidenceStore(runId,runDir);const observations:Observation[]=[];
 const checks:Check[]=[{checkId:'imported-image',description:'Decode and preserve the supplied image',isRequired:true}];
 const observed=new Map<string,string[]>();const reasons=new Map<string,string>();
 let evaluation:EvaluationResult={provider:spec.evaluator,status:'failed',findings:[],screenMap:[],interpretations:[],limitations:['Evaluation did not run.']};
 let terminationReason:string|undefined;let isCancelled=false;
 let followup:FollowupResult|undefined;const evaluationCalls:EvaluationResult[]=[];
 const cancel=()=>{isCancelled=true;terminationReason='User cancelled';controller.abort();};process.once('SIGINT',cancel);dependencies.signal?.addEventListener('abort',cancel,{once:true});if(dependencies.signal?.aborted)cancel();
 const timer=setTimeout(()=>{terminationReason='Automatic inspection time limit reached';controller.abort(new DOMException(terminationReason,'TimeoutError'));},spec.limits.maxDurationMs);timer.unref();
 try{
  if(spec.followup){const source=spec.followup.source.image;if(!source||createHash('sha256').update(await readFile(spec.imagePath!)).digest('hex')!==source.sha256)throw new Error('Static follow-up source integrity verification failed');}
  const observation=await importImage(spec.imagePath!,store,spec.followup?'stored-png':'upload');observations.push(observation);
  observed.set('imported-image',observation.screenshotRefs);
  if(!controller.signal.aborted){
   // Never send source filenames/paths or caller-provided browser state to the model.
   const evaluationSpec={...spec,imagePath:undefined,viewport:observation.viewport};let reviewObservation=observation;
   if(spec.followup){const request=spec.followup;const isSelectedOnly=request.scopeMode==='selected-only'||hasExplicitRegionRestriction(request.instruction);followup={requestId:request.requestId,workspaceId:request.workspaceId,status:'partial',reason:'정적 이미지의 후속 검토를 완료하지 못했습니다.',restoration:{status:'not-required',reason:'원본 이미지의 SHA를 확인했습니다. 웹 브라우저를 열거나 상태를 복원하지 않았습니다.'},history:[],replay:[],needsImageHandoff:false,beforeObservationId:observation.observationId,afterObservationId:observation.observationId,scopeMode:isSelectedOnly?'selected-only':'related-screen',scopeDescription:isSelectedOnly?'선택한 이미지 영역만':'저장된 이미지와 요청에 관련된 화면'};
    if(isSelectedOnly&&!request.region)throw new Error('Static selected-only review requires an image region');
    if(request.region){const region=request.region,source=request.source.image!;if(![region.x,region.y,region.width,region.height].every(Number.isSafeInteger)||region.x<0||region.y<0||region.width<1||region.height<1||region.x+region.width>source.width||region.y+region.height>source.height)throw new Error('Static selected region is outside the immutable source');const bytes=await sharp(spec.imagePath!).extract({left:region.x,top:region.y,width:region.width,height:region.height}).png().toBuffer();const crop=await store.save(observation.observationId,'screenshot',bytes,'image/png','followup-region');crop.screenshot={coordinateSpace:'image-pixels',clip:region,deviceScaleFactor:1,maskColor:'',redactionRegions:[]};observation.evidenceRefs.push(crop);observation.screenshotRefs.push(crop.evidenceId);if(isSelectedOnly)reviewObservation={...observation,evidenceRefs:[crop],screenshotRefs:[crop.evidenceId]};}
    evaluationSpec.purpose=`${request.instruction}\nStatic image only. Actual scope: ${followup.scopeDescription}. ${isSelectedOnly?'Review ONLY the supplied crop; coordinates refer to the original image.':''}`;
   }
   const input={runId,runDir,spec:evaluationSpec,observations:[reviewObservation],rules:[],actions:[],evidence:reviewObservation.evidenceRefs,
    coverage:{...computeCoverage(checks,observed,reasons,false),unavailableChecks:IMAGE_UNAVAILABLE_CHECKS},
    timeoutMs:Math.max(0,spec.limits.maxDurationMs-(Date.now()-start)),canRequestObservation:false,signal:controller.signal};
   let canReview=true;if(followup){dependencies.onProgress?.({phase:'planning',reason:'저장된 이미지로 답할 수 있는 요청인지 확인합니다.'});const selected=await(dependencies.decideImageFollowup??decideImageFollowup)(input);evaluationCalls.push(selected.evaluation);canReview=Boolean(selected.decision?.canAnswerFromImage);followup.answer=selected.decision?.answer;followup.reason=selected.decision?.reason??'정적 이미지 요청을 판단하지 못했습니다.';followup.needsImageHandoff=Boolean(selected.decision&&!selected.decision.canAnswerFromImage);if(!canReview)evaluation={...selected.evaluation,status:'partial',limitations:[...selected.evaluation.limitations,'정적 이미지로는 새 화면 조작이나 실제 상태 변화를 검증할 수 없습니다. 준비된 상태 이미지를 제공해 주세요.']};}
   if(canReview&&!controller.signal.aborted){dependencies.onProgress?.({phase:'evaluating',reason:'저장된 이미지의 요청 범위를 평가합니다.'});evaluation=await(dependencies.evaluate??evaluate)({...input,timeoutMs:Math.max(0,spec.limits.maxDurationMs-(Date.now()-start))});evaluationCalls.push(evaluation);if(followup){followup.status=evaluation.status==='completed'?'completed':'partial';followup.reason=evaluation.status==='completed'?'저장된 이미지의 요청 범위를 검토했습니다. 실제 웹 동작은 검증하지 않았습니다.':'이미지의 최종 평가를 완료하지 못했습니다.';}}
  }
 }catch(error){terminationReason=error instanceof Error?error.message.slice(0,500):'Image inspection failed';reasons.set('imported-image',terminationReason);if(followup){followup.status='partial';followup.reason=terminationReason;}}
 finally{clearTimeout(timer);process.removeListener('SIGINT',cancel);dependencies.signal?.removeEventListener('abort',cancel);}
 if(followup&&controller.signal.aborted){followup.status=isCancelled?'cancelled':'partial';followup.reason=isCancelled?'이미지 후속 검토가 취소되었습니다.':'이미지 후속 검토 시간이 초과되었습니다.';}
 if(evaluationCalls.length){const usage:NonNullable<EvaluationResult['usage']>={};for(const key of ['inputTokens','cacheCreationInputTokens','cacheReadInputTokens','outputTokens','estimatedCost'] as const){const values=evaluationCalls.flatMap(call=>typeof call.usage?.[key]==='number'?[call.usage[key]!]:[]);if(values.length)usage[key]=values.reduce((a,b)=>a+b,0);}evaluation={...evaluation,calls:evaluationCalls.flatMap(call=>call.calls??[]),usage:Object.keys(usage).length?usage:undefined};}
 const hasValidEvaluation=evaluation.status==='completed'&&!controller.signal.aborted;
 const coverage={...computeCoverage(checks,observed,reasons,hasValidEvaluation),unavailableChecks:IMAGE_UNAVAILABLE_CHECKS};
 if(!hasValidEvaluation)terminationReason??='Evaluation incomplete';
 const status=isCancelled?'cancelled':coverage.canFinish?'completed':observations.length?'partial':'failed';
 const result:ReviewResult={...(followup?{followup}:{}),...(evaluation.observationLedger?{observationLedger:evaluation.observationLedger}:{}),schemaVersion:'0.1',provider:spec.evaluator,runId,status,imageSource:observations[0]?.source,startedAt,endedAt:new Date().toISOString(),
  suggestions:evaluation.suggestions??[],findings:evaluation.findings.filter(f=>f.disposition==='confirmed'),verificationCandidates:evaluation.findings.filter(f=>f.disposition==='needs-verification'),
  coverage,observations,actions:[],rules:[],evidence:store.evidence,evaluation,
  limitations:[...IMAGE_UNAVAILABLE_CHECKS.map(item=>item.reason),...evaluation.limitations],terminationReason};
 const {imagePath:_,...safeSpec}=spec;if(safeSpec.followup)safeSpec.followup={...safeSpec.followup,sourceImagePath:undefined};
 await Promise.all([
  writeFile(resolve(runDir,'manifest.json'),JSON.stringify({schemaVersion:'0.1',inputKind:'image',provider:spec.evaluator,requestedModel:spec.model??null,requestedReasoningEffort:spec.reasoningEffort??null,strategy:spec.strategy??'A',runId,status,spec:{...safeSpec,viewport:observations[0]?.viewport},imageSource:result.imageSource,coverage,startedAt,endedAt:result.endedAt,terminationReason,evaluationCalls:(evaluationCalls.length?evaluationCalls:[evaluation]).map(call=>({provider:spec.evaluator,status:call.status,usage:call.usage,model:call.model,calls:call.calls})),implementation:{runtimeHashes},toolVersions:{node:process.version}},null,2),{mode:0o600}),
  writeFile(resolve(runDir,'check-plan.json'),JSON.stringify(checks,null,2),{mode:0o600}),
  writeFile(resolve(runDir,'report.json'),JSON.stringify(result,null,2),{mode:0o600}),
  writeFile(resolve(runDir,'report.md'),renderReport(result),{mode:0o600}),
 ]);
 return {result,runDir};
}
