import {projectPostLeaseKey} from './post-host-policy.js';
import {mkdir,writeFile,readFile,readdir,rm} from 'node:fs/promises';
import {resolve} from 'node:path';
import {randomUUID,createHash} from 'node:crypto';
import {fileURLToPath} from 'node:url';
import {dirname} from 'node:path';
import {createInterface} from 'node:readline/promises';
import {Budget,validateSpec,computeCoverage,safeUrl} from './policy.js';
import {EvidenceStore} from './evidence.js';
import {BrowserSession} from './browser.js';
import {sweepVertical} from './vertical-scroll.js';
import {startMcp,connectMcp,callTool} from './mcp.js';
import {evaluate} from './evaluator.js';
import {unreportedRuleCandidates} from './rule-findings.js';
import {decideState,discoverStates} from './state-discovery.js';
import {renderReport} from './report.js';
import {isVerificationTab} from './verification.js';
import {buildFindingAssessments,applyAutomaticVerificationRequests} from './evaluation-verification.js';
import {acquireBrowserLease,type BrowserLeaseReservation} from './browser-lease.js';
import {executeFollowup,decideFollowup,followupEvaluationInput} from './followup.js';
import {isReversibleReplayDismissal} from './replay-dismissal.js';
import type {FollowupProgress,FollowupResult} from './followup-types.js';
import {decideImageFollowup} from './followup-image.js';
import {inspectImage} from './image-core.js';
import type {VerificationResult} from './verification-types.js';
import type {RunSpec,ReviewResult,Check,Observation,ActionRecord,RuleFinding,EvaluationResult,StateDiscoveryResult} from './types.js';
import {verifyThemePair,type ThemeCapture,type ThemeProbe} from './theme-review.js';
import {makeStyleComparison} from './style-comparison.js';
import {makeAutomaticStyleComparison} from './automatic-style-comparison.js';
import {ReviewAuthenticationError,ReviewLoginRequired,type ReviewCredentials,type ProjectSupabaseAuth} from './review-auth.js';
export interface ReviewRuntimeOptions {
 evaluate?:typeof evaluate;
 decideState?:typeof decideState;
 decideFollowup?:typeof decideFollowup;
 decideImageFollowup?:typeof decideImageFollowup;
 signal?:AbortSignal;
 onProgress?:(progress:FollowupProgress)=>void;
 canSendProjectPost?:(projectId:string,hostname:string)=>boolean;
 credentials?:ReviewCredentials;
 projectSupabaseAuth?:ProjectSupabaseAuth;
 shouldDetectRedirectedLogin?:boolean;
 expectedRedirectedLoginUrl?:string;
}
export async function inspect(spec:RunSpec,outputRoot:string,dependencies:ReviewRuntimeOptions={}):Promise<{result:ReviewResult;runDir:string}>{
 validateSpec(spec);const hasStyleComparison=Boolean(spec.styleComparison||spec.autoStyleComparison);if(dependencies.credentials&&hasStyleComparison)throw new Error('Style comparison does not support authentication.');if(dependencies.credentials&&(spec.imagePath||spec.shouldWaitForLogin))throw new ReviewAuthenticationError('destination');if(spec.imagePath)return inspectImage(spec,outputRoot,dependencies);const runtimeDir=dirname(fileURLToPath(import.meta.url));const runtimeHashes:Record<string,string>={};
 for(const name of (await readdir(runtimeDir)).filter(name=>/\.(?:js|ts)$/.test(name))){runtimeHashes[name]=createHash('sha256').update(await readFile(resolve(runtimeDir,name))).digest('hex');}
 const runId=`${new Date().toISOString().replace(/[:.]/g,'-')}-${randomUUID().slice(0,8)}`;const runDir=resolve(outputRoot,runId);await mkdir(runDir,{recursive:true,mode:0o700});
 const startedAt=new Date().toISOString();const budget=new Budget(spec);const store=new EvidenceStore(runId,runDir);let session=new BrowserSession(spec,budget,store,undefined,{canSendProjectPost:dependencies.canSendProjectPost,projectSupabaseAuth:dependencies.projectSupabaseAuth});let lease:BrowserLeaseReservation|undefined;let hasReusedBrowser=false;let followup:FollowupResult|undefined;
 const checks:Check[]=[{checkId:'initial-screen',description:'Capture initial viewport and structure',isRequired:true},...(!spec.followup?[{checkId:'initial-rules',description:'Run deterministic accessibility and layout checks',isRequired:true}]:[]),...spec.allowedActions.filter(a=>!spec.shouldVerify||!isVerificationTab(a)).map(a=>({checkId:`action-${a.id}`,description:a.description,isRequired:true}))];
 if(spec.themeReview)checks.push(
  {checkId:'theme-light',description:'Verify the light palette and measure text contrast',isRequired:true},
  {checkId:'theme-dark',description:'Verify the dark palette and measure text contrast',isRequired:true});
 if(spec.alignmentContracts?.length)checks.push({checkId:'group-alignment',description:'Measure each configured control group',isRequired:true});
 if(hasStyleComparison)checks.push({checkId:'style-comparison',description:'Compare rendered styles across the configured pages',isRequired:true});
 const observed=new Map<string,string[]>();const reasons=new Map<string,string>();const limitations=['관찰된 뷰포트와 기록된 스크롤 구간을 검사했습니다. iframe 내부는 검사 범위에서 제외됩니다.','Input fields are masked; other personal content may remain. Inspect only authorized data.','AI evaluation is tool-restricted; additional capture or element inspection is limited to one policy-controlled round.'];
 let terminationReason:string|undefined;let isCancelled=false;let hasCurrentReviewContext=true;const abortController=new AbortController();let deadlineTimer:NodeJS.Timeout|undefined;
 const armDeadline=()=>{deadlineTimer=setTimeout(()=>{terminationReason='Automatic inspection time limit reached';abortController.abort(new DOMException(terminationReason,'TimeoutError'));void session.close();},budget.remainingMs());deadlineTimer.unref();};
 const recordEnvironment=()=>{if(session.warnings.some(w=>w.startsWith('Blocked')||w.startsWith('WebSocket'))&&!checks.some(c=>c.checkId==='unblocked-environment')){checks.push({checkId:'unblocked-environment',description:'Page rendered without policy-blocked requests',isRequired:true});reasons.set('unblocked-environment','Inspection policy blocked requests; missing data or loading may be environmental');}if(session.observations.some(observation=>observation.unsupportedFrames>0)&&!checks.some(check=>check.checkId==='embedded-frame-content')){checks.push({checkId:'embedded-frame-content',description:'Inspect visible embedded frame contents',isRequired:true});reasons.set('embedded-frame-content','Embedded frame inspection is unsupported in MVP');}};
 let stateDiscovery:StateDiscoveryResult|undefined;
 const evaluationCalls:EvaluationResult[]=[];const verifications:VerificationResult[]=[];
 let evaluation:EvaluationResult={provider:spec.evaluator,status:'failed',findings:[],screenMap:[],interpretations:[],limitations:['Evaluation did not run']};
 let mcp:Awaited<ReturnType<typeof startMcp>>|undefined;let client:Awaited<ReturnType<typeof connectMcp>>|undefined;
 const onCancel=()=>{isCancelled=true;terminationReason='User cancelled';abortController.abort();void session.close();};process.once('SIGINT',onCancel);dependencies.signal?.addEventListener('abort',onCancel,{once:true});if(dependencies.signal?.aborted)onCancel();
 try{
  if(!spec.shouldWaitForLogin)armDeadline();
  if(abortController.signal.aborted)throw new Error('User cancelled');
  if(!hasStyleComparison&&!dependencies.credentials&&!dependencies.expectedRedirectedLoginUrl)lease=await acquireBrowserLease(spec.followup?.workspaceId??spec.workspaceId,spec.followup?.executionBase?.runId??spec.followup?.source.runId,abortController.signal,projectPostLeaseKey(spec.projectPostPolicy));
  hasReusedBrowser=Boolean(lease?.physical);
  if(lease?.physical)session=new BrowserSession(spec,budget,store,lease.physical,{canSendProjectPost:dependencies.canSendProjectPost});
  dependencies.onProgress?.({phase:'opening',reason:hasReusedBrowser?'보관된 작업공간 브라우저를 확인합니다.':'검토 대상 화면을 엽니다.'});
  try{await session.start(dependencies.credentials);}
  catch(error){
   if(!dependencies.credentials||isCancelled)throw error;
   throw error instanceof ReviewAuthenticationError?error:new ReviewAuthenticationError('target');
  }
  if(spec.shouldWaitForLogin){
   const readline=createInterface({input:process.stdin,output:process.stderr});
   try{await readline.question('Complete login in the browser, return to the target origin, then press Enter: ',{signal:AbortSignal.timeout(600000)});await session.finishLogin();armDeadline();}finally{readline.close();}
  }
  if(!dependencies.credentials&&!spec.shouldWaitForLogin){
   const expectedLoginUrl=dependencies.expectedRedirectedLoginUrl;
   if(expectedLoginUrl||dependencies.shouldDetectRedirectedLogin)await session.prepareLoginCapture(expectedLoginUrl,hasReusedBrowser);
  }
  mcp=await startMcp(session);client=await connectMcp(mcp.url,mcp.token);
  const styleReference=spec.styleComparison?await session.captureStyleSide('reference'):undefined;
  const autoReference=spec.autoStyleComparison?await session.captureAutomaticStyleSide('reference'):undefined;
  const initial=styleReference?.observation??autoReference?.observation??await callTool<Observation>(client,'captureObservation');observed.set('initial-screen',initial.evidenceRefs.map(e=>e.evidenceId));
  const base=spec.followup?.executionBase;
  const dismissalIndices=[...(base?.dismissalEvidence?.map(item=>item.replayIndex)??[]),...(base?.dismissalConflicts??[])];
  const hasScopedDismissalReplay=!hasReusedBrowser&&dismissalIndices.some(replayIndex=>{
   const step=base?.replay?.[replayIndex];
   return step&&isReversibleReplayDismissal(step);
  });
  // In a proven replay, the historical modal check owns the first interaction with a fresh page.
  if(spec.stateDiscovery&&!hasScopedDismissalReplay){
   const checkId='url-state-discovery';checks.push({checkId,description:'Observe a prepared content, empty or error state after bounded loading and safe modal discovery',isRequired:true});
   const determineState:typeof decideState=async (...args)=>{
    await session.validateLoginCaptureScope();
    return (dependencies.decideState??decideState)(...args);
   };
   const collected=await budget.preservingObservations(spec.themeReview?1:0,()=>discoverStates(session,()=>({runId,runDir,spec,observations:session.observations,rules:session.rules,actions:session.actions,evidence:store.evidence,coverage:computeCoverage(checks,observed,reasons,false),timeoutMs:budget.remainingMs(),canRequestObservation:false,signal:abortController.signal}),determineState));
   session.checkLoginCaptureError();
   stateDiscovery=collected.result;evaluationCalls.push(...collected.evaluations);
   if(stateDiscovery.status==='completed')observed.set(checkId,session.observations.filter(obs=>stateDiscovery!.observationIds.includes(obs.observationId)).flatMap(obs=>obs.evidenceRefs.map(e=>e.evidenceId)));else reasons.set(checkId,stateDiscovery.reason);
  }
  if(session.observations.some(observation=>observation.unsupportedFrames>0)){checks.push({checkId:'embedded-frame-content',description:'Inspect visible embedded frame contents',isRequired:true});reasons.set('embedded-frame-content','Embedded frame inspection is unsupported in MVP');}
  if(spec.followup){
   const checkId='followup-goal';checks.push({checkId,description:spec.followup.instruction,isRequired:true});
   const determineFollowup:typeof decideFollowup=async (...args)=>{
    await session.validateLoginCaptureScope();
    return (dependencies.decideFollowup??decideFollowup)(...args);
   };
   const executed=await executeFollowup(session,()=>({runId,runDir,spec,observations:session.observations,rules:[],actions:session.actions,evidence:store.evidence,coverage:computeCoverage(checks,observed,reasons,false),timeoutMs:budget.remainingMs(),canRequestObservation:false,signal:abortController.signal}),{hasReusedBrowser,decide:determineFollowup,onProgress:dependencies.onProgress});
   session.checkLoginCaptureError();
   followup=executed.result;evaluationCalls.push(...executed.evaluations);
   if(followup.status==='completed')observed.set(checkId,session.observations.flatMap(observation=>observation.screenshotRefs));else reasons.set(checkId,followup.reason);
  }
  if(!spec.followup){
   const captureTheme=async()=>{
    await callTool<Observation>(client!,'captureObservation');
    return session.observations.at(-1)!;
   };
   let light=session.observations.at(-1)!;
   if(spec.themeReview&&!light.isStable&&light.state?.readiness!=='loading'&&light.state?.readiness!=='blocked'&&budget.remainingObservations()>1){
    try{
     const recaptured=await captureTheme();
     if(light.accessibilitySnapshot===recaptured.accessibilitySnapshot&&light.url===recaptured.url)recaptured.state=light.state;
     light=recaptured;
    }catch(error){limitations.push(`명확한 라이트 테마 캡처를 다시 확보하지 못했습니다. ${errorMessage(error)}`);}
   }
   const runRules=async(observation:Observation)=>{
    await callTool<RuleFinding[]>(client!,'runRuleChecks',{observationId:observation.observationId});
    return store.evidence.find(e=>e.observationId===observation.observationId&&e.kind==='rule')?.evidenceId;
   };
   try{const ref=await runRules(light);if(ref)observed.set('initial-rules',[ref]);}catch(error){reasons.set('initial-rules',errorMessage(error));}
   let dark:Observation|undefined;
   if(spec.themeReview){
    let darkProbe:ThemeProbe|undefined;
    let darkError:string|undefined;
    const lightProbe=await session.readReviewTheme(light).catch(()=>undefined);
    try{
     await session.setReviewTheme('dark');
     dark=await captureTheme();
     if(!dark.isStable&&budget.remainingObservations()>0)dark=await captureTheme();
     if(light.state?.readiness==='loading'||light.state?.readiness==='blocked')dark.state=light.state;
     await runRules(dark);
     darkProbe=await session.readReviewTheme(dark);
    }catch(error){darkError=errorMessage(error);}
    const lightScreenshot=light.evidenceRefs.find(ref=>ref.kind==='screenshot');
    const darkScreenshot=dark?.evidenceRefs.find(ref=>ref.kind==='screenshot');
    let captures:{light:ThemeCapture;dark:ThemeCapture}|undefined;
    if(lightProbe&&darkProbe&&lightScreenshot&&darkScreenshot&&lightScreenshot.sha256!==darkScreenshot.sha256&&!spec.themeReview.selectors){
     const readCapture=async(ref:NonNullable<typeof lightScreenshot>):Promise<ThemeCapture>=>({
      data:(await store.read(ref.evidenceId)).data,viewport:spec.viewport,
      masks:ref.screenshot?.redactionRegions?.map(region=>region.boundingBox)
     });
     try{
      const [lightImage,darkImage]=await Promise.all([readCapture(lightScreenshot),readCapture(darkScreenshot)]);
      captures={light:lightImage,dark:darkImage};
     }catch(error){limitations.push(`테마 근거 이미지를 읽지 못했습니다. ${errorMessage(error)}`);}
    }
    let themes;
    try{themes=await verifyThemePair(lightProbe,darkProbe,spec.themeReview,captures);}
    catch(error){
     limitations.push(`테마 근거 이미지를 비교하지 못했습니다. ${errorMessage(error)}`);
     themes=await verifyThemePair(lightProbe,darkProbe,spec.themeReview);
    }
    for(const observation of [light,dark]){
     const theme=observation===light?themes.light:themes.dark;
     const id=`theme-${theme.requested}`;
     if(observation)observation.theme=theme;
     const rule=observation?.deterministicChecks;
     const contrast=rule?.contrast;
     if(theme.status==='verified'&&rule&&contrast&&contrast.status!=='inapplicable'&&contrast.incomplete===0&&!contrast.hasReachedLimit)
      observed.set(id,[rule.evidenceId,...observation!.screenshotRefs]);
     else reasons.set(id,theme.requested==='dark'&&darkError?darkError:theme.status==='unverified'?theme.reason:
      contrast?.hasReachedLimit?'텍스트 대비 검사에 사용할 수 있는 측정 한도에 도달했습니다.':
      contrast?.incomplete?`텍스트 대비 측정에 추가 확인이 필요한 요소가 ${contrast.incomplete}개 있습니다.`:'텍스트 대비를 측정할 수 있는 요소 또는 근거를 확보하지 못했습니다.');
    }
   }
   if(spec.alignmentContracts?.length){
    const expected=[light,...(spec.themeReview?[dark]:[])];
    const reports=expected.flatMap(observation=>observation?.deterministicChecks?[observation.deterministicChecks]:[]);
    if(reports.length===expected.length&&reports.every(report=>report.alignment&&
      spec.alignmentContracts!.every((_contract,index)=>report.alignment!.checks.some(check=>check.contractIndex===index+1)&&
      !report.alignment!.checks.some(check=>check.contractIndex===index+1&&check.status==='unverified'))))
     observed.set('group-alignment',reports.map(report=>report.evidenceId));
    else reasons.set('group-alignment','지정한 컨트롤 그룹 중 일부의 시각 크기 또는 정렬을 측정하지 못했습니다.');
   }
  }
  if(spec.styleComparison&&styleReference){
   const target=!isCancelled&&budget.remainingMs()>0?await session.captureStyleSide('comparison').catch(()=>undefined):undefined;
   const describe=({observation,sample}:typeof styleReference)=>({
    sample,url:observation.url,observationId:observation.observationId,screenshotEvidenceId:observation.screenshotRefs[0],
   });
   const measured=makeStyleComparison(spec.styleComparison,describe(styleReference),
    target?describe(target):{url:safeUrl(spec.styleComparison.comparisonUrl),sample:{status:'unverified',reason:'unavailable'}});
   const evidence=await store.save(initial.observationId,'rule',JSON.stringify(measured,null,2),'application/json','style-comparison');
   initial.evidenceRefs.push(evidence);
   initial.deterministicChecks={evidenceId:evidence.evidenceId,...initial.deterministicChecks,styleComparison:{evidenceId:evidence.evidenceId,...measured}};
   if(measured.checks.some(check=>check.status==='unverified'))
    reasons.set('style-comparison','지정한 두 화면의 요소를 안정적으로 측정하지 못했습니다.');
   else observed.set('style-comparison',[evidence.evidenceId,...initial.screenshotRefs,...(target?.observation.screenshotRefs??[])]);
  }
  if(spec.autoStyleComparison&&autoReference){
   const target=!isCancelled&&budget.remainingMs()>0?await session.captureAutomaticStyleSide('comparison').catch(()=>undefined):undefined;
   const describe=({observation,sample}:typeof autoReference)=>({
    sample,url:observation.url,observationId:observation.observationId,screenshotEvidenceId:observation.screenshotRefs[0],
   });
   const measured=makeAutomaticStyleComparison(describe(autoReference),target?describe(target):{
    url:safeUrl(spec.autoStyleComparison.comparisonUrl),sample:{entries:[],hasReachedLimit:false,reason:'unavailable'},
   });
   const evidence=await store.save(initial.observationId,'rule',JSON.stringify(measured,null,2),'application/json','automatic-style-comparison');
   initial.evidenceRefs.push(evidence);
   initial.deterministicChecks={evidenceId:evidence.evidenceId,...initial.deterministicChecks,autoStyleComparison:{evidenceId:evidence.evidenceId,...measured}};
   if(measured.reference.reason||measured.comparison.reason)
    reasons.set('style-comparison','지정한 두 화면을 안정적으로 측정하지 못했습니다.');
   else if(measured.reference.hasReachedLimit||measured.comparison.hasReachedLimit)
    reasons.set('style-comparison','요소 탐색 한도에 도달해 일부 요소의 짝을 확인하지 못했습니다.');
   else if(!measured.coverage.matched)
    reasons.set('style-comparison','두 화면에서 비교할 수 있는 요소 쌍을 찾지 못했습니다.');
   else if(measured.coverage.unmeasured)
    reasons.set('style-comparison','일부 요소의 스타일을 안정적으로 측정하지 못했습니다.');
   else observed.set('style-comparison',[evidence.evidenceId,...initial.screenshotRefs,...(target?.observation.screenshotRefs??[])]);
  }
  for(const action of spec.allowedActions.filter(action=>!spec.shouldVerify||!isVerificationTab(action))){
   if(isCancelled)break;
   try{const record=await callTool<ActionRecord>(client,'performAction',{actionId:action.id,expectedObservationId:session.observations.at(-1)?.observationId});
    if(record.outcome==='success'&&record.afterObservationId){const obs=session.observations.find(o=>o.observationId===record.afterObservationId)!;observed.set(`action-${action.id}`,obs.evidenceRefs.map(e=>e.evidenceId));}else{reasons.set(`action-${action.id}`,record.message??'Action observation incomplete');break;}
   }catch(error){reasons.set(`action-${action.id}`,errorMessage(error));break;}
  }
  if(!spec.followup&&!spec.themeReview&&!hasStyleComparison&&spec.reviewPipeline!=='observation-ledger'&&!isCancelled&&budget.remainingMs()>2500){
   const checkId='vertical-scroll';
   const recordScrollLimit=(reason:string)=>{reasons.set(checkId,reason);limitations.push(reason);};
   const initialPosition=session.observations.at(-1)!;
   try{
    const sweep=await budget.preservingObservations(spec.shouldVerify?Math.min(6,Math.max(0,budget.remainingObservations()-3)):0,()=>sweepVertical(session,initialPosition,abortController.signal));
    if(!sweep.hasRestoredPosition){
     hasCurrentReviewContext=false;
     terminationReason??=sweep.reason;
    }
    if(sweep.observations.length||sweep.reason){
     checks.push({checkId,description:'Capture overlapping viewports through the observed vertical scroll extent',isRequired:true});
     if(sweep.reason)recordScrollLimit(sweep.reason);
     else observed.set(checkId,sweep.observations.flatMap(item=>item.screenshotRefs));
    }
   }catch(error){
    hasCurrentReviewContext=false;
    terminationReason??='스크롤 캡처 후 현재 화면을 확인하지 못했습니다.';
    checks.push({checkId,description:'Capture overlapping viewports through the observed vertical scroll extent',isRequired:true});
    recordScrollLimit(`스크롤 캡처가 중단되었습니다. ${errorMessage(error)}`);
   }
  }
  await session.validateLoginCaptureScope();
  recordEnvironment();
  if(followup&&followup.restoration.status!=='failed'&&!isCancelled&&budget.remainingMs()>0){
   dependencies.onProgress?.({phase:'evaluating',reason:'조작 후 실제 화면을 요청 범위에 맞춰 평가합니다.'});
   const input=await followupEvaluationInput(session,{runId,runDir,spec,observations:session.observations,rules:session.rules,actions:session.actions,evidence:store.evidence,coverage:computeCoverage(checks,observed,reasons,false),timeoutMs:budget.remainingMs(),canRequestObservation:false,signal:abortController.signal},followup);
   evaluation=await(dependencies.evaluate??evaluate)({...input,timeoutMs:budget.remainingMs()});evaluationCalls.push(evaluation);
   if(evaluation.status!=='completed'){followup.status='partial';followup.reason+=' UI 평가를 완료하지 못했습니다.';observed.delete('followup-goal');reasons.set('followup-goal',followup.reason);}
  }
  const evaluateCurrent=async(canRequestObservation:boolean)=>{
   await session.saveFormRowChecks(session.observations);
   const result=await (dependencies.evaluate??evaluate)({runId,runDir,spec,observations:session.observations,rules:session.rules,actions:session.actions,evidence:store.evidence,coverage:computeCoverage(checks,observed,reasons,false),timeoutMs:budget.remainingMs(),canRequestObservation,signal:abortController.signal});
   const taggedResult={...result,provider:result.provider??spec.evaluator};evaluationCalls.push(taggedResult);return taggedResult;
  };
  if(!spec.followup&&!isCancelled&&budget.remainingMs()>0){
   evaluation=await evaluateCurrent(hasCurrentReviewContext&&!spec.shouldVerify&&!spec.themeReview);
   if(hasCurrentReviewContext&&!spec.shouldVerify&&!spec.themeReview&&evaluation.observationRequests?.length&&!abortController.signal.aborted){
    const requestLimit=spec.mode==='quick'?1:2;
    for(const request of evaluation.observationRequests.slice(0,requestLimit)){
     try{budget.assertTime();if(request.observationId!==session.observations.at(-1)?.observationId)throw new Error('Stale additional observation request');
      if(request.type==='inspect'&&request.elementRef)await callTool(client,'inspectElement',{observationId:request.observationId,elementRef:request.elementRef});
      else if(request.type==='capture')await callTool(client,'captureObservation');
      else throw new Error('Invalid additional observation request');
     }catch(error){limitations.push(`Additional observation not completed: ${errorMessage(error)}`);}
    }
    session.checkLoginCaptureError();recordEnvironment();if(!abortController.signal.aborted&&budget.remainingMs()>0)evaluation=await evaluateCurrent(false);
   }
   if(spec.shouldVerify){
    evaluation=applyAutomaticVerificationRequests({runId,runDir,spec,observations:session.observations,rules:session.rules,actions:session.actions,evidence:store.evidence,coverage:computeCoverage(checks,observed,reasons,false),timeoutMs:budget.remainingMs(),canRequestObservation:false,signal:abortController.signal},evaluation);
    // This immutable prefix is the paired baseline. Verification adds evidence, never replaces it.
    await writeFile(resolve(runDir,'verification-input.json'),JSON.stringify({runId,spec:{...spec,targetUrl:safeUrl(spec.targetUrl!),allowedActions:spec.allowedActions.map(({value,...action})=>({...action,...(value?{hasValue:true}:{})}))},evaluation,observations:session.observations,actions:session.actions,rules:session.rules,evidence:store.evidence,coverage:computeCoverage(checks,observed,reasons,evaluation.status==='completed')},null,2),{mode:0o600});
    const seenCandidates=new Set<string>();
    for(const request of (evaluation.verificationRequests??[]).slice(0,3)){
     if(seenCandidates.has(request.candidateId))continue;seenCandidates.add(request.candidateId);
     const checkId=`verification-${request.requestId}`;checks.push({checkId,description:`${request.recipe} measurement for ${request.candidateId}`,isRequired:true});
     if(!hasCurrentReviewContext){reasons.set(checkId,'스크롤 후 현재 화면을 복원하지 못해 검증 동작을 실행할 수 없습니다.');continue;}
     try{
      const candidate=evaluation.findings.find(f=>f.issueId===request.candidateId&&f.disposition!=='dismissed');
      if(!candidate||![...request.claimIds,...(request.recipe==='occlusion'?request.additionalTargets?.flatMap(target=>target.claimIds)??[]:[])].every(id=>candidate.observedFacts.some(f=>f.factId===id))||!candidate.expectations.some(expectation=>JSON.stringify(expectation)===JSON.stringify(request.expectation)))throw new Error('Verification request is not anchored to an accepted candidate and expectation');
      const measured=await callTool<VerificationResult>(client,'verifyCandidate',{request});verifications.push(measured);
      if(measured.outcome==='inconclusive')reasons.set(checkId,measured.summary);else observed.set(checkId,measured.evidenceIds);
     }catch(error){reasons.set(checkId,errorMessage(error));limitations.push(`Verification not completed: ${errorMessage(error)}`);}
    }
    if((evaluation.verificationRequests?.length??0)>3)limitations.push('Verification request cap reached (3 per run); excess requests were not executed.');
    recordEnvironment();
   }
  }
  session.checkLoginCaptureError();
 }catch(error){
  // The internal MCP transport textifies errors. Preserve the capture guard's typed failure
  // even when a tool wrapper or an optional re-observation handles the serialized error.
  const failure=session.getLoginCaptureError()??error;
  if(!isCancelled&&(failure instanceof ReviewAuthenticationError||failure instanceof ReviewLoginRequired)){
   terminationReason=failure.message;
   await rm(runDir,{recursive:true,force:true});
   throw failure;
  }
  terminationReason=isCancelled?'User cancelled':errorMessage(error);limitations.push(terminationReason);
 }
 finally{if(deadlineTimer)clearTimeout(deadlineTimer);process.removeListener('SIGINT',onCancel);dependencies.signal?.removeEventListener('abort',onCancel);await client?.close().catch(()=>{});await mcp?.close().catch(()=>{});const canReuse=!spec.themeReview&&!terminationReason&&!abortController.signal.aborted&&!isCancelled&&(!spec.followup||Boolean(followup&&followup.restoration.status!=='failed')); if(lease&&canReuse){const physical=await session.releasePhysicalContext().catch(()=>undefined);await lease.release(physical,runId,Boolean(physical));}else{await session.close().catch(()=>{});await lease?.release(undefined,runId,false);}}
 recordEnvironment();
 if(followup&&isCancelled){followup.status='cancelled';followup.reason='후속 검토가 취소되었습니다.';observed.delete('followup-goal');reasons.set('followup-goal',followup.reason);}
 if(followup&&followup.status!=='completed'){observed.delete('followup-goal');reasons.set('followup-goal',followup.reason);}
 if(evaluationCalls.length){
  const usage:NonNullable<EvaluationResult['usage']>={};
  for(const key of ['inputTokens','cacheCreationInputTokens','cacheReadInputTokens','outputTokens','estimatedCost'] as const){const values=evaluationCalls.flatMap(call=>typeof call.usage?.[key]==='number'?[call.usage[key]!]:[]);if(values.length)usage[key]=values.reduce((a,b)=>a+b,0);if(values.length>0&&values.length<evaluationCalls.length)limitations.push(`${key} totals cover only calls that reported usage; other call usage is unknown`);}
  evaluation={...evaluation,calls:evaluationCalls.flatMap(call=>call.calls??[]),usage:Object.keys(usage).length?usage:undefined};
 }
 const hasValidEvaluation=evaluation.status==='completed';if(followup&&!hasValidEvaluation&&followup.status==='completed'){followup.status=isCancelled?'cancelled':'partial';followup.reason+=' UI 평가를 완료하지 못했습니다.';observed.delete('followup-goal');reasons.set('followup-goal',followup.reason);}const coverage=computeCoverage(checks,observed,reasons,hasValidEvaluation);
 if(spec.evaluator==='rules-only')limitations.push('Rules-only inspection: AI usability evaluation was not performed.');
 if(!hasValidEvaluation)terminationReason??='Evaluation incomplete';
 const status=isCancelled?'cancelled':coverage.canFinish?'completed':store.evidence.length?'partial':'failed';
 const verificationCandidates=evaluation.findings.filter(f=>f.disposition==='needs-verification');
 if(spec.evaluator!=='rules-only')verificationCandidates.push(...unreportedRuleCandidates(session.rules,evaluation));
 const result:ReviewResult={...(followup?{followup}:{}),...(stateDiscovery?{stateDiscovery}:{}),...(spec.shouldVerify?{verifications,findingsBasis:'initial-ai-review' as const,findingAssessments:buildFindingAssessments(evaluation.findings,verifications)}:{}),schemaVersion:'0.1',provider:spec.evaluator,runId,status,targetUrl:safeUrl(spec.targetUrl!),startedAt,endedAt:new Date().toISOString(),findings:evaluation.findings.filter(f=>f.disposition==='confirmed'),verificationCandidates,coverage,observations:session.observations,actions:session.actions,rules:session.rules,evidence:store.evidence,limitations:[...new Set([...limitations,...session.warnings,...evaluation.limitations])],evaluation,terminationReason};
 const safeSpec={...spec,...(spec.followup?{followup:{...spec.followup,sourceImagePath:undefined}}:{}),...(spec.styleComparison?{styleComparison:{...spec.styleComparison,comparisonUrl:safeUrl(spec.styleComparison.comparisonUrl)}}:{}),...(spec.autoStyleComparison?{autoStyleComparison:{comparisonUrl:safeUrl(spec.autoStyleComparison.comparisonUrl)}}:{}),targetUrl:safeUrl(spec.targetUrl!),allowedActions:spec.allowedActions.map(({value,...action})=>({...action,...(value?{hasValue:true}:{})}))};
 await Promise.all([
  writeFile(resolve(runDir,'manifest.json'),JSON.stringify({schemaVersion:'0.1',provider:spec.evaluator,requestedModel:spec.model??null,requestedReasoningEffort:spec.reasoningEffort??null,strategy:spec.strategy??'A',runId,status,spec:safeSpec,coverage,startedAt,endedAt:result.endedAt,terminationReason,evaluationCalls:evaluationCalls.map(call=>({provider:call.provider??spec.evaluator,status:call.status,usage:call.usage,model:call.model,calls:call.calls})),implementation:{runtimeHashes},toolVersions:{node:process.version}},null,2),{mode:0o600}),
  ...(spec.shouldVerify?[writeFile(resolve(runDir,'verification-replay.json'),JSON.stringify({version:'1',maxRequests:3,maxOcclusionTargetsPerRequest:3,requests:evaluation.verificationRequests??[],results:verifications,requiresFreshReferences:true},null,2),{mode:0o600})]:[]),
  writeFile(resolve(runDir,'check-plan.json'),JSON.stringify(checks,null,2),{mode:0o600}),
  writeFile(resolve(runDir,'report.json'),JSON.stringify(result,null,2),{mode:0o600}),
  writeFile(resolve(runDir,'report.md'),renderReport(result),{mode:0o600})
 ]);return{result,runDir};
}
function errorMessage(error:unknown):string{return error instanceof Error?error.message.slice(0,500):'Inspection failed';}
