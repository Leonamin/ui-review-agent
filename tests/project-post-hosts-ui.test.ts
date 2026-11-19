import test from 'node:test';
import assert from 'node:assert/strict';
import {once} from 'node:events';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {resolve} from 'node:path';
import {chromium} from 'playwright';
import {createServer as createViteServer} from 'vite';
import {ReviewService} from '../src/review-service.js';
import {ReportRepository} from '../viewer/server/repository.js';
import {createViewerServer} from '../viewer/server/http.js';

test('project host permissions are saved through the UI, cancellable, and safe against stale edits',async()=>{
 const root=await mkdtemp(resolve(tmpdir(),'project-post-hosts-ui-'));
 const service=new ReviewService(root);
 await service.start();
 const project=await service.addProject({name:'호스트 권한 검증'});
 const vite=await createViteServer({configFile:resolve('viewer/vite.config.ts'),server:{middlewareMode:true,hmr:false,ws:false}});
 const server=createViewerServer(new ReportRepository(root),resolve('viewer'),service,vite.middlewares);
 server.listen(0,'127.0.0.1');
 await once(server,'listening');
 const base=`http://127.0.0.1:${(server.address() as {port:number}).port}`;
 const browser=await chromium.launch();
 const page=await browser.newPage({viewport:{width:390,height:844}});
 const settings=page.locator('.project-post-hosts');
 const manage=page.getByRole('button',{name:'관리',exact:true});
 const projectUrl=base+`/?project=${project.projectId}`;
 const postUrl=projectUrl+'&manage=post';
 async function readProject(){
  const response=await page.request.get(base+'/api/review-projects');
  assert.ok(response.ok());
  return (await response.json()).projects.find((item:{projectId:string})=>item.projectId===project.projectId);
 }
 async function open(count:number){
  await manage.click();
  await page.getByRole('menuitem',{name:`POST 허용 호스트 ${count}개`,exact:true}).click();
  await page.waitForURL(postUrl);
 }
 async function edit(){
  await settings.getByRole('button',{name:'허용 호스트 수정',exact:true}).click();
 }
 try{
  await page.goto(projectUrl);
  assert.equal(await settings.count(),0);
  await open(0);
  await settings.getByText('모든 HTTPS 경로에 POST를 허용',{exact:true}).waitFor();
  await edit();
  const input=settings.getByRole('textbox',{name:'API 호스트 1',exact:true});
  const remove=settings.getByRole('button',{name:'API 호스트 1 삭제',exact:true});
  const [inputBox,removeBox]=await Promise.all([input.boundingBox(),remove.boundingBox()]);
  assert(inputBox&&removeBox);
  assert.ok(inputBox.x+inputBox.width<removeBox.x,'delete is next to the host input');
  assert.ok(Math.abs(inputBox.y+inputBox.height-removeBox.y-removeBox.height)<1);
  const save=settings.getByRole('button',{name:'저장',exact:true});
  await input.fill('https://api.example.com/path');
  await save.click();
  await settings.getByRole('alert').getByText('주소나 경로 없이',{exact:false}).waitFor();
  assert.deepEqual((await readProject()).postAllowedHosts,[]);
  await input.fill('discarded.example.com');
  page.once('dialog',dialog=>void dialog.dismiss());
  await page.keyboard.press('Escape');
  assert.equal(page.url(),postUrl);
  assert.equal(await input.inputValue(),'discarded.example.com');
  await page.goBack();
  await settings.waitFor({state:'hidden'});
  await page.waitForFunction(()=>document.activeElement?.textContent==='관리');
  await page.goForward();
  await settings.getByText('등록한 호스트가 없습니다.').waitFor();
  await edit();
  assert.equal(await input.inputValue(),'','browser Back discards the previous edit');
  await settings.getByRole('button',{name:'취소',exact:true}).click();
  assert.deepEqual((await readProject()).postAllowedHosts,[]);
  await edit();
  await input.fill('API.EXAMPLE.COM');
  await settings.getByRole('button',{name:'호스트 추가',exact:true}).click();
  await settings.getByRole('textbox',{name:'API 호스트 2',exact:true}).fill('other.example.com');
  await save.click();
  await settings.getByRole('status').getByText('POST 허용 호스트를 저장했습니다.').waitFor();
  assert.deepEqual((await readProject()).postAllowedHosts,['api.example.com','other.example.com']);
  await page.reload();
  await page.getByRole('dialog',{name:'POST 허용 호스트 2개'}).waitFor();
  await settings.getByText('api.example.com',{exact:true}).waitFor();
  await edit();
  const active=await readProject();
  const updated=await page.request.post(base+`/api/review-projects/${project.projectId}/post-hosts`,{
   headers:{Origin:base},data:{postAllowedHosts:['concurrent.example.com'],expectedVersion:active.version},
  });
  assert.ok(updated.ok(), await updated.text());
  await settings.getByRole('button',{name:'API 호스트 2 삭제',exact:true}).click();
  await save.click();
  await settings.getByRole('alert').getByText('설정이 다른 곳에서 변경됐습니다.',{exact:false}).waitFor();
  assert.deepEqual((await readProject()).postAllowedHosts,['concurrent.example.com']);
  await settings.getByRole('button',{name:'저장된 설정 다시 불러오기',exact:true}).click();
  await settings.getByText('concurrent.example.com',{exact:true}).waitFor();
  await edit();
  await settings.getByRole('button',{name:'API 호스트 1 삭제',exact:true}).click();
  await save.click();
  await settings.getByText('등록한 호스트가 없습니다.').waitFor();
  assert.deepEqual((await readProject()).postAllowedHosts,[]);
  assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false);
  await page.getByRole('dialog').getByRole('button',{name:'닫기',exact:true}).click();
  await page.waitForURL(projectUrl);
  await page.waitForFunction(()=>document.activeElement?.textContent==='관리');
 }finally{
  await browser.close();await service.close();server.closeAllConnections();
  await new Promise<void>(done=>server.close(()=>done()));await vite.close();await rm(root,{recursive:true,force:true});
 }
});
