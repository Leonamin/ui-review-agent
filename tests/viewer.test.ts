import {request as httpRequest} from 'node:http';import test from 'node:test';import assert from 'node:assert/strict';import {mkdtemp,mkdir,writeFile,rm,symlink} from 'node:fs/promises';import {tmpdir} from 'node:os';import {join} from 'node:path';import {createHash} from 'node:crypto';
import {ReportRepository} from '../viewer/server/repository.js';import {createViewerServer} from '../viewer/server/http.js';
import {recordedCapture} from '../viewer/server/report-metadata.js';
const png=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jF9sAAAAASUVORK5CYII=','base64');
async function fixture(fn:(root:string)=>Promise<void>){const root=await mkdtemp(join(tmpdir(),'viewer-'));try{await fn(root);}finally{await rm(root,{recursive:true,force:true});}}
async function makeReport(root:string,name:string,evidence?:any){const dir=join(root,name);await mkdir(dir,{recursive:true});await writeFile(join(dir,'report.json'),JSON.stringify({runId:name,status:'completed',targetUrl:'https://example.com/<script>alert(1)</script>',findings:[],...(evidence?{evidence:[evidence]}:{})}));return dir;}
test('viewer discovers nested reports, preserves legacy unknowns and safely reads optional manifest metadata',async()=>fixture(async root=>{const dir=await makeReport(root,'group/run');await writeFile(join(dir,'manifest.json'),JSON.stringify({requestedModel:'requested-only',spec:{purpose:'검사 목적'}}));await mkdir(join(root,'broken'));await writeFile(join(root,'broken/report.json'),'{');const repo=new ReportRepository(root),list=await repo.list();assert.equal(list.reports.length,2);const row=list.reports.find(r=>r.runId==='group/run')!;const detail=await repo.detail(row.id);assert.equal(detail.measurementCount,null);assert.equal(detail.hasVerificationData,false);assert.equal(detail.actualModel,'미확인');assert.equal(detail.requestedModel,'requested-only');assert.equal(detail.purpose,'검사 목적');assert(list.reports.some(r=>r.hasReadError));await assert.rejects(()=>repo.detail('../../etc/passwd'));}));
test('viewer rejects symlink escapes, traversal, non-PNG evidence and changed image hashes without remote access',async()=>fixture(async root=>{const outside=await mkdtemp(join(tmpdir(),'viewer-outside-'));try{await writeFile(join(outside,'private.png'),png);await symlink(outside,join(root,'external'));const evidence={evidenceId:'image1',kind:'screenshot',relativePath:'image.png',absolutePath:join(outside,'private.png'),sha256:createHash('sha256').update(png).digest('hex')};const dir=await makeReport(root,'run',evidence);await symlink(join(outside,'private.png'),join(dir,'image.png'));const repo=new ReportRepository(root);let list=await repo.list();assert.equal(list.reports.length,1);const id=list.reports[0].id,imageId=createHash('sha256').update('image1').digest('hex');await assert.rejects(()=>repo.image(id,imageId),/폴더 밖/);await rm(join(dir,'image.png'));await writeFile(join(dir,'image.png'),png);assert.deepEqual(await repo.image(id,imageId),png);await writeFile(join(dir,'image.png'),'<svg onload="alert(1)"/>');await assert.rejects(()=>repo.image(id,imageId),/PNG/);await writeFile(join(dir,'report.json'),JSON.stringify({evidence:[{...evidence,relativePath:'../private.png'}]}));await assert.rejects(()=>repo.image(id,imageId),/경로/);}finally{await rm(outside,{recursive:true,force:true});}}));
test('viewer HTTP API is read-only and rejects cross-origin, rebinding hosts and arbitrary files',async()=>fixture(async root=>{await makeReport(root,'run');const server=createViewerServer(new ReportRepository(root),root);await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve));const addr=server.address();assert(addr&&typeof addr!=='string');const url=`http://127.0.0.1:${addr.port}`;try{const good=await fetch(url+'/api/reports');assert.equal(good.status,200);assert.match(good.headers.get('content-security-policy')! ,/object-src 'none'/);assert.equal((await fetch(url+'/api/reports',{headers:{Origin:'https://evil.example'}})).status,403);assert.equal(await new Promise<number>(resolve=>{const req=httpRequest(url+'/api/reports',{headers:{Host:'evil.example'}},res=>{res.resume();resolve(res.statusCode!);});req.end();}),403);assert.equal((await fetch(url+'/api/reports',{method:'POST'})).status,405);assert.equal((await fetch(url+'/api/reports',{headers:{'Sec-Fetch-Site':'cross-site'}})).status,403);assert.equal((await fetch(url+'/report.json')).status,404);assert.equal((await fetch(url+'/api/reports/..%2F..%2Fsecret')).status,404);}finally{server.closeAllConnections();await new Promise<void>(resolve=>server.close(()=>resolve()));}}));

test('viewer exposes recorded integer measurement values without guessing absent totals',async()=>fixture(async root=>{const dir=await makeReport(root,'measured');await writeFile(join(dir,'report.json'),JSON.stringify({verifications:[{measurements:{currency:'KRW',displayedTotalMinor:'54000',computedTotalMinor:'48000',differenceMinor:'6000',bindings:[{targetRef:'e23',valueText:'54,000원'}]},beforeObservationId:'obs-002',afterObservationId:'obs-003'},{}]}));const repo=new ReportRepository(root);const list=await repo.list();const detail=await repo.detail(list.reports[0].id);assert.equal(detail.measurements[0].recordedValues?.[2].value,'6,000원');assert.match(detail.measurements[0].measurementJson!,/e23/);assert.equal(detail.measurements[0].beforeObservationId,'obs-002');assert.deepEqual(detail.measurements[1].recordedValues,[]);}));

test('viewer metadata uses recorded page and visible heading labels, with shared list/detail normalization',async()=>fixture(async root=>{
 const dir=await makeReport(root,'metadata');const report={runId:'metadata',targetUrl:'http://127.0.0.1:4183/checkout/?token=do-not-copy',observations:[{pageTitle:'물결 문구',elements:[{tag:'strong',text:'물결 문구',isVisible:true},{tag:'h1',text:'주문 확인',isVisible:true}]}]};await writeFile(join(dir,'report.json'),JSON.stringify(report));const repo=new ReportRepository(root);const first=(await repo.list()).reports[0];const detail=await repo.detail(first.id);
 for(const value of [first,detail]){assert.equal(value.serviceName,undefined);assert.equal(value.screenTitle,'주문 확인');assert.equal(value.urlPath,'/checkout/');assert.equal(value.isLocalTarget,true);assert.equal(value.metadataProvenance?.screenTitle,'visible-heading');assert.equal(value.metadataProvenance?.serviceName,undefined);}
 report.observations[0].elements[1].text='배송지 확인';await writeFile(join(dir,'report.json'),JSON.stringify(report));assert.equal((await repo.list()).reports[0].screenTitle,'배송지 확인','No stale metadata survives changed report content');
}));
test('metadata never guesses service brands, promotes sample recommendations or selects ambiguous headings',async()=>{
 const {observedReportMetadata}=await import('../viewer/server/report-metadata.js');
 const legacy=observedReportMetadata({suggested:{serviceName:'Made up',screenAlias:'AI example'}},'https://brand.example/orders?secret=x');assert.equal(legacy.serviceName,undefined);assert.equal(legacy.screenTitle,undefined);assert.equal(legacy.urlPath,'/orders');
 const d=observedReportMetadata({observations:[{pageTitle:'Report page',elements:[null,{}, {tag:'strong',text:'Report page',isVisible:false},{tag:'h1',text:'Hidden',isVisible:false},{tag:'h1',text:'First',isVisible:true},{tag:'h1',text:'Second',isVisible:true}]}]},'not a URL');assert.equal(d.pageTitle,'Report page');assert.equal(d.serviceName,undefined);assert.equal(d.screenTitle,undefined);assert.equal(d.urlPath,undefined);
 const sameLabel=observedReportMetadata({observations:[{pageTitle:'주문 확인',elements:[{tag:'strong',text:'주문 확인',isVisible:true}]}]},'https://example.com/');assert.equal(sameLabel.serviceName,undefined,'A bold page label is not a service identity');
 assert.doesNotThrow(()=>observedReportMetadata({observations:[false]},'https://example.com/'));
});

test('viewer uses the initial observation thumbnail and keeps capture conditions tied to their observations',async()=>fixture(async root=>{
 const dir=await makeReport(root,'captured');
 const screenshot=(evidenceId:string,observationId:string)=>({evidenceId,observationId,kind:'screenshot'});
 await writeFile(join(dir,'report.json'),JSON.stringify({
  targetUrl:'https://example.com/start?secret=hide#private',
  evidence:[screenshot('crop','first'),screenshot('initial','first'),screenshot('next','second')],
  observations:[
   {observationId:'first',url:'https://example.com/result?secret=hide#private',screenshotRefs:['initial'],captureStartedAt:'2026-11-12T00:00:00Z',viewport:{width:390,height:844,deviceScaleFactor:2},scrollOffset:{x:0,y:0},isStable:true},
   {observationId:'second',url:'javascript:alert(1)',viewport:{width:0,height:844},scrollOffset:{x:0,y:124},isStable:false},
   null,
  ],
 }));
 const repo=new ReportRepository(root), row=(await repo.list()).reports[0];
 const detail=await repo.detail(row.id);
 assert.equal(row.thumbnailUrl,detail.images[1].url);
 assert.equal(detail.requestedUrl,'https://example.com/start');
 assert.deepEqual(detail.captures,[
  {observationId:'first',observedUrl:'https://example.com/result',capturedAt:'2026-11-12T00:00:00Z',viewport:{width:390,height:844,deviceScaleFactor:2},scrollOffset:{x:0,y:0},isStable:true},
  {observationId:'second',scrollOffset:{x:0,y:124},isStable:false},
 ]);
}));

test('viewer retains bounded spacing measurements without dropping legacy alignment',()=>{
 const bounds={x:10,y:20,width:40,height:30};
 const spacing={inspectedPairs:1,inspectedCards:0,isLimited:true,checks:[
  {kind:'control-gap',bounds,targetBounds:[bounds,{...bounds,x:50}],observed:0,threshold:2,axis:'row'},
 ]};
 const previous={evidenceId:'obs-001-rules',alignment:{tolerance:1,checks:[]}};
 const observation={observationId:'obs-001',deterministicChecks:{...previous,spacing}};
 assert.deepEqual(recordedCapture(observation)?.deterministicChecks,observation.deterministicChecks);
 assert.deepEqual(recordedCapture({...observation,deterministicChecks:previous})?.deterministicChecks,previous);
 const corrupted={...spacing,checks:[{...spacing.checks[0],observed:-1}]};
 assert.deepEqual(recordedCapture({deterministicChecks:{...previous,spacing:corrupted}})?.deterministicChecks,previous);
});

test('viewer projects URL layout evidence into the matching screenshot crop and grounds focus in finding refs',async()=>fixture(async root=>{
 const dir=await makeReport(root,'layout');
 const screenshot=(evidenceId:string,observationId:string,x:number,y:number)=>({
  evidenceId,observationId,kind:'screenshot',
  screenshot:{coordinateSpace:'viewport-css-pixels',clip:{x,y,width:100,height:100},deviceScaleFactor:2},
 });
 const element=(elementRef:string,x:number,y:number,width:number,height:number,isVisible=true)=>({
  elementRef,boundingBox:{x,y,width,height},isVisible,
 });
 const section=(label:string,...elementRefs:string[])=>({label,elementRefs});
 const finding=(issueId:string,disposition:string,observationId:string,elementRefs:string[],hasMaskedContentDependency=false)=>({
  issueId,disposition,visualEvidence:[{observationId,elementRefs,hasMaskedContentDependency}],
 });
 await writeFile(join(dir,'report.json'),JSON.stringify({
  targetUrl:'https://example.com/',
  evidence:[screenshot('crop','first',20,30),screenshot('other','second',0,0)],
  observations:[
   {observationId:'first',isStable:true,elements:[
    element('heading',0,10,40,45),element('target',80,80,20,30),
    element('outside-top',60,0,20,20),element('outside-bottom',60,140,20,20),element('hidden',75,70,10,10,false),
   ]},
   {observationId:'second',isStable:true,elements:[element('target',10,20,30,40)]},
  ],
  evaluation:{
   screenMap:[
    {observationId:'first',sections:[
     section('본문','heading','target'),section('잘린 제목','heading'),
     section('화면 밖','outside-top','outside-bottom'),section('숨김','hidden'),section('미확인','missing'),
    ]},
    {observationId:'second',sections:[section('다음 화면','target')]},
   ],
   findings:[
    finding('dismissed','dismissed','first',['heading']),
    finding('masked','confirmed','first',['heading'],true),
    finding('target-finding','needs-verification','first',['target']),
    {...finding('no-target','confirmed','first',[]),evidenceIds:['crop']},
    finding('other-finding','confirmed','second',['target']),
   ],
  },
 }));
 const repo=new ReportRepository(root);
 const detail=await repo.detail((await repo.list()).reports[0].id);
 assert.deepEqual(detail.images[0].layout,{
  imageSize:{width:200,height:200,deviceScaleFactor:2},
  regions:[{label:'본문',bounds:{x:0,y:0,width:.8,height:.8}},{label:'잘린 제목',bounds:{x:0,y:0,width:.2,height:.25}}],
  focusAreas:[{findingId:'target-finding',bounds:{x:.6,y:.5,width:.2,height:.3}}],
 });
 assert.deepEqual(detail.images[1].layout?.regions,[{label:'다음 화면',bounds:{x:.1,y:.2,width:.3,height:.4}}]);
 assert.deepEqual(detail.images[1].layout?.focusAreas,[{findingId:'other-finding',bounds:{x:.1,y:.2,width:.3,height:.4}}]);
}));

test('viewer omits layout overlays when a capture lacks reliable URL geometry or an evaluation map',async()=>{
 const {projectReportImageLayout}=await import('../viewer/server/report-layout.js');
 const observation={
  observationId:'one',isStable:true,
  elements:[{elementRef:'e0',boundingBox:{x:0,y:0,width:20,height:20}}],
 };
 const report={observations:[observation],evaluation:{screenMap:[{observationId:'one',sections:[{label:'제목',elementRefs:['e0']}]}]}};
 const screenshot={coordinateSpace:'viewport-css-pixels',clip:{x:0,y:0,width:100,height:200},deviceScaleFactor:1};
 const evidence={observationId:'one',screenshot};
 assert.equal(projectReportImageLayout(report,{observationId:'one'}),undefined);
 assert.equal(projectReportImageLayout(report,{...evidence,screenshot:{...screenshot,coordinateSpace:'image-pixels'}}),undefined);
 assert.equal(projectReportImageLayout(report,{...evidence,screenshot:{...screenshot,deviceScaleFactor:0}}),undefined);
 assert.equal(projectReportImageLayout({...report,evaluation:{}},evidence),undefined);
 assert.equal(projectReportImageLayout({...report,imageSource:{kind:'image'}},evidence),undefined);
 assert.equal(projectReportImageLayout({...report,observations:[{...observation,isStable:false}]},evidence),undefined);
});

test('viewer serves image estimates only on their original capture and links focus to accepted findings',async()=>fixture(async root=>{
 const dir=await makeReport(root,'image-layout');
 const source={kind:'image',fileName:'booking.webp',width:390,height:844};
 const observationId='obs-001',evidenceId='obs-001-screenshot';
 const screenshot={coordinateSpace:'image-pixels',clip:{x:0,y:0,width:390,height:844},deviceScaleFactor:1};
 const original={kind:'screenshot',observationId,evidenceId,screenshot};
 const wrongEvidence={...original,evidenceId:'other'};
 const finding=(issueId:string,disposition='confirmed',evidenceIds=[evidenceId])=>({issueId,disposition,evidenceIds,observationIds:[observationId]});
 const bounds={x:.1,y:.2,width:.7,height:.4};
 const layout={observationId,evidenceId,regions:[
  {label:' 예약 본문 ',bounds},
  {label:'캡처 밖',bounds:{...bounds,width:.95}},
  {label:'너비 없음',bounds:{...bounds,width:0}},
 ],focusAreas:[
  {findingId:'booking',bounds},
  {findingId:'dismissed',bounds},
  {findingId:'different-capture',bounds},
  {findingId:'unknown',bounds},
 ]};
 const report={imageSource:source,observations:[{observationId,source,isStable:false,screenshotRefs:[evidenceId]}],
  evidence:[original,wrongEvidence],evaluation:{imageLayouts:[layout],findings:[finding('booking'),finding('dismissed','dismissed'),finding('different-capture','confirmed',['other'])]}};
 const path=join(dir,'report.json');
 await writeFile(path,JSON.stringify(report));
 const repo=new ReportRepository(root);
 const id=(await repo.list()).reports[0].id;
 const detail=await repo.detail(id);
 assert.deepEqual(detail.images[0].layout,{
  imageSize:{width:390,height:844,deviceScaleFactor:1},isEstimated:true,
  regions:[{label:'예약 본문',bounds}],focusAreas:[{findingId:'booking',bounds}],
 });
 assert.equal(detail.images[1].layout,undefined);

 const {projectReportImageLayout}=await import('../viewer/server/report-layout.js');
 assert.equal(projectReportImageLayout(report,{...original,observationId:'other'}),undefined);
 assert.equal(projectReportImageLayout(report,{...original,screenshot:{...screenshot,clip:{...screenshot.clip,x:1}}}),undefined);
 assert.equal(projectReportImageLayout(report,{...original,screenshot:{...screenshot,clip:{...screenshot.clip,width:389}}}),undefined);
 assert.equal(projectReportImageLayout({...report,focusedReview:{}},original),undefined);
 assert.equal(projectReportImageLayout({...report,evaluation:{}},original),undefined);
 assert.equal(projectReportImageLayout({...report,evaluation:{...report.evaluation,imageLayouts:[layout,{...layout,observationId:'other'}]}},original),undefined);

 const focusOnly={...layout,regions:[]};
 const withLayout=(imageLayout:typeof layout)=>({...report,evaluation:{...report.evaluation,imageLayouts:[imageLayout]}});
 assert.deepEqual(projectReportImageLayout(withLayout(focusOnly),original)?.focusAreas,[{findingId:'booking',bounds}]);
 assert.equal(projectReportImageLayout(withLayout({...focusOnly,focusAreas:[...focusOnly.focusAreas,{findingId:'booking',bounds}]}),original),undefined);
}));

test('viewer keeps advisory suggestions separate from counts and supports legacy absence',async()=>fixture(async root=>{
 const dir=await makeReport(root,'advisory');const path=join(dir,'report.json');
 const record={findings:[],verificationCandidates:[],evaluation:{findings:[]},suggestions:[{suggestionId:'s1',title:'구조 검토',observation:'관찰',rationale:'이유',possibleImpact:'추정',uncertainty:'동작 미확인',recommendation:'검토',evidenceIds:['e1'],observationIds:['o1']}]};
 await writeFile(path,JSON.stringify(record));const repo=new ReportRepository(root);const row=(await repo.list()).reports[0];const detail=await repo.detail(row.id);
 assert.equal(row.initialCount,0);assert.equal(detail.findings.length,0);assert.equal(detail.suggestions?.length,1);assert.equal(detail.suggestions?.[0].uncertainty,'동작 미확인');
 await writeFile(path,JSON.stringify({findings:[]}));assert.deepEqual((await repo.detail(row.id)).suggestions,[]);
}));

test('viewer restores the suggestions route on reload or history navigation',async()=>{const {reportRoute}=await import('../viewer/app/route.js');assert.deepEqual(reportRoute('?report=example&tab=suggestions'),{id:'example',tab:'suggestions'});assert.equal(reportRoute('?tab=unknown').tab,'summary');});

test('viewer distinguishes failed AI evaluation from valid zero findings, validation partial and legacy reports',async()=>fixture(async root=>{
 const records=[
  {name:'timeout',status:'partial',evaluation:{status:'failed',findings:[],limitations:['OpenAI-compatible API evaluation timed out. No AI review was completed.']}},
  {name:'zero',status:'completed',evaluation:{status:'completed',findings:[],limitations:[]}},
  {name:'validation',status:'partial',evaluation:{status:'partial',findings:[],limitations:['Rejected finding: invalid claim/source reference.']}},
  {name:'capture-partial',status:'partial',evaluation:{status:'completed',findings:[],limitations:[]}},
  {name:'legacy',status:'partial',findings:[],limitations:['Evaluation incomplete']},
  {name:'not-run',status:'failed',evaluation:{status:'failed',findings:[],limitations:['Evaluation did not run.']}},
 ];
 for(const record of records){const dir=await makeReport(root,record.name);await writeFile(join(dir,'report.json'),JSON.stringify({runId:record.name,...record}));}
 const repo=new ReportRepository(root),list=await repo.list();
 for(const summary of list.reports){const detail=await repo.detail(summary.id);assert.deepEqual(detail.evaluation,summary.evaluation);assert.equal(detail.initialCount,summary.initialCount);}
 const byName=Object.fromEntries(list.reports.map(row=>[row.runId,row]));
 assert.equal(byName.timeout.evaluation?.status,'failed');assert.equal(byName.timeout.initialCount,null);assert.match(byName.timeout.evaluation!.reason!,/응답 시간이 초과/);
 assert.equal(byName.zero.evaluation?.status,'completed');assert.equal(byName.zero.initialCount,0);
 assert.equal(byName.validation.evaluation?.status,'partial');assert.equal(byName.validation.initialCount,0);assert.match(byName.validation.evaluation!.reason!,/근거 검증/);
 assert.equal(byName['capture-partial'].evaluation?.status,'completed');assert.equal(byName['capture-partial'].initialCount,0);
 assert.equal(byName.legacy.evaluation,undefined);assert.equal(byName.legacy.initialCount,0);
 assert.match(byName['not-run'].evaluation!.reason!,/실행되지 않았습니다/);
}));

test('viewer exposes only supported reasons for a partially completed review',async()=>fixture(async root=>{
 const wait={status:'partial',reasonCode:'wait-limit',maxWaitMs:1500};
 const failedEvaluation={status:'failed',failureCode:'timeout'};
 const oldWait={
  status:'partial',reason:'준비 완료를 확인하지 못했습니다. 로딩, 준비 조건 및 관찰 범위를 확인해야 합니다.',
  modalExploration:{status:'not-needed'},blockedRequests:[],
 };
 const cancelledEvaluation={
  status:'failed',limitations:['OpenAI-compatible API evaluation cancelled.'],
  calls:[{stage:'A-discovery',status:'failed',endedAt:'2026-11-17T00:00:01.508Z'}],
 };
 const records=[
  {name:'both',stateDiscovery:wait,evaluation:failedEvaluation},
  {name:'wait',stateDiscovery:wait,evaluation:{status:'completed'}},
  {name:'prior-wait',stateDiscovery:oldWait,observations:[
   {captureEndedAt:'2026-11-17T00:00:00.000Z'},{captureStartedAt:'2026-11-17T00:00:01.507Z'},
  ]},
  {name:'unknown',stateDiscovery:oldWait,evaluation:cancelledEvaluation},
  {name:'prior-timeout',evaluation:cancelledEvaluation,terminationReason:'Automatic inspection time limit reached',endedAt:'2026-11-17T00:00:01.512Z'},
  {name:'unrelated-timeout',evaluation:cancelledEvaluation,terminationReason:'Automatic inspection time limit reached',endedAt:'2026-11-17T00:00:04.000Z'},
 ];
 for(const {name,...record} of records){
  const dir=await makeReport(root,name);
  await writeFile(join(dir,'report.json'),JSON.stringify({runId:name,status:'partial',...record}));
  if(name==='prior-wait')await writeFile(join(dir,'manifest.json'),JSON.stringify({spec:{stateDiscovery:{maxWaitMs:1500}}}));
 }
 const repo=new ReportRepository(root),list=await repo.list();
 const byName=Object.fromEntries(list.reports.map(row=>[row.runId,row]));
 const {reportPartialCauseLabels}=await import('../viewer/features/reports/presentation.js');
 assert.deepEqual(reportPartialCauseLabels(byName.both),['화면 준비 대기 한도','AI 평가 시간 초과']);
 assert.deepEqual(reportPartialCauseLabels(await repo.detail(byName.both.id)),['화면 준비 대기 한도','AI 평가 시간 초과']);
 assert.deepEqual(byName.wait.stateDiscoveryWait,{maxWaitMs:1500});
 assert.deepEqual(reportPartialCauseLabels(byName.wait),['화면 준비 대기 한도']);
 assert.equal(byName['prior-wait'].stateDiscoveryWait,undefined);
 assert.deepEqual((await repo.detail(byName['prior-wait'].id)).stateDiscoveryWait,{maxWaitMs:1500});
 assert.deepEqual(reportPartialCauseLabels(await repo.detail(byName.unknown.id)),[]);
 assert.deepEqual(reportPartialCauseLabels(byName['prior-timeout']),['AI 평가 시간 초과']);
 assert.deepEqual(reportPartialCauseLabels(byName['unrelated-timeout']),[]);
}));

test('viewer preserves state-specific capture labels and partial discovery independently of evaluation',async()=>fixture(async root=>{
 const dir=await makeReport(root,'state-captures');
 await writeFile(join(dir,'report.json'),JSON.stringify({runId:'state-captures',status:'partial',targetUrl:'https://example.com/',evaluation:{status:'completed',findings:[]},stateDiscovery:{status:'partial',reason:'Data request was blocked by the read-only policy',dismissalCount:1},evidence:[{kind:'screenshot',evidenceId:'loading',observationId:'first'},{kind:'screenshot',evidenceId:'blocked',observationId:'second'}],observations:[{observationId:'first',state:{label:'최초 로딩',readiness:'loading',reason:'Visible spinner'},isStable:true},{observationId:'second',state:{label:'팝업 닫은 뒤',readiness:'blocked',reason:'Data request blocked'},isStable:true}]}));
 const repo=new ReportRepository(root),row=(await repo.list()).reports[0],detail=await repo.detail(row.id);
 assert.equal(detail.evaluation?.status,'completed');assert.equal(detail.stateDiscovery?.status,'partial');assert.equal(detail.stateDiscovery?.dismissalCount,1);
 assert.deepEqual(detail.images.map(image=>image.label),['최초 로딩','팝업 닫은 뒤']);
 assert.equal(detail.captures?.[0].state?.readiness,'loading');assert.equal(detail.captures?.[1].state?.readiness,'blocked');
 assert.equal(detail.captures?.[1].isStable,true,'Capture stability does not imply loaded data');
}));

test('viewer keeps modal retry history distinct from partial data readiness and preserves legacy absence',async()=>fixture(async root=>{
 const dir=await makeReport(root,'modal-history');
 const modalExploration={status:'completed',attempts:2,actionCount:3,reason:'Recovered original URL and entered after another test choice',history:[{actionId:'a1',attempt:1,method:'continue',buttonLabel:'Start',outcome:'rejected',hasModalDismissed:null,hasRedirected:true,beforeObservationId:'obs-1',afterObservationId:'obs-2'},{actionId:'a2',attempt:2,method:'preference',buttonLabel:'Both',outcome:'success',hasModalDismissed:false,hasRedirected:false,beforeObservationId:'obs-3',afterObservationId:'obs-4'}]};
 await writeFile(join(dir,'report.json'),JSON.stringify({status:'partial',stateDiscovery:{status:'partial',reason:'Blocked analytics purpose unknown',dismissalCount:0,modalExploration}}));
 const repo=new ReportRepository(root),row=(await repo.list()).reports[0],detail=await repo.detail(row.id);
 assert.equal(detail.stateDiscovery?.status,'partial');assert.equal(detail.stateDiscovery?.modalExploration?.status,'completed');assert.equal(detail.stateDiscovery?.modalExploration?.history[0].hasRedirected,true);assert.equal(detail.stateDiscovery?.modalExploration?.history[1].buttonLabel,'Both');assert.equal(detail.stateDiscovery?.modalExploration?.history[0].hasModalDismissed,null);
 await writeFile(join(dir,'report.json'),JSON.stringify({stateDiscovery:{status:'partial',reason:'Legacy report'}}));
 assert.equal((await repo.detail(row.id)).stateDiscovery?.modalExploration,undefined);
}));

test('list scope and trash both apply before the visible limit, and purged reports return 404',async()=>fixture(async root=>{
 const visibleDir=await makeReport(root,'visible');
 const repository=new ReportRepository(root);
 const [visible]=(await repository.list()).reports;
 const trashed=new Set<string>();
 for(let offset=0;offset<1000;offset+=50){
  await Promise.all(Array.from({length:50},async(_,index)=>{
   const name='trashed-'+(offset+index);
   await makeReport(root,name);
   trashed.add(createHash('sha256').update(join(name,'report.json')).digest('hex'));
  }));
 }
 const scoped=await repository.list(id=>id===visible.id);
 assert.equal(scoped.hasMore,false);
 assert.deepEqual(scoped.reports.map(report=>report.id),[visible.id]);

 repository.setTrashedReportIdsLookup(()=>trashed);
 const list=await repository.list();
 assert.equal(list.hasMore,false);
 assert.deepEqual(list.reports.map(report=>report.id),[visible.id]);

 await rm(visibleDir,{recursive:true});
 await assert.rejects(repository.detail(visible.id),{status:404});
}));
