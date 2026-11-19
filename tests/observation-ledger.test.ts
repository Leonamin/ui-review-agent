import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,writeFile,readFile,readdir,rm} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {createHash} from 'node:crypto';
import {evaluate} from '../src/evaluator.js';
import {reconcileLedger,verifyFinalLedgerStorage} from '../src/observation-ledger.js';
import {validateSpec} from '../src/policy.js';
import {renderReport} from '../src/report.js';
import {ReportRepository} from '../viewer/server/repository.js';
import type {EvaluationInput,EvaluationResult,ObservationLedger,ReviewFinding,ReviewResult} from '../src/types.js';

async function fixture(){
 const runDir=await mkdtemp(join(tmpdir(),'ledger-test-'));const bytes=Buffer.from('test-evidence');const absolutePath=join(runDir,'image.png');await writeFile(absolutePath,bytes);
 const evidence={evidenceId:'e1',observationId:'o1',runId:'r1',kind:'screenshot' as const,relativePath:'image.png',absolutePath,mimeType:'image/png',sha256:createHash('sha256').update(bytes).digest('hex'),isRedacted:false,screenshot:{coordinateSpace:'image-pixels' as const,clip:{x:0,y:0,width:390,height:800},deviceScaleFactor:1,maskColor:'',redactionRegions:[]}};
 const source={kind:'image' as const,fileName:'private-name.png',mimeType:'image/png' as const,sourceSha256:'source',originalRelativePath:'input.png',importedAt:'2026-01-01',width:390,height:800,hasAutomaticRedaction:false as const,normalization:'decoded-oriented-png' as const};
 const input:EvaluationInput={runId:'r1',runDir,spec:{imagePath:'/private/source.png',reviewPipeline:'observation-ledger',strategy:'A',evaluator:'codex',mode:'quick',purpose:'Review readability.',model:'test-model',reasoningEffort:'medium',viewport:{width:390,height:800,deviceScaleFactor:1},allowedActions:[],allowedOrigins:[],hasMutationPermission:false,isHeaded:false,shouldWaitForLogin:false,limits:{maxDurationMs:10000,maxObservations:1,maxActions:0,maxToolCalls:20,maxFindings:10}},observations:[{observationId:'o1',runId:'r1',url:'',pageTitle:'',captureStartedAt:'',captureEndedAt:'',viewport:{width:390,height:800,deviceScaleFactor:1},scrollOffset:{x:0,y:0},isStable:false,consistencyWarnings:[],screenshotRefs:['e1'],evidenceRefs:[evidence],elements:[],accessibilitySnapshot:'',documentWidth:390,viewportWidth:390,unsupportedFrames:0,imageFailures:0,source}],evidence:[evidence],actions:[],rules:[],coverage:{requiredChecks:['image'],observedChecks:[{checkId:'image',evidenceIds:['e1']}],unmetChecks:[],canFinish:true,completionBlockers:[]},timeoutMs:10000,canRequestObservation:false};
 return {input,cleanup:()=>rm(runDir,{recursive:true,force:true})};
}
function collection(count=1){return {notes:Array.from({length:count},(_,i)=>({visibleFact:`Text ${i+1} is clipped at its right edge.`,location:`field ${i+1}`,taskRelevance:'Reading the displayed value',unknowns:['Whether focus reveals the rest'],observationIds:['o1'],evidenceIds:['e1']})),regions:[{label:'Form',status:'inspected',reason:'Visible area reviewed'}],isTruncated:false,limitations:[]};}
function finding(issueId='f1',noteId='note-001'):ReviewFinding&{noteIds:string[]}{return {issueId,noteIds:[noteId],layer:'L1',category:'forms',title:`Clipped text ${issueId}`,disposition:'needs-verification',observedFacts:[{factId:'fact1',text:'The visible text ends at the input edge.'}],expectations:[{expectationId:'exp1',expectationSource:'heuristic',sourceRef:'heuristic:readability',statement:'Task content should be readable',applicability:'Reading the value'}],reasoning:'Need to check whether the remaining content can be inspected.',userImpact:'Whole value cannot be read in this image.',severity:'minor',confidence:'medium',confidenceRationale:'Visible clipping, interaction unobserved.',evidenceIds:['e1'],observationIds:['o1'],reproductionSteps:['Inspect the right edge'],recommendation:'Check full value access',hasFailureObservation:false,failureAttribution:null,attributionEvidenceIds:[],needsFurtherVerification:true,verificationNeeded:'Focus the field: if full value is available, dismiss; otherwise confirm the limited claim.',visualEvidence:[{observationId:'o1',elementRefs:[],hasMaskedContentDependency:false}],claimEvidenceLinks:[{claimId:'fact1',evidenceIds:['e1'],sourceRefs:[],supportStatus:'supported',assessedBy:'model',rationale:'Visible in screenshot',hasMaskedContentDependency:false},{claimId:'exp1',evidenceIds:[],sourceRefs:['heuristic:readability'],supportStatus:'supported',assessedBy:'model',rationale:'Reading task',hasMaskedContentDependency:false}]};}
function resolution(noteId='note-001',issueId='f1'){return {noteId,resolution:'routed' as const,reason:'A concrete verification question remains',outputRefs:[{kind:'finding' as const,id:issueId}],mergedInto:null};}
function excluded(noteId:string){return {noteId,resolution:'excluded' as const,reason:'Visible value is adequate for the shown task',outputRefs:[],mergedInto:null};}
function judgment(count=1){return {findings:Array.from({length:count},(_,i)=>finding(`f${i+1}`,`note-${String(i+1).padStart(3,'0')}`)),suggestions:[],screenMap:[{observationId:'o1',sections:[{sectionId:'s1',label:'Form',elementRefs:[],evidenceIds:['e1'],visibleSummary:'Form fields'}]}],interpretations:[],limitations:[],resolutions:Array.from({length:count},(_,i)=>resolution(`note-${String(i+1).padStart(3,'0')}`,`f${i+1}`)),additionalObservationRequests:[]};}
function response(structuredOutput:unknown){return {events:[{type:'turn.completed'}],exitCode:0,hasTimedOut:false,hasUnexpectedToolCall:false,structuredOutput};}
const imageLayout={observationId:'o1',evidenceId:'e1',regions:[{label:'입력 양식',bounds:{x:.1,y:.2,width:.8,height:.5}}],focusAreas:[]};
function evaluation():EvaluationResult{return {status:'completed',findings:[],suggestions:[],screenMap:[],interpretations:[],limitations:[]};}
function ledger(count=2):ObservationLedger{return {schemaVersion:'observation-ledger-0.1',collectionStatus:'completed',observations:collection(count).notes.map((note,i)=>({...note,noteId:`note-${String(i+1).padStart(3,'0')}`,sourceIndex:i,sourceCallId:'call',sourceDraftSha256:'hash'})),regions:[],rejectedObservations:[],resolutions:[],additionalObservationRequests:[],isObservationCoverageComplete:false,accountedCount:0,adjudicatedCount:0,overflowFindings:[],overflowSuggestions:[],limitations:[]};}

test('ledger saves IDs and original collection before adjudication; actual provider receives original image evidence and both stages are audited',async()=>{
 const {input,cleanup}=await fixture();try{let calls=0;
  const result=await evaluate(input,{runCodex:async(callInput,options)=>{
   calls++;assert.equal(callInput.evidence[0].absolutePath,input.evidence[0].absolutePath);assert.equal(callInput.spec.model,'test-model');assert.equal(callInput.spec.reasoningEffort,'medium');assert.doesNotMatch(options.prompt,/private-name|private\/source/);
   if(calls===1){assert.doesNotMatch(options.prompt,/screenMap|requiredScreenMaps|claimEvidenceLinks|maxFindings/);assert.doesNotMatch(options.instructions,/IMAGE_CLASSIFICATION|confidenceRationale/);return response({...collection(),imageLayouts:[imageLayout]});}
   const saved=JSON.parse(await readFile(join(input.runDir,'observation-ledger-collected.json'),'utf8'));assert.equal(saved.observations[0].noteId,'note-001');assert.ok(saved.observations[0].sourceCallId);assert.ok(saved.observations[0].sourceDraftSha256);assert.match(options.prompt,/note-001/);
   const occlusion={occluderBounds:{x:.625,y:.25,width:.25,height:.25},occludedBounds:{x:.25,y:.375,width:.5,height:.25}};
   const draft=judgment();
   const {observedFacts,expectations,claimEvidenceLinks,...finding}=draft.findings[0];
   const [factEvidence,expectationEvidence]=claimEvidenceLinks.map(({claimId,...claimEvidence})=>claimEvidence);
   return response({...draft,findings:[{...finding,
    observedFacts:[{...observedFacts[0],claimEvidence:factEvidence}],
    expectations:[{...expectations[0],claimEvidence:expectationEvidence}],
   }],imageLayouts:[{...imageLayout,regions:[],focusAreas:[{findingId:'f1',occlusion},{findingId:'unknown',occlusion}]}]});
  }});
  assert.equal(calls,2);assert.equal(result.status,'completed');assert.equal(result.observationLedger?.adjudicatedCount,1);assert.equal(result.observationLedger?.isObservationCoverageComplete,true);assert.deepEqual(result.findings[0].noteIds,['note-001']);
  assert.deepEqual(result.imageLayouts,[{...imageLayout,focusAreas:[{findingId:'f1',bounds:{x:.625,y:.375,width:.125,height:.125}}]}]);
  const files=await readdir(input.runDir);assert.equal(files.filter(n=>n.startsWith('evaluation-input-')).length,2);assert.equal(files.filter(n=>n.startsWith('provider-events-')).length,2);
  const inputs=await Promise.all(files.filter(n=>n.startsWith('evaluation-input-')).map(async name=>JSON.parse(await readFile(join(input.runDir,name),'utf8'))));
  const collectionSchema=inputs.find(item=>item.stage==='ledger-collection').schema;
  assert.ok(collectionSchema.required.includes('imageLayouts'));
  assert.equal(collectionSchema.properties.imageLayouts.minItems,1);
  assert.equal(collectionSchema.properties.imageLayouts.items.properties.regions.minItems,1);
  assert.equal(collectionSchema.properties.imageLayouts.items.properties.focusAreas.maxItems,0);
  const judgmentSchema=inputs.find(item=>item.stage==='ledger-adjudication').schema;
  assert.ok(!judgmentSchema.required.includes('imageLayouts'));
  assert.ok(judgmentSchema.properties.findings.items.properties.observedFacts.items.required.includes('claimEvidence'));
  assert.equal(judgmentSchema.properties.imageLayouts.items.properties.regions.maxItems,0);
  for(const name of files.filter(n=>n.startsWith('candidates-')))assert.equal(JSON.parse(await readFile(join(input.runDir,name),'utf8')).promptVersion,'image-observation-ledger-0.5.0');
 }finally{await cleanup();}
});

test('missing decision triggers exactly one bounded repair and does not recollect observations',async()=>{
 const {input,cleanup}=await fixture();try{let calls=0;
  const result=await evaluate(input,{runCodex:async(_i,options)=>{calls++;if(calls===1)return response(collection(2));const draft=judgment(2);if(calls===2)draft.resolutions.pop();else assert.match(options.prompt,/Missing resolution/);return response(draft);}});
  assert.equal(calls,3);assert.deepEqual(result.calls?.map(call=>call.isRepair),[false,false,true]);assert.equal(result.observationLedger?.adjudicatedCount,2);assert.equal(result.status,'completed');
 }finally{await cleanup();}
});

test('unresolved decision is retained as unreviewed, not a product verification candidate',async()=>{
 const {input,cleanup}=await fixture();try{let calls=0;const result=await evaluate(input,{runCodex:async()=>{calls++;return response(calls===1?collection():{...judgment(),findings:[],resolutions:[]});}});
  assert.equal(calls,3);assert.equal(result.status,'partial');assert.equal(result.findings.length,0);assert.equal(result.observationLedger?.accountedCount,1);assert.equal(result.observationLedger?.adjudicatedCount,0);assert.equal(result.observationLedger?.resolutions[0].resolution,'unreviewed');assert.equal(result.observationLedger?.isObservationCoverageComplete,false);
 }finally{await cleanup();}
});

test('collection and adjudication repair share four-call ceiling and preserve rejected raw notes',async()=>{
 const {input,cleanup}=await fixture();try{let calls=0;const result=await evaluate(input,{runCodex:async()=>{calls++;if(calls<=2){const draft=collection(2);draft.notes[1].evidenceIds=['unknown'];return response(draft);}return response({...judgment(),findings:[],resolutions:[]});}});
  assert.equal(calls,4);assert.equal(result.status,'partial');assert.equal(result.observationLedger?.observations.length,1);assert.equal(result.observationLedger?.rejectedObservations.length,1);assert.equal(result.observationLedger?.resolutions[0].resolution,'unreviewed');
  const files=await readdir(input.runDir);assert.equal(files.filter(n=>n.startsWith('ledger-collection-draft-')).length,2);
 }finally{await cleanup();}
});

test('adjudication timeout leaves persisted collection and valid unreviewed accounting',async()=>{
 const {input,cleanup}=await fixture();try{let calls=0;const result=await evaluate(input,{runCodex:async()=>{calls++;return calls===1?response(collection()):{...response(undefined),hasTimedOut:true};}});
  assert.equal(result.status,'partial');assert.equal(result.observationLedger?.resolutions[0].resolution,'unreviewed');assert.equal(result.findings.length,0);assert.equal(JSON.parse(await readFile(join(input.runDir,'observation-ledger-collected.json'),'utf8')).observations.length,1);
 }finally{await cleanup();}
});

test('zero valid candidates skips adjudication; collection failure never becomes completed zero review',async()=>{
 for(const hasValidCollection of [true,false]){const {input,cleanup}=await fixture();try{let calls=0;const result=await evaluate(input,{runCodex:async()=>{calls++;return response(hasValidCollection?{...collection(0),imageLayouts:[imageLayout]}:{invalid:'bad'});}});assert.equal(result.status,hasValidCollection?'completed':'failed');assert.equal(calls,hasValidCollection?1:2);assert.equal(result.observationLedger?.isObservationCoverageComplete,hasValidCollection);assert.deepEqual(result.imageLayouts,hasValidCollection?[imageLayout]:undefined);}finally{await cleanup();}}
});

test('shared deadline stops second stage without discarding collected notes',async()=>{
 const {input,cleanup}=await fixture();try{input.timeoutMs=20;let calls=0;const result=await evaluate(input,{runCodex:async()=>{calls++;await new Promise(r=>setTimeout(r,30));return response(collection());}});assert.equal(calls,1);assert.equal(result.status,'partial');assert.equal(result.observationLedger?.observations.length,1);assert.equal(result.observationLedger?.adjudicatedCount,0);}finally{await cleanup();}
});

test('coverage rejects duplicate/unknown resolutions, asymmetric output links, self merge and merge cycles',()=>{
 const cases=[
  [excluded('note-001'),excluded('note-001'),excluded('note-002')],
  [excluded('note-001'),excluded('note-002'),excluded('unknown')],
  [{...excluded('note-001'),resolution:'merged' as const,mergedInto:'note-001'},excluded('note-002')],
  [{...excluded('note-001'),resolution:'merged' as const,mergedInto:'note-002'},{...excluded('note-002'),resolution:'merged' as const,mergedInto:'note-001'}],
 ];
 for(const decisions of cases){const result=reconcileLedger(ledger(),evaluation(),decisions,[]);assert.equal(result.ledger.isObservationCoverageComplete,false);assert.ok(result.errors.length);}
 const output=evaluation();output.findings=[finding('f1','note-001')];const asymmetric=reconcileLedger(ledger(),output,[excluded('note-001'),excluded('note-002')],[]);assert.ok(asymmetric.errors.length);assert.equal(output.findings.length,0);assert.equal(asymmetric.ledger.resolutions[0].resolution,'unreviewed');assert.equal(asymmetric.ledger.adjudicatedCount,1);
});

test('merge completion propagates terminal unreviewed and a rejected output cannot be hidden by another valid output',()=>{
 const output=evaluation();output.findings=[finding()];const decisions=[{...resolution(),outputRefs:[{kind:'finding' as const,id:'f1'},{kind:'finding' as const,id:'rejected'}]},{...excluded('note-002'),resolution:'merged' as const,mergedInto:'note-001'}];
 const checked=reconcileLedger(ledger(),output,decisions,[]);assert.equal(checked.ledger.adjudicatedCount,0);assert.equal(checked.ledger.resolutions[0].outputRefs.length,2);assert.ok(checked.ledger.resolutions.every(item=>item.resolution==='unreviewed'));assert.equal(output.findings.length,1);
});

test('validator rejected finding leaves observation unresolved while valid output remains',async()=>{
 const {input,cleanup}=await fixture();try{let calls=0;const result=await evaluate(input,{runCodex:async()=>{calls++;if(calls===1)return response(collection());const draft=judgment();draft.findings.push(finding('bad'));draft.findings[1].evidenceIds=['unknown'];draft.resolutions[0].outputRefs.push({kind:'finding',id:'bad'});return response(draft);}});
  assert.equal(result.status,'partial');assert.equal(result.findings.length,1);assert.equal(result.observationLedger?.adjudicatedCount,0);assert.match(result.observationLedger!.resolutions[0].errors.join(' '),/bad/);
 }finally{await cleanup();}
});

test('display limit preserves overflow outputs and complete note references',async()=>{
 const {input,cleanup}=await fixture();try{input.spec.limits.maxFindings=1;let calls=0;const result=await evaluate(input,{runCodex:async()=>response(++calls===1?collection(2):judgment(2))});assert.equal(result.status,'completed');assert.equal(result.findings.length,1);assert.equal(result.observationLedger?.overflowFindings.length,1);assert.equal(result.observationLedger?.adjudicatedCount,2);assert.equal(result.observationLedger?.isObservationCoverageComplete,true);}finally{await cleanup();}
});

test('additional observation request keeps affected registered observation unreviewed',()=>{
 const checked=reconcileLedger(ledger(1),evaluation(),[excluded('note-001')],[{noteIds:['note-001'],reason:'A new detail needs collection'}]);assert.equal(checked.ledger.adjudicatedCount,0);assert.equal(checked.ledger.resolutions[0].resolution,'unreviewed');
});

test('ledger option refuses URL, B/C and rules-only while standard remains compatible',async()=>{
 const {input,cleanup}=await fixture();try{assert.doesNotThrow(()=>validateSpec(input.spec));for(const change of [{strategy:'B'},{strategy:'C'},{evaluator:'rules-only'},{imagePath:undefined,targetUrl:'https://example.com',allowedOrigins:['https://example.com']}])assert.throws(()=>validateSpec({...input.spec,...change} as any),/ledger requires|Rules-only/);assert.doesNotThrow(()=>validateSpec({...input.spec,reviewPipeline:'standard',strategy:'B'}));}finally{await cleanup();}
});

test('Markdown and viewer show incomplete ledger separately from product defects; legacy report has no ledger',async()=>{
 const {input,cleanup}=await fixture();try{const data=ledger(1);data.resolutions=[{noteId:'note-001',resolution:'unreviewed',reason:'Timeout',outputRefs:[],mergedInto:null,errors:['Timeout']}];data.accountedCount=1;
  const result:ReviewResult={schemaVersion:'0.1',runId:'r1',status:'partial',startedAt:'2026-01-01',endedAt:'2026-01-01',imageSource:input.observations[0].source,findings:[],verificationCandidates:[],suggestions:[],coverage:input.coverage,observations:input.observations,evidence:input.evidence,actions:[],rules:[],limitations:[],evaluation:{...evaluation(),status:'partial',observationLedger:data},observationLedger:data};
  const markdown=renderReport(result);assert.match(markdown,/관찰 판정이 완료되지 않았습니다/);assert.match(markdown,/unreviewed/);assert.match(markdown,/검사가 완료되지 않아/);
  await writeFile(join(input.runDir,'report.json'),JSON.stringify(result));const repo=new ReportRepository(input.runDir);const row=(await repo.list()).reports[0];const detail=await repo.detail(row.id);assert.equal(detail.observationLedger?.adjudicatedCount,0);assert.equal(detail.observationLedger?.notes[0].status,'unreviewed');assert.equal(detail.findings.length,0);
  delete result.observationLedger;delete result.evaluation.observationLedger;await writeFile(join(input.runDir,'report.json'),JSON.stringify(result));assert.equal((await repo.detail(row.id)).observationLedger,undefined);
 }finally{await cleanup();}
});


test('collection repair cannot erase previously registered valid notes or replace a rejected collection with empty success',async()=>{
 const {input,cleanup}=await fixture();try{let calls=0;const result=await evaluate(input,{runCodex:async()=>{calls++;if(calls===1){const draft=collection(2);draft.notes[1].evidenceIds=['unknown'];return response(draft);}if(calls===2)return response(collection(0));return response(judgment());}});
 assert.equal(calls,3);assert.equal(result.status,'partial');assert.equal(result.observationLedger?.observations.length,1);assert.equal(result.observationLedger?.rejectedObservations.length,1);assert.equal(result.findings.length,1);assert.match(result.limitations.join(' '),/earlier partial review was retained/);
 }finally{await cleanup();}
});

test('adjudication repair cannot discard an earlier valid result while repairing another note',async()=>{
 const {input,cleanup}=await fixture();try{let calls=0;const result=await evaluate(input,{runCodex:async()=>{calls++;if(calls===1)return response(collection(2));if(calls===2)return response(judgment(1));const draft=judgment(2);draft.findings.shift();draft.resolutions.shift();return response(draft);}});
 assert.equal(calls,3);assert.equal(result.status,'partial');assert.equal(result.findings[0].issueId,'f1');assert.equal(result.observationLedger?.resolutions[0].resolution,'routed');assert.equal(result.observationLedger?.resolutions[1].resolution,'unreviewed');assert.equal(result.observationLedger?.adjudicatedCount,1);
 }finally{await cleanup();}
});


test('final storage check catches post-validation output loss and propagates merge incompleteness',()=>{
 const output=evaluation();output.findings=[finding()];const checked=reconcileLedger(ledger(),output,[resolution(),{...excluded('note-002'),resolution:'merged',mergedInto:'note-001'}],[]).ledger;
 assert.equal(checked.adjudicatedCount,2);assert.equal(checked.isObservationCoverageComplete,true);
 output.findings=[];verifyFinalLedgerStorage(checked,output);assert.equal(checked.isObservationCoverageComplete,false);assert.equal(checked.adjudicatedCount,0);assert.ok(checked.resolutions.every(d=>d.resolution==='unreviewed'));
});

test('presentation distinguishes collection limits, unreviewed notes and other incomplete coverage without mutating reports',async()=>{
 const {input,cleanup}=await fixture();
 try{
  for(const [collectionStatus,hasUnreviewed,title] of [
   ['partial',false,'관찰 수집 범위 제한'],
   ['completed',true,'관찰 판정 미완료'],
   ['completed',false,'관찰 처리 완결성 미충족'],
  ] as const){
   const data=ledger(1);data.collectionStatus=collectionStatus;data.adjudicatedCount=hasUnreviewed?0:1;data.accountedCount=1;
   data.resolutions=[{noteId:'note-001',resolution:hasUnreviewed?'unreviewed':'excluded',reason:'Fixture',outputRefs:[],mergedInto:null,errors:[]}];
   const result:ReviewResult={schemaVersion:'0.1',runId:'r1',status:'partial',startedAt:'2026-01-01',endedAt:'2026-01-01',findings:[],verificationCandidates:[],coverage:input.coverage,observations:input.observations,evidence:input.evidence,actions:[],rules:[],limitations:[],evaluation:evaluation(),observationLedger:data};
   const before=JSON.stringify(result);const markdown=renderReport(result);
   assert.ok(markdown.includes(title));assert.match(markdown,/관찰 처리 완결성: 미충족/);
   if(!hasUnreviewed)assert.doesNotMatch(markdown,/관찰 판정이 완료되지 않았습니다|관찰 판정 미완료/);
   assert.equal(JSON.stringify(result),before);
   delete result.observationLedger;assert.doesNotMatch(renderReport(result),/관찰 처리 기록/);
  }
 }finally{await cleanup();}
});
