import test from 'node:test';
import assert from 'node:assert/strict';
import {once} from 'node:events';
import {createHash,randomUUID} from 'node:crypto';
import {mkdir,mkdtemp,rm,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {resolve} from 'node:path';
import {chromium} from 'playwright';
import sharp from 'sharp';
import {createServer as createViteServer} from 'vite';
import type {inspect} from '../src/core.js';
import {ReviewAuthenticationError,ReviewLoginRequired,type ReviewCredentials} from '../src/review-auth.js';
import {ReviewService} from '../src/review-service.js';
import {createViewerServer} from '../viewer/server/http.js';
import {ReportRepository} from '../viewer/server/repository.js';

test('dashboard starts URL reviews with optional credentials and preserves the previous result on retry',async()=>{
 const root=await mkdtemp(resolve(tmpdir(),'review-start-ui-'));
 const credentialsSeen:Array<ReviewCredentials|undefined>=[];
 const protectedUrl='https://example.test/protected';
 const loginUrl='https://example.test/login';
 const deferredUrl='https://example.test/first-workspace-review';
 let finishFirstReview:()=>void=()=>{};
 const firstReviewGate=new Promise<void>(done=>{finishFirstReview=done;});
 const service=new ReviewService(root,{inspect:(async(spec,outputRoot,runtime)=>{
  credentialsSeen.push(runtime?.credentials);
  if(spec.targetUrl===deferredUrl){
   runtime?.onProgress?.({phase:'opening',reason:'검토 대상 화면을 엽니다.'});
   await firstReviewGate;
  }
  if(runtime?.credentials?.method==='code')throw new ReviewAuthenticationError('rejected');
  if(spec.targetUrl===protectedUrl&&runtime?.shouldDetectRedirectedLogin&&!runtime.expectedRedirectedLoginUrl&&!runtime.credentials){
   throw new ReviewLoginRequired(loginUrl,['password']);
  }
  const runId=randomUUID();
  const runDir=resolve(outputRoot,runId);
  await mkdir(runDir,{recursive:true});
  const observedUrl=runtime?.expectedRedirectedLoginUrl;
  const evidence=[];
  if(observedUrl){
   const png=await sharp({create:{width:640,height:400,channels:3,background:'#fafafa'}}).png().toBuffer();
   await writeFile(resolve(runDir,'screen.png'),png);
   evidence.push({kind:'screenshot',evidenceId:'screen',observationId:'obs-001',relativePath:'screen.png',sha256:createHash('sha256').update(png).digest('hex')});
  }
  const result={
   runId,status:'completed',startedAt:new Date().toISOString(),targetUrl:spec.targetUrl,
   observations:observedUrl?[{observationId:'obs-001',url:observedUrl,evidenceRefs:evidence}]:[],evidence,
   findings:[],limitations:[],coverage:{canFinish:true,unmetChecks:[]},
  };
  await writeFile(resolve(runDir,'manifest.json'),JSON.stringify({spec}));
  await writeFile(resolve(runDir,'report.json'),JSON.stringify(result));
  return {result,runDir};
 }) as typeof inspect});
 await service.start();
 const project=await service.addProject({name:'합성 프로젝트'});
 const workspace=await service.addWorkspace({projectId:project.projectId,name:'예약 상세',goal:'예약 정보 확인'});
 const deferred=await service.addWorkspace({projectId:project.projectId,name:'Codex 접수',goal:'목록 확인'});
 await service.submitWorkspaceInitial(deferred.workspaceId,{
  submissionId:randomUUID(),target:{kind:'url',url:deferredUrl,shouldWaitForStart:true},
 });
 const vite=await createViteServer({configFile:resolve('viewer/vite.config.ts'),server:{middlewareMode:true,hmr:false,ws:false}});
 const server=createViewerServer(new ReportRepository(root),resolve('viewer'),service,vite.middlewares);
 server.listen(0,'127.0.0.1');
 await once(server,'listening');
 const base=`http://127.0.0.1:${(server.address() as {port:number}).port}`;
 const browser=await chromium.launch();
 const page=await browser.newPage({viewport:{width:1440,height:900}});
 const errors:string[]=[];
 const startResponses:Array<{path:string;status:number}>=[];
 const retiredRequests:string[]=[];
 page.on('pageerror',error=>errors.push(error.message));
 page.on('response',response=>{
  const path=new URL(response.url()).pathname;
  if(/^\/api\/workspace-requests\/[^/]+\/start$/.test(path))startResponses.push({path,status:response.status()});
 });
 page.on('request',request=>{
  const path=new URL(request.url()).pathname;
  if(path.startsWith('/api/review-tasks'))retiredRequests.push(path);
 });
 try{
  for(const path of ['/?view=tasks',`/?task=${randomUUID()}`]){
   await page.goto(base+path);
   await page.getByRole('heading',{name:'리뷰 프로젝트',exact:true}).waitFor();
   assert.equal(new URL(page.url()).search,new URL(path,base).search);
   assert.equal(await page.getByRole('link',{name:'기존 리뷰 작업 보기',exact:true}).count(),0);
  }
  await page.goto(base+`/?workspace=${deferred.workspaceId}`);
  await page.getByRole('heading',{name:'검토 시작',exact:true}).waitFor();
  const summaryTab=page.getByRole('tab',{name:'요약',exact:true});
  const tabList=page.getByRole('tablist',{name:'보고서 보기'});
  const summary=page.getByRole('tabpanel',{name:'요약',exact:true});
  const history=page.getByRole('button',{name:'요청과 검증 내역',exact:true});
  const sidebar=page.getByRole('complementary',{name:'작업공간 목록'});
  const resizer=sidebar.getByRole('separator',{name:'작업공간 목록 너비'});
  await resizer.press('ArrowRight');
  const pendingTabs=await tabList.boundingBox();
  assert.ok(pendingTabs);
  const sidebarWidth=await resizer.getAttribute('aria-valuenow');
  assert.equal(await summary.isVisible(),true);
  await summary.getByRole('heading',{name:'검토 요청 접수',exact:true}).waitFor();
  assert.deepEqual(await tabList.getByRole('tab').allTextContents(),['요약','검토','결과','범위와 한계']);
  for(const name of ['검토','결과','범위와 한계']){
   assert.equal(await tabList.getByRole('tab',{name,exact:true}).isDisabled(),true);
  }
  assert.equal(await history.getAttribute('aria-expanded'),'false');
  assert.deepEqual(credentialsSeen,[]);
  await page.getByRole('button',{name:'로그인 없이 검토',exact:true}).click();
  await summary.getByText('검토 중',{exact:true}).waitFor();
  assert.equal(await summary.getByText('검토 대상 화면을 엽니다.').count(),0);
  assert.equal(await summary.getByRole('button',{name:'검증 중지',exact:true}).isVisible(),true);
  finishFirstReview();
  await page.getByRole('heading',{name:/^현재 결과/}).waitFor();
  assert.equal(await resizer.getAttribute('aria-valuenow'),sidebarWidth);
  assert.equal(await summaryTab.getAttribute('aria-selected'),'true');
  assert.deepEqual(await tabList.boundingBox(),pendingTabs);
  assert.equal(await history.getAttribute('aria-expanded'),'false');
  assert.equal(await tabList.getByRole('tab',{name:'결과',exact:true}).isEnabled(),true);
  assert.deepEqual(credentialsSeen,[undefined]);

  await page.goto(base+`/?workspace=${workspace.workspaceId}`);
  await summary.getByRole('heading',{name:'첫 검토를 준비하세요',exact:true}).waitFor();
  assert.equal(await history.getAttribute('aria-expanded'),'false');
  await page.getByLabel('화면 URL').fill('https://example.test/reservations');
  await page.getByRole('button',{name:'로그인 정보 입력',exact:true}).click();
  const dialog=page.getByRole('dialog',{name:'로그인 정보 입력'});
  await dialog.getByText('https://example.test · 이번 실행에만 사용').waitFor();
  await dialog.getByLabel('ID',{exact:true}).fill('test-review-account');
  await dialog.getByLabel('비밀번호',{exact:true}).fill('synthetic-password');
  await dialog.getByRole('button',{name:'로그인하고 검토',exact:true}).click();
  await page.getByRole('heading',{name:/^현재 결과/}).waitFor();
  assert.deepEqual(credentialsSeen.at(-1),{method:'password',username:'test-review-account',password:'synthetic-password'});

  const previousReport=(await service.workspace(workspace.workspaceId)).workspace.latestReportId;
  assert.ok(previousReport);
  await page.getByRole('tab',{name:'검토',exact:true}).click();
  await page.getByRole('textbox',{name:'추가 지시'}).fill('요약 영역을 한 번 더 확인');
  await page.getByRole('button',{name:'로그인 정보 입력',exact:true}).click();
  await dialog.getByRole('radio',{name:'일회용 코드'}).check();
  assert.equal(await dialog.getByLabel('비밀번호',{exact:true}).count(),0);
  await dialog.getByRole('textbox',{name:'일회용 코드'}).fill('012345');
  await dialog.getByRole('button',{name:'로그인하고 검토',exact:true}).click();
  await dialog.waitFor({state:'hidden'});
  await page.getByText(/^로그인에 실패했습니다/).first().waitFor();
  assert.deepEqual(credentialsSeen.at(-1),{method:'code',code:'012345'});
  assert.equal((await service.workspace(workspace.workspaceId)).workspace.latestReportId,previousReport);
  assert.equal(await page.getByRole('heading',{name:/^현재 결과/}).isVisible(),true);

  await page.getByRole('button',{name:'로그인 없이 검토',exact:true}).click();
  await page.getByRole('heading',{name:'추가 검토 시작',exact:true}).waitFor({state:'hidden'});
  await page.getByRole('button',{name:'새 결과 보기',exact:true}).waitFor();
  assert.equal(credentialsSeen.at(-1),undefined);

  const runsBeforeProjectStart=credentialsSeen.length;
  await page.goto(base+`/?project=${project.projectId}`);
  await page.getByRole('button',{name:'새 UI 검토',exact:true}).click();
  await page.getByLabel('화면 또는 기능 이름').fill('프로젝트 예약 목록');
  await page.getByLabel('확인할 내용').fill('예약 목록을 확인');
  await page.getByLabel('화면 URL').fill('https://example.test/list');
  await page.getByRole('button',{name:'로그인 정보 입력',exact:true}).click();
  await page.getByRole('tab',{name:'요약',exact:true}).waitFor();
  await page.getByRole('heading',{name:'검토 시작',exact:true}).waitFor();
  assert.equal(credentialsSeen.length,runsBeforeProjectStart);
  await page.getByRole('button',{name:'로그인 없이 검토',exact:true}).click();
  await page.getByRole('heading',{name:/^현재 결과/}).waitFor();
  assert.equal(credentialsSeen.length,runsBeforeProjectStart+1);
  assert.equal(credentialsSeen.at(-1),undefined);

  const protectedWorkspace=await service.addWorkspace({projectId:project.projectId,name:'보호 화면',goal:'접근한 화면 확인'});
  await page.goto(base+`/?workspace=${protectedWorkspace.workspaceId}&tab=summary`);
  await page.getByLabel('화면 URL').fill(protectedUrl);
  await page.getByRole('button',{name:'첫 검토 시작',exact:true}).click();
  const redirectChoice=page.getByRole('region',{name:'로그인 화면으로 이동했습니다',exact:true});
  await redirectChoice.getByText(protectedUrl,{exact:true}).waitFor();
  await redirectChoice.getByText(loginUrl,{exact:true}).waitFor();
  assert.equal(await dialog.isVisible(),false);
  const launcher=redirectChoice.getByRole('button',{name:'로그인하고 원래 화면 검토',exact:true});
  await launcher.press('Enter');
  await dialog.getByLabel('비밀번호',{exact:true}).waitFor();
  assert.equal(await dialog.getByRole('radio',{name:'일회용 코드'}).count(),0);
  await page.keyboard.press('Escape');
  await dialog.waitFor({state:'hidden'});
  await page.waitForFunction(()=>document.activeElement?.textContent==='로그인하고 원래 화면 검토');
  await redirectChoice.getByRole('button',{name:'현재 로그인 화면 검토',exact:true}).click();
  const redirectNotice=page.getByRole('status').filter({hasText:'로그인 화면을 검토했습니다'});
  await redirectNotice.getByText(protectedUrl,{exact:true}).waitFor();
  await redirectNotice.getByText(loginUrl,{exact:true}).waitFor();
  const fallbackReport=(await service.workspace(protectedWorkspace.workspaceId)).workspace.latestReportId;
  assert.ok(fallbackReport);
  await page.getByRole('tab',{name:'결과',exact:true}).click();
  await page.getByRole('tab',{name:'검토',exact:true}).click();
  await page.getByRole('textbox',{name:'추가 지시'}).fill('보호 화면을 다시 확인');
  await page.getByRole('button',{name:'검증 요청',exact:true}).click();
  await redirectChoice.getByRole('button',{name:'현재 로그인 화면 검토',exact:true}).waitFor();
  assert.equal((await service.workspace(protectedWorkspace.workspaceId)).workspace.latestReportId,fallbackReport);
  assert.equal(await page.getByRole('tab',{name:'검토',exact:true,selected:true}).count(),1);
  await launcher.click();
  await dialog.getByLabel('ID',{exact:true}).fill('test-review-account');
  await dialog.getByLabel('비밀번호',{exact:true}).fill('synthetic-password');
  await dialog.getByRole('button',{name:'로그인하고 원래 화면 검토',exact:true}).click();
  await redirectChoice.waitFor({state:'hidden'});
  await page.getByRole('button',{name:'새 결과 보기',exact:true}).click();
  assert.deepEqual(credentialsSeen.at(-1),{method:'password',username:'test-review-account',password:'synthetic-password'});
  await page.getByRole('tab',{name:'요약',exact:true}).click();
  assert.equal(await redirectNotice.count(),0);
  assert.equal(startResponses.length,7);
  assert.ok(startResponses.every(response=>response.status===202));
  assert.deepEqual(retiredRequests,[]);
  assert.deepEqual(errors,[]);
 }finally{
  finishFirstReview();
  await browser.close();
  await service.close();
  server.closeAllConnections();
  await new Promise<void>(done=>server.close(()=>done()));
  await vite.close();
  await rm(root,{recursive:true,force:true});
 }
});
