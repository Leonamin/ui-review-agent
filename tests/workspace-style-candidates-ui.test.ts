import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {once} from 'node:events';
import {mkdir,mkdtemp,rm,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {resolve} from 'node:path';
import {chromium,type Locator} from 'playwright';
import sharp from 'sharp';
import {createServer as createViteServer} from 'vite';
import type {AutoStyleComparisonReport} from '../src/automatic-style-comparison.js';
import {ReviewService} from '../src/review-service.js';
import type {ReportDetail} from '../viewer/features/reports/types.js';
import {createViewerServer} from '../viewer/server/http.js';
import {ReportRepository} from '../viewer/server/repository.js';

const hash=(value:string|Buffer)=>createHash('sha256').update(value).digest('hex');
const viewport={width:960,height:600,deviceScaleFactor:1};
const startedAt='2026-11-19T02:24:55Z';
const targetUrl='https://example.test/style-check';
const evidenceDirectory=process.env.WORKSPACE_STYLE_CANDIDATE_SCREENSHOT_DIR;

async function writeStyleReport(root:string){
 const runId='workspace-style-fixture';
 const dir=resolve(root,runId);
 await mkdir(dir);
 async function capture(evidenceId:string,observationId:string,color:string){
  const relativePath=`${evidenceId}.png`;
  const screenshot=await sharp(Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="960" height="600"><rect width="960" height="600" fill="#fafafa"/><rect x="32" y="36" width="460" height="24" fill="#252525"/><rect x="32" y="88" width="300" height="44" rx="8" fill="${color}"/><rect x="32" y="156" width="180" height="44" rx="8" fill="${color}"/></svg>`)).png().toBuffer();
  await writeFile(resolve(dir,relativePath),screenshot);
  return {kind:'screenshot',evidenceId,observationId,relativePath,sha256:hash(screenshot)};
 }
 const [a1,b1,a2,b2,other]=await Promise.all([
  capture('pair-1-a','obs-1-a','#124e66'),capture('pair-1-b','obs-1-b','#03989e'),
  capture('pair-2-a','obs-2-a','#653e49'),capture('pair-2-b','obs-2-b','#82453e'),
  capture('other-screenshot','obs-2-a','#222222'),
 ]);
 function comparison(first:typeof a1,second:typeof b1,start:number,size:number):AutoStyleComparisonReport{
  const matches=Array.from({length:size},(_,index):AutoStyleComparisonReport['matches'][number]=>{
   const number=start+index;
   const target={label:`요소 ${number}`,selector:`#element-${number}`,bounds:{x:32,y:index===0?88:156,width:300,height:44}};
   return {role:'button',method:'label',reference:target,comparison:target,
    differences:[{property:'padding-left',reference:`${number}px`,comparison:`${number+12}px`}]};
  });
  return {evidenceId:`${first.evidenceId}-checks`,
   reference:{url:`${targetUrl}/a`,observationId:first.observationId,screenshotEvidenceId:first.evidenceId,hasReachedLimit:false,inspected:size},
   comparison:{url:`${targetUrl}/b`,observationId:second.observationId,screenshotEvidenceId:second.evidenceId,hasReachedLimit:false,inspected:size},
   matches,unmatched:[],ambiguous:[],unmeasured:[],coverage:{matched:size,changed:size,unmatched:0,ambiguous:0,unmeasured:0}};
 }
 function observation(image:typeof a1,style?:AutoStyleComparisonReport,additional?:typeof other){
  return {observationId:image.observationId,pageTitle:'스타일 비교 검증',url:targetUrl,viewport,
   evidenceRefs:additional?[additional,image]:[image],
   ...(style?{deterministicChecks:{evidenceId:style.evidenceId,autoStyleComparison:style,
    spacing:{inspectedPairs:1,inspectedCards:0,checks:[]}}}:{})};
 }
 await writeFile(resolve(dir,'report.json'),JSON.stringify({
  runId,targetUrl,startedAt,endedAt:startedAt,status:'completed',findings:[],limitations:[],
  observations:[observation(a1,comparison(a1,b1,1,11)),observation(b1),observation(a2,comparison(a2,b2,12,1),other),observation(b2)],
 }));
 return hash(`${runId}/report.json`);
}

async function assertCapture(dialog:Locator,reportId:string,side:'A'|'B',element:number,evidenceId:string){
 const picture=dialog.getByRole('img',{name:`화면 ${side}의 요소 ${element} 캡처`,exact:true});
 await picture.waitFor();
 const path=`/api/reports/${reportId}/images/${hash(evidenceId)}`;
 assert.equal(await picture.getAttribute('src'),path);
 assert.equal(await dialog.getByRole('link',{name:`화면 ${side} 원본 열기`,exact:true}).getAttribute('href'),path);
 await picture.evaluate(image=>(image as HTMLImageElement).decode());
}

async function assertCenteredScrollIndicator(listbox:Locator,direction:'up'|'down'){
 const icon=listbox.locator(`.gc-select-scroll > .lucide-chevron-${direction}`);
 await icon.waitFor();
 const offset=await icon.evaluate(element=>{
  const iconBounds=element.getBoundingClientRect();
  const listBounds=element.closest('[role=listbox]')!.getBoundingClientRect();
  return iconBounds.x+iconBounds.width/2-listBounds.x-listBounds.width/2;
 });
 assert.ok(Math.abs(offset)<=1,`the ${direction} scroll indicator is centered`);
}

test('workspace summary keeps captures in place with many style candidates and opens each candidate’s evidence',async t=>{
 const root=await mkdtemp(resolve(tmpdir(),'workspace-style-ui-'));
 const service=new ReviewService(root);
 const repository=new ReportRepository(root);
 let closeViewer:()=>Promise<void>=async()=>{};
 t.after(async()=>{
  await closeViewer();
  await service.close();
  await rm(root,{recursive:true,force:true});
 });
 await service.start();
 const project=await service.addProject({name:'스타일 비교 합성 프로젝트'});
 const workspace=await service.addWorkspace({projectId:project.projectId,name:'두 화면 스타일 비교',goal:'스타일 후보 수와 근거 확인'});
 const reportId=await writeStyleReport(root);
 await service.attachWorkspaceReport(workspace.workspaceId,{reportId,expectedVersion:workspace.version},id=>repository.followupSource(id));

 const vite=await createViteServer({configFile:resolve('viewer/vite.config.ts'),server:{middlewareMode:true,hmr:false,ws:false}});
 const server=createViewerServer(repository,resolve('viewer'),service,vite.middlewares);
 server.listen(0,'127.0.0.1');
 await once(server,'listening');
 closeViewer=async()=>{
  server.closeAllConnections();
  await new Promise<void>(done=>server.close(()=>done()));
  await vite.close();
 };
 const base=`http://127.0.0.1:${(server.address() as {port:number}).port}`;
 const summaryUrl=`${base}/?workspace=${workspace.workspaceId}&report=${reportId}&tab=summary`;
 if(evidenceDirectory)await mkdir(evidenceDirectory,{recursive:true});
 const browser=await chromium.launch();
 try{
  const page=await browser.newPage({reducedMotion:'reduce',locale:'ko-KR',timezoneId:'Asia/Seoul'});
  const errors:string[]=[];
  page.on('pageerror',error=>errors.push(error.message));
  let candidateCount=1;
  let shouldHideSecondCapture=false;
  await page.route(`${base}/api/reports/${reportId}`,async route=>{
   if(candidateCount===12){await route.continue();return;}
   // Keep the selected report, shell and captures identical while varying only its style candidates.
   const response=await route.fetch();
   const report=await response.json() as ReportDetail;
   const comparison=report.captures?.[0].deterministicChecks?.autoStyleComparison;
   assert.ok(comparison);
   comparison.matches=comparison.matches.slice(0,1);
   comparison.coverage.matched=1;
   comparison.coverage.changed=candidateCount;
   if(!candidateCount)comparison.matches[0].differences=[];
   if(shouldHideSecondCapture)comparison.comparison.screenshotEvidenceId='unrecorded-capture';
   if(report.captures?.[2].deterministicChecks)delete report.captures[2].deterministicChecks.autoStyleComparison;
   await route.fulfill({response,json:report});
  });
  const candidateSummary=page.locator('.workspace-style-candidate-summary');
  const dialog=page.getByRole('dialog',{name:'스타일 차이 후보',exact:true});
  let hasVisited=false;
  async function openSummary(count:number){
   candidateCount=count;
   if(hasVisited)await page.reload();else{await page.goto(summaryUrl);hasVisited=true;}
   await page.getByRole('tab',{name:'요약',exact:true,selected:true}).waitFor();
   await page.waitForFunction(()=>[...document.querySelectorAll<HTMLImageElement>('.workspace-report-capture img')].some(image=>image.naturalWidth>0));
   await page.evaluate(async()=>{await document.fonts.ready;window.scrollTo(0,0);});
  }
  for(const {width,height} of [{width:1440,height:1000},{width:390,height:844},{width:320,height:740}]){
   await page.setViewportSize({width,height});
   const positions=[];
   for(const count of [1,12]){
    await openSummary(count);
    const label=candidateSummary.getByText(`자동 스타일 차이 후보 ${count}쌍`,{exact:true});
    const openButton=candidateSummary.getByRole('button',{name:count===1?'A/B 캡처 보기':'후보 보기',exact:true});
    await label.waitFor();
    const [labelBox,buttonBox,rowBox]=await Promise.all([label.boundingBox(),openButton.boundingBox(),candidateSummary.boundingBox()]);
    assert.ok(labelBox&&buttonBox&&rowBox);
    assert.ok(labelBox.y<buttonBox.y+buttonBox.height&&buttonBox.y<labelBox.y+labelBox.height,'summary label and button must share one row');
    assert.ok(labelBox.x+labelBox.width<=buttonBox.x,'the summary label must fit next to the button');
    assert.equal(await label.evaluate(element=>{
     const text=document.createRange();
     text.selectNodeContents(element);
     return new Set([...text.getClientRects()].map(rect=>Math.round(rect.top))).size;
    }),1,'the summary count must fit on a single line');
    assert.equal(await candidateSummary.getByRole('button').count(),1);
    assert.equal(await candidateSummary.getByRole('img').count(),0);
    assert.equal(await dialog.isVisible(),false);
    const layout=await page.evaluate(()=>({
     currentResultHeight:document.querySelector('.workspace-current-result')!.getBoundingClientRect().height,
     observationTop:document.querySelector('.workspace-report-capture')!.getBoundingClientRect().top,
     hasOverflow:document.documentElement.scrollWidth>document.documentElement.clientWidth,
    }));
    assert.ok(layout.observationTop<height,'the observation is visible without scrolling');
    assert.equal(layout.hasOverflow,false);
    positions.push({...layout,rowHeight:rowBox.height});
    if(evidenceDirectory&&width>=390)await page.screenshot({path:resolve(evidenceDirectory,`summary-${width}-${count}-candidates.png`),animations:'disabled'});

    await openButton.press('Enter');
    await dialog.waitFor();
    await assertCapture(dialog,reportId,'A',1,'pair-1-a');
    await assertCapture(dialog,reportId,'B',1,'pair-1-b');
    const table=dialog.getByRole('table',{name:/차이가 기록된 속성 1개/});
    await table.getByRole('row',{name:/왼쪽 안쪽 여백.*1px.*13px/}).waitFor();
    if(count===1){
     assert.equal(await dialog.getByRole('radio').count(),0);
     assert.equal(await dialog.getByRole('combobox',{name:'후보 선택',exact:true}).count(),0);
    }else{
     if(width===1440){
      const first=dialog.getByRole('radio',{name:/^1\. .*요소 1$/});
      await first.press('ArrowDown');
      await table.getByRole('row',{name:/왼쪽 안쪽 여백.*2px.*14px/}).waitFor();
      await dialog.getByRole('radio',{name:/^12\. .*요소 12$/}).check();
     }else{
      const selector=dialog.getByRole('combobox',{name:'후보 선택',exact:true});
      const listbox=page.getByRole('listbox');
      assert.equal(await selector.evaluate(button=>button.getBoundingClientRect().height),44);
      await selector.press('Enter');
      await listbox.waitFor();
      await assertCenteredScrollIndicator(listbox,'down');
      assert.equal(await listbox.locator('.lucide-chevron-up').count(),0);
      await page.keyboard.press('Escape');
      await listbox.waitFor({state:'hidden'});
      await page.waitForFunction(button=>button===document.activeElement,await selector.elementHandle());
      await selector.click();
      await listbox.getByRole('option',{name:/^12\. .*요소 12$/}).click();
      await listbox.waitFor({state:'hidden'});
      await page.waitForFunction(button=>button===document.activeElement,await selector.elementHandle());
      await selector.press('Enter');
      await assertCenteredScrollIndicator(listbox,'up');
      assert.equal(await listbox.locator('.lucide-chevron-down').count(),0);
      if(evidenceDirectory&&width===390)await page.screenshot({path:resolve(evidenceDirectory,'shared-dropdown-mobile-centered.png'),animations:'disabled'});
      await page.keyboard.press('Escape');
      await listbox.waitFor({state:'hidden'});
     }
     await assertCapture(dialog,reportId,'A',12,'pair-2-a');
     await assertCapture(dialog,reportId,'B',12,'pair-2-b');
     await table.getByRole('row',{name:/왼쪽 안쪽 여백.*12px.*24px/}).waitFor();
     assert.equal(await table.getByRole('row',{name:/왼쪽 안쪽 여백 1px 13px/}).count(),0);
     assert.equal(await dialog.evaluate(element=>element.scrollWidth>element.clientWidth),false);
     if(evidenceDirectory&&width>=390)await page.screenshot({path:resolve(evidenceDirectory,`comparison-${width}-candidate-12.png`),animations:'disabled'});
    }
    assert.ok(await dialog.evaluate(element=>element.contains(document.activeElement)));
    await page.keyboard.press('Escape');
    await dialog.waitFor({state:'hidden'});
    await page.waitForFunction(button=>button===document.activeElement,await openButton.elementHandle());
   }
   assert.deepEqual(positions[0],positions[1],`${width}px: summary height and observation position with one versus twelve candidates`);
   t.diagnostic(`${width} × ${height} layout with 1 and 12 candidates: ${JSON.stringify(positions[0])}`);
  }
  await openSummary(0);
  await candidateSummary.getByText('측정한 스타일 차이 없음',{exact:true}).waitFor();
  assert.equal(await candidateSummary.getByRole('button',{name:/후보 보기|A\/B 캡처 보기/}).count(),0);
  await candidateSummary.getByRole('button',{name:'검사 범위 보기',exact:true}).click();
  const coverage=page.getByRole('dialog',{name:'자동 스타일 비교 범위',exact:true});
  await coverage.getByRole('button',{name:'검사 범위',exact:true}).click();
  await coverage.getByText('비교한 요소 1쌍 · 차이 없음 1쌍',{exact:true}).waitFor();
  await page.keyboard.press('Escape');
  await coverage.waitFor({state:'hidden'});
  shouldHideSecondCapture=true;
  await openSummary(1);
  await candidateSummary.getByRole('button',{name:'A/B 캡처 보기',exact:true}).click();
  await dialog.getByText('저장된 캡처가 없습니다.',{exact:true}).waitFor();
  assert.equal(await dialog.getByRole('link',{name:'화면 B 원본 열기',exact:true}).count(),0);
  await assertCapture(dialog,reportId,'A',1,'pair-1-a');
  await dialog.getByRole('row',{name:/왼쪽 안쪽 여백.*1px.*13px/}).waitFor();
  await page.keyboard.press('Escape');
  await dialog.waitFor({state:'hidden'});
  await page.getByRole('button',{name:'자동 검사 결과',exact:true}).click();
  await page.getByText('간격과 여백',{exact:true}).first().waitFor();
  assert.equal(await page.getByRole('region',{name:'화면 간 스타일 자동 비교',exact:true}).count(),0);
  assert.deepEqual(errors,[]);
 }finally{
  await browser.close();
 }
});
