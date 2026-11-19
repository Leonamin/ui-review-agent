import assert from 'node:assert/strict';
import {once} from 'node:events';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {resolve} from 'node:path';
import test from 'node:test';
import {chromium,type Locator} from 'playwright';
import {createServer as createViteServer} from 'vite';
import {measureFormRowAlignment} from '../src/group-alignment.js';
import {ReviewService} from '../src/review-service.js';
import {createViewerServer} from '../viewer/server/http.js';
import {ReportRepository} from '../viewer/server/repository.js';

async function box(control:Locator){
 const bounds=await control.boundingBox();
 assert(bounds);
 return bounds;
}

test('settings align the API controls on desktop and keep the mobile key action after its help',async()=>{
 const root=await mkdtemp(resolve(tmpdir(),'settings-layout-ui-'));
 const service=new ReviewService(root);
 await service.start();
 await service.updateSettings({defaultEvaluator:'openai-compatible',providers:{
  'openai-compatible':{baseUrl:'https://example.test/v1',model:'fixture-model',reasoningEffort:'high',apiFormat:'chat',apiKey:'fixture-key'},
 }});
 const vite=await createViteServer({configFile:resolve('viewer/vite.config.ts'),server:{middlewareMode:true,hmr:false,ws:false}});
 const server=createViewerServer(new ReportRepository(root),resolve('viewer'),service,vite.middlewares);
 server.listen(0,'127.0.0.1');
 await once(server,'listening');
 const base=`http://127.0.0.1:${(server.address() as {port:number}).port}`;
 const browser=await chromium.launch();
 try{
  const page=await browser.newPage({viewport:{width:1440,height:900}});
  await page.goto(base+'/?view=settings');
  const model=page.getByLabel(/^OpenAI Compatible API 모델/);
  const effort=page.getByRole('combobox',{name:'OpenAI Compatible API 추론 강도',exact:true});
  const key=page.getByLabel('API 키',{exact:true});
  const remove=page.getByRole('button',{name:'저장된 키 삭제',exact:true});
  await remove.waitFor();
  await page.evaluate(async()=>{await document.fonts.ready;window.scrollTo(0,document.documentElement.scrollHeight);});
  const [modelBox,effortBox,keyBox,removeBox]=await Promise.all([model,effort,key,remove].map(box));
  assert.equal(modelBox.y,effortBox.y);
  assert.equal(keyBox.y,removeBox.y);
  assert.deepEqual([modelBox.height,effortBox.height,keyBox.height,removeBox.height],[44,44,44,44]);
  const refs=await page.evaluateHandle(()=>Array.from(document.querySelectorAll('input, button, select')));
  const checks=(await measureFormRowAlignment(page,refs)).checks;
  await refs.dispose();
  assert(checks.some(check=>check.formPair==='field-select'&&check.members[0]?.visualBox.y===modelBox.y&&check.status==='passed'));
  assert(checks.some(check=>check.formPair==='field-action'&&check.members[0]?.visualBox.y===keyBox.y&&check.status==='passed'));
  await page.setViewportSize({width:390,height:844});
  const helpId=await key.getAttribute('aria-describedby');
  assert(helpId);
  const help=page.locator(`#${helpId}`);
  const [mobileModel,mobileEffort,mobileKey,mobileHelp,mobileRemove]=await Promise.all([model,effort,key,help,remove].map(box));
  assert(mobileEffort.y>mobileModel.y+mobileModel.height);
  assert(mobileHelp.y>=mobileKey.y+mobileKey.height&&mobileRemove.y>mobileHelp.y+mobileHelp.height);
  assert.equal(mobileRemove.x,mobileKey.x);
  assert(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth));
 }finally{
  await browser.close();
  await service.close();
  server.closeAllConnections();
  await new Promise<void>(done=>server.close(()=>done()));
  await vite.close();
  await rm(root,{recursive:true,force:true});
 }
});
