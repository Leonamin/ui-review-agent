import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp, writeFile, readFile, readdir, rm} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {createHash} from 'node:crypto';
import {evaluate, evaluateStage, validateReviewDraft, runClaude, CLAUDE_REVIEW_JSON_SCHEMA, type ReviewDraft} from '../src/evaluator.js';
import {Budget} from '../src/policy.js';
import {renderReport} from '../src/report.js';
import { defaultStandardEvaluationTimeouts, deriveStandardReviewTimeouts } from '../src/evaluation-budget.js';
import type {EvaluationInput, ReviewFinding, ReviewResult} from '../src/types.js';

test('rejected model draft is retained separately without the CLI envelope', async()=>{
  const {input,draft,cleanup}=await fixture();
  try {
    draft.findings[0]!.evidenceIds=['nonexistent-evidence'];
    const result=await evaluate(input,{runClaude:async()=>({exitCode:0,hasTimedOut:false,events:[{type:'system',subtype:'init',tools:['StructuredOutput'],mcp_servers:[]},{type:'result',structured_output:draft,result:'PRIVATE_CLI_ENVELOPE'}]})});
    assert.equal(result.status,'partial');assert.equal(result.findings.length,0);
    const names=(await readdir(input.runDir)).filter(name=>name.startsWith('candidates-'));
    assert.equal(names.length,1);
    const diagnostic=await readFile(join(input.runDir,names[0]!), 'utf8');
    assert.ok(diagnostic.includes('nonexistent-evidence'));assert.ok(diagnostic.includes('invalid or unverified evidence ID'));
    assert.ok(!diagnostic.includes('PRIVATE_CLI_ENVELOPE'));
  } finally {await cleanup();}
});

async function fixture(): Promise<{input: EvaluationInput; draft: ReviewDraft; cleanup: () => Promise<void>}> {
  const runDir = await mkdtemp(join(tmpdir(), 'inspector-review-test-'));
  const bytes = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a/vQAAAAASUVORK5CYII=', 'base64');
  const absolutePath = join(runDir, 'screenshot.png');
  await writeFile(absolutePath, bytes);
  const evidence = {evidenceId: 'e1', observationId: 'o1', runId: 'r1', kind: 'screenshot' as const, relativePath: 'screenshot.png', absolutePath, mimeType: 'image/png', sha256: createHash('sha256').update(bytes).digest('hex'), isRedacted: true};
  const finding: ReviewFinding = {
    issueId: 'issue-1', layer: 'L1', category: 'layout', title: '내용 잘림', disposition: 'confirmed',
    observedFacts: [{factId: 'f1', text: '화면 오른쪽에서 텍스트가 잘립니다.'}],
    expectations: [{expectationId: 'x1', expectationSource: 'heuristic', sourceRef: 'heuristic:readability', statement: '내용을 읽을 수 있어야 합니다.', applicability: '관찰된 텍스트 가독성'}],
    reasoning: '잘린 텍스트가 보입니다.', userImpact: '일부 내용을 읽을 수 없습니다.', severity: 'minor', confidence: 'high', confidenceRationale: '화면 증거 있음',
    evidenceIds: ['e1'], observationIds: ['o1'], reproductionSteps: ['화면을 연다.'], recommendation: '영역 크기를 조정합니다.',
    hasFailureObservation: false, failureAttribution: null, attributionEvidenceIds: [], needsFurtherVerification: false,
    claimEvidenceLinks: [
      {claimId: 'f1', evidenceIds: ['e1'], sourceRefs: [], supportStatus: 'supported', assessedBy: 'model', rationale: '관찰된 영역'},
      {claimId: 'x1', evidenceIds: [], sourceRefs: ['heuristic:readability'], supportStatus: 'supported', assessedBy: 'model', rationale: '읽기 과업에 적용'},
    ],
  };
  const input: EvaluationInput = {
    runId: 'r1', runDir,
    spec: {targetUrl: 'http://example.test', mode: 'quick', purpose: '내용을 읽는다.', viewport: {width:390,height:844,deviceScaleFactor:1}, allowedActions: [], allowedOrigins: ['http://example.test'], hasMutationPermission: false, isHeaded:false, shouldWaitForLogin:false, limits: {maxDurationMs:1000,maxObservations:3,maxActions:0,maxToolCalls:20,maxFindings:10}, evaluator:'claude'},
    observations: [{observationId:'o1',runId:'r1',url:'http://example.test',pageTitle:'Example',captureStartedAt:'2026-11-10T00:00:00Z',captureEndedAt:'2026-11-10T00:00:00Z',viewport:{width:390,height:844,deviceScaleFactor:1},scrollOffset:{x:0,y:0},isStable:true,consistencyWarnings:[],screenshotRefs:['e1'],evidenceRefs:[evidence],elements:[],accessibilitySnapshot:'',documentWidth:390,viewportWidth:390,unsupportedFrames:0,imageFailures:0}],
    evidence:[evidence], actions:[], rules:[], coverage:{requiredChecks:['initial'],observedChecks:[{checkId:'initial',evidenceIds:['e1']}],unmetChecks:[],canFinish:false,completionBlockers:[]},timeoutMs:1000,
  };
  const draft: ReviewDraft = {findings:[finding],screenMap:[{observationId:'o1',sections:[{sectionId:'s1',label:'내용',elementRefs:[],evidenceIds:['e1'],visibleSummary:'텍스트 영역'}]}],interpretations:[],limitations:[]};
  return {input,draft,cleanup:()=>rm(runDir,{recursive:true,force:true})};
}

test('records provider and overall evaluation timeouts, while manual cancellation remains unclassified',async()=>{
 const {input,cleanup}=await fixture();
 try {
  const evaluateWithAbort=async(reason?:DOMException,hasTimedOut=false)=>{
   const controller=new AbortController();
   return evaluate({...input,signal:controller.signal},{runClaude:async()=>{
    if(reason)controller.abort(reason);
    return {exitCode:1,hasTimedOut,events:[]};
   }});
  };
  const provider=await evaluateWithAbort(undefined,true);
  const overall=await evaluateWithAbort(new DOMException('Automatic inspection time limit reached','TimeoutError'));
  for(const result of [provider,overall]){
   assert.equal(result.status,'failed');
   assert.equal(result.failureCode,'timeout');
   assert.equal(result.calls?.[0].failureCode,'timeout');
  }
  const manual=await evaluateWithAbort(new DOMException('User cancelled','AbortError'),true);
  assert.equal(manual.status,'failed');
  assert.equal(manual.failureCode,undefined);
  assert.equal(manual.calls?.[0].failureCode,undefined);
  assert.match(manual.limitations[0],/cancelled/);
 }finally{await cleanup();}
});

test('image evaluation reuses provider with pixels-only prompt and retained reproducible call records',async()=>{
 const {input,draft,cleanup}=await fixture();try{
  input.spec.evaluator='codex';input.spec.targetUrl=undefined;input.canRequestObservation=false;
  const observation=input.observations[0];observation.isStable=false;
  observation.source={kind:'image',fileName:'SECRET_FILENAME.png',mimeType:'image/png',sourceSha256:'sourcehash',originalRelativePath:'input/original.png',importedAt:'2026-01-01T00:00:00Z',width:390,height:844,hasAutomaticRedaction:false,normalization:'decoded-oriented-png'};
  observation.url='https://hidden-source.invalid';observation.pageTitle='PRIVATE_PAGE_TITLE';
  const result=await evaluate(input,{runCodex:async(_input,options)=>{
   const prompt=JSON.parse(options.prompt.slice(0,options.prompt.indexOf('\n')));
   assert.equal(prompt.inputContract.kind,'image');assert.equal(prompt.inputContract.hasDomEvidence,false);
   assert.equal(prompt.observations[0].url,undefined);assert.equal(prompt.observations[0].viewport,undefined);assert.equal(prompt.observations[0].isStable,undefined);
   assert.deepEqual(prompt.observations[0].imageDimensions,{width:390,height:844});
   assert.doesNotMatch(options.prompt,/SECRET_FILENAME|hidden-source|PRIVATE_PAGE_TITLE|2026-01-01/);
   return {events:[{type:'turn.completed'}],exitCode:0,hasTimedOut:false,hasUnexpectedToolCall:false,structuredOutput:draft};
  }});
  assert.equal(result.status,'completed');assert.equal(result.findings[0].disposition,'confirmed');
  const files=await readdir(input.runDir);const saved=files.find(name=>name.startsWith('evaluation-input-'))!;
  assert.ok(saved);assert.ok(files.some(name=>name.startsWith('provider-events-')));
  assert.doesNotMatch(await readFile(join(input.runDir,saved),'utf8'),/SECRET_FILENAME|hidden-source|PRIVATE_PAGE_TITLE/);
  draft.findings[0].layer='L2';const unsupported=await validateReviewDraft(draft,input);
  assert.equal(unsupported.findings[0].disposition,'needs-verification');assert.match(unsupported.findings[0].verificationNeeded!,/No completed action/);
 }finally{await cleanup();}
});

test('valid evidence-backed general critique does not require failure attribution', async () => {
  const {input,draft,cleanup}=await fixture();try {
    const result=await validateReviewDraft(draft,input);
    assert.equal(result.status,'completed');assert.equal(result.findings[0].disposition,'confirmed');assert.equal(result.findings[0].failureAttribution,null);
  } finally {await cleanup();}
});

test('tampered evidence is rejected rather than presented as a clean review',async()=>{
  const {input,draft,cleanup}=await fixture();try {
    await writeFile(input.evidence[0].absolutePath,'changed');
    const result=await validateReviewDraft(draft,input);
    assert.equal(result.status,'partial');assert.equal(result.findings.length,0);assert.match(result.limitations.join(' '),/integrity/);
  } finally {await cleanup();}
});

test('unknown or tool-attributed failures cannot become confirmed product defects',async()=>{
  const {input,draft,cleanup}=await fixture();try {
    draft.findings[0].hasFailureObservation=true;draft.findings[0].failureAttribution='unknown';
    let result=await validateReviewDraft(draft,input);
    assert.equal(result.findings[0].disposition,'needs-verification');
    draft.findings[0].failureAttribution='automation';
    result=await validateReviewDraft(draft,input);assert.equal(result.findings.length,0);assert.match(result.limitations.join(' '),/Execution limitation/);
  } finally {await cleanup();}
});

test('policy-blocked environment downgrades a claimed product failure',async()=>{
  const {input,draft,cleanup}=await fixture();try {
    input.observations[0].consistencyWarnings=['Blocked POST request in read-only mode'];
    Object.assign(draft.findings[0],{hasFailureObservation:true,failureAttribution:'product',attributionEvidenceIds:['e1'],attributionRationale:'Assumed product failure'});
    const result=await validateReviewDraft(draft,input);
    assert.equal(result.findings[0].failureAttribution,'unknown');assert.equal(result.findings[0].disposition,'needs-verification');
  } finally {await cleanup();}
});

test('existing files alone do not establish semantic support',async()=>{
  const {input,draft,cleanup}=await fixture();try {
    draft.findings[0].claimEvidenceLinks[0].supportStatus='unsupported';
    const result=await validateReviewDraft(draft,input);
    assert.equal(result.findings[0].disposition,'needs-verification');assert.equal(result.findings[0].needsFurtherVerification,true);
  } finally {await cleanup();}
});

test('a user goal alone does not establish a missing product requirement',async()=>{
  const {input,draft,cleanup}=await fixture();try {
    Object.assign(draft.findings[0].expectations[0],{expectationSource:'user-goal',sourceRef:'context:purpose'});
    draft.findings[0].claimEvidenceLinks[1].sourceRefs=['context:purpose'];
    const result=await validateReviewDraft(draft,input);
    assert.equal(result.findings[0].disposition,'needs-verification');
  } finally {await cleanup();}
});

test('L2 conclusions require actual before/after action evidence',async()=>{
  const {input,draft,cleanup}=await fixture();try {
    draft.findings[0].layer='L2';
    const result=await validateReviewDraft(draft,input);assert.equal(result.findings[0].disposition,'needs-verification');
  } finally {await cleanup();}
});

test('unknown refs and model claiming human review are rejected',async()=>{
  const {input,draft,cleanup}=await fixture();try {
    draft.findings[0].claimEvidenceLinks[0].assessedBy='human';
    assert.equal((await validateReviewDraft(draft,input)).findings.length,0);
    draft.findings[0].claimEvidenceLinks[0].assessedBy='model';draft.findings[0].evidenceIds=['unknown'];
    assert.equal((await validateReviewDraft(draft,input)).findings.length,0);
  } finally {await cleanup();}
});

test('pending additional observations keep the evaluation partial and validate references',async()=>{
  const {input,draft,cleanup}=await fixture();try {
    input.canRequestObservation=true;draft.observationRequests=[{type:'capture',observationId:'o1',reason:'Need stable view'}];
    const result=await validateReviewDraft(draft,input);assert.equal(result.status,'partial');assert.equal(result.observationRequests?.length,1);
    draft.observationRequests=[{type:'inspect',observationId:'o1',elementRef:'unknown',reason:'Need zoom'}];
    assert.equal((await validateReviewDraft(draft,input)).observationRequests?.length,0);
  } finally {await cleanup();}
});

test('zero findings is valid when all supplied observations have maps',async()=>{
  const {input,draft,cleanup}=await fixture();try {draft.findings=[];assert.equal((await validateReviewDraft(draft,input)).status,'completed');}finally{await cleanup();}
});

test('actual CLI failure envelope is not treated as success or replaced with a mock',async()=>{
  const {input,cleanup}=await fixture();try {
    const result=await evaluate(input,{runClaude:async()=>({exitCode:1,hasTimedOut:false,events:[{type:'system',subtype:'init',tools:[],mcp_servers:[]},{type:'result',subtype:'success',is_error:true,result:'401 OAuth access token expired'}]})});
    assert.equal(result.status,'failed');assert.equal(result.findings.length,0);assert.match(result.limitations[0],/authentication/);
  } finally {await cleanup();}
});

test('only output-only schema tool is accepted; browser or shell capability fails closed',async()=>{
  const {input,draft,cleanup}=await fixture();try {
    input.spec.model='requested-but-unconfirmed';
    for(const tools of [['StructuredOutput'],['Bash']]) {
      const result=await evaluate(input,{runClaude:async()=>({exitCode:0,hasTimedOut:false,events:[{type:'system',subtype:'init',tools,mcp_servers:[]},{type:'result',subtype:'success',is_error:false,structured_output:draft}]})});
      assert.equal(result.status,tools[0]==='StructuredOutput'?'completed':'failed');assert.equal(result.model,undefined);
    }
  } finally {await cleanup();}
});

test('Markdown escapes untrusted markup and incomplete empty results do not claim success',async()=>{
  const {input,draft,cleanup}=await fixture();try {
    draft.findings[0].title='<script>alert(1)</script> [bad](https://bad.test)';
    const evaluation=await validateReviewDraft(draft,input);
    const result:ReviewResult={schemaVersion:'0.1',runId:'r1',status:'partial',targetUrl:input.spec.targetUrl,startedAt:'now',endedAt:'now',findings:[],verificationCandidates:evaluation.findings,coverage:input.coverage,observations:input.observations,actions:[],rules:[],evidence:input.evidence,limitations:[],evaluation};
    const markdown=renderReport(result);
    assert.match(markdown,/검사가 완료되지 않아 문제 없음으로 판단할 수 없습니다/);assert.ok(!markdown.includes('<script>'));assert.ok(markdown.includes('\\[bad\\]'));
    result.evidence[0].relativePath='../../secret';assert.ok(!renderReport(result).includes('](../../secret)'));
  } finally {await cleanup();}
});


test('Claude full schema uses the draft-7 dialect accepted by the installed CLI',()=>{
  assert.equal(CLAUDE_REVIEW_JSON_SCHEMA.$schema,'http://json-schema.org/draft-07/schema#');
  assert.ok(JSON.stringify(CLAUDE_REVIEW_JSON_SCHEMA).includes('claimEvidenceLinks'));
});

test('finding cap is enforced and excess candidates remain available for audit',async()=>{
  const {input,draft,cleanup}=await fixture();try {
    input.spec.limits.maxFindings=1;
    const second=structuredClone(draft.findings[0]);second.issueId='issue-2';second.title='다른 중요한 문제';second.severity='major';
    draft.findings.push(second);
    const result=await validateReviewDraft(draft,input);
    assert.equal(result.findings.length,1);assert.equal(result.findings[0].issueId,'issue-2');assert.equal(result.omittedFindings?.length,1);
    input.spec.evaluator='rules-only';
    input.rules=[1,2].map(index=>({ruleFindingId:`r${index}`,observationId:'o1',ruleId:'test-rule',ruleVersion:'1',result:'violation',title:'Rule warning',description:'Measured rule result',evidenceIds:['e1'],elementRefs:[],impact:'minor'}));
    const rules=await evaluate(input);assert.equal(rules.findings.length,1);assert.equal(rules.omittedFindings?.length,1);
  }finally{await cleanup();}
});


test('failed and schema-missing model calls retain known cost without claiming a successful review',async()=>{
  const {input,cleanup}=await fixture();try {
    for(const hasError of [true,false]) {
      const result=await evaluate(input,{runClaude:async()=>({exitCode:hasError?1:0,hasTimedOut:false,events:[{type:'system',subtype:'init',tools:['StructuredOutput'],mcp_servers:[],model:'test-model'},{type:'result',subtype:'error',is_error:hasError,usage:{input_tokens:100,output_tokens:20},total_cost_usd:0.02}]})});
      assert.equal(result.status,'failed');assert.equal(result.model,'test-model');assert.equal(result.usage?.estimatedCost,0.02);assert.equal(result.usage?.inputTokens,100);
    }
    const timeout=await evaluate(input,{runClaude:async()=>({exitCode:null,hasTimedOut:true,events:[]})});
    assert.equal(timeout.usage,undefined);assert.equal(timeout.status,'failed');
  }finally{await cleanup();}
});


test('evaluator timeout terminates a nonresponsive child process', {skip: process.platform === 'win32'}, async()=>{
  const {input,cleanup}=await fixture();
  const originalPath=process.env.PATH;
  try {
    await writeFile(join(input.runDir,'claude'), `#!${process.execPath}\nprocess.stdin.resume();process.on('SIGTERM',()=>{});setInterval(()=>{},1000);\n`, {mode:0o700});
    process.env.PATH=`${input.runDir}:${originalPath ?? ''}`;
    input.timeoutMs=150;
    const startedAt=Date.now();const result=await runClaude(input);
    assert.equal(result.hasTimedOut,true);assert.ok(Date.now()-startedAt<3000);assert.notEqual(result.exitCode,0);
  }finally {process.env.PATH=originalPath;await cleanup();}
});


test('input token total includes uncached, cache creation and cache read components',async()=>{
  const {input,draft,cleanup}=await fixture();try {
    const result=await evaluate(input,{runClaude:async()=>({exitCode:0,hasTimedOut:false,events:[{type:'system',subtype:'init',tools:['StructuredOutput'],mcp_servers:[]},{type:'result',subtype:'success',is_error:false,structured_output:draft,usage:{input_tokens:2,cache_creation_input_tokens:100,cache_read_input_tokens:200,output_tokens:10},total_cost_usd:0.01}]})});
    assert.equal(result.usage?.inputTokens,302);assert.equal(result.usage?.cacheCreationInputTokens,100);assert.equal(result.usage?.cacheReadInputTokens,200);
  }finally{await cleanup();}
});

test('bounded repair fixes deterministic reference errors with same observations and cumulative usage',async()=>{
 const {input,draft,cleanup}=await fixture();try{
  input.timeoutMs=5000;let callCount=0;
  const bad=structuredClone(draft);bad.screenMap=[];
  const result=await evaluate(input,{runClaude:async(attempt,repair)=>{
   callCount++;assert.equal(attempt.observations,input.observations);assert.ok(attempt.timeoutMs<=5000);
   if(callCount===2){assert.deepEqual(repair?.draft,bad);assert.ok(repair?.validationMessages.some(message=>message.includes('no valid screen map')));}
   return {exitCode:0,hasTimedOut:false,events:[{type:'system',subtype:'init',tools:['StructuredOutput'],mcp_servers:[]},{type:'result',structured_output:callCount===1?bad:draft,usage:{input_tokens:5,output_tokens:2},total_cost_usd:0.02}]};
  }});
  assert.equal(callCount,2);assert.equal(result.status,'completed');assert.equal(result.usage?.estimatedCost,0.04);assert.equal(result.usage?.inputTokens,10);
  assert.equal((await readdir(input.runDir)).filter(name=>name.startsWith('candidates-')).length,2);
 }finally{await cleanup();}
});

test('repair never invents unknown IDs or loops until an invalid claim passes',async()=>{
 const {input,draft,cleanup}=await fixture();try{
  input.timeoutMs=5000;draft.findings[0]!.evidenceIds=['unknown'];let callCount=0;
  const result=await evaluate(input,{runClaude:async()=>{callCount++;return {exitCode:0,hasTimedOut:false,events:[{type:'system',subtype:'init',tools:['StructuredOutput'],mcp_servers:[]},{type:'result',structured_output:draft}]};}});
  assert.equal(callCount,2);assert.equal(result.status,'partial');assert.equal(result.findings.length,0);
 }finally{await cleanup();}
});

test('repair timeout retains the first partial review and known cost',async()=>{
 const {input,draft,cleanup}=await fixture();try{
  input.timeoutMs=5000;draft.screenMap=[];let callCount=0;
  const result=await evaluate(input,{runClaude:async()=>{callCount++;return callCount===2?{exitCode:null,hasTimedOut:true,events:[]}:{exitCode:0,hasTimedOut:false,events:[{type:'system',subtype:'init',tools:['StructuredOutput'],mcp_servers:[]},{type:'result',structured_output:draft,total_cost_usd:0.03}]};}});
  assert.equal(result.status,'partial');assert.equal(result.findings.length,1);assert.equal(result.usage?.estimatedCost,0.03);assert.ok(result.limitations.some(message=>message.includes('repair failed')));
 }finally{await cleanup();}
});

test('privacy-dependent claims are excluded while visible geometry remains reviewable',async()=>{
 const {input,draft,cleanup}=await fixture();try{
  input.observations[0]!.elements.push({elementRef:'masked-input',tag:'input',role:'textbox',text:'[input value omitted]',accessibleName:'',boundingBox:{x:1,y:1,width:10,height:10},isVisible:true,isEnabled:true});
  input.observations[0]!.redactionRegions=[{regionId:'mask-1',elementRef:'masked-input',reason:'input-value',boundingBox:{x:1,y:1,width:10,height:10}}];
  draft.findings[0]!.visualEvidence=[{observationId:'o1',elementRefs:['masked-input'],hasMaskedContentDependency:true}];
  for(const link of draft.findings[0]!.claimEvidenceLinks)link.hasMaskedContentDependency=true;
  const excluded=await validateReviewDraft(draft,input);assert.equal(excluded.findings.length,0);assert.ok(excluded.limitations.some(message=>message.includes('Inspection artifact excluded')));
  const mixed=structuredClone(draft);
  const originalFact=mixed.findings[0]!.observedFacts[0]!;
  mixed.findings[0]!.observedFacts.push({factId:'unmasked-fact',text:'Visible error text gives no recovery route.'});
  mixed.findings[0]!.claimEvidenceLinks.push({claimId:'unmasked-fact',evidenceIds:['e1'],sourceRefs:[],supportStatus:'supported',assessedBy:'model',rationale:'Visible text outside the mask',hasMaskedContentDependency:false});
  const preserved=await validateReviewDraft(mixed,input);
  assert.equal(preserved.findings.length,1);assert.equal(preserved.findings[0]!.observedFacts.length,2);assert.equal(preserved.findings[0]!.disposition,'needs-verification');assert.ok(preserved.findings[0]!.verificationNeeded?.includes(originalFact.factId));
  draft.findings[0]!.visualEvidence[0]!.elementRefs=[];
  assert.equal((await validateReviewDraft(draft,input)).findings[0]?.disposition,'needs-verification');
  draft.findings[0]!.visualEvidence[0]!.hasMaskedContentDependency=false;
  assert.equal((await validateReviewDraft(draft,input)).findings.length,1);
  draft.findings[0]!.visualEvidence[0]!.elementRefs=['unknown-element'];
  assert.equal((await validateReviewDraft(draft,input)).status,'partial');
 }finally{await cleanup();}
});

test('visible-promise source evidence must belong to a declared observation',async()=>{
 const {input,draft,cleanup}=await fixture();try{
  const otherEvidence={...input.evidence[0]!,evidenceId:'e2',observationId:'o2'};
  input.evidence.push(otherEvidence);input.observations.push({...input.observations[0]!,observationId:'o2',evidenceRefs:[otherEvidence],screenshotRefs:['e2']});
  const finding=draft.findings[0]!;const expectation=finding.expectations[0]!;
  expectation.expectationSource='visible-promise';expectation.sourceRef='e2';
  const link=finding.claimEvidenceLinks.find(item=>item.claimId===expectation.expectationId)!;link.sourceRefs=['e2'];
  const result=await validateReviewDraft(draft,input);
  assert.equal(result.findings.length,0);assert.ok(result.limitations.some(message=>message.includes('evidence/observation mismatch')));
 }finally{await cleanup();}
});

test('a masked expectation alone cannot confirm an otherwise visible finding',async()=>{
 const {input,draft,cleanup}=await fixture();try{
  const finding=draft.findings[0]!;finding.visualEvidence=[{observationId:'o1',elementRefs:[],hasMaskedContentDependency:false}];
  const expectationId=finding.expectations[0]!.expectationId;
  for(const link of finding.claimEvidenceLinks)link.hasMaskedContentDependency=link.claimId===expectationId;
  const result=await validateReviewDraft(draft,input);
  assert.equal(result.findings.length,1);assert.equal(result.findings[0]!.disposition,'needs-verification');assert.ok(result.findings[0]!.verificationNeeded?.includes(expectationId));
 }finally{await cleanup();}
});

test('Codex uses common validation, never falls back, and leaves actual model and cost unknown',async()=>{
 const {input,draft,cleanup}=await fixture();try{
  input.spec.evaluator='codex';input.spec.model='requested-model';
  const result=await evaluate(input,{runClaude:async()=>{throw new Error('Must not fallback');},runCodex:async()=>({exitCode:0,hasTimedOut:false,hasUnexpectedToolCall:false,structuredOutput:draft,events:[{type:'turn.completed',usage:{input_tokens:100,cached_input_tokens:60,cache_write_input_tokens:10,output_tokens:20}}]})});
  assert.equal(result.provider,'codex');assert.equal(result.status,'completed');assert.equal(result.model,undefined);assert.equal(result.usage?.estimatedCost,undefined);assert.equal(result.usage?.inputTokens,100);assert.equal(result.usage?.cacheReadInputTokens,60);assert.equal(result.usage?.outputTokens,20);
  const rejected=await evaluate(input,{runCodex:async()=>({exitCode:0,hasTimedOut:false,hasUnexpectedToolCall:true,structuredOutput:draft,events:[{type:'turn.completed'}]})});
  assert.equal(rejected.status,'failed');assert.match(rejected.limitations[0]!,/unexpected tool call/);
 }finally{await cleanup();}
});

test('B uses three independent checklist partitions and accounts every call',async()=>{
 const {input,draft,cleanup}=await fixture();try{
  input.spec.strategy='B';input.timeoutMs=10000;input.spec.model='gpt-6.1-sol';input.spec.reasoningEffort='medium';
  const prompts:string[]=[];
  const result=await evaluate(input,{runClaude:async(_input,_repair,stage)=>{
   prompts.push(stage!.prompt!);const copy=structuredClone(draft);copy.findings[0]!.category=prompts.length===1?'layout':prompts.length===2?'feedback':'forms';
   return {exitCode:0,hasTimedOut:false,events:[{type:'system',subtype:'init',tools:[],mcp_servers:[],model:'actual-model'},{type:'result',structured_output:copy,usage:{input_tokens:10,output_tokens:2},total_cost_usd:0.01}]};
  }});
  assert.equal(result.calls?.length,3);assert.equal(result.findings.length,3);assert.equal(new Set(result.findings.map(f=>f.issueId)).size,3);assert.equal(result.usage?.inputTokens,30);assert.equal(result.usage?.estimatedCost,0.03);
  assert.ok(prompts.every(prompt=>!prompt.includes('내용 잘림')));assert.ok(result.calls?.every(call=>call.requestedReasoningEffort==='medium'&&call.actualReasoningEffort===undefined));
 }finally{await cleanup();}
});

test('C verifier cannot introduce new IDs and failed verification downgrades discovery',async()=>{
 const {input,draft,cleanup}=await fixture();try{
  input.spec.strategy='C';input.timeoutMs=10000;let count=0;
  const result=await evaluate(input,{runClaude:async(_input,_repair,stage)=>{count++;return {exitCode:0,hasTimedOut:false,events:[{type:'system',subtype:'init',tools:[],mcp_servers:[]},{type:'result',structured_output:stage!.name==='C-discovery'?draft:{decisions:[{candidateId:'invented',decision:'keep',reason:'unsupported ID'}]}}]};}});
  assert.equal(count,3);assert.equal(result.calls?.length,3);assert.equal(result.calls?.[2]?.isRepair,true);assert.equal(result.status,'partial');assert.equal(result.findings[0]?.issueId,'issue-1');assert.equal(result.findings[0]?.disposition,'needs-verification');
 }finally{await cleanup();}
});

test('C preserves original candidates and never upgrades an uncertain finding',async()=>{
 const {input,draft,cleanup}=await fixture();try{
  input.spec.strategy='C';input.timeoutMs=10000;draft.findings[0]!.confidence='low';
  const result=await evaluate(input,{runClaude:async(_input,_repair,stage)=>({exitCode:0,hasTimedOut:false,events:[{type:'system',subtype:'init',tools:[],mcp_servers:[]},{type:'result',structured_output:stage!.name==='C-discovery'?draft:{decisions:[{candidateId:'issue-1',decision:'keep',reason:'visible evidence'}]}}]})});
  assert.equal(result.calls?.length,2);assert.equal(result.findings[0]?.disposition,'needs-verification');assert.equal(result.verificationDecisions?.[0]?.candidateId,'issue-1');
 }finally{await cleanup();}
});

test('B retains excluded category and capped candidates through final merge',async()=>{
 const {input,draft,cleanup}=await fixture();try{
  input.spec.strategy='B';input.timeoutMs=10000;input.spec.limits.maxFindings=1;
  const result=await evaluate(input,{runClaude:async(_input,_repair,stage)=>{const copy=structuredClone(draft);copy.findings.push({...structuredClone(copy.findings[0]!),issueId:'extra',title:'다른 후보'});return {exitCode:0,hasTimedOut:false,events:[{type:'system',subtype:'init',tools:[],mcp_servers:[]},{type:'result',structured_output:copy}]};}});
  assert.equal(result.findings.length,1);assert.equal(result.omittedFindings?.length,5);
 }finally{await cleanup();}
});
test('C explicitly skips verifier when discovery has zero candidates',async()=>{
 const {input,draft,cleanup}=await fixture();try{input.spec.strategy='C';draft.findings=[];
 const result=await evaluate(input,{runClaude:async()=>({exitCode:0,hasTimedOut:false,events:[{type:'system',subtype:'init',tools:[],mcp_servers:[]},{type:'result',structured_output:draft}]})});
 assert.equal(result.calls?.length,1);assert.equal(result.skippedStages?.[0]?.stage,'C-verification');
 }finally{await cleanup();}
});

test('verification proposals bind original facts, expectations, live references and action permissions',async()=>{
 const {input,draft,cleanup}=await fixture();try{
  input.spec.shouldVerify=true;input.observations[0]!.elements.push({elementRef:'target',tag:'div',role:'',text:'visible',accessibleName:'',boundingBox:{x:0,y:0,width:10,height:10},isVisible:true,isEnabled:true});
  draft.findings[0]!.visualEvidence=[{observationId:'o1',elementRefs:['target'],hasMaskedContentDependency:false}];
  const request={requestId:'v1',candidateId:'issue-1',claimIds:['f1'],observationId:'o1',expectation:draft.findings[0]!.expectations[0],evidenceIds:['e1'],preconditions:['Target remains the same visible element.'],recipe:'occlusion',targetRef:'target',issue:'clipping'};
  input.observations[0]!.elements.push({...input.observations[0]!.elements[0]!,elementRef:'unrelated'});
  draft.verificationRequests=[request];const result=await validateReviewDraft(draft,input);assert.equal(result.verificationRequests?.length,1);assert.equal(result.findings[0]?.disposition,'confirmed');
  for(const change of [{candidateId:'invented'},{claimIds:['invented']},{expectation:{...request.expectation,statement:'invented business requirement'}},{evidenceIds:['invented']},{targetRef:'invented'},{targetRef:'unrelated'},{script:'arbitrary code'},{targetScopes:[{targetRef:'target',scope:'control-surface'}]}]){
   draft.verificationRequests=[{...request,...change}];const rejected=await validateReviewDraft(draft,input);assert.equal(rejected.verificationRequests?.length,0);assert.equal(rejected.findings.length,1);assert.match(rejected.limitations.join(' '),/Rejected verification request/);
  }
  draft.verificationRequests=[request];input.spec.shouldVerify=false;assert.equal((await validateReviewDraft(draft,input)).verificationRequests?.length,0);
 }finally{await cleanup();}
});

test('verification proposals cannot read masked money or schedule unapproved keyboard actions',async()=>{
 const {input,draft,cleanup}=await fixture();try{
  input.spec.shouldVerify=true;
  for(const elementRef of ['total','item','dialog'])input.observations[0]!.elements.push({elementRef,tag:'div',role:'',text:'100',accessibleName:'',boundingBox:{x:0,y:0,width:10,height:10},isVisible:true,isEnabled:true});
  draft.findings[0]!.visualEvidence=[{observationId:'o1',elementRefs:['total','item','dialog'],hasMaskedContentDependency:false}];
  const common={requestId:'v1',candidateId:'issue-1',claimIds:['f1'],observationId:'o1',expectation:draft.findings[0]!.expectations[0],evidenceIds:['e1'],preconditions:[]};
  draft.verificationRequests=[{...common,recipe:'focus',scopeRef:'dialog',allowedActionIds:['not-allowed']}];assert.equal((await validateReviewDraft(draft,input)).verificationRequests?.length,0);
  draft.verificationRequests=[{...common,recipe:'money',totalRef:'total',itemRefs:['item']}];assert.equal((await validateReviewDraft(draft,input)).verificationRequests?.length,1);
  input.observations[0]!.redactionRegions=[{regionId:'m1',elementRef:'item',reason:'input-value',boundingBox:{x:0,y:0,width:10,height:10}}];
  draft.verificationRequests=[{...common,recipe:'money',totalRef:'total',itemRefs:['item']}];assert.equal((await validateReviewDraft(draft,input)).verificationRequests?.length,0);
 }finally{await cleanup();}
});

test('report separates measurement refutation from immutable initial AI disposition',async()=>{
 const {input,draft,cleanup}=await fixture();try{
  const {buildFindingAssessments}=await import('../src/evaluation-verification.js');
  const evaluation=await validateReviewDraft(draft,input);
  const request={requestId:'v1',candidateId:'issue-1',claimIds:['f1'],observationId:'o1',expectation:draft.findings[0]!.expectations[0]!,evidenceIds:['e1'],preconditions:[],recipe:'occlusion' as const,targetRef:'target',issue:'clipping' as const};
  const verifications:import('../src/verification-types.js').VerificationResult[]=[{verificationId:'vr1',request,recipeVersion:'1',outcome:'refuted',hypothesisKind:'text-clipped',hasObservedViolation:false,expectedInvariant:'Text remains visible.',condition:'Target text is clipped.',summary:'Measured condition was false.',measurements:{hasClipping:false},limitations:['Does not verify all semantic claims.'],evidenceIds:['e1'],actionIds:[],failureAttribution:null,startedAt:'now',endedAt:'now',replay:{recipe:'occlusion',version:'1',targetRefs:['target'],allowedActionIds:[],requiresFreshReferences:true}}];
  const result:ReviewResult={schemaVersion:'0.1',runId:'r1',status:'completed',targetUrl:input.spec.targetUrl,startedAt:'now',endedAt:'now',findings:evaluation.findings,verificationCandidates:[],coverage:input.coverage,observations:input.observations,actions:[],rules:[],evidence:input.evidence,limitations:[],evaluation,verifications,findingsBasis:'initial-ai-review',findingAssessments:buildFindingAssessments(evaluation.findings,verifications)};
  const markdown=renderReport(result);assert.match(markdown,/측정 반증 있음/);assert.match(markdown,/AI 초기 판정/);assert.match(markdown,/적용 주장: f1/);assert.equal(result.findings[0]!.disposition,'confirmed');assert.equal(result.findingAssessments?.[0]?.hasWholeFindingVerification,false);assert.equal(result.findingAssessments?.[0]?.measurements[0]?.outcome,'refuted');
  result.verifications=[];assert.match(renderReport(result),/실행된 검증이 없습니다/);
 }finally{await cleanup();}
});

test('strategy merge preserves verification candidate lineage and removes dismissed C proposals',async()=>{
 const {input,draft,cleanup}=await fixture();try{
  input.spec.shouldVerify=true;input.timeoutMs=10000;input.observations[0]!.elements.push({elementRef:'target',tag:'div',role:'',text:'visible',accessibleName:'',boundingBox:{x:0,y:0,width:10,height:10},isVisible:true,isEnabled:true});
  draft.findings[0]!.visualEvidence=[{observationId:'o1',elementRefs:['target'],hasMaskedContentDependency:false}];
  draft.verificationRequests=[{requestId:'v1',candidateId:'issue-1',claimIds:['f1'],observationId:'o1',expectation:draft.findings[0]!.expectations[0],evidenceIds:['e1'],preconditions:[],recipe:'occlusion',targetRef:'target',issue:'clipping'}];
  const process=(output:unknown)=>({exitCode:0,hasTimedOut:false,events:[{type:'system',subtype:'init',tools:[],mcp_servers:[]},{type:'result',structured_output:output}]});
  input.spec.strategy='B';const merged=await evaluate(input,{runClaude:async(_input,_repair,stage)=>process(stage?.name==='B-presentation'?draft:{...draft,findings:[],verificationRequests:[]})});assert.equal(merged.verificationRequests?.[0]?.candidateId,'presentation:issue-1');
  input.spec.strategy='C';const dismissed=await evaluate(input,{runClaude:async(_input,_repair,stage)=>process(stage?.name==='C-discovery'?draft:{decisions:[{candidateId:'issue-1',decision:'dismiss',reason:'Not sufficiently supported.'}]})});assert.equal(dismissed.findings.length,0);assert.equal(dismissed.verificationRequests?.length,0);
 }finally{await cleanup();}
});

test('verification model schema uses strict-compatible anyOf with mutually exclusive recipe literals',async()=>{
 const {input,draft,cleanup}=await fixture();try{
  input.spec.evaluator='codex';input.spec.shouldVerify=true;
  const result=await evaluate(input,{runCodex:async(_input,options)=>{
   const items=(options.schema as any).properties.verificationRequests.items;
   assert.equal(items.oneOf,undefined);assert.equal(items.anyOf[0].properties.additionalTargets,undefined);assert.equal(items.anyOf[0].properties.targetScopes,undefined);assert.equal(items.anyOf[0].properties.occluderRefs,undefined);assert.equal(items.anyOf.length,3);assert.deepEqual(items.anyOf.map((branch:any)=>branch.properties.recipe.const),['occlusion','focus','money']);
   const {codexOutputSchema}=await import('../src/codex.js');const strict=codexOutputSchema(options.schema);assert.ok(!JSON.stringify(strict).includes('"oneOf"'));for(const branch of strict.properties.verificationRequests.items.anyOf)assert.deepEqual(new Set(branch.required),new Set(Object.keys(branch.properties)));
   return {events:[{type:'turn.completed'}],exitCode:0,hasTimedOut:false,hasUnexpectedToolCall:false,structuredOutput:{...draft,verificationRequests:[]}};
  }});assert.equal(result.status,'completed');
 }finally{await cleanup();}
});

test('automatic routing selects only uniquely grounded hypotheses and preserves model precedence',async()=>{
 const {input,draft,cleanup}=await fixture();try{
  const {applyAutomaticVerificationRequests}=await import('../src/evaluation-verification.js');
  input.spec.shouldVerify=true;
  input.observations[0]!.elements.push({elementRef:'target',tag:'div',role:'',text:'visible text',accessibleName:'',boundingBox:{x:0,y:0,width:10,height:10},isVisible:true,isEnabled:true});
  draft.findings[0]!.visualEvidence=[{observationId:'o1',elementRefs:['target'],hasMaskedContentDependency:false}];
  const initial=await validateReviewDraft(draft,input);const original=JSON.stringify(initial.findings);
  const result=applyAutomaticVerificationRequests(input,initial);
  assert.equal(result.verificationRequests?.[0]?.recipe,'occlusion',JSON.stringify(result.verificationSelections));assert.equal(result.verificationSelections?.at(-1)?.origin,'automatic');assert.equal(JSON.stringify(result.findings),original);
  assert.equal(applyAutomaticVerificationRequests(input,result).verificationRequests?.length,1);
  input.observations[0]!.elements.push({...input.observations[0]!.elements[0]!,elementRef:'other'});
  draft.findings[0]!.visualEvidence[0]!.elementRefs.push('other');
  const ambiguous=applyAutomaticVerificationRequests(input,await validateReviewDraft(draft,input));assert.equal(ambiguous.verificationRequests?.length,0);assert.match(ambiguous.verificationSelections?.at(-1)?.reason??'',/Multiple clipping targets|not unique/);
  draft.findings[0]!.visualEvidence[0]!.elementRefs=['target'];
  for(const text of ['카드가 설명 텍스트를 가립니다.','카드가 텍스트와 겹칩니다.']){
   draft.findings[0]!.observedFacts[0]!.text=text;
   assert.equal(applyAutomaticVerificationRequests(input,await validateReviewDraft(draft,input)).verificationRequests?.[0]?.recipe,'occlusion');
  }
  for(const text of ['The text is not clipped.','텍스트는 가리지 않는다.','The component is visually plain.']){
   draft.findings[0]!.observedFacts[0]!.text=text;
   assert.equal(applyAutomaticVerificationRequests(input,await validateReviewDraft(draft,input)).verificationRequests?.length,0);
  }
  draft.findings[0]!.observedFacts[0]!.text='The component is visually plain.';
  const unrelated=applyAutomaticVerificationRequests(input,await validateReviewDraft(draft,input));assert.equal(unrelated.verificationRequests?.length,0);
  const modelRequest={...result.verificationRequests![0]!,requestId:'model-request'};
  const preferred=applyAutomaticVerificationRequests(input,{...initial,verificationRequests:[modelRequest]});assert.equal(preferred.verificationRequests?.[0]?.requestId,'model-request');assert.equal(preferred.verificationSelections?.at(-1)?.origin,'model');
 }finally{await cleanup();}
});

test('automatic monetary routing uses only explicit candidate targets and observed structural labels',async()=>{
 const {input,draft,cleanup}=await fixture();try{
  const {applyAutomaticVerificationRequests}=await import('../src/evaluation-verification.js');
  input.spec.shouldVerify=true;draft.findings[0]!.observedFacts[0]!.text='Displayed total does not match the item sum.';
  for(const [elementRef,labelText,text] of [['total','Total','$120.00'],['item','Subtotal','$100.00']])input.observations[0]!.elements.push({elementRef:elementRef!,tag:'dd',role:'',text:text!,accessibleName:'',boundingBox:{x:0,y:0,width:10,height:10},isVisible:true,isEnabled:true,moneyLabelRelation:{status:'resolved',source:'definition-list',labelRefs:[`${elementRef}-label`],labelText}});
  draft.findings[0]!.visualEvidence=[{observationId:'o1',elementRefs:['total','item'],hasMaskedContentDependency:false}];
  const result=applyAutomaticVerificationRequests(input,await validateReviewDraft(draft,input));assert.equal(result.verificationRequests?.[0]?.recipe,'money');
  draft.findings[0]!.observedFacts[0]!.text='표시된 합계가 상품 금액과 일치하지 않습니다.';assert.equal(applyAutomaticVerificationRequests(input,await validateReviewDraft(draft,input)).verificationRequests?.[0]?.recipe,'money');
  draft.findings[0]!.observedFacts[0]!.text='표시된 합계가 상품 금액과 다릅니다.';assert.equal(applyAutomaticVerificationRequests(input,await validateReviewDraft(draft,input)).verificationRequests?.[0]?.recipe,'money');
  draft.findings[0]!.visualEvidence[0]!.elementRefs=['total'];
  const incomplete=applyAutomaticVerificationRequests(input,await validateReviewDraft(draft,input));assert.equal(incomplete.verificationRequests?.length,0);
  draft.findings[0]!.visualEvidence[0]!.elementRefs=['total','item'];input.observations[0]!.redactionRegions=[{regionId:'m',elementRef:'item',reason:'input-value',boundingBox:{x:0,y:0,width:10,height:10}}];
  assert.equal(applyAutomaticVerificationRequests(input,await validateReviewDraft(draft,input)).verificationRequests?.length,0);
 }finally{await cleanup();}
});

test('automatic routing rejects cross-observation facts, enforces cap and gives long candidate IDs unique requests',async()=>{
 const {input,draft,cleanup}=await fixture();try{
  const {applyAutomaticVerificationRequests}=await import('../src/evaluation-verification.js');
  input.spec.shouldVerify=true;input.observations[0]!.elements.push({elementRef:'target',tag:'div',role:'',text:'visible',accessibleName:'',boundingBox:{x:0,y:0,width:10,height:10},isVisible:true,isEnabled:true});
  draft.findings[0]!.visualEvidence=[{observationId:'o1',elementRefs:['target'],hasMaskedContentDependency:false}];
  const initial=await validateReviewDraft(draft,input);
  const many={...initial,findings:Array.from({length:4},(_,i)=>({...structuredClone(initial.findings[0]!),issueId:'x'.repeat(199)+i}))};
  const capped=applyAutomaticVerificationRequests(input,many);assert.equal(capped.verificationRequests?.length,3);assert.equal(new Set(capped.verificationRequests?.map(request=>request.requestId)).size,3);assert.match(capped.verificationSelections?.at(-1)?.reason??'',/budget/);
  const cross=structuredClone(initial);cross.findings[0]!.claimEvidenceLinks[0]!.evidenceIds.push('other-evidence');
  input.evidence.push({...input.evidence[0]!,evidenceId:'other-evidence',observationId:'o2'});
  assert.equal(applyAutomaticVerificationRequests(input,cross).verificationRequests?.length,0);
  cross.findings[0]!.observationIds.push('o2');cross.findings[0]!.visualEvidence!.push({observationId:'o2',elementRefs:['target'],hasMaskedContentDependency:false});
  assert.match(applyAutomaticVerificationRequests(input,cross).verificationSelections?.at(-1)?.reason??'',/one unmasked observation/);
 }finally{await cleanup();}
});

test('monetary comparison routing requires additive context and rejects negated or unrelated comparisons',async()=>{
 const {input,draft,cleanup}=await fixture();try{
  const {applyAutomaticVerificationRequests}=await import('../src/evaluation-verification.js');input.spec.shouldVerify=true;
  for(const [elementRef,text] of [['total','Total $120.00'],['item','Subtotal $100.00']])input.observations[0]!.elements.push({elementRef:elementRef!,tag:'p',role:'',text:text!,accessibleName:'',boundingBox:{x:0,y:0,width:10,height:10},isVisible:true,isEnabled:true});
  draft.findings[0]!.visualEvidence=[{observationId:'o1',elementRefs:['total','item'],hasMaskedContentDependency:false}];
  for(const text of ['The charged total is higher than the sum of line items.','결제 금액이 항목 합계보다 크다.','표시된 총액은 합산 금액보다 적습니다.','항목 합산보다 더 청구된다.','표시된 총 금액과 항목 합계가 불일치한다.']){draft.findings[0]!.observedFacts[0]!.text=text;assert.equal(applyAutomaticVerificationRequests(input,await validateReviewDraft(draft,input)).verificationRequests?.[0]?.recipe,'money',text);}
  for(const text of ['The total is not higher than the sum.','합계보다 결제 금액이 더 크지 않다.','결제 금액과 항목 합계는 같다.','이전 주문보다 총액이 크다.','항목 합계보다 총액이 큰 것은 정상이다.','The card is larger than the total label.','The payment amount is visible.','금액 입력 오류 메시지가 명확하지 않다.','The price label differs in color.','총 결제 금액은 배송비가 포함되어 상품 합계보다 큽니다.','The total is higher than the subtotal because of shipping.','The total is higher than the subtotal.']){draft.findings[0]!.observedFacts[0]!.text=text;assert.equal(applyAutomaticVerificationRequests(input,await validateReviewDraft(draft,input)).verificationRequests?.length,0,text);}
 }finally{await cleanup();}
});

test('multiple visual targets use fact-bound opaque covering direction and never route covering text as victim',async()=>{
 const {input,draft,cleanup}=await fixture();try{
  const {applyAutomaticVerificationRequests}=await import('../src/evaluation-verification.js');input.spec.shouldVerify=true;
  for(const [elementRef,text,covering] of [['victim','배송 안내 사항',['cover']],['cover','오늘의 특별 혜택',[]]] as const)input.observations[0]!.elements.push({elementRef,tag:'p',role:'',text,accessibleName:'',boundingBox:{x:0,y:0,width:100,height:20},isVisible:true,isEnabled:true,occlusionEvidence:{textRects:[{x:0,y:0,width:100,height:20}],coveringElementRefs:[...covering],hasUncertainCover:false}});
  draft.findings[0]!.visualEvidence=[{observationId:'o1',elementRefs:['victim','cover'],hasMaskedContentDependency:false}];draft.findings[0]!.observedFacts[0]!.text='오늘의 특별 혜택 카드가 배송 안내 사항 텍스트를 가립니다.';
  const routed=applyAutomaticVerificationRequests(input,await validateReviewDraft(draft,input));assert.equal(routed.verificationRequests?.[0]?.recipe,'occlusion');const request=routed.verificationRequests![0]!;if(request.recipe==='occlusion'){assert.equal(request.targetRef,'victim');assert.deepEqual(request.occluderRefs,['cover']);}
  draft.verificationRequests=[request];assert.equal((await validateReviewDraft(draft,input)).verificationRequests?.length,0,'model cannot inject automatic multi-target extensions');delete draft.verificationRequests;
  draft.findings[0]!.observedFacts[0]!.text='안내 내용 일부가 앞쪽 카드에 가려집니다.';assert.equal(applyAutomaticVerificationRequests(input,await validateReviewDraft(draft,input)).verificationRequests?.length,1,'single paraphrased claim uses candidate-owned directional evidence');
  const originalFact=structuredClone(draft.findings[0]!.observedFacts[0]!);
  const unmatchedFact={factId:'f-unmatched',text:'다른 버튼 위를 별도 카드가 덮고 있습니다.'};draft.findings[0]!.observedFacts.push(unmatchedFact);draft.findings[0]!.claimEvidenceLinks.push({...draft.findings[0]!.claimEvidenceLinks[0]!,claimId:unmatchedFact.factId});
  for(const ordered of [[originalFact,unmatchedFact],[unmatchedFact,originalFact]]){draft.findings[0]!.observedFacts=ordered;assert.equal(applyAutomaticVerificationRequests(input,await validateReviewDraft(draft,input)).verificationRequests?.length,0,'one recognized hypothesis cannot inherit targets from another original fact');}
  draft.findings[0]!.observedFacts=[originalFact];draft.findings[0]!.claimEvidenceLinks.pop();const singleAgain=applyAutomaticVerificationRequests(input,await validateReviewDraft(draft,input));assert.equal(singleAgain.verificationRequests?.length,1);assert.deepEqual(singleAgain.verificationRequests![0]!.claimIds,[originalFact.factId],'removing another fact cannot invent its identifier');
  input.observations[0]!.elements.push({...input.observations[0]!.elements[1]!,elementRef:'uncovered',text:'다른 신청 안내',occlusionEvidence:{textRects:[],coveringElementRefs:[],hasUncertainCover:false}});draft.findings[0]!.visualEvidence[0]!.elementRefs.push('uncovered');
  draft.findings[0]!.observedFacts[0]!.text='다른 신청 안내 텍스트가 가려집니다.';assert.equal(applyAutomaticVerificationRequests(input,await validateReviewDraft(draft,input)).verificationRequests?.length,0,'explicit unrelated target cannot be replaced with a covered one');
  draft.findings[0]!.visualEvidence[0]!.elementRefs=['victim','cover'];
  draft.findings[0]!.observedFacts[0]!.text='상단 내용이 카드에 가려집니다.';draft.findings[0]!.observedFacts.push({factId:'f2',text:'하단 내용도 별도로 가려집니다.'});draft.findings[0]!.claimEvidenceLinks.push({...draft.findings[0]!.claimEvidenceLinks[0]!,claimId:'f2'});assert.equal(applyAutomaticVerificationRequests(input,await validateReviewDraft(draft,input)).verificationRequests?.length,0,'multiple independent paraphrased claims have no unique target assignment');draft.findings[0]!.observedFacts.pop();draft.findings[0]!.claimEvidenceLinks.pop();
  draft.findings[0]!.observedFacts[0]!.text='배송 안내 사항 텍스트가 가려집니다.';input.observations[0]!.elements[0]!.occlusionEvidence!.hasUncertainCover=true;assert.equal(applyAutomaticVerificationRequests(input,await validateReviewDraft(draft,input)).verificationRequests?.length,0);
 }finally{await cleanup();}
});

test('per-target assessments never assign a later reproduced target to the first target claim',async()=>{
 const {input,draft,cleanup}=await fixture();try{
  const {buildFindingAssessments}=await import('../src/evaluation-verification.js');
  const request={requestId:'v1',candidateId:'issue-1',claimIds:['f1'],observationId:'o1',expectation:draft.findings[0]!.expectations[0]!,evidenceIds:['e1'],preconditions:[],recipe:'occlusion' as const,targetRef:'first',issue:'occlusion' as const,additionalTargets:[{targetRef:'second',claimIds:['f2']}]};
  const measurement:import('../src/verification-types.js').VerificationResult={verificationId:'v1',request,recipeVersion:'1',outcome:'reproduced',hypothesisKind:'text-occluded',hasObservedViolation:true,expectedInvariant:'Readable text',condition:'Text is covered',summary:'One of two targets reproduced',measurements:{},limitations:[],evidenceIds:['e1'],actionIds:[],failureAttribution:null,startedAt:'now',endedAt:'now',replay:{recipe:'occlusion',version:'1',targetRefs:['first','second'],allowedActionIds:[],requiresFreshReferences:true},targetMeasurements:[{targetRef:'first',claimIds:['f1'],outcome:'not-reproduced',summary:'First target clear',hasMeasured:true},{targetRef:'second',claimIds:['f2'],outcome:'reproduced',summary:'Second target covered',hasMeasured:true}]};
  const assessments=buildFindingAssessments(draft.findings,[measurement]);assert.deepEqual(assessments[0]!.measurements.map(item=>[item.claimIds,item.outcome]),[[['f1'],'not-reproduced'],[['f2'],'reproduced']]);
  const evaluation=await validateReviewDraft(draft,input);const report:ReviewResult={schemaVersion:'0.1',runId:'r1',status:'completed',targetUrl:input.spec.targetUrl,startedAt:'now',endedAt:'now',findings:draft.findings,verificationCandidates:[],coverage:input.coverage,observations:input.observations,actions:[],rules:[],evidence:input.evidence,limitations:[],evaluation,verifications:[measurement]};
  const markdown=renderReport(report);assert.match(markdown,/first, not-reproduced/);assert.match(markdown,/second, reproduced/);assert.match(markdown,/연결된 원본 주장: f1, f2/);
 }finally{await cleanup();}
});

test('split monetary facts combine only within one candidate and shared observation evidence',async()=>{
 const {input,draft,cleanup}=await fixture();try{
  const {applyAutomaticVerificationRequests}=await import('../src/evaluation-verification.js');input.spec.shouldVerify=true;
  for(const [elementRef,text] of [['total','Total $70.00'],['item','Subtotal $60.00']])input.observations[0]!.elements.push({elementRef:elementRef!,tag:'p',role:'',text:text!,accessibleName:'',boundingBox:{x:0,y:0,width:10,height:10},isVisible:true,isEnabled:true});
  const finding=draft.findings[0]!;finding.visualEvidence=[{observationId:'o1',elementRefs:['total','item'],hasMaskedContentDependency:false}];
  finding.observedFacts=[{factId:'f1',text:'The line item sum is $60 and the displayed total is $70.'},{factId:'f2',text:'A difference appears without a corresponding item.'}];finding.claimEvidenceLinks.push({...finding.claimEvidenceLinks[0]!,claimId:'f2'});
  let result=applyAutomaticVerificationRequests(input,await validateReviewDraft(draft,input));assert.equal(result.verificationRequests?.[0]?.recipe,'money');assert.deepEqual(result.verificationRequests?.[0]?.claimIds,['f1','f2']);
  for(const text of ['There is no difference.','차액은 없다.','차액이 발생하지 않는다.','차액은 배송비 때문이다.','다른 주문의 차액이다.','The difference is €10.']){finding.observedFacts[1]!.text=text;assert.equal(applyAutomaticVerificationRequests(input,await validateReviewDraft(draft,input)).verificationRequests?.length,0,text);}
  finding.observedFacts[1]!.text='The difference is not explained by the item amounts.';
  const initial=await validateReviewDraft(draft,input);input.evidence.push({...input.evidence[0]!,evidenceId:'e2'});initial.findings[0]!.claimEvidenceLinks.find(link=>link.claimId==='f2')!.evidenceIds=['e2'];assert.equal(applyAutomaticVerificationRequests(input,initial).verificationRequests?.length,0,'no shared evidence');
  input.evidence[1]!.observationId='o2';initial.findings[0]!.observationIds.push('o2');assert.equal(applyAutomaticVerificationRequests(input,initial).verificationRequests?.length,0,'different observation');
  const separated=await validateReviewDraft(draft,input);const a=structuredClone(separated.findings[0]!),b=structuredClone(a);a.observedFacts=[a.observedFacts[0]!];b.issueId='another-candidate';b.observedFacts=[b.observedFacts[1]!];assert.equal(applyAutomaticVerificationRequests(input,{...separated,findings:[a,b]}).verificationRequests?.length,0,'different candidate');
 }finally{await cleanup();}
});

test('Korean comparative conjugations retain monetary scope and reject negation and normal totals',async()=>{
 const {input,draft,cleanup}=await fixture();try{
  const {applyAutomaticVerificationRequests}=await import('../src/evaluation-verification.js');input.spec.shouldVerify=true;
  for(const [elementRef,text] of [['total','총 결제 금액 9,000원'],['item','상품 금액 7,000원']])input.observations[0]!.elements.push({elementRef:elementRef!,tag:'p',role:'',text:text!,accessibleName:'',boundingBox:{x:0,y:0,width:10,height:10},isVisible:true,isEnabled:true});
  draft.findings[0]!.visualEvidence=[{observationId:'o1',elementRefs:['total','item'],hasMaskedContentDependency:false}];
  for(const ending of ['크다','큽니다','커요','크며 차액이 남는다','작다','작습니다','작아요','적다','적습니다','적어요','높다','높습니다','높아요','낮다','낮습니다','많습니다']){draft.findings[0]!.observedFacts[0]!.text=`표시된 총 결제 금액이 항목 합계보다 ${ending}.`;assert.equal(applyAutomaticVerificationRequests(input,await validateReviewDraft(draft,input)).verificationRequests?.[0]?.recipe,'money',ending);}
  for(const text of ['총 결제 금액은 항목 합계보다 크지 않습니다.','총 결제 금액은 항목 합계보다 크다고 할 수 없다.','총 결제 금액이 항목 합계보다 커요? 아닙니다.','총 결제 금액이 항목 합계보다 낮지 않다.','총 결제 금액은 배송비가 포함되어 상품 합계보다 큽니다.','항목 합계와 총 결제 금액은 같습니다.','총 결제 금액 제목의 글자가 상품 안내보다 큽니다.','총 결제 금액의 글자가 항목 합계 글자보다 큽니다.','The total font is larger than the line item sum font.']){draft.findings[0]!.observedFacts[0]!.text=text;assert.equal(applyAutomaticVerificationRequests(input,await validateReviewDraft(draft,input)).verificationRequests?.length,0,text);}
 }finally{await cleanup();}
});

function imageFixtureInput(input:EvaluationInput):void {
 input.spec.targetUrl=undefined;input.spec.evaluator='codex';input.canRequestObservation=false;
 input.observations[0].source={kind:'image',fileName:'sample.png',mimeType:'image/png',sourceSha256:'hash',originalRelativePath:'input/original.png',importedAt:'2026-01-01T00:00:00Z',width:390,height:844,hasAutomaticRedaction:false,normalization:'decoded-oriented-png'};
}
const advisory={suggestionId:'suggestion-1',category:'layout' as const,title:'관련 정보 묶음 검토',observation:'설명과 선택 항목이 분리되어 있습니다.',rationale:'관련 정보를 함께 읽는 데 도움이 될 수 있습니다.',possibleImpact:'탐색 부담이 줄어들 가능성이 있습니다.',uncertainty:'실제 탐색 동작이나 사용자 이해도는 확인하지 않았습니다.',recommendation:'관련 정보를 함께 배치하는 안을 검토합니다.',evidenceIds:['e1'],observationIds:['o1']};

test('image suggestions retain evidence without entering findings, reject invalid links and remain outside URL schema',async()=>{
 const {input,draft,cleanup}=await fixture();try{
  const raw={...draft,findings:[],suggestions:[advisory]};
  assert.equal((await validateReviewDraft(raw,input)).status,'failed');
  imageFixtureInput(input);
  const result=await validateReviewDraft(raw,input);assert.equal(result.status,'completed');assert.equal(result.findings.length,0);assert.deepEqual(result.suggestions,[advisory]);
  for(const suggestions of [[{...advisory,evidenceIds:['missing']}],[{...advisory,observationIds:['missing']}],[{...advisory,evidenceIds:[]}],[{...advisory,uncertainty:''}]]){
   const rejected=await validateReviewDraft({...raw,suggestions},input);assert.notEqual(rejected.status,'completed');assert.equal(rejected.suggestions?.length??0,0);
  }
  const duplicate=await validateReviewDraft({...raw,suggestions:[advisory,advisory]},input);assert.equal(duplicate.status,'partial');assert.equal(duplicate.suggestions?.length,1);
  const legacy=await validateReviewDraft({...draft,findings:[]},input);assert.equal(legacy.status,'completed');assert.deepEqual(legacy.suggestions,[]);
 }finally{await cleanup();}
});

test('image-only provider policy and schema preserve URL behavior and allow empty suggestions',async()=>{
 const {input,draft,cleanup}=await fixture();try{
  input.spec.evaluator='codex';
  const run=async(isImage:boolean)=>evaluate(input,{runCodex:async(_input,options)=>{
   const properties=(options.schema as any).properties;
   assert.equal(Boolean(properties.suggestions),isImage);
   assert.equal(Boolean(properties.imageLayouts),isImage);
   if(isImage){
    assert.match(options.instructions,/Judge the visible symptom separately/);assert.match(options.instructions,/Zero suggestions is valid/);
    assert.match(options.instructions,/Classify the usability claim, not just the visible phenomenon/);
    assert.match(options.instructions,/Confidence concerns the narrowed usability conclusion/);
    assert.match(options.instructions,/use verificationNeeded to state the decision-changing question/);
    assert.match(options.instructions,/occluderBounds for the front element and occludedBounds for the element behind it/);
    assert.match(options.instructions,/Each observed fact and expectation must contain its own claimEvidence object/);
    assert.match(options.prompt,/Put claimEvidence directly on each observed fact and expectation/);
    const modelFinding=properties.findings.items.properties;
    assert.ok(!modelFinding.claimEvidenceLinks);
    for(const claims of [modelFinding.observedFacts,modelFinding.expectations]){
     assert.ok(claims.items.required.includes('claimEvidence'));
     assert.ok(!claims.items.properties.claimEvidence.properties.claimId);
    }
    const variants=properties.imageLayouts.items.properties.focusAreas.items.anyOf;
    assert.deepEqual(variants.map((variant:{required:string[]})=>variant.required),[['findingId','bounds'],['findingId','occlusion']]);
   }
   else {
    assert.match(options.instructions,/Then report only meaningful supported issues/);
    assert.doesNotMatch(options.instructions,/Classify the usability claim|IMAGE_CLASSIFICATION|Use suggestions only/);
   }
   return {events:[{type:'turn.completed'}],exitCode:0,hasTimedOut:false,hasUnexpectedToolCall:false,structuredOutput:{...draft,...(isImage?{suggestions:[]}: {})}};
  }});
  assert.equal((await run(false)).status,'completed');imageFixtureInput(input);assert.equal((await run(true)).status,'completed');
 }finally{await cleanup();}
});

test('image provider evidence uses its containing claim IDs without permitting invalid links',async()=>{
 const {input,draft,cleanup}=await fixture();try{
  imageFixtureInput(input);
  const {claimEvidenceLinks,observedFacts,expectations,...finding}=draft.findings[0]!;
  const [factEvidence,expectationEvidence]=claimEvidenceLinks.map(({claimId,...claimEvidence})=>({...claimEvidence,hasMaskedContentDependency:false}));
  const inlineFinding={...finding,visualEvidence:[],
   observedFacts:[{...observedFacts[0],claimEvidence:factEvidence}],
   expectations:[{...expectations[0],claimEvidence:expectationEvidence}],
  };
  let calls=0;
  const accepted=await evaluate(input,{runCodex:async()=>{
   calls++;
   return {events:[{type:'turn.completed'}],exitCode:0,hasTimedOut:false,hasUnexpectedToolCall:false,
    structuredOutput:{...draft,findings:[inlineFinding]}};
  }});
  assert.equal(calls,1);
  assert.equal(accepted.status,'completed');
  const saved=accepted.findings[0]!;
  assert.deepEqual(saved.observedFacts,observedFacts);assert.deepEqual(saved.expectations,expectations);
  assert.deepEqual(saved.claimEvidenceLinks,claimEvidenceLinks.map(link=>({...link,hasMaskedContentDependency:false})));
  const invalidEvidence={...factEvidence,evidenceIds:['fabricated-screenshot']};
  const rejected=await validateReviewDraft({...draft,findings:[{...inlineFinding,
   observedFacts:[{...inlineFinding.observedFacts[0],claimEvidence:invalidEvidence}],
  }]},input);
  assert.equal(rejected.findings.length,0);
  assert.match(rejected.limitations.join(' '),/invalid or unverified evidence ID/);
  const wrongSource={...expectationEvidence,sourceRefs:['fabricated-source']};
  const invalidSource=await validateReviewDraft({...draft,findings:[{...inlineFinding,
   expectations:[{...inlineFinding.expectations[0],claimEvidence:wrongSource}],
  }]},input);
  assert.equal(invalidSource.findings.length,0);
  assert.match(invalidSource.limitations.join(' '),/invalid claim\/source reference/);
  const legacy=await validateReviewDraft({...draft,findings:[{...draft.findings[0],
   claimEvidenceLinks:[{...claimEvidenceLinks[0],claimId:'claim-1'},claimEvidenceLinks[1]],
  }]},input);
  assert.equal(legacy.findings.length,0);
  assert.match(legacy.limitations.join(' '),/unknown claim IDs \[claim-1\]; use exact IDs from this finding \[f1, x1\]/);
 }finally{await cleanup();}
});

test('image focus intersects only a bound covering pair and preserves ordinary focus',async()=>{
 const {input,draft,cleanup}=await fixture();try{
  imageFixtureInput(input);
  input.evidence[0].screenshot={coordinateSpace:'image-pixels',clip:{x:0,y:0,width:390,height:844},deviceScaleFactor:1,maskColor:'',redactionRegions:[]};
  const layout={observationId:'o1',evidenceId:'e1',regions:[{label:'본문',bounds:{x:0,y:0,width:1,height:1}}]};
  const findingId=draft.findings[0]!.issueId;
  const occluderBounds={x:.625,y:.25,width:.25,height:.25};
  const occludedBounds={x:.25,y:.375,width:.5,height:.25};
  const pair={findingId,occlusion:{occluderBounds,occludedBounds}};
  const ordinary={findingId,bounds:{x:.125,y:.25,width:.75,height:.5}};
  const check=async(focusAreas:unknown[],expected:unknown)=>{
   const evaluated=await validateReviewDraft({...draft,imageLayouts:[{...layout,focusAreas}]},input);
   assert.equal(evaluated.status,'completed');
   assert.equal(evaluated.findings[0]?.issueId,findingId);
   assert.deepEqual(evaluated.imageLayouts,[{...layout,focusAreas:expected}]);
  };
  await check([pair],[{findingId,bounds:{x:.625,y:.375,width:.125,height:.125}}]);
  await check([ordinary],[ordinary]);
  await check([{...pair,findingId:'another-finding'}],[]);
  await check([{...pair,occlusion:{occluderBounds:{...occluderBounds,width:.5},occludedBounds}}],[]);
  await check([{...pair,occlusion:{occluderBounds:{...occluderBounds,x:.75},occludedBounds}}],[]);
  await check([{...pair,occlusion:{occluderBounds:{x:.1,y:.25,width:.2,height:.25},occludedBounds:{...occludedBounds,x:.3}}}],[]);
  await check([{...pair,bounds:ordinary.bounds}],[]);
  await check([pair,ordinary],[]);
 }finally{await cleanup();}
});

test('B suggestions are category-scoped and separately bounded; C suggestions survive without verifier promotion',async()=>{
 const {input,draft,cleanup}=await fixture();try{
  imageFixtureInput(input);input.timeoutMs=10000;input.spec.limits.maxFindings=1;input.spec.strategy='B';
  input.evidence[0].screenshot={coordinateSpace:'image-pixels',clip:{x:0,y:0,width:390,height:844},deviceScaleFactor:1,maskColor:'',redactionRegions:[]};
  const imageLayouts=[{observationId:'o1',evidenceId:'e1',regions:[{label:'본문',bounds:{x:0,y:.1,width:1,height:.9}}],focusAreas:[]}];
  const process=(raw:unknown)=>({events:[{type:'turn.completed'}],exitCode:0,hasTimedOut:false,hasUnexpectedToolCall:false,structuredOutput:raw});
  const merged=await evaluate(input,{runCodex:async(_input,options)=>{
   assert.match(options.instructions,/Classify the usability claim, not just the visible phenomenon/);
   assert.match(options.instructions,/use verificationNeeded to state the decision-changing question/);
   return process({...draft,findings:[],suggestions:[advisory,{...advisory,suggestionId:'suggestion-2',title:'다른 묶음 검토'}],
    ...(options.prompt.includes('Navigation affordances')?{imageLayouts}:{})});
  }});
  assert.deepEqual(merged.imageLayouts,imageLayouts);
  assert.ok(!merged.limitations.some(message=>message.includes('일반 영역을 표시할 수 없습니다')));
  assert.equal(merged.findings.length,0);assert.equal(merged.suggestions?.length,1);assert.match(merged.suggestions![0].suggestionId,/suggestion-/);
  input.spec.strategy='C';const checked=await evaluate(input,{runCodex:async(_input,options)=>{
   assert.match(options.instructions,/Classify the usability claim, not just the visible phenomenon/);
   if(options.instructions.includes('For this stage')){
    assert.doesNotMatch(options.instructions,/Use suggestions only|use verificationNeeded/);
    assert.match(options.instructions,/decision reason must identify the decision-changing question/);
    return process({decisions:[{candidateId:'issue-1',decision:'dismiss',reason:'Insufficient support'}]});
   }
   return process({...draft,suggestions:[advisory]});
  }});
  assert.equal(checked.findings.length,0);assert.equal(checked.suggestions?.length,1);assert.equal(checked.suggestions?.[0].uncertainty,advisory.uncertainty);
  const report={schemaVersion:'0.1',runId:'r1',status:'completed',startedAt:'now',endedAt:'now',findings:[],verificationCandidates:[],suggestions:checked.suggestions,coverage:input.coverage,observations:input.observations,actions:[],rules:[],evidence:input.evidence,limitations:[],evaluation:checked} as ReviewResult;
  const markdown=renderReport(report);assert.match(markdown,/보고 지적: 0개, 추가 검증 후보: 0개/);assert.match(markdown,/개선 제안 \(결함 수 제외\)/);assert.match(markdown,/예상 영향 \(추정\)/);assert.match(markdown,/screenshot.png/);report.findings=draft.findings;assert.equal((renderReport(report).match(/## 개선 제안/g)??[]).length,1);
 }finally{await cleanup();}
});

// Contract regression only: whether a model classifies real evidence correctly is
// measured by the blinded evaluation, not by these hand-labelled mock responses.
test('image classification preserves supported findings, unresolved candidates and advisory output separately',async()=>{
 const {input,draft,cleanup}=await fixture();try{
  imageFixtureInput(input);
  const question='질문: 해당 작업의 정보를 상세 보기에서 확인할 수 있는가? 증거: 상세 보기와 업무 기준. 불충분하면 문제 확정, 충분하면 제외하고 선택적 이익이 있을 때만 제안.';
  const candidate={...draft.findings[0]!,issueId:'uncertain-2',title:'추가 정보 제공 여부 확인',disposition:'needs-verification' as const,needsFurtherVerification:true,verificationNeeded:question,confidenceRationale:'관찰은 명확하지만 보완 경로의 충분성은 미확인입니다.'};
  const evaluation=await validateReviewDraft({...draft,findings:[draft.findings[0],candidate],suggestions:[advisory]},input);
  assert.equal(evaluation.status,'completed');
  assert.deepEqual(evaluation.findings.map(finding=>finding.disposition),['confirmed','needs-verification']);
  assert.equal(evaluation.findings[1]!.verificationNeeded,question);
  assert.deepEqual(evaluation.suggestions,[advisory]);
  const report:ReviewResult={schemaVersion:'0.1',runId:'r1',status:'completed',imageSource:input.observations[0]!.source,startedAt:'now',endedAt:'now',findings:evaluation.findings.filter(finding=>finding.disposition==='confirmed'),verificationCandidates:evaluation.findings.filter(finding=>finding.disposition==='needs-verification'),suggestions:evaluation.suggestions,coverage:input.coverage,observations:input.observations,actions:[],rules:[],evidence:input.evidence,limitations:[],evaluation};
  const markdown=renderReport(report);
  assert.match(markdown,/보고 지적: 1개, 추가 검증 후보: 1개/);
  assert.ok(markdown.includes(question));
  assert.match(markdown,/개선 제안 \(결함 수 제외\)/);
  const empty=await validateReviewDraft({...draft,findings:[],suggestions:[]},input);
  assert.equal(empty.status,'completed');assert.deepEqual(empty.findings,[]);assert.deepEqual(empty.suggestions,[]);
 }finally{await cleanup();}
});


test('default compatible split reserves the full repair after a near-limit initial response',async t=>{
 const {input,draft,cleanup}=await fixture();t.after(cleanup);
 t.mock.timers.enable({apis:['Date'],now:Date.now()});
 const configured=deriveStandardReviewTimeouts(defaultStandardEvaluationTimeouts);
 input.spec.evaluator='openai-compatible';input.timeoutMs=configured.timeoutSeconds*1000-25000;
 input.spec.evaluationBudget=configured.evaluationBudget;
 const bad=structuredClone(draft);bad.screenMap=[];const limits:number[]=[];
 const result=await evaluate(input,{runOpenAiCompatible:async current=>{
  limits.push(current.timeoutMs);assert.equal(current.callBudgetMetadata?.isRepair,limits.length===2);
  if(limits.length===1)t.mock.timers.tick(959000);
  return {output:limits.length===1?bad:draft,model:'fixture'};
 }});
 assert.deepEqual(limits,[960000,180000]);assert.equal(result.status,'completed');assert.equal(result.calls?.length,2);
});

test('explicit repair obeys the smaller outer remainder and never loops beyond one repair',async t=>{
 const {input,draft,cleanup}=await fixture();t.after(cleanup);
 t.mock.timers.enable({apis:['Date'],now:Date.now()});
 input.spec.evaluator='openai-compatible';input.timeoutMs=250000;
 input.spec.evaluationBudget={stageTimeoutSeconds:330,initialTimeoutSeconds:240,repairTimeoutSeconds:90};
 draft.screenMap=[];const limits:number[]=[];
 const result=await evaluate(input,{runOpenAiCompatible:async current=>{limits.push(current.timeoutMs);if(limits.length===1)t.mock.timers.tick(200000);return {output:draft};}});
 assert.deepEqual(limits,[240000,50000]);assert.equal(result.status,'partial');assert.equal(result.calls?.length,2);
});

test('initial timeout or outer cancellation never starts a validation repair; legacy cap stays 150 seconds',async t=>{
 const {input,draft,cleanup}=await fixture();t.after(cleanup);
 input.spec.evaluator='openai-compatible';input.timeoutMs=360000;let count=0;
 await evaluate(input,{runOpenAiCompatible:async current=>{count++;assert(current.timeoutMs<=150000);return {hasTimedOut:true};}});assert.equal(count,1);
 input.spec.evaluationBudget={stageTimeoutSeconds:330,initialTimeoutSeconds:240,repairTimeoutSeconds:90};count=0;
 const timed=await evaluate(input,{runOpenAiCompatible:async current=>{count++;assert.equal(current.timeoutMs,240000);return {hasTimedOut:true};}});assert.equal(count,1);assert.equal(timed.status,'failed');
 const controller=new AbortController();input.signal=controller.signal;count=0;draft.screenMap=[];
 await evaluate(input,{runOpenAiCompatible:async()=>{count++;controller.abort();return {output:draft};}});assert.equal(count,1);
});


test('discovery and final review share the outer deadline instead of each receiving a fresh sixteen minutes',async t=>{
 const {input,draft,cleanup}=await fixture();t.after(cleanup);
 t.mock.timers.enable({apis:['Date'],now:Date.now()});
 const configured=deriveStandardReviewTimeouts(defaultStandardEvaluationTimeouts);
 input.spec.evaluator='openai-compatible';input.spec.evaluationBudget=configured.evaluationBudget;input.spec.limits.maxDurationMs=configured.timeoutSeconds*1000;
 const budget=new Budget(input.spec),controller=new AbortController(),limits:number[]=[];
 const discovery=await evaluateStage({...input,timeoutMs:budget.remainingMs(),signal:controller.signal},{runOpenAiCompatible:async current=>{
  limits.push(current.timeoutMs);t.mock.timers.tick(960000);return{output:{},model:'fixture'};
 }},{name:'url-state-discovery',schema:{type:'object'},validate:async()=>({status:'completed',findings:[],screenMap:[],interpretations:[],limitations:[]})});
 assert.equal(discovery.status,'completed');assert.equal(budget.remainingMs(),240000);
 const reviewed=await evaluate({...input,timeoutMs:budget.remainingMs(),signal:controller.signal},{runOpenAiCompatible:async current=>{
  limits.push(current.timeoutMs);assert(current.callBudgetMetadata!.stageTimeoutMs<=240000);t.mock.timers.tick(current.timeoutMs);controller.abort();return{hasTimedOut:true};
 }});
 assert.deepEqual(limits,[960000,240000]);assert.equal(reviewed.status,'failed');assert.equal(budget.remainingMs(),0);assert.throws(()=>budget.assertTime(),/time limit/);
 await evaluate({...input,timeoutMs:budget.remainingMs(),signal:controller.signal},{runOpenAiCompatible:async()=>{assert.fail('exhausted run must not start another provider call');}});
});
