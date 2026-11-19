import {strict as assert} from 'node:assert';
import {once} from 'node:events';
import {mkdir,mkdtemp,rm,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {resolve} from 'node:path';
import test from 'node:test';
import {setTimeout as wait} from 'node:timers/promises';
import {chromium,type Locator} from 'playwright';
import {createServer as createViteServer} from 'vite';
import {ReviewService} from '../src/review-service.js';
import {createViewerServer} from '../viewer/server/http.js';
import {ReportRepository} from '../viewer/server/repository.js';

test('project catalog sorts report completion independently from attachment order and filters visible cards',async()=>{
 const root=await mkdtemp(resolve(tmpdir(),'project-catalog-'));
 const service=new ReviewService(root);
 await service.start();
 const shop=await service.addProject({name:'Example Shop'});
 await wait(4);
 const sample=await service.addProject({name:'Sample Admin'});
 await wait(4);
 const empty=await service.addProject({name:'Zulu'});
 const shopWorkspace=await service.addWorkspace({projectId:shop.projectId,name:'Browse',goal:'Check'});
 const sampleWorkspace=await service.addWorkspace({projectId:sample.projectId,name:'Admin',goal:'Check'});
 for(const [runId,report] of [
  ['shop-new',{targetUrl:'https://www.example.com/',startedAt:'2026-01-01T00:00:00Z',endedAt:'2026-01-03T00:00:00Z'}],
  ['sample-image',{imageSource:{kind:'image',fileName:'admin.png'},startedAt:'2026-01-02T00:00:00Z'}],
  ['shop-old',{targetUrl:'https://www.example.com/',startedAt:'2025-12-31T00:00:00Z'}],
 ] as const){
  const directory=resolve(root,runId);
  await mkdir(directory);
  await writeFile(resolve(directory,'report.json'),JSON.stringify({runId,status:'completed',...report}));
 }
 const repository=new ReportRepository(root);
 const reportIds=new Map((await repository.list()).reports.map(report=>[report.runId,report.id]));
 const attach=(workspaceId:string,runId:string,expectedVersion:number)=>
  service.attachWorkspaceReport(workspaceId,{reportId:reportIds.get(runId),expectedVersion},id=>repository.detail(id));
 const attached=await attach(shopWorkspace.workspaceId,'shop-new',shopWorkspace.version);
 await attach(shopWorkspace.workspaceId,'shop-old',attached.version);
 await attach(sampleWorkspace.workspaceId,'sample-image',sampleWorkspace.version);
 assert.equal((await service.workspace(shopWorkspace.workspaceId)).workspace.latestReportId,reportIds.get('shop-old'));

 const vite=await createViteServer({configFile:resolve('viewer/vite.config.ts'),server:{middlewareMode:true,hmr:false,ws:false}});
 const server=createViewerServer(repository,resolve('viewer'),service,vite.middlewares);
 server.listen(0,'127.0.0.1');
 await once(server,'listening');
 const base=`http://127.0.0.1:${(server.address() as {port:number}).port}`;
 const browser=await chromium.launch({ignoreDefaultArgs:['--hide-scrollbars'],args:['--disable-features=OverlayScrollbar']});
 const page=await browser.newPage({viewport:{width:320,height:844},hasTouch:true});
 const titles=()=>page.locator('.review-project-grid h2').allTextContents();
 const sort=page.getByRole('combobox',{name:'정렬',exact:true});
 const reportFilter=page.getByRole('combobox',{name:'보고서',exact:true});
 async function choose(control:Locator,label:string){
  await control.tap();
  await page.getByRole('option',{name:label,exact:true}).tap();
 }
 try{
  const catalog=await(await page.request.get(base+'/api/review-projects?view=catalog')).json();
  assert.ok(!('projectByReport' in catalog));
  assert.ok(!('postAllowedHosts' in catalog.projects[0]));
  await page.goto(base+'/?view=projects');
  await page.getByRole('heading',{name:empty.name,exact:true}).waitFor();
  assert.deepEqual(await titles(),[shop.name,sample.name,empty.name]);
  await sort.press('Enter');
  await page.getByRole('option',{name:'이름 오름차순',exact:true}).waitFor();
  await page.waitForFunction(()=>document.activeElement?.getAttribute('role')==='option');
  await page.keyboard.press('ArrowDown');
  await page.waitForFunction(()=>document.activeElement?.textContent?.trim()==='이름 내림차순');
  await page.keyboard.press('Enter');
  await page.getByRole('listbox').waitFor({state:'hidden'});
  assert.deepEqual(await titles(),[empty.name,sample.name,shop.name]);
  await choose(sort,'최근 생성순');
  assert.deepEqual(await titles(),[empty.name,sample.name,shop.name]);
  await choose(sort,'최근 보고서순');
  assert.deepEqual(await titles(),[shop.name,sample.name,empty.name]);
  const icons=page.locator('.review-project-card img');
  await page.waitForFunction(()=>[...document.querySelectorAll<HTMLImageElement>('.review-project-card img')].filter(img=>img.complete&&img.naturalWidth>0).length===2);
  assert.deepEqual(await icons.evaluateAll(images=>images.map(image=>image.getAttribute('src'))),['/ui-review-agent-icon.svg','/ui-review-agent-icon.svg']);
  assert.equal(await page.getByRole('link',{name:/Zulu/}).locator('.project-initial').textContent(),'Z');
  await choose(reportFilter,'보고서 있음');
  assert.deepEqual(await titles(),[shop.name,sample.name]);
  await page.getByRole('searchbox',{name:'프로젝트 검색'}).fill('sAMPLe');
  assert.deepEqual(await titles(),[sample.name]);
  await choose(reportFilter,'보고서 없음');
  await page.getByText('검색과 필터에 맞는 프로젝트가 없습니다.').waitFor();
  await page.getByRole('searchbox',{name:'프로젝트 검색'}).clear();
  assert.deepEqual(await titles(),[empty.name]);
  assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false);
  const desktop=await browser.newPage({viewport:{width:1440,height:380}});
  const desktopSort=desktop.getByRole('combobox',{name:'정렬',exact:true});
  await desktop.goto(base+'/?view=projects');
  await desktop.getByRole('heading',{name:empty.name,exact:true}).waitFor();
  const catalogBounds=()=>desktop.locator('.review-project-main').evaluate(main=>{
   const {x,width}=main.getBoundingClientRect();
   return {x,width};
  });
  assert.equal(await desktop.evaluate(()=>document.documentElement.scrollHeight>innerHeight),true);
  const before=await catalogBounds();
  await desktopSort.press('Enter');
  await desktop.getByRole('listbox').waitFor();
  assert.deepEqual(await catalogBounds(),before);
  await desktop.keyboard.press('ArrowDown');
  await desktop.keyboard.press('Escape');
  await desktop.waitForFunction(()=>document.activeElement?.classList.contains('gc-select'));
  assert.equal(await desktopSort.evaluate(trigger=>trigger===document.activeElement),true);
  assert.match(await desktopSort.textContent()??'',/이름 오름차순/);
  await page.route('**/ui-review-agent-icon.svg',route=>route.abort());
  await page.reload();
  await page.getByRole('link',{name:/Example Shop/}).locator('.project-initial').getByText('E',{exact:true}).waitFor();
 }finally{
  await browser.close();
  await service.close();
  server.closeAllConnections();
  await new Promise<void>(done=>server.close(()=>done()));
  await vite.close();
  await rm(root,{recursive:true,force:true});
 }
});
