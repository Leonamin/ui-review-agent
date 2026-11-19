import test from 'node:test';
import assert from 'node:assert/strict';
import {once} from 'node:events';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {resolve} from 'node:path';
import {chromium} from 'playwright';
import {createServer as createViteServer} from 'vite';
import {ReviewService} from '../src/review-service.js';
import {createViewerServer} from '../viewer/server/http.js';
import {ReportRepository} from '../viewer/server/repository.js';

test('project settings bind an exact review site to its Supabase origin',async()=>{
 const root=await mkdtemp(resolve(tmpdir(),'supabase-auth-ui-'));
 const service=new ReviewService(root);
 await service.start();
 const project=await service.addProject({name:'로그인 출처 검증'});
 const vite=await createViteServer({configFile:resolve('viewer/vite.config.ts'),server:{middlewareMode:true,hmr:false,ws:false}});
 const server=createViewerServer(new ReportRepository(root),resolve('viewer'),service,vite.middlewares);
 server.listen(0,'127.0.0.1');
 await once(server,'listening');
 const base=`http://127.0.0.1:${(server.address() as {port:number}).port}`;
 const browser=await chromium.launch();
 const page=await browser.newPage({viewport:{width:390,height:844}});
 const settings=page.locator('.project-supabase-auth');
 const manage=page.getByRole('button',{name:'관리',exact:true});
 const projectUrl=base+`/?project=${project.projectId}`;
 const loginUrl=projectUrl+'&manage=login';
 const target=settings.getByRole('textbox',{name:'검토 사이트 출처 1',exact:true});
 const origin=settings.getByRole('textbox',{name:'Supabase 출처 1',exact:true});
 const save=settings.getByRole('button',{name:'저장',exact:true});
 const edit=settings.getByRole('button',{name:'로그인 출처 수정',exact:true});
 const binding={targetOrigin:'https://app.example.com',origin:'https://project-ref.supabase.co'};
 async function readProject(){
  const response=await page.request.get(base+'/api/review-projects');
  assert.ok(response.ok());
  return (await response.json()).projects.find((item:{projectId:string})=>item.projectId===project.projectId);
 }

 try{
  await page.goto(loginUrl);
  await page.getByRole('dialog',{name:'Supabase 로그인 출처 0개'}).waitFor();
  await page.keyboard.press('Escape');
  await page.waitForURL(projectUrl);
  await page.waitForFunction(()=>document.activeElement?.textContent==='관리');
  await manage.click();
  await page.getByRole('menuitem',{name:'Supabase 로그인 출처 0개',exact:true}).click();
  await page.waitForURL(loginUrl);
  await edit.click();
  const remove=settings.getByRole('button',{name:'로그인 출처 연결 1 삭제',exact:true});
  const [targetBox,originBox,removeBox]=await Promise.all([target.boundingBox(),origin.boundingBox(),remove.boundingBox()]);
  assert(targetBox&&originBox&&removeBox);
  assert.ok(removeBox.y+removeBox.height<=targetBox.y,'group delete is above both fields');
  assert.ok(Math.abs(removeBox.x+removeBox.width-targetBox.x-targetBox.width)<1);
  assert.equal(targetBox.width,originBox.width);
  await target.fill(`${binding.targetOrigin}/products`);
  await origin.fill(binding.origin);
  await save.click();
  await settings.getByRole('alert').getByText('경로 없이',{exact:false}).waitFor();
  assert.deepEqual((await readProject()).supabaseAuthBindings,[]);

  await target.fill('https://APP.example.com/');
  await origin.fill('https://PROJECT-REF.supabase.co/');
  await save.click();
  await settings.getByRole('status').getByText('Supabase 로그인 출처를 저장했습니다.').waitFor();
  assert.deepEqual((await readProject()).supabaseAuthBindings,[binding]);
  assert.deepEqual((await readProject()).postAllowedHosts,[]);
  assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false);

  await page.reload();
  await page.getByRole('dialog',{name:'Supabase 로그인 출처 1개'}).waitFor();
  await settings.getByText(binding.origin,{exact:true}).waitFor();
  await edit.click();
  const active=await readProject();
  const replacement={...binding,origin:'https://replacement.supabase.co'};
  const response=await page.request.post(base+`/api/review-projects/${project.projectId}/supabase-auth-bindings`,{
   headers:{Origin:base},data:{supabaseAuthBindings:[replacement],expectedVersion:active.version},
  });
  assert.ok(response.ok(),await response.text());
  await settings.getByRole('button',{name:'로그인 출처 연결 1 삭제',exact:true}).click();
  await save.click();
  await settings.getByRole('alert').getByText('설정이 다른 곳에서 변경됐습니다.',{exact:false}).waitFor();
  assert.deepEqual((await readProject()).supabaseAuthBindings,[replacement]);
  await settings.getByRole('button',{name:'저장된 설정 다시 불러오기',exact:true}).click();
  await settings.getByText(replacement.origin,{exact:true}).waitFor();
  await edit.click();
  await settings.getByRole('button',{name:'로그인 출처 연결 1 삭제',exact:true}).click();
  await save.click();
  await settings.getByText('등록한 연결이 없습니다.').waitFor();
  assert.deepEqual((await readProject()).supabaseAuthBindings,[]);
 }finally{
  await browser.close();await service.close();server.closeAllConnections();
  await new Promise<void>(done=>server.close(()=>done()));await vite.close();
  await rm(root,{recursive:true,force:true});
 }
});
