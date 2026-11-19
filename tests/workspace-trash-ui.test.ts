import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {once} from 'node:events';
import {mkdir,mkdtemp,rm,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {resolve} from 'node:path';
import {chromium} from 'playwright';
import {createServer as createViteServer} from 'vite';
import {ReviewService} from '../src/review-service.js';
import {createViewerServer} from '../viewer/server/http.js';
import {ReportRepository} from '../viewer/server/repository.js';

test('workspace trash requires confirmation and restores the workspace and its report from the mobile viewer',async t=>{
 const root=await mkdtemp(resolve(tmpdir(),'workspace-trash-ui-'));
 const service=new ReviewService(root);
 const repository=new ReportRepository(root);
 let closeViewer:()=>Promise<void>=async()=>{};
 t.after(async()=>{
  await closeViewer();
  await service.close();
  await rm(root,{recursive:true,force:true});
 });
 await service.start();
 const project=await service.addProject({name:'합성 제품'});
 const workspace=await service.addWorkspace({projectId:project.projectId,name:'휴지통 테스트 화면',goal:'복원 확인'});
 const runDir=resolve(root,'fixture');
 await mkdir(runDir);
 await writeFile(resolve(runDir,'report.json'),JSON.stringify({
  runId:'fixture',targetUrl:'https://example.test/trash',status:'completed',
  startedAt:new Date().toISOString(),observations:[{pageTitle:'복원할 보고서',url:'https://example.test/trash'}],
 }));
 const reportId=createHash('sha256').update('fixture/report.json').digest('hex');
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
 const browser=await chromium.launch();
 try{
  const page=await browser.newPage({viewport:{width:390,height:844}});
  const errors:string[]=[];
  page.on('pageerror',error=>errors.push(error.message));
  await page.goto(`${base}/?workspace=${workspace.workspaceId}`);
  const manage=page.getByRole('button',{name:'관리',exact:true});
  const openTrashDialog=async()=>{
   await manage.click();
   await page.getByRole('menuitem',{name:'휴지통으로 이동',exact:true}).click();
  };
  await openTrashDialog();
  const dialog=page.getByRole('dialog',{name:'작업공간을 휴지통으로 이동할까요?'});
  await dialog.getByText('휴지통 테스트 화면').waitFor();
  await page.waitForFunction(()=>document.activeElement?.textContent==='취소');
  await page.keyboard.press('Escape');
  await dialog.waitFor({state:'hidden'});
  await page.waitForFunction(()=>document.activeElement?.textContent==='관리');
  assert.equal((await service.workspace(workspace.workspaceId)).workspace.workspaceId,workspace.workspaceId);

  const moveUrl=`${base}/api/review-workspaces/${workspace.workspaceId}/trash`;
  await page.route(moveUrl,route=>route.fulfill({status:409,json:{error:'진행 중인 검토가 있습니다.'}}));
  await openTrashDialog();
  await dialog.getByRole('button',{name:'휴지통으로 이동',exact:true}).click();
  await dialog.getByRole('alert').filter({hasText:'진행 중인 검토가 있습니다.'}).waitFor();
  await page.unroute(moveUrl);
  await dialog.getByRole('button',{name:'휴지통으로 이동',exact:true}).click();
  await page.waitForURL(`${base}/?view=trash`);
  await page.getByRole('link',{name:'휴지통',exact:true}).and(page.locator('[aria-current="page"]')).waitFor();
  const item=page.getByRole('listitem').filter({hasText:'휴지통 테스트 화면'});
  await item.getByText('합성 제품 / 요청 0건 / 보고서 1건').waitFor();
  assert.ok(Date.parse((await item.locator('time').getAttribute('datetime'))!));
  assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>document.documentElement.clientWidth),false);
  assert.equal((await page.request.get(`${base}/api/reports/${reportId}`)).status(),404);

  await item.getByRole('button',{name:'휴지통 테스트 화면 복원'}).click();
  await page.getByText('휴지통이 비어 있습니다.').waitFor();
  await page.getByRole('status').filter({hasText:'휴지통 테스트 화면 작업공간을 복원했습니다.'}).waitFor();
  await page.waitForFunction(()=>document.activeElement?.textContent==='복원한 작업공간 열기');
  await page.getByRole('link',{name:'복원한 작업공간 열기'}).click();
  await page.getByRole('heading',{name:'휴지통 테스트 화면',exact:true}).waitFor();
  assert.equal((await page.request.get(`${base}/api/reports/${reportId}`)).status(),200);
  assert.deepEqual(errors,[]);
 }finally{
  await browser.close();
 }
});
