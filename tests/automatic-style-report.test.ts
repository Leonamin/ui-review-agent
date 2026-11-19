import assert from 'node:assert/strict';
import test from 'node:test';
import type {AutoStyleComparisonReport} from '../src/automatic-style-comparison.js';
import {renderReport} from '../src/report.js';
import type {EvidenceRef, Observation, ReviewResult} from '../src/types.js';
import {recordedCapture} from '../viewer/server/report-metadata.js';

const bounds={x:24,y:56,width:192,height:40};
const target=(label:string,selector:string)=>({label,selector,bounds});
const comparison:AutoStyleComparisonReport={
 evidenceId:'auto-style-evidence',
 reference:{url:'https://example.test/projects',observationId:'obs-001',screenshotEvidenceId:'capture-a',hasReachedLimit:false,inspected:3},
 comparison:{url:'https://example.test/reports',observationId:'obs-002',screenshotEvidenceId:'capture-b',hasReachedLimit:true,inspected:4},
 matches:[
  {role:'searchbox',method:'unique-role',reference:target('프로젝트 검색','#project-search'),comparison:target('보고서 검색','#report-search'),
   differences:[{property:'border-top-left-radius',reference:'16px',comparison:'999px'}]},
  {role:'button',method:'label',reference:target('필터','#filter-a'),comparison:target('필터','#filter-b'),differences:[]},
 ],
 unmatched:[{side:'reference',role:'checkbox',...target('오류만 표시','#errors')}],
 ambiguous:[{side:'comparison',role:'button',...target('더 보기','#more')}],
 unmeasured:[{side:'comparison',role:'link',...target('편집','#edit'),reason:'unstable'}],
 coverage:{matched:2,changed:1,unmatched:1,ambiguous:1,unmeasured:1},
};

function observationFor(report:AutoStyleComparisonReport):Observation {
 return {
  observationId:'obs-001',runId:'r1',url:report.reference.url,pageTitle:'프로젝트',
  captureStartedAt:'2026-11-19T00:00:00Z',captureEndedAt:'2026-11-19T00:00:01Z',
  viewport:{width:800,height:600,deviceScaleFactor:1},scrollOffset:{x:0,y:0},
  isStable:true,consistencyWarnings:[],screenshotRefs:['capture-a'],evidenceRefs:[],elements:[],
  accessibilitySnapshot:'',documentWidth:800,viewportWidth:800,unsupportedFrames:0,imageFailures:0,
  deterministicChecks:{evidenceId:'existing-rules',autoStyleComparison:report},
 };
}

const screenshot=(evidenceId:string,observationId:string,relativePath:string):EvidenceRef=>({
 evidenceId,observationId,kind:'screenshot',relativePath,absolutePath:'',runId:'r1',mimeType:'image/png',sha256:'',isRedacted:true,
});

test('normalizes automatically compared captures alongside other recorded checks',()=>{
 const observation=observationFor(comparison);
 const checks={...observation.deterministicChecks,evidenceId:'existing-rules',alignment:{tolerance:1,checks:[]}};
 assert.deepEqual(recordedCapture({...observation,deterministicChecks:checks})?.deterministicChecks,checks);
 const {autoStyleComparison:_,...otherChecks}=checks;
 const malformed={...comparison,coverage:{...comparison.coverage,matched:-1}};
 assert.deepEqual(recordedCapture({...observation,deterministicChecks:{...otherChecks,autoStyleComparison:malformed}})?.deterministicChecks,otherChecks);
 assert.deepEqual(recordedCapture({...observation,deterministicChecks:otherChecks})?.deterministicChecks,otherChecks);
});

test('Markdown shows both automatic comparison captures, candidate evidence and unpaired coverage',()=>{
 const observation=observationFor(comparison);
 const result:ReviewResult={
  schemaVersion:'0.1',runId:'r1',status:'completed',startedAt:observation.captureStartedAt,endedAt:observation.captureEndedAt,
  targetUrl:observation.url,observations:[observation],findings:[],verificationCandidates:[],actions:[],rules:[],
  evidence:[screenshot('capture-a','obs-001','a capture.png'),screenshot('capture-b','obs-002','b capture.png')],
  coverage:{canFinish:true,requiredChecks:[],observedChecks:[],unmetChecks:[],completionBlockers:[]},
  limitations:[],evaluation:{status:'completed',provider:'rules-only',findings:[],screenMap:[],interpretations:[],limitations:[]},
 };
 const markdown=renderReport(result);
 assert.match(markdown,/비교한 요소 2쌍 · 차이 후보 1쌍 · 차이 없음 1쌍/);
 assert.match(markdown,/화면 A.*\[캡처 보기\]\(a%20capture\.png\)/);
 assert.match(markdown,/화면 B.*\[캡처 보기\]\(b%20capture\.png\)/);
 assert.match(markdown,/프로젝트 검색 ↔ 보고서 검색/);
 assert.match(markdown,/border-top-left-radius · A 16px \/ B 999px/);
 assert.match(markdown,/차이 없음 · 버튼 · 필터 ↔ 필터/);
 assert.match(markdown,/대응 요소 없음 1개 · 모호함 1개 · 미측정 1개/);
 assert.match(markdown,/탐색 한도에 도달/);
 assert.match(markdown,/측정하지 못함 · 화면 B · 링크 · 편집.*캡처 전후/);
 assert.match(markdown,/디자인 기준 위반 여부는 별도 확인/);
});
