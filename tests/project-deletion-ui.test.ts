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

test('project deletion offers both scopes and restores the cascade as one trash entry',async t=>{
 const root=await mkdtemp(resolve(tmpdir(),'project-deletion-ui-'));
 const service=new ReviewService(root);
 const repository=new ReportRepository(root);
 let closeViewer:()=>Promise<void>=async()=>{};
 t.after(async()=>{
  await closeViewer();
  await service.close();
  await rm(root,{recursive:true,force:true});
 });
 await service.start();
 const moveProject=await service.addProject({name:'이동 테스트 프로젝트'});
 const cascadeProject=await service.addProject({name:'삭제 테스트 프로젝트'});
 const moveWorkspace=await service.addWorkspace({projectId:moveProject.projectId,name:'이동할 작업공간',goal:'소속과 보고서 보존 확인'});
 const cascadeWorkspace=await service.addWorkspace({projectId:cascadeProject.projectId,name:'복원할 작업공간',goal:'그룹 복원 확인'});
 const alreadyTrashed=await service.addWorkspace({projectId:cascadeProject.projectId,name:'기존 휴지통 작업공간',goal:'개별 휴지통 확인'});
 const existingTrash=await service.trashWorkspace(alreadyTrashed.workspaceId,{expectedVersion:alreadyTrashed.version});
 const runDirectory=resolve(root,'fixture');
 await mkdir(runDirectory);
 await writeFile(resolve(runDirectory,'report.json'),JSON.stringify({
  runId:'fixture',targetUrl:'https://example.test/screen',status:'completed',
  startedAt:new Date().toISOString(),observations:[{pageTitle:'이동 후에도 보존할 보고서',url:'https://example.test/screen'}],
 }));
 const reportId=createHash('sha256').update('fixture/report.json').digest('hex');
 await service.attachWorkspaceReport(moveWorkspace.workspaceId,{reportId,expectedVersion:moveWorkspace.version},id=>repository.followupSource(id));

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
  const manage=page.getByRole('button',{name:'관리',exact:true});
  const dialog=page.getByRole('dialog',{name:'리뷰 프로젝트 삭제'});
  async function openDeletion(){
   await manage.click();
   await page.getByRole('menuitem',{name:'프로젝트 삭제'}).click();
   await dialog.getByRole('radio',{name:'프로젝트만 삭제'}).waitFor();
  }

  await page.goto(`${base}/?project=${moveProject.projectId}&manage=delete`);
  await manage.waitFor();
  assert.equal(await dialog.count(),0,'only an app-created history entry opens deletion');
  await page.goto(`${base}/?project=${moveProject.projectId}`);
  await manage.click();
  await page.getByRole('menuitem',{name:'POST 허용 호스트 0개',exact:true}).click();
  const settings=page.getByRole('dialog',{name:'POST 허용 호스트 0개'});
  await settings.waitFor();
  await page.goBack();
  await settings.waitFor({state:'hidden'});
  await openDeletion();
  await page.goForward();
  assert.equal(await page.getByRole('dialog').count(),1);
  await dialog.getByRole('radio',{name:'프로젝트만 삭제'}).waitFor();
  const deleteButton=dialog.getByRole('button',{name:'프로젝트 삭제',exact:true});
  assert.equal(await deleteButton.isEnabled(),false);
  await page.waitForFunction(()=>document.activeElement?.textContent==='취소');
  await page.keyboard.press('Escape');
  await dialog.waitFor({state:'hidden'});
  await page.waitForFunction(()=>document.activeElement?.textContent==='관리');

  await openDeletion();
  await dialog.getByText('작업공간 1개 · 요청 0건 · 보고서 1건').waitFor();
  await dialog.getByText(/POST 허용 및 Supabase 로그인 권한은 해제됩니다/).waitFor();
  assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>document.documentElement.clientWidth),false);
  await dialog.getByRole('radio',{name:'프로젝트만 삭제'}).check();
  await deleteButton.click();
  await page.getByRole('heading',{name:'미분류',exact:true}).waitFor();
  await page.getByRole('link',{name:/이동할 작업공간/}).waitFor();
  assert.equal(await manage.count(),0);
  const context=await service.workspaceContext(reportId);
  assert.equal(context.workspace?.workspaceId,moveWorkspace.workspaceId);
  assert.equal(context.project?.isUncategorized,true);
  assert.equal((await page.request.get(`${base}/api/reports/${reportId}`)).status(),200);

  await page.goto(`${base}/?project=${cascadeProject.projectId}`);
  await openDeletion();
  await dialog.getByText(/이미 휴지통에 있는 작업공간 1개/).waitFor();
  await dialog.getByRole('radio',{name:'하위까지 포함 삭제'}).check();
  await dialog.getByRole('button',{name:'휴지통으로 이동'}).click();
  await page.waitForURL(`${base}/?view=trash`);
  const entry=page.getByRole('listitem').filter({hasText:cascadeProject.name});
  await entry.getByText('리뷰 프로젝트 / 작업공간 1개 / 요청 0건 / 보고서 0건').waitFor();
  assert.equal(await page.getByRole('listitem').count(),1);
  assert.equal((await page.request.get(`${base}/api/review-workspaces/${cascadeWorkspace.workspaceId}`)).status(),404);
  await entry.getByRole('button',{name:`${cascadeProject.name} 프로젝트 복원`}).click();
  const restoredProjectLink=page.getByRole('link',{name:'복원한 프로젝트 열기'});
  await restoredProjectLink.waitFor();
  const separateTrashEntry=page.getByRole('listitem').filter({hasText:alreadyTrashed.name});
  await separateTrashEntry.waitFor();
  assert.equal(await separateTrashEntry.locator('time').getAttribute('datetime'),existingTrash.expiresAt);
  await restoredProjectLink.click();
  await page.getByRole('link',{name:/복원할 작업공간/}).waitFor();

  await t.test('an older trash reload cannot bring back a restored workspace',{timeout:20_000},async()=>{
   const nextProject=await service.addProject({name:'연속 복원 테스트 프로젝트'});
   const preview=await service.projectDeletionPreview(nextProject.projectId);
   await service.deleteProject(nextProject.projectId,{mode:'cascade',scopeVersion:preview.scopeVersion});
   await page.goto(`${base}/?view=trash`);
   const restoreWorkspace=page.getByRole('button',{name:`${alreadyTrashed.name} 복원`,exact:true});
   await restoreWorkspace.waitFor();
   const {promise:staleSnapshot,resolve:captureSnapshot,reject:rejectSnapshot}=
    Promise.withResolvers<{workspaces:(typeof existingTrash)[]}>();
   const {promise:deliverSnapshot,resolve:releaseSnapshot}=Promise.withResolvers<void>();
   const {promise:deliveryFinished,resolve:finishDelivery}=Promise.withResolvers<void>();
   await page.route('**/api/review-workspace-trash',async route=>{
    try{
     const response=await route.fetch();
     captureSnapshot(await response.json());
     await deliverSnapshot;
     await route.fulfill({response});
    }catch(error){
     rejectSnapshot(error);
     throw error;
    }finally{
     finishDelivery();
    }
   },{times:1});
   try{
    await page.getByRole('button',{name:`${nextProject.name} 프로젝트 복원`,exact:true}).click();
    const {workspaces}=await staleSnapshot;
    assert.ok(workspaces.some(entry=>entry.workspace.workspaceId===alreadyTrashed.workspaceId));
    await restoreWorkspace.click();
    await page.getByRole('link',{name:'복원한 작업공간 열기',exact:true}).waitFor();
    await restoreWorkspace.waitFor({state:'hidden'});
    releaseSnapshot();
    await deliveryFinished;
    await page.evaluate(()=>new Promise<void>(done=>requestAnimationFrame(()=>requestAnimationFrame(()=>done()))));
    assert.equal((await service.trashedWorkspaces()).length,0);
    assert.equal(await restoreWorkspace.count(),0,'a stale list must not show the restored workspace');
   }finally{
    releaseSnapshot();
   }
  });
  assert.deepEqual(errors,[]);
 }finally{
  await browser.close();
 }
});
