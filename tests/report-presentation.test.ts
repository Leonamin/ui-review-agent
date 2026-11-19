import test from 'node:test';
import assert from 'node:assert/strict';
import {reportHref,reportRoute,workspaceReportHref,workspaceReportTab} from '../viewer/app/route.js';
import {reportName,findingImageIndex,verificationSummary} from '../viewer/features/reports/presentation.js';
import {emptyReportFilters,filterReports,reportListStatusLabel} from '../viewer/features/reports/report-list.js';
import {sample} from '../viewer/features/reports/fixtures.js';
import type {ReportRecommendation} from '../viewer/features/reports/types.js';

test('report defaults to summary while existing detail deep links remain valid',()=>{
 assert.deepEqual(reportRoute('?report=run'),{id:'run',tab:'summary'});
 for(const tab of ['findings','suggestions','measurements','limits']) assert.equal(reportRoute(`?report=run&tab=${tab}`).tab,tab);
 assert.equal(reportRoute('?report=run&tab=unknown').tab,'summary');
});
test('linked report links pin the run and default to results without dropping legacy entry states',()=>{
 assert.equal(workspaceReportTab(reportHref('older run','summary')),'results');
 assert.equal(workspaceReportTab('?report=older-run'),'results');
 assert.equal(workspaceReportTab('?workspace=screen'),'results');
 assert.equal(workspaceReportTab(reportHref('older run','findings')),'results');
 for(const tab of ['results','suggestions','measurements','limits']){
  assert.equal(workspaceReportTab(reportHref('older run',tab)),tab);
 }
 const href=workspaceReportHref('report owner','older run','summary');
 const url=new URL(href,'http://localhost');
 assert.equal(url.searchParams.get('workspace'),'report owner');
 assert.deepEqual(reportRoute(url.search),{id:'older run',tab:'summary'});
 assert.equal(workspaceReportTab(url.search),'summary');
});
test('the composer tab is available only on workspace report links',()=>{
 const href=workspaceReportHref('screen','run','compose');
 assert.equal(workspaceReportTab(new URL(href,'http://localhost').search),'compose');
 assert.equal(workspaceReportTab('?report=run&tab=compose'),'results');
 assert.equal(reportRoute('?report=run&tab=compose').tab,'summary');
});
test('recorded task target names supersede inferred headings but explicit report edits remain visible',()=>{
 const report={...sample,screenTitle:'목록에서 작업을 선택하세요',taskContext:{taskId:'task',taskTitle:'작업',revisionId:'revision',revisionNumber:2,targetId:'target',targetName:'사용자가 입력한 화면',attemptNumber:1}};
 assert.equal(reportName(report),'사용자가 입력한 화면');
 const recommendation={screenName:'자동 추천 화면',status:'suggested'} as ReportRecommendation;
 assert.equal(reportName({...report,recommendation}),'사용자가 입력한 화면');
 assert.equal(reportName({...report,recommendation:{...recommendation,status:'edited',screenName:'직접 수정한 이름'}}),'직접 수정한 이름');
 assert.equal(reportName({...report,recommendation:{...recommendation,status:'confirmed'}}),'자동 추천 화면');
 assert.equal(reportName({...report,taskContext:undefined}),'목록에서 작업을 선택하세요');
});
test('finding image selection follows recorded evidence and does not imply an unrelated capture is evidence',()=>{
 const images=[{id:'a',observationId:'obs-a',label:'capture-a',url:'a.png'},{id:'b',observationId:'obs-b',label:'capture-b',url:'b.png'}];
 const finding={...sample.findings[0],observationIds:['obs-b'],evidenceIds:[]};
 assert.equal(findingImageIndex({images},finding),1);
 assert.equal(findingImageIndex({images},{...finding,observationIds:[],evidenceIds:['capture-a']}),0);
 assert.equal(findingImageIndex({images},{...finding,observationIds:[],evidenceIds:['missing']}),-1);
 assert.equal(findingImageIndex({images:[]},finding),-1);
 const sameObservation=images.map(image=>({...image,observationId:'same'}));
 assert.equal(findingImageIndex({images:sameObservation},{...finding,observationIds:['same'],evidenceIds:['capture-b']}),1);
 const imagesWithEvidenceIds=sameObservation.map(image=>({...image,evidenceId:`raw-${image.id}`}));
 assert.equal(findingImageIndex({images:imagesWithEvidenceIds},{observationIds:['same'],evidenceIds:['raw-b']}),1);
});
test('missing verification data remains distinct from zero executed checks and actual records',()=>{
 assert.equal(verificationSummary({...sample,hasVerificationData:false,measurements:[]}),'기록 없음');
 assert.equal(verificationSummary({...sample,hasVerificationData:true,measurements:[]}),'실행된 검사 없음');
 assert.equal(verificationSummary(sample),'1건 기록');
});

test('evaluation labels never present a failed evaluation as a zero-count success',async()=>{
 const {evaluationLabel,findingCountLabel}=await import('../viewer/features/reports/presentation.js');
 assert.equal(evaluationLabel({evaluation:{status:'failed'}}),'AI 평가 실패');
 assert.equal(findingCountLabel({evaluation:{status:'failed'},initialCount:0}),'집계 불가');
 assert.equal(evaluationLabel({evaluation:{status:'partial'}}),'AI 평가 일부 완료');
 assert.equal(findingCountLabel({evaluation:{status:'partial'},initialCount:0}),'0건');
 assert.equal(evaluationLabel({evaluation:{status:'completed'}}),undefined);
 assert.equal(findingCountLabel({evaluation:{status:'completed'},initialCount:0}),'0건');
 assert.equal(findingCountLabel({initialCount:null}),'미기록');
});

test('report list combines search words, displayed status, and input type',()=>{
 const taskContext={taskId:'task',taskTitle:'Example Shop 운영',revisionId:'revision',revisionNumber:2,targetId:'target',targetName:'관리자 예약 관리 · 다크',attemptNumber:1};
 const failedEvaluation={...sample,id:'image',target:'이미지: booking.png',status:'partial',evaluation:{status:'failed' as const},taskContext};
 const partialRun={...sample,id:'url',target:'https://example.com/reservations',status:'partial',taskContext};
 const unreadable={...sample,id:'unknown',target:'보고서 오류',hasReadError:true};
 const reports=[failedEvaluation,partialRun,unreadable];
 assert.equal(reportListStatusLabel(failedEvaluation),'AI 평가 실패');
 assert.deepEqual(filterReports(reports,{...emptyReportFilters,query:'다크  EXAMPLE shop 예약',status:'evaluation-failed',source:'image'}),[failedEvaluation]);
 assert.deepEqual(filterReports(reports,{...emptyReportFilters,query:'/reservations   운영',status:'partial',source:'url'}),[partialRun]);
 assert.deepEqual(filterReports(reports,{...emptyReportFilters,status:'partial',source:'image'}),[]);
 assert.deepEqual(filterReports(reports,{...emptyReportFilters,status:'read-error',source:'unknown'}),[unreadable]);
});
