import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,rm,utimes} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {resolve} from 'node:path';
import {randomUUID,createHash} from 'node:crypto';
import {once} from 'node:events';
import {chromium,type Page} from 'playwright';
import sharp from 'sharp';
import {createServer as createViteServer} from 'vite';
import {ReviewService} from '../src/review-service.js';
import {ReportRepository} from '../viewer/server/repository.js';
import {createViewerServer} from '../viewer/server/http.js';
import type {inspect} from '../src/core.js';

async function openWorkspaceAction(page:Page,menu:string,action:string){
 await page.getByRole('button',{name:menu,exact:true}).click();
 await page.getByRole('menuitem',{name:action,exact:true}).click();
}

test('workspace browser binds searches to immutable reports, accepts sequential commands, and opens unlinked reports',async()=>{
 const longReportTitle=`필터와 목록 확인 ${'UnbrokenReviewTitle'.repeat(10)} 제목 끝`;
 const root=await mkdtemp(resolve(tmpdir(),'workspace-ui-'));let release:()=>void=()=>{};let shouldHold=false;const seen:Parameters<typeof inspect>[0][]=[];
 const service=new ReviewService(root,{inspect:(async(spec,out)=>{
  seen.push(spec);if(shouldHold)await new Promise<void>(done=>{release=done;});
  const runId=randomUUID(),runDir=resolve(out,runId);await mkdir(runDir,{recursive:true});
  const bytes=await sharp(Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="800" height="500"><rect width="800" height="500" fill="#f4f4f5"/><text x="40" y="65" font-size="28">Synthetic catalog fixture</text><rect x="40" y="100" width="720" height="60" fill="white"/><text x="60" y="138" font-size="20">Category: All / Latest</text><rect x="40" y="190" width="220" height="260" fill="#ddd"/><rect x="290" y="190" width="220" height="260" fill="#ddd"/></svg>')).png().toBuffer();await writeFile(resolve(runDir,'screen.png'),bytes);
  const now=new Date().toISOString(),evidence={kind:'screenshot',evidenceId:'screen',observationId:'obs1',relativePath:'screen.png',sha256:createHash('sha256').update(bytes).digest('hex')};
  const followup=spec.followup?{requestId:spec.followup.requestId,workspaceId:spec.followup.workspaceId,status:'partial',reason:'합성 후속 검증의 확인 범위',restoration:{status:'replayed',reason:'합성 상태'},history:[],replay:[],scopeDescription:'필터와 결과 목록',needsImageHandoff:false}:undefined;
  const baseObservation={...(spec.imagePath?{source:{kind:'image',fileName:'synthetic.png',width:800,height:500}}:{}),observationId:'obs1',pageTitle:'Synthetic catalog',url:spec.targetUrl,state:{label:'합성 상품 목록',readiness:'ready',reason:'합성 검증 자료'},evidenceRefs:[evidence]};
  const secondEvidence={...evidence,evidenceId:'dark-screen',observationId:'obs2'};
  const hasResultsFixture=spec.targetUrl==='https://example.test/?scope=all#catalog'&&!spec.followup;
  const chip=(x:number,visualHeight:number,hitHeight:number,visualSource:'element'|'before')=>({visualSource,hitBox:{x,y:20,width:80,height:hitHeight},visualBox:{x,y:20+(hitHeight-visualHeight)/2,width:80,height:visualHeight}});
  const darkRegion={role:'region',bounds:{x:0,y:80,width:400,height:420},background:'#0f172b'};
  const contrastViolation={status:'violation',observedRatio:1.12,expectedRatio:4.5,foreground:'#1c2633',background:darkRegion.background,target:{tag:'h2',bounds:{x:16,y:238,width:140,height:24}}};
  const observations=spec.themeReview?[
   {...baseObservation,theme:{requested:'light',status:'verified',reason:'라이트 테마 적용'},deterministicChecks:{evidenceId:'light-rules',contrast:{status:'passed',passed:2,violations:0,incomplete:0}}},
   {...baseObservation,observationId:'obs2',evidenceRefs:[secondEvidence],theme:{requested:'dark',status:'verified',scope:'region',regions:[darkRegion],reason:'다크 테마 영역 적용'},deterministicChecks:{evidenceId:'dark-rules',contrast:{status:'violation',source:'visible-text',passed:1,violations:1,incomplete:1,examples:[contrastViolation,{status:'incomplete',expectedRatio:4.5}]},alignment:{tolerance:1,checks:[{status:'candidate',groupIndex:1,axis:'row',line:1,members:[chip(20,36,36,'element'),chip(120,28,40,'before')],differences:[{kind:'cross-size',spread:8}]},{status:'unverified',groupIndex:null,contractIndex:1,reason:'group-not-found',members:[],differences:[]}]}}},
  ]:hasResultsFixture?[baseObservation,{...baseObservation,observationId:'obs2',evidenceRefs:[secondEvidence]}]:[baseObservation];
  const findings=[
   {
    issueId:'fixture-issue',title:spec.followup?'필터 후 합성 문제':'원본 합성 문제',
    disposition:'confirmed',severity:'major',category:'layout',
    observedFacts:[{text:'상품 검색 안내가 목록 상단에 가려집니다.'}],
    observationIds:['obs1'],evidenceIds:['screen'],userImpact:'합성 검증',recommendation:'합성 제안',
   },
   {issueId:'fixture-filter-controls',title:'카테고리와 정렬 필터의 버튼 상태를 한눈에 구분하기 어려움',disposition:'needs-verification'},
   {issueId:'fixture-catalog-details',title:'상품 목록의 카드 제목과 가격 사이 안쪽 여백이 부족함',disposition:'confirmed',severity:'minor',category:'layout'},
  ];
  const evaluation=spec.imagePath&&!spec.followup
   ?{status:'failed',failureCode:'timeout',findings:[],limitations:['OpenAI-compatible API evaluation timed out. No AI review was completed.']}
   :hasResultsFixture?{status:'completed',findings,verificationSelections:[{
    candidateId:'fixture-filter-controls',recipe:'focus',origin:'automatic',status:'skipped',
    reason:'두 선택 상태의 조작 순서가 기록되지 않았습니다.',
   }]}:undefined;
  const resultsFixture=hasResultsFixture?{
   suggestions:[{
    suggestionId:'fixture-suggestion',title:'상품 가격과 이름을 한 줄에 표시',
    observation:'카드의 상품 가격과 이름이 서로 다른 줄에 배치됩니다.',
    rationale:'상품 선택 전에 두 정보를 함께 확인할 수 있습니다.',possibleImpact:'상품 목록을 더 빠르게 훑을 수 있습니다.',
    uncertainty:'실제 탐색 시간은 측정하지 않았습니다.',recommendation:'가격을 제목 옆에 두는 배치를 비교해 보세요.',
    evidenceIds:['dark-screen'],observationIds:['obs2'],
   }],
   verifications:[
    {
     verificationId:'fixture-measurement',request:{candidateId:'fixture-issue',recipe:'occlusion'},outcome:'reproduced',
     condition:'목록 상단에서 안내 문구의 가림 여부를 확인합니다.',summary:'안내 문구의 오른쪽 끝이 가려졌습니다.',
     evidenceIds:['screen'],beforeObservationId:'obs1',hasMeasured:true,
     limitations:['표본 지점의 검사 결과입니다.'],measurements:{samplePoints:2},
    },
    {
     verificationId:'fixture-unlinked-measurement',request:{recipe:'focus'},outcome:'inconclusive',
     condition:'연결 대상이 없는 이전 검사 기록입니다.',summary:'이전 보고서의 단독 측정값입니다.',evidenceIds:['screen'],
    },
   ],
  }:{};
  const result={
   ...resultsFixture,...(followup?{followup}:{}),...(evaluation?{evaluation}:{}),
   runId,status:'partial',startedAt:now,endedAt:now,targetUrl:spec.targetUrl,observations,
   evidence:spec.themeReview||hasResultsFixture?[evidence,secondEvidence]:[evidence],
   findings:evaluation?.status==='failed'?[]:findings,limitations:['합성 검토이며 실제 사이트 결과가 아닙니다.'],
   coverage:{canFinish:false,unmetChecks:[{reason:'합성 검사'}]},
  };
  await writeFile(resolve(runDir,'manifest.json'),JSON.stringify({spec}));await writeFile(resolve(runDir,'report.json'),JSON.stringify(result));return{result,runDir};}) as typeof inspect,
  inspectFocused:async()=>{throw new Error('Synthetic focused review fixture');},
 });
 await service.start();const project=await service.addProject({name:'합성 제품',description:'브라우저 검증용'});const workspace=await service.addWorkspace({projectId:project.projectId,name:'상품 목록',goal:longReportTitle});
 let lastWorkspace=workspace;
 for(let index=1;index<=20;index++)lastWorkspace=await service.addWorkspace({projectId:project.projectId,name:`상품 목록 변형 ${index}`,goal:'작업공간 탐색 검증'});
 await service.submitWorkspaceInitial(workspace.workspaceId,{submissionId:randomUUID(),target:{kind:'url',url:'https://example.test/?scope=all#catalog'}});
 let detail=await service.workspace(workspace.workspaceId);for(let i=0;i<100&&!detail.workspace.latestReportId;i++){await new Promise(done=>setTimeout(done,20));detail=await service.workspace(workspace.workspaceId);}
 assert.ok(detail.workspace.latestReportId);const reportId=detail.workspace.latestReportId;
 const vite=await createViteServer({configFile:resolve('viewer/vite.config.ts'),server:{middlewareMode:true,hmr:false,ws:false}});
 const server=createViewerServer(new ReportRepository(root),resolve('viewer'),service,vite.middlewares);server.listen(0,'127.0.0.1');await once(server,'listening');const base=`http://127.0.0.1:${(server.address() as {port:number}).port}`;
 const browser=await chromium.launch({ignoreDefaultArgs:['--hide-scrollbars'],args:['--disable-features=OverlayScrollbar']});const page=await browser.newPage({viewport:{width:1440,height:1000}});const errors:string[]=[];page.on('pageerror',error=>errors.push(error.message));
 try{
  await page.goto(base+`/?workspace=${workspace.workspaceId}`);await page.getByRole('heading',{name:'상품 목록',exact:true}).waitFor();
  const sidebar=page.getByRole('complementary',{name:'작업공간 목록',exact:true});
  const resizer=sidebar.getByRole('separator',{name:'작업공간 목록 너비'});
  const separatorBounds=await resizer.boundingBox();
  assert.ok(separatorBounds);
  const separatorCenter=separatorBounds.x+separatorBounds.width/2;
  await page.mouse.move(separatorCenter,separatorBounds.y+200);
  await page.mouse.down();
  await page.mouse.move(separatorCenter+75,separatorBounds.y+200);
  await page.mouse.up();
  assert.equal(await resizer.getAttribute('aria-valuenow'),'299');
  await resizer.press('Home');
  await sidebar.getByRole('button',{name:'작업공간 목록 열기',exact:true}).click();
  assert.equal(await resizer.getAttribute('aria-valuenow'),'299');
  await resizer.press('ArrowRight');
  assert.equal(await resizer.getAttribute('aria-valuenow'),'315');
  const workspaceSearch=sidebar.getByRole('searchbox',{name:'작업공간 이름 검색'});
  await workspaceSearch.fill('상품 목록');
  const sort=sidebar.getByRole('combobox',{name:'생성일 정렬'});
  await sort.click();
  await page.getByRole('option',{name:'오래된 생성순',exact:true}).click();
  const sidebarList=sidebar.getByRole('navigation',{name:'프로젝트의 작업공간'});
  const workspaceLink=sidebarList.getByRole('link',{name:lastWorkspace.name,exact:true});
  await workspaceLink.scrollIntoViewIfNeeded();
  const sidebarScroll=await sidebarList.evaluate(element=>element.scrollTop);
  assert.ok(sidebarScroll>0);
  const sidebarHandle=await sidebar.elementHandle();
  const workspaceHandle=await page.getByRole('heading',{name:'상품 목록',exact:true}).elementHandle();
  let releaseWorkspace:()=>void=()=>{};
  const workspaceGate=new Promise<void>(resolve=>{releaseWorkspace=resolve;});
  const workspacePath=base+'/api/review-workspaces/'+lastWorkspace.workspaceId;
  await page.route(workspacePath,async route=>{await workspaceGate;await route.continue();});
  try{
   await workspaceLink.click();
   await page.getByRole('status').filter({hasText:'작업공간을 불러오는 중입니다.'}).waitFor();
   assert.equal(await workspaceLink.getAttribute('aria-current'),'page');
   assert.equal(await workspaceHandle?.evaluate(element=>element.isConnected),false);
   assert.equal(await sidebarHandle?.evaluate(element=>element.isConnected),true);
   assert.equal(await sidebarList.evaluate(element=>element.scrollTop),sidebarScroll);
  }finally{releaseWorkspace();}
  await page.getByRole('heading',{name:lastWorkspace.name,exact:true}).waitFor();
  await page.unroute(workspacePath);
  await page.goBack();
  await page.getByRole('heading',{name:'상품 목록',exact:true}).waitFor();
  await page.goForward();
  await page.getByRole('heading',{name:lastWorkspace.name,exact:true}).waitFor();
  assert.equal(await sidebarHandle?.evaluate(element=>element.isConnected),true);
  assert.equal(await workspaceSearch.inputValue(),'상품 목록');
  assert.equal(await sort.innerText(),'오래된 생성순');
  assert.equal(await resizer.getAttribute('aria-valuenow'),'315');
  await page.goBack();
  await page.getByRole('heading',{name:'상품 목록',exact:true}).waitFor();
  await page.setViewportSize({width:320,height:740});
  const reviewTab=page.getByRole('tab',{name:'검토',exact:true});
  assert.equal(await reviewTab.evaluate(element=>{
   const tab=element.getBoundingClientRect();
   const list=element.closest('[role="tablist"]')!.getBoundingClientRect();
   return tab.left>=list.left&&tab.right<=list.right;
  }),true,'review tab is visible without scrolling on mobile');
  const mobileSidebarToggle=sidebar.getByRole('button',{name:'작업공간 목록',exact:true});
  await mobileSidebarToggle.click();
  assert.equal(await workspaceSearch.inputValue(),'상품 목록');
  await mobileSidebarToggle.click();
  await page.getByRole('combobox',{name:'보고서',exact:true}).click();
  const reportMenu=page.getByRole('listbox');
  const longReport=reportMenu.getByRole('option').filter({hasText:longReportTitle});
  const title=longReport.getByText(longReportTitle,{exact:true});
  const executionDate=longReport.getByText(/\d{4}년 \d{1,2}월 \d{1,2}일/);
  const menuBounds=await reportMenu.boundingBox();
  assert.ok(menuBounds&&menuBounds.x>=0&&menuBounds.x+menuBounds.width<=320);
  const titleBounds=await title.boundingBox(),dateBounds=await executionDate.boundingBox();
  assert.ok(titleBounds&&dateBounds&&dateBounds.y>=titleBounds.y+titleBounds.height);
  assert.ok(await title.evaluate(element=>{
   const range=document.createRange();
   const text=element.firstChild!;
   range.setStart(text,text.textContent!.length-1);
   range.setEnd(text,text.textContent!.length);
   const titleBox=element.getBoundingClientRect(),lastCharacter=range.getBoundingClientRect();
   return element.scrollWidth<=element.clientWidth&&element.scrollHeight<=element.clientHeight&&
    lastCharacter.bottom<=titleBox.bottom&&lastCharacter.right<=titleBox.right;
  }),'the mobile option displays even the end of its unbroken title without clipping');
  await page.keyboard.press('Escape');
  await reportMenu.waitFor({state:'hidden'});
  await page.setViewportSize({width:1440,height:1000});
  const openCapture=page.getByRole('button',{name:'캡처 이미지 크게 보기',exact:true});
  const imageViewer=page.getByRole('dialog',{name:'이미지 보기',exact:true});
  await openCapture.press('Enter');await imageViewer.waitFor();await page.keyboard.press('Escape');await imageViewer.waitFor({state:'hidden'});
  await page.waitForFunction(()=>document.activeElement?.classList.contains('workspace-capture-open'));
  await page.getByRole('button',{name:'영역 선택',exact:true}).click();
  assert.equal(await openCapture.count(),0);
  const image=page.locator('.workspace-capture-frame img');const bounds=await image.boundingBox();assert.ok(bounds);await page.mouse.move(bounds.x+30,bounds.y+30);await page.mouse.down();await page.mouse.move(bounds.x+200,bounds.y+150);await page.mouse.up();await page.locator('.workspace-selected-region').waitFor();
  assert.equal(await imageViewer.isVisible(),false);
  await page.getByRole('button',{name:'선택 영역 해제',exact:true}).click();await page.locator('.workspace-selected-region').waitFor({state:'hidden'});
  await page.mouse.move(bounds.x+40,bounds.y+40);await page.mouse.down();await page.mouse.move(bounds.x+180,bounds.y+120);await page.mouse.up();await page.locator('.workspace-selected-region').waitFor();
  const summaryTab=page.getByRole('tab',{name:'요약',exact:true});
  const queue=page.getByRole('region',{name:'검토 요청',exact:true});
  const queueRow=(instruction:string)=>queue.getByRole('listitem').filter({has:page.getByText(instruction,{exact:true})});
  const draft=page.getByRole('textbox',{name:/추가 지시/});
  const firstInstruction='기본 카테고리를 고른 뒤 목록을 확인해줘';
  const cancelledInstruction='정렬 영역도 확인해줘';
  const queuedInstruction='다른 검증이 끝나면 전체 목록을 확인해줘 '+'UnbrokenTarget'.repeat(12);
  shouldHold=true;
  await reviewTab.click();
  await draft.fill(firstInstruction);
  await page.getByRole('button',{name:'검증 요청',exact:true}).click();
  await queueRow(firstInstruction).getByText('검토 중',{exact:true}).waitFor();
  await summaryTab.click();
  await page.getByRole('button',{name:'요청과 검증 내역',exact:true}).click();
  await page.getByRole('region',{name:'요청과 검증 내역',exact:true}).getByText(firstInstruction,{exact:true}).waitFor();

  await page.reload();
  await reviewTab.click();
  await queueRow(firstInstruction).getByText('검토 중',{exact:true}).waitFor();
  const staleDetail=await service.workspace(workspace.workspaceId);
  const ownWorkspacePath=base+'/api/review-workspaces/'+workspace.workspaceId;
  await page.route(ownWorkspacePath,route=>route.fulfill({json:staleDetail}));
  try{
   const refreshed=page.waitForResponse(response=>response.url()===ownWorkspacePath);
   await draft.fill(queuedInstruction);
   await page.getByRole('button',{name:'대기에 추가',exact:true}).click();
   await refreshed;
   await queueRow(queuedInstruction).getByText('대기 중',{exact:true}).waitFor();
  }finally{
   await page.unroute(ownWorkspacePath);
  }
  detail=await service.workspace(workspace.workspaceId);
  const queued=detail.requests.at(-1)!;
  assert.equal(queued.parentReportId,reportId);
  assert.equal(queued.source?.targetUrl,'https://example.test/?scope=all#catalog');
  assert.equal(detail.requests.length,3);
  assert.ok(detail.requests[1].region);
  assert.ok(detail.requests[1].source?.image?.sha256);
  assert.ok(queued.executionBaseRequestId);
  const newRow=queueRow(queuedInstruction);
  await newRow.getByText('대기 중',{exact:true}).waitFor();
  const newRowHandle=await newRow.elementHandle();
  assert.ok(newRowHandle);
  release();
  await newRow.getByText('검토 중',{exact:true}).waitFor();
  assert.equal(await newRowHandle.evaluate(element=>element.isConnected),true);

  const nextInstruction='결과를 기다리는 동안 작성한 다음 지시';
  await draft.fill(nextInstruction);
  shouldHold=false;
  release();
  await newRow.getByText('일부 완료',{exact:true}).waitFor();
  assert.equal(await newRowHandle.evaluate(element=>element.isConnected),true);
  await page.setViewportSize({width:320,height:740});
  assert.equal(await newRow.evaluate(element=>element.scrollWidth<=element.clientWidth),true);
  await page.setViewportSize({width:1440,height:1000});
  assert.equal(await draft.inputValue(),nextInstruction);
  const resultId=(await service.workspace(workspace.workspaceId)).requests.at(-1)?.attempts.at(-1)?.reportId;
  assert.ok(resultId);
  const popupWaiting=page.waitForEvent('popup');
  await newRow.getByRole('link',{name:'결과 보기 (새 탭 열기)',exact:true}).click();
  const popup=await popupWaiting;
  await popup.getByRole('tab',{name:/^결과/,selected:true}).waitFor();
  assert.equal(new URL(popup.url()).searchParams.get('report'),resultId);
  await popup.close();
  assert.equal(await draft.inputValue(),nextInstruction);
  await page.getByRole('button',{name:'입력 지우기',exact:true}).click();
  await newRow.getByRole('link',{name:'결과 보기',exact:true}).click();
  await page.getByRole('tab',{name:/^결과/,selected:true}).waitFor();
  assert.equal(new URL(page.url()).searchParams.get('report'),resultId);

  await page.goto(base+`/?workspace=${workspace.workspaceId}&report=${reportId}&tab=compose`);
  const originalDraft='원본 근거를 유지한 추가 요청';
  await draft.fill(originalDraft);
  await summaryTab.click();
  await page.getByRole('heading',{name:/선택한 검증 결과/}).waitFor();
  await page.goBack();
  await page.getByRole('tab',{name:'검토',exact:true,selected:true}).waitFor();
  assert.equal(await draft.inputValue(),originalDraft);
  await page.getByRole('button',{name:'검증 요청',exact:true}).click();
  await queueRow(originalDraft).getByRole('link',{name:'결과 보기',exact:true}).waitFor();
  detail=await service.workspace(workspace.workspaceId);
  assert.equal(detail.requests.at(-1)?.parentReportId,reportId);
  await queueRow(originalDraft).getByRole('link',{name:'결과 보기',exact:true}).click();
  await summaryTab.click();
  await page.getByRole('tab',{name:'요약',exact:true,selected:true}).waitFor();
  await page.getByRole('heading',{name:/^현재 결과/}).waitFor();
  const resultsTab=page.getByRole('tab',{name:/^결과/});
  const resultList=page.getByRole('list',{name:'결과 목록',exact:true});
  const resultRow=(title:string)=>resultList.getByRole('button',{name:new RegExp(title)});
  await resultsTab.click();
  await resultRow('필터 후 합성 문제').waitFor();

  shouldHold=true;
  await reviewTab.click();
  const runningInstruction='새 검증이 진행되는 동안 대기 지시를 취소해줘';
  await draft.fill(runningInstruction);
  await page.getByRole('button',{name:'검증 요청',exact:true}).click();
  await queueRow(runningInstruction).getByText('검토 중',{exact:true}).waitFor();
  await draft.fill(cancelledInstruction);
  await page.getByRole('button',{name:'대기에 추가',exact:true}).click();
  await queueRow(cancelledInstruction).getByRole('button',{name:'대기 취소',exact:true}).click();
  await queueRow(cancelledInstruction).getByText('취소',{exact:true}).waitFor();
  shouldHold=false;
  release();
  await resultsTab.click();

  await openWorkspaceAction(page,'관리','프로젝트와 화면 소속 변경');
  const membership=page.getByRole('dialog',{name:'프로젝트와 화면 소속 변경',exact:true});
  const projectSelect=membership.getByRole('combobox',{name:'프로젝트',exact:true});
  await projectSelect.scrollIntoViewIfNeeded();
  const workspaceWidth=()=>page.locator('.review-workspace-main').evaluate(element=>element.getBoundingClientRect().width);
  const widthBeforeSelect=await workspaceWidth();
  await projectSelect.click();await page.getByRole('listbox').waitFor();
  assert.equal(await workspaceWidth(),widthBeforeSelect,'project selection preserves workspace width');
  await page.keyboard.press('Escape');await page.getByRole('listbox').waitFor({state:'hidden'});
  assert.equal(await workspaceWidth(),widthBeforeSelect);
  await page.keyboard.press('Escape');await membership.waitFor({state:'hidden'});
  await page.waitForFunction(()=>!document.body.hasAttribute('data-scroll-locked'));

  await page.screenshot({path:'/tmp/ui-workspace-implementation-desktop.png',fullPage:true});
  await page.setViewportSize({width:390,height:844});
  await page.screenshot({path:'/tmp/ui-workspace-implementation-mobile.png',fullPage:true});
  const mobileLayout=await resultList.evaluate(async list=>{
   await document.fonts.ready;
   await new Promise<void>(done=>requestAnimationFrame(()=>requestAnimationFrame(()=>done())));
   const {clientWidth,scrollWidth}=document.documentElement;
   return {hasPageOverflow:Math.max(scrollWidth,document.body.scrollWidth)>clientWidth,hasListOverflow:list.scrollWidth>list.clientWidth};
  });
  assert.deepEqual(mobileLayout,{hasPageOverflow:false,hasListOverflow:false});
  let releaseReport:()=>void=()=>{};const reportGate=new Promise<void>(done=>{releaseReport=done;}),detailPath=base+'/api/reports/'+reportId;
  await page.route(detailPath,async route=>{await reportGate;await route.continue();});
  await page.goto(base+`/?workspace=${workspace.workspaceId}&report=${reportId}`);await page.getByRole('heading',{name:'선택한 검증을 불러오는 중입니다.'}).waitFor();assert.equal(await page.getByRole('heading',{name:'첫 검토를 준비하세요'}).count(),0);releaseReport();await resultRow('원본 합성 문제').waitFor();await page.unroute(detailPath);
  const latestReportId=(await service.workspace(workspace.workspaceId)).workspace.latestReportId;
  assert.ok(latestReportId);
  assert.notEqual(latestReportId,reportId);
  const linkedHref=`/?workspace=${workspace.workspaceId}&report=${reportId}`;
  await page.goto(base+`${linkedHref}&tab=limits`);
  await page.getByRole('tab',{name:'범위와 한계',selected:true}).waitFor();

  await page.setViewportSize({width:1440,height:1000});
  await page.goto(base+`${linkedHref}&tab=findings`);
  await resultsTab.and(page.locator('[aria-selected="true"]')).waitFor();
  const resultsPanel=page.getByRole('tabpanel',{name:/^결과/});
  const observation=page.getByRole('region',{name:'관찰 화면',exact:true});
  const [observationBounds,panelBounds]=await Promise.all([observation.boundingBox(),resultsPanel.boundingBox()]);
  assert.ok(observationBounds&&panelBounds&&observationBounds.x+observationBounds.width<=panelBounds.x,'the capture stays left of the result panel');
  assert.equal(await resultList.getByRole('button').count(),4);
  const finding=resultRow('원본 합성 문제');
  await finding.getByText('상품 검색 안내가 목록 상단에 가려집니다.',{exact:true}).waitFor();
  await page.route(ownWorkspacePath,route=>route.fulfill({status:502,body:'Bad Gateway'}),{times:1});
  const detailAlert=page.getByRole('alert').filter({hasText:'요청을 처리하지 못했습니다.'});
  await detailAlert.waitFor();
  assert.equal(await finding.isVisible(),true);
  await detailAlert.waitFor({state:'hidden'});
  assert.equal(await finding.isVisible(),true);
  const typeFilter=resultsPanel.getByRole('combobox',{name:'유형',exact:true});
  await typeFilter.click();
  await page.getByRole('option',{name:'문제',exact:true}).click();
  assert.equal(await resultList.getByRole('button').count(),2);
  await page.setViewportSize({width:1440,height:420});
  const workspaceMain=page.locator('.review-workspace-main');
  const mainScroll=await workspaceMain.evaluate(element=>{
   element.scrollTop=56;
   return element.scrollTop;
  });
  assert.ok(mainScroll>0,'the desktop fixture can scroll the workspace main pane');
  const retainedPanel=await resultsPanel.elementHandle();
  await finding.press('Enter');
  const detailHeading=resultsPanel.getByRole('heading',{name:'원본 합성 문제',exact:true});
  await detailHeading.waitFor();
  assert.ok(await retainedPanel?.evaluate(element=>element.isConnected),'result detail replaces the contents of the existing panel');
  assert.ok(await detailHeading.evaluate(element=>element===document.activeElement));
  const inspection=resultsPanel.getByRole('button',{name:/^실제 검사/});
  await inspection.click();
  await resultsPanel.getByText('목록 상단에서 안내 문구의 가림 여부를 확인합니다.',{exact:true}).waitFor();
  assert.equal(await resultsPanel.getByText('연결 대상이 없는 이전 검사 기록입니다.',{exact:true}).count(),0);
  await workspaceMain.evaluate(element=>{element.scrollTop=0;});
  await resultsPanel.getByRole('button',{name:'목록으로',exact:true}).click();
  assert.equal(await typeFilter.innerText(),'문제');
  assert.ok(await finding.evaluate(element=>element===document.activeElement),'returning to the list focuses the row that opened the detail');
  assert.equal(await workspaceMain.evaluate(element=>element.scrollTop),mainScroll);
  await page.setViewportSize({width:1440,height:1000});
  await typeFilter.click();
  await page.getByRole('option',{name:'추가 확인',exact:true}).click();
  assert.equal(await resultList.getByRole('button').count(),1);
  await resultRow('카테고리와 정렬 필터').click();
  await resultsPanel.getByRole('button',{name:/^실제 검사/}).click();
  await resultsPanel.getByText('두 선택 상태의 조작 순서가 기록되지 않았습니다.',{exact:true}).waitFor();

  await page.setViewportSize({width:390,height:844});
  await page.goto(base+`${linkedHref}&tab=suggestions`);
  await typeFilter.waitFor();
  assert.equal(await typeFilter.innerText(),'개선 제안');
  const proposal=resultRow('상품 가격과 이름을 한 줄에 표시');
  await proposal.scrollIntoViewIfNeeded();
  const resultListScroll=await page.evaluate(()=>window.scrollY);
  await proposal.click();
  await resultsPanel.getByText('실제 탐색 시간은 측정하지 않았습니다.',{exact:false}).waitFor();
  const secondCapturePath=`/api/reports/${reportId}/images/${createHash('sha256').update('dark-screen').digest('hex')}`;
  await observation.locator(`img[src="${secondCapturePath}"]`).waitFor();
  assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth));
  await resultsPanel.getByRole('button',{name:'목록으로',exact:true}).click();
  assert.equal(await typeFilter.innerText(),'개선 제안');
  assert.ok(await proposal.evaluate(element=>element===document.activeElement));
  await page.waitForFunction(previousScroll=>Math.abs(window.scrollY-previousScroll)<=1,resultListScroll);
  await page.goto(base+`${linkedHref}&tab=measurements`);
  await page.getByRole('tab',{name:'범위와 한계',selected:true}).waitFor();
  await page.getByRole('region',{name:'회차 검사 이력',exact:true}).getByText('연결 대상이 없는 이전 검사 기록입니다.',{exact:true}).waitFor();

  const anotherProject=await service.addProject({name:'다른 합성 제품',description:'프로젝트 간 검색 검증용'});
  const anotherWorkspace=await service.addWorkspace({projectId:anotherProject.projectId,name:'과거 상품 목록',goal:'이전 검사 보관'});
  const repository=new ReportRepository(root);
  const fixtureTime=new Date('2020-01-01T00:00:00.000Z');
  for(let index=0;index<16;index++){
   const runId=`catalog-archive-${index}`;
   const folder=resolve(root,runId);
   const reportPath=resolve(folder,'report.json');
   const url=`https://example.test/archive/${index}`;
   await mkdir(folder);
   await writeFile(reportPath,JSON.stringify({
    runId,targetUrl:url,status:'partial',startedAt:fixtureTime.toISOString(),
    observations:[{pageTitle:`보관된 상품 목록 ${index}`,url}],
   }));
   const modifiedAt=new Date(fixtureTime.getTime()+index*1000);
   await utimes(reportPath,modifiedAt,modifiedAt);
   const archiveReportId=createHash('sha256').update(`${runId}/report.json`).digest('hex');
   const {workspace:{version}}=await service.workspace(anotherWorkspace.workspaceId);
   await service.attachWorkspaceReport(anotherWorkspace.workspaceId,{reportId:archiveReportId,expectedVersion:version},id=>repository.detail(id));
  }

  const archiveDir=resolve(root,'standalone');
  await mkdir(archiveDir);
  const archiveImage=await sharp({create:{width:400,height:240,channels:3,background:'white'}}).png().toBuffer();
  await writeFile(resolve(archiveDir,'screen.png'),archiveImage);
  const standaloneEvidence={kind:'screenshot',evidenceId:'standalone-screen',observationId:'standalone-observation',relativePath:'screen.png',sha256:createHash('sha256').update(archiveImage).digest('hex')};
  await writeFile(resolve(archiveDir,'report.json'),JSON.stringify({
   runId:'standalone',targetUrl:'https://example.test/archive/standalone',status:'partial',
   observations:[{observationId:'standalone-observation',pageTitle:'독립 보고서',url:'https://example.test/archive/standalone',evidenceRefs:[standaloneEvidence]}],
  }));
  const standaloneId=createHash('sha256').update('standalone/report.json').digest('hex');

  await page.setViewportSize({width:1440,height:1000});
  await page.goto(base+'/?view=projects');
  const openReportSearch=page.getByRole('link',{name:'보고서 검색',exact:true});
  await openReportSearch.waitFor();
  assert.equal(await page.getByRole('navigation',{name:'작업 공간',exact:true}).getByRole('link',{name:'전체 보고서',exact:true}).count(),0);
  await openReportSearch.press('Enter');
  const searchHref=base+'/?view=report-search';
  await page.waitForURL(searchHref);
  await page.waitForFunction(()=>document.activeElement?.textContent==='보고서 검색');
  const reportList=page.getByRole('list',{name:'보고서 목록'});
  const reportSearch=page.getByRole('searchbox',{name:'보고서 검색'});
  const statusFilter=page.getByRole('combobox',{name:'상태',exact:true});
  const sourceFilter=page.getByRole('combobox',{name:'입력 유형',exact:true});
  const linkedResult=reportList.locator(`a[href="${linkedHref}&tab=summary"]`);
  await linkedResult.waitFor();
  assert.match(await linkedResult.innerText(),/합성 제품.*상품 목록/s);
  await reportList.getByText('보관된 상품 목록 0',{exact:true}).waitFor();
  assert.match(await reportList.getByRole('link',{name:/보관된 상품 목록 0/}).innerText(),/다른 합성 제품.*과거 상품 목록/s);
  assert.equal(await reportList.getByText('독립 보고서',{exact:true}).count(),0);
  await reportSearch.fill('다른 합성 제품 0');
  await linkedResult.waitFor({state:'hidden'});
  await reportList.getByText('보관된 상품 목록 0',{exact:true}).waitFor();

  await reportSearch.fill('example.test');
  await statusFilter.click();
  await page.getByRole('option',{name:'일부 완료',exact:true}).click();
  await sourceFilter.click();
  await page.getByRole('option',{name:'웹 URL',exact:true}).click();
  await linkedResult.click();
  await page.waitForURL(base+`${linkedHref}&tab=summary`);
  await page.getByRole('tab',{name:'요약',exact:true,selected:true}).waitFor();
  await page.getByRole('heading',{name:'상품 목록',exact:true}).waitFor();
  await page.goBack();
  await page.waitForURL(searchHref);
  await linkedResult.waitFor();
  assert.ok(await linkedResult.evaluate(element=>element===document.activeElement));
  assert.equal(await reportSearch.inputValue(),'example.test');
  assert.equal(await statusFilter.innerText(),'일부 완료');
  assert.equal(await sourceFilter.innerText(),'웹 URL');
  await page.goForward();
  await page.waitForURL(base+`${linkedHref}&tab=summary`);
  await resultsTab.click();
  await page.waitForURL(base+`${linkedHref}&tab=results`);
  await resultRow('원본 합성 문제').waitFor();
  await page.goBack();
  await page.goBack();
  await page.waitForURL(searchHref);

  await sourceFilter.click();
  await page.getByRole('option',{name:'이미지',exact:true}).click();
  await page.getByText('조건에 맞는 보고서가 없습니다.',{exact:true}).waitFor();
  await page.getByRole('button',{name:'초기화',exact:true}).click();
  assert.equal(await sourceFilter.innerText(),'모든 유형');
  await page.waitForFunction(()=>document.activeElement?.getAttribute('type')==='search');

  await page.setViewportSize({width:390,height:844});
  await page.goto(base+'/?view=projects');
  await openReportSearch.click();
  await reportList.getByText('보관된 상품 목록 0',{exact:true}).waitFor();
  assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false);
  const scrolledResult=reportList.getByRole('link',{name:/보관된 상품 목록 0/});
  await scrolledResult.scrollIntoViewIfNeeded();
  const scrollTop=await page.evaluate(()=>window.scrollY);
  assert.ok(scrollTop,'the linked results fixture must allow scrolling');
  const scrolledHref=await scrolledResult.getAttribute('href');
  assert.ok(scrolledHref);
  await scrolledResult.click();
  await page.waitForURL(base+scrolledHref);
  await page.getByRole('tab',{name:'요약',exact:true,selected:true}).waitFor();
  await page.goBack();
  await page.waitForURL(searchHref);
  await page.waitForFunction(expected=>window.scrollY===expected,scrollTop);

  await page.goto(base+'/?view=projects');
  await page.getByRole('button',{name:'관리',exact:true}).press('Enter');
  await page.getByRole('menuitem',{name:'미연결 보고서',exact:true}).press('Enter');
  await page.getByRole('heading',{name:'미연결 보고서',exact:true}).waitFor();
  const standaloneResult=page.getByRole('link',{name:/독립 보고서/});
  await standaloneResult.waitFor();
  assert.equal(await reportList.locator(`a[href*="${reportId}"]`).count(),0);
  await standaloneResult.click();
  await page.getByRole('heading',{name:'독립 보고서',exact:true}).waitFor();
  assert.equal(new URL(page.url()).searchParams.get('report'),standaloneId);
  assert.equal(new URL(page.url()).searchParams.has('workspace'),false);
  const capture=page.locator('#report-main').getByRole('group',{name:'관찰 캡처 갤러리'}).locator('img').first();
  await capture.waitFor();
  await page.waitForFunction(image=>image instanceof HTMLImageElement&&image.naturalWidth===400,await capture.elementHandle());
  assert.deepEqual(await service.workspaceContext(standaloneId),{});
  await page.getByRole('link',{name:'미연결 보고서',exact:true}).click();
  await standaloneResult.waitFor();

  const archiveServer=createViewerServer(repository,resolve('viewer'),undefined,vite.middlewares);
  archiveServer.listen(0,'127.0.0.1');await once(archiveServer,'listening');
  try{
   const archiveBase=`http://127.0.0.1:${(archiveServer.address() as {port:number}).port}`;
   await page.goto(archiveBase+'/?view=projects');
   await openWorkspaceAction(page,'관리','미연결 보고서');
   await standaloneResult.click();
   await page.getByRole('heading',{name:'독립 보고서',exact:true}).waitFor();
   assert.equal(new URL(page.url()).searchParams.get('report'),standaloneId);
  }finally{
   archiveServer.closeAllConnections();
   await new Promise<void>(done=>archiveServer.close(()=>done()));
  }
  await page.goto(base+'/?view=projects');await page.getByRole('button',{name:'새 프로젝트',exact:true}).click();await page.getByRole('textbox',{name:'프로젝트 이름'}).fill('브라우저에서 만든 프로젝트');await page.getByRole('button',{name:'만들기',exact:true}).click();await page.getByRole('button',{name:'새 UI 검토',exact:true}).click();await page.getByRole('textbox',{name:'화면 또는 기능 이름'}).fill('새 화면');await page.getByRole('textbox',{name:/확인할 내용/}).fill('기본 화면을 확인');await page.getByRole('textbox',{name:'화면 URL'}).fill('https://example.test/new?tab=all');
  await page.getByRole('checkbox',{name:'라이트·다크 모드 함께 검사'}).check();
  await page.getByRole('button',{name:'작업공간 만들고 검토 시작'}).click();await page.getByRole('heading',{name:'새 화면',exact:true}).waitFor();
  await summaryTab.click();
  await page.getByRole('button',{name:'자동 검사 결과',exact:true}).click();
  assert.deepEqual(seen.find(spec=>spec.targetUrl==='https://example.test/new?tab=all')?.themeReview,{mode:'both'});
  await page.getByText('영역 적용 확인',{exact:true}).waitFor();
  await page.getByText('배경 변화 영역 1 (region) · 배경 #0f172b · 위치 0, 80',{exact:false}).waitFor();
  await page.getByText('텍스트 대비 보완 검사',{exact:true}).waitFor();
  await page.getByText('전경 #1c2633 · 배경 #0f172b',{exact:false}).waitFor();
  await page.getByText('측정 1.12:1',{exact:false}).waitFor();
  await page.getByRole('button',{name:'그룹별 정렬과 크기 측정'}).click();
  await page.getByText('외곽 높이 차이 8 CSS px').waitFor();
  await page.getByText('지정한 그룹을 찾지 못했습니다.').waitFor();
  assert.equal(await page.getByText('추가 확인 · 기준 4.5:1',{exact:true}).count(),0);
  assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false);
  await page.getByRole('tab',{name:'범위와 한계',exact:true}).click();
  await page.getByRole('button',{name:'자동 검사 결과',exact:true}).click();
  await page.getByRole('link',{name:'다크 모드 캡처 보기'}).waitFor();
  await page.getByText('측정 1.12:1',{exact:false}).waitFor();
  const imageWorkspace=await service.addWorkspace({projectId:project.projectId,name:'이미지 화면',goal:'이미지 선택 상태 검토'});const asset=await service.upload({fileName:'image-fixture.png',base64:(await sharp({create:{width:800,height:500,channels:3,background:'white'}}).png().toBuffer()).toString('base64')});await service.submitWorkspaceInitial(imageWorkspace.workspaceId,{submissionId:randomUUID(),target:{kind:'image',assetId:asset.assetId}});
  for(let i=0;i<100&&!(await service.workspace(imageWorkspace.workspaceId)).workspace.latestReportId;i++)await new Promise(done=>setTimeout(done,20));
  await page.goto(base+`/?workspace=${imageWorkspace.workspaceId}`);
  await page.getByRole('tab',{name:'검토',exact:true}).click();
  const composeTab=page.getByRole('tab',{name:'검토',exact:true});
  await composeTab.and(page.locator('[aria-selected="true"]')).waitFor();
  await page.getByText('제공된 이미지에 보이는 내용을 검토합니다.',{exact:false}).waitFor();
  const imageInstruction=page.getByRole('textbox',{name:/추가 지시/});
  await imageInstruction.fill('이미지의 선택 상태를 검토해줘');
  const workspaceTabs=['요약','결과','범위와 한계'];
  const summaryOnly=[
   page.getByRole('heading',{name:/^현재 결과/}),
   page.getByText('AI 평가 시간 초과',{exact:true}),
   page.getByRole('button',{name:'화면 비교',exact:true}),
   page.getByRole('button',{name:'요청과 검증 내역',exact:true}),
  ];
  for(const tabName of workspaceTabs){
   const reportTab=page.getByRole('tab',{name:tabName,exact:true});
   await reportTab.click();
   await reportTab.and(page.locator('[aria-selected="true"]')).waitFor();
   assert.equal(await imageInstruction.isVisible(),false,tabName);
   for(const element of summaryOnly)assert.equal(await element.isVisible(),tabName==='요약',tabName);
  }
  await page.getByRole('button',{name:'검토 조건과 실행 정보',exact:true}).click();
  await page.getByRole('region',{name:'검토 조건과 실행 정보',exact:true})
   .getByText('이미지 선택 상태 검토',{exact:true}).waitFor();
  await composeTab.click();
  assert.equal(await imageInstruction.inputValue(),'이미지의 선택 상태를 검토해줘');
  await page.getByRole('button',{name:'이미지 검토 요청',exact:true}).click();
  for(let i=0;i<100&&!seen.some(spec=>spec.followup&&spec.imagePath);i++)await new Promise(done=>setTimeout(done,20));
  assert.ok(seen.some(spec=>spec.followup&&spec.imagePath),'image followup dispatches a static image inspector');
  const reviewMode=page.getByRole('combobox',{name:'검토 방식',exact:true});
  await reviewMode.click();
  assert.deepEqual(await page.getByRole('option').allTextContents(),['이미지 검토 작성','집중 재검토 작성','두 화면 스타일 비교']);
  await page.getByRole('option',{name:'집중 재검토 작성',exact:true}).click();
  const focusInstruction=page.getByRole('textbox',{name:'확인할 내용',exact:true});
  await focusInstruction.fill('저장된 영역의 선택 상태만 확인해줘');
  await page.getByRole('tab',{name:'요약',exact:true}).click();
  assert.equal(await focusInstruction.isVisible(),false);
  await composeTab.click();
  assert.equal(await focusInstruction.inputValue(),'저장된 영역의 선택 상태만 확인해줘');
  await page.getByRole('button',{name:'캡처에서 영역 선택',exact:true}).click();
  const focusImage=page.locator('.workspace-capture-frame img');
  await focusImage.scrollIntoViewIfNeeded();
  const focusBounds=await focusImage.boundingBox();
  assert.ok(focusBounds);
  await page.mouse.move(focusBounds.x+focusBounds.width*.2,focusBounds.y+focusBounds.height*.2);
  await page.mouse.down();
  await page.mouse.move(focusBounds.x+focusBounds.width*.45,focusBounds.y+focusBounds.height*.5);
  await page.mouse.up();
  await page.getByText('선택한 캡처 영역을 사용합니다.',{exact:true}).waitFor();
  const focusAccepted=page.waitForResponse(response=>response.url()===base+'/api/focused-reviews'&&response.request().method()==='POST');
  await page.getByRole('button',{name:'집중 재검토 요청',exact:true}).click();
  assert.equal((await focusAccepted).status(),202);
  await page.screenshot({path:'/tmp/ui-image-workspace-implementation-mobile.png',fullPage:true});await page.setViewportSize({width:1440,height:1000});await page.screenshot({path:'/tmp/ui-image-workspace-implementation-desktop.png',fullPage:true});
  assert.equal(errors.length,0,errors.join('\n'));
 }finally{shouldHold=false;release();await browser.close();await service.close();server.closeAllConnections();await new Promise<void>(done=>server.close(()=>done()));await vite.close();await rm(root,{recursive:true,force:true});}
});
