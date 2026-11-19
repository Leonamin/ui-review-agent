import test from 'node:test';
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {inspect} from '../src/core.js';
import {closeBrowserLeases} from '../src/browser-lease.js';
import type {EvaluationResult,Observation,RuleFinding,RunSpec} from '../src/types.js';

const terminalButtons='<button type="button" disabled>변경 사항 저장</button><button type="button" disabled>변경 취소</button>';
const alignmentRow=`<form style="display:flex;align-items:flex-start;gap:16px;font:16px/1.6 sans-serif">
 <label style="display:grid;gap:8px">API key<input type="password" value="secret-in-field" style="box-sizing:border-box;height:44px;border:1px solid #777;background:white"></label>
 <button type="button" style="margin-top:25px;height:44px;border:1px solid #777;background:white">Delete saved key</button>
 </form>`;
const content=`<h1>평가자 설정</h1><p>기본 평가자와 CLI 모델을 선택하는 화면입니다.</p><div style="height:820px"></div><h2>기본 평가 시간</h2>${alignmentRow}${terminalButtons}`;
const evaluation:EvaluationResult={status:'completed',findings:[],screenMap:[],interpretations:[],limitations:[]};

async function fixture(html:string,run:(spec:RunSpec,root:string)=>Promise<void>){
 const server=createServer((_req,res)=>res.setHeader('Content-Type','text/html; charset=utf-8').end(html));
 await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve));
 const address=server.address();assert(address&&typeof address!=='string');
 const origin=`http://127.0.0.1:${address.port}`;
 const root=await mkdtemp(join(tmpdir(),'vertical-scroll-'));
 try{await run({targetUrl:origin,allowedOrigins:[origin],mode:'quick',purpose:'설정 화면 시각 검사',viewport:{width:800,height:600,deviceScaleFactor:1},
  allowedActions:[],hasMutationPermission:false,isHeaded:false,shouldWaitForLogin:false,
  limits:{maxDurationMs:35000,maxObservations:15,maxActions:0,maxToolCalls:24,maxFindings:10},evaluator:'rules-only'},root);}
 finally{await closeBrowserLeases();server.closeAllConnections();await new Promise<void>(resolve=>server.close(()=>resolve()));await rm(root,{recursive:true,force:true});}
}
function hasBothButtons(observation:Observation){
 return ['변경 사항 저장','변경 취소'].every(label=>observation.elements.some(element=>element.tag==='button'&&element.text===label&&!element.isEnabled&&
  element.boundingBox.y>=0&&element.boundingBox.y+element.boundingBox.height<=observation.viewport.height));
}
function assertFormRowRule(result: {observations:Observation[];rules:RuleFinding[]}){
 const rule=result.rules.find(rule=>rule.ruleVersion==='form-row-1');
 assert(rule);
 const observation=result.observations.find(observation=>observation.observationId===rule.observationId);
 assert(observation?.scrollOffset.y);
 const check=observation.deterministicChecks?.alignment?.checks.find(check=>check.formPair==='field-action');
 assert.equal(check?.differences[0].signedTopOffset,-8.59375);
 assert.deepEqual(check?.members.map(member=>member.elementRef),rule.elementRefs);
 assert(rule.evidenceIds.every(id=>observation.evidenceRefs.some(ref=>ref.evidenceId===id)));
 assert(observation.evidenceRefs.some(ref=>ref.kind==='screenshot'&&ref.screenshot?.redactionRegions.some(region=>region.reason==='input-value'&&region.elementRef===rule.elementRefs[0])));
 assert(!JSON.stringify(rule).includes('secret-in-field'));
}

test('normal URL review sends overlapping masked document viewports and restores the original position',async()=>fixture(
 `<!doctype html><html lang="ko"><title>설정</title><main>${content.replace('<div style="height:820px"></div>','<div style="height:820px"><div style="display:none">'+'<p>Hidden content</p>'.repeat(520)+'</div></div>')}</main></html>`,async(spec,root)=>{
  const {result}=await inspect({...spec,evaluator:'codex'},root,{evaluate:async input=>{
   const areas=input.observations.filter(item=>item.verticalScroll);
   assert.equal(areas.length,2);
   const [top,bottom]=areas;
   assert.equal(top.scrollOffset.y,0);
   assert(bottom.scrollOffset.y>0);
   assert(bottom.verticalScroll!.visibleStart<top.verticalScroll!.visibleEnd);
   assert.equal(bottom.verticalScroll!.visibleEnd,bottom.verticalScroll!.extent);
   assert.deepEqual(bottom.viewport,spec.viewport);
   assert(hasBothButtons(bottom));
   assert(bottom.evidenceRefs.some(item=>item.kind==='screenshot'&&item.screenshot?.redactionRegions.some(region=>region.reason==='input-value')));
   assert(!JSON.stringify(bottom).includes('secret-in-field'));
   assertFormRowRule(input);
   return evaluation;
  }});
  assert.equal(result.status,'completed',result.terminationReason??JSON.stringify(result.coverage));
  assert.equal(result.actions.length,0);
  assert.equal(result.observations.at(-1)!.scrollOffset.y,0);
  assertFormRowRule(result);
  assert(result.verificationCandidates.some(candidate=>candidate.source==='automatic-rule'&&candidate.title.includes('상단 정렬')));
 }));

test('normal URL review records inner scroll coordinates without changing document scroll',async()=>fixture(
 `<!doctype html><html lang="ko"><title>설정</title><div style="height:0;overflow:hidden"><div style="width:790px;height:590px;overflow:auto"><article style="height:2000px"></article></div></div><main style="height:480px;width:750px;overflow:auto">${content}</main></html>`,async(spec,root)=>{
  const {result}=await inspect(spec,root,{evaluate:async input=>{
   const areas=input.observations.filter(item=>item.verticalScroll);
   assert(areas.length>=2);
   assert(areas.every(item=>item.scrollOffset.y===0&&item.verticalScroll?.owner==='container'));
   assert(areas.some(item=>item.verticalScroll!.offset>0&&hasBothButtons(item)));
   return evaluation;
  }});
  assert.equal(result.status,'completed',JSON.stringify(result.coverage));
 }));

test('URL follow-up can scroll to offscreen disabled buttons without operating controls',async()=>fixture(
 `<!doctype html><html lang="ko"><title>설정</title><main>${content}</main></html>`,async(spec,root)=>{
  const {result}=await inspect({...spec,evaluator:'codex',followup:{requestId:'settings-request',workspaceId:'settings-workspace',
   instruction:'설정 화면 아래로 스크롤하여 저장 및 취소 버튼을 검토해 주세요.',
   source:{reportId:'a'.repeat(64),reportSha256:'b'.repeat(64),runId:'old-run'},maxOptions:1}},root,{
   decideFollowup:async input=>{
    const active=input.observations.at(-1)!;
    const hasVisibleTargets=hasBothButtons(active);
    if(!hasVisibleTargets)assert(input.scrollDirections?.includes('down'));
    return{evaluation,decision:{phase:hasVisibleTargets?'done':'scroll',reason:'설정 화면 하단을 확인합니다.',answer:'',
     isRestored:true,isSelectedRegionBound:true,isRequestedOptionMissing:false,scopeMode:'related-screen',
     scopeDescription:'설정 화면 하단의 두 버튼',action:hasVisibleTargets?null:{direction:'down'},
     scopeSuggestion:{kind:'same-workspace',name:'설정',goal:'설정 하단 점검',reason:'설정 화면'}}};
   },
   evaluate:async input=>{
    assert(input.observations.some(item=>item.scrollOffset.y>0&&item.verticalScroll&&hasBothButtons(item)));
    assert(input.observations.some(item=>item.scrollOffset.y===0));
    assertFormRowRule(input);
    return evaluation;
   }
  });
  assert.equal(result.status,'completed',result.terminationReason??JSON.stringify(result.followup));
  assert.equal(result.actions.length,0);
  assert(result.followup?.history.every(step=>step.type==='scroll'&&step.scroll?.direction==='down'&&step.outcome==='success'));
  assert.equal(result.followup?.replay.length,0);
  assert(result.followup?.state?.scroll);
  assert(result.followup.state.anchors.includes('기본 평가 시간'));
  assertFormRowRule(result);
  assert.equal(result.verificationCandidates.filter(candidate=>candidate.source==='automatic-rule'&&candidate.title.includes('상단 정렬')).length,1);

  await closeBrowserLeases();
  const source={reportId:'c'.repeat(64),reportSha256:'d'.repeat(64),runId:result.runId};
  const second=await inspect({...spec,followup:{requestId:'second-request',workspaceId:'settings-workspace',instruction:'앞서 본 하단 영역을 확인해 주세요.',
   source,maxOptions:1,executionBase:{...source,replay:[],state:result.followup.state}}},root,{
   decideFollowup:async input=>{
    const active=input.observations.at(-1)!;
    assert(hasBothButtons(active));
    assert(active.scrollOffset.y>0);
    return{evaluation,decision:{phase:'done',reason:'저장과 취소가 보입니다.',answer:'',
     isRestored:true,isSelectedRegionBound:true,isRequestedOptionMissing:false,scopeMode:'related-screen',
     scopeDescription:'복원된 하단 영역',action:null,scopeSuggestion:{kind:'same-workspace',name:'설정',goal:'설정 하단 점검',reason:'설정 화면'}}};
   },
   evaluate:async input=>{assert(hasBothButtons(input.observations.at(-1)!));return evaluation;}
  });
  assert.equal(second.result.followup?.restoration.status,'replayed');
  assert.equal(second.result.status,'completed',JSON.stringify(second.result.followup));
  assert.equal(second.result.actions.length,0);
 }));

test('a URL scan reports incomplete coverage when an explicit observation budget prevents reaching the bottom',async()=>fixture(
 `<!doctype html><html lang="ko"><title>설정</title><main>${content.replace('height:820px','height:1800px')}</main></html>`,async(spec,root)=>{
  const {result}=await inspect({...spec,limits:{...spec.limits,maxObservations:3}},root,{evaluate:async()=>evaluation});
  assert.equal(result.evaluation.status,'completed');
  assert.equal(result.status,'partial');
  assert(result.coverage.unmetChecks.some(item=>item.checkId==='vertical-scroll'&&item.reason.includes('끝까지')));
  assert(result.observations.some(item=>item.scrollOffset.y>0&&item.verticalScroll));
  assert.equal(result.observations.at(-1)!.scrollOffset.y,0);
 }));
