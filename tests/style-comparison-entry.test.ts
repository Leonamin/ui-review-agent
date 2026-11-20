import {readStoredReviewTask} from './helpers/review-state.js';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {once} from 'node:events';
import {mkdir,mkdtemp,rm,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {resolve} from 'node:path';
import test from 'node:test';
import {setTimeout as wait} from 'node:timers/promises';
import {chromium} from 'playwright';
import {createServer as createViteServer} from 'vite';
import type {inspect,ReviewRuntimeOptions} from '../src/core.js';
import {ReviewService} from '../src/review-service.js';
import type {RunSpec} from '../src/types.js';
import {createViewerServer} from '../viewer/server/http.js';
import {ReportRepository} from '../viewer/server/repository.js';

async function waitUntil(check:()=>Promise<boolean>) {
 const until=Date.now()+5000;
 do {
  if(await check())return;
  await wait(20);
 } while(Date.now()<until);
 assert.fail('Review did not finish');
}

function makeEngine(calls:Array<{spec:RunSpec;runtime:ReviewRuntimeOptions|undefined}>,shouldFailFirst=false):typeof inspect {
 return (async (spec:RunSpec,output:string,runtime?:ReviewRuntimeOptions)=>{
  calls.push({spec,runtime});
  if(shouldFailFirst&&calls.length===1)throw new Error('Fixture navigation failed');
  const runId=randomUUID(),runDir=resolve(output,runId),timestamp=new Date().toISOString();
  await mkdir(runDir,{recursive:true});
  const result={runId,status:'completed',provider:spec.evaluator,targetUrl:spec.targetUrl,startedAt:timestamp,endedAt:timestamp,
   observations:[],evidence:[],findings:[],verificationCandidates:[],limitations:[]};
  await writeFile(resolve(runDir,'report.json'),JSON.stringify(result));
  return {result,runDir};
 }) as typeof inspect;
}

const referenceUrl='https://app.example.test/?view=projects';
const comparisonUrl='https://app.example.test/?view=reports';

test('comparison queue persists an isolated rules-only pair across restart, retry and revision',async()=>{
 const root=await mkdtemp(resolve(tmpdir(),'comparison-queue-'));
 const calls:Array<{spec:RunSpec;runtime:ReviewRuntimeOptions|undefined}>=[];
 const engine=makeEngine(calls,true);
 let service=new ReviewService(root,{inspect:engine});
 try{
  await service.start();
  await service.updateSettings({revision:0,defaultEvaluator:'claude',providers:{claude:{model:'sonnet'}}});
  const target={kind:'url',name:'목록 검색',url:referenceUrl,comparisonUrl};
  const input={submissionId:randomUUID(),title:'두 화면 스타일',purpose:'검색창 비교',targets:[target]};
  await assert.rejects(service.submit({...input,targets:[{...target,comparisonUrl:'https://elsewhere.test/'}]}),/같은 사이트/);
  await assert.rejects(service.submit({...input,targets:[{...target,comparisonUrl:referenceUrl}]}),/서로 다른/);
  await assert.rejects(service.submit({...input,targets:[{...target,comparisonUrl:comparisonUrl+'x'.repeat(2048)}]}),/2048/);
  await assert.rejects(service.submit({...input,targets:[{...target,shouldWaitForStart:true}]}),/함께 지정/);
  await assert.rejects(service.submit({...input,options:{evaluator:'claude'}}),/함께 지정/);
  const accepted=await service.submit(input);
  const {taskId}=accepted.task;
  const [stored]=accepted.revision.targets;
  await waitUntil(async()=> (await readStoredReviewTask(service, taskId)).revisions[0].targets[0].attempts[0].status==='failed');
  await service.close();
  service=new ReviewService(root,{inspect:engine});
  await service.start();
  const repeated=await service.submit(input);
  assert.equal(repeated.revision.revisionId,accepted.revision.revisionId);
  assert.equal(repeated.revision.options.evaluator,'rules-only');
  assert.deepEqual(repeated.revision.targets[0].kind==='url'&&repeated.revision.targets[0].comparisonUrl,comparisonUrl);
  await service.retry(taskId,repeated.revision.revisionId,stored.targetId,randomUUID(),stored.attempts[0].attemptId);
  await waitUntil(async()=> (await readStoredReviewTask(service, taskId)).revisions[0].targets[0].attempts.at(-1)?.status==='completed');
  await assert.rejects(service.submit({...input,submissionId:randomUUID(),targets:[{...target,comparisonUrl:undefined,targetId:stored.targetId}]},taskId),/함께 지정/);
  const revised=await service.submit({...input,submissionId:randomUUID(),targets:[{...target,targetId:stored.targetId}]},taskId);
  await waitUntil(async()=> (await readStoredReviewTask(service, taskId)).revisions[1].targets[0].attempts[0].status==='completed');
  assert.equal(revised.revision.targets[0].targetId,stored.targetId);
  assert.equal(calls.length,3);
  for(const {spec,runtime} of calls) {
   assert.deepEqual(spec.autoStyleComparison,{comparisonUrl});
   assert.equal(spec.targetUrl,referenceUrl);
   assert.equal(spec.evaluator,'rules-only');
   assert.equal(spec.model,undefined);
   assert.equal(spec.stateDiscovery,undefined);
   assert.equal(spec.hasMutationPermission,false);
   assert.equal(runtime?.shouldDetectRedirectedLogin,false);
  }
  const ordinary=await service.submit({...input,submissionId:randomUUID(),targets:[{...target,comparisonUrl:undefined}]});
  assert.equal(ordinary.revision.options.evaluator,'claude');
 }finally{
  await service.close();
  await rm(root,{recursive:true,force:true});
 }
});

test('workspace accepts two URLs from the dashboard and repeats the comparison with both prefilled',async()=>{
 const root=await mkdtemp(resolve(tmpdir(),'comparison-dashboard-'));
 const calls:Array<{spec:RunSpec;runtime:ReviewRuntimeOptions|undefined}>=[];
 const service=new ReviewService(root,{inspect:makeEngine(calls)});
 await service.start();
 const project=await service.addProject({name:'스타일 비교 프로젝트'});
 await service.updateProjectPostHosts(project.projectId,{expectedVersion:project.version,postAllowedHosts:['app.example.test']});
 const workspace=await service.addWorkspace({projectId:project.projectId,name:'스타일 비교',goal:'검색 입력 비교'});
 const vite=await createViteServer({configFile:resolve('viewer/vite.config.ts'),server:{middlewareMode:true,hmr:false,ws:false}});
 const server=createViewerServer(new ReportRepository(root),resolve('viewer'),service,vite.middlewares);
 server.listen(0,'127.0.0.1');
 await once(server,'listening');
 const {port}=server.address() as {port:number};
 const browser=await chromium.launch();
 try{
  const page=await browser.newPage();
  await page.goto(`http://127.0.0.1:${port}/?workspace=${workspace.workspaceId}`);
  await page.getByRole('combobox',{name:'시작할 자료'}).click();
  await page.getByRole('option',{name:'화면 스타일 비교'}).click();
  await page.getByLabel('기준 화면 URL').fill(referenceUrl);
  await page.getByLabel('비교 화면 URL').fill(comparisonUrl);
  assert.equal(await page.getByRole('button',{name:'로그인 정보 입력'}).count(),0);
  await page.getByRole('button',{name:'스타일 비교 시작'}).click();
  await waitUntil(async()=>!!(await service.workspace(workspace.workspaceId)).workspace.latestReportId);
  const detail=await service.workspace(workspace.workspaceId);
  assert.equal(detail.requests.length,1);
  const [request]=detail.requests;
  assert.equal(request.comparisonUrl,comparisonUrl);
  assert.equal(request.options.evaluator,'rules-only');
  assert.equal(calls[0].spec.projectPostPolicy,undefined);
  assert.equal(calls[0].runtime?.canSendProjectPost,undefined);
  const parentReportId=detail.workspace.latestReportId!;
  await assert.rejects(service.submitWorkspaceFollowup(workspace.workspaceId,{submissionId:randomUUID(),parentReportId,instruction:'다시 검토'},async()=>{
   assert.fail('Comparison reports must not silently replay the reference URL');
  }),/스타일 비교/);

  await page.goto(`http://127.0.0.1:${port}/?workspace=${workspace.workspaceId}&report=${parentReportId}&tab=compose`);
  const reviewTab=page.getByRole('tab',{name:'검토',exact:true});
  const composer=page.getByRole('tabpanel',{name:'검토',exact:true});
  await composer.getByRole('heading',{name:'화면 스타일 다시 비교'}).waitFor();
  assert.equal(await page.getByRole('button',{name:'추가 검토',exact:true}).count(),0);
  assert.equal(await composer.getByRole('button',{name:'검증 요청',exact:true}).count(),0);
  assert.equal(await composer.getByRole('button',{name:'집중 재검토 요청',exact:true}).count(),0);
  assert.equal(await page.getByRole('dialog').count(),0);
  assert.equal(await composer.getByLabel('기준 화면 URL').inputValue(),referenceUrl);
  const comparisonInput=composer.getByLabel('비교 화면 URL');
  assert.equal(await comparisonInput.inputValue(),comparisonUrl);
  const draftUrl='https://app.example.test/?view=other';
  await comparisonInput.fill(draftUrl);
  await page.getByRole('tab',{name:'요약',exact:true}).click();
  assert.equal(await comparisonInput.isVisible(),false);
  await reviewTab.click();
  assert.equal(await comparisonInput.inputValue(),draftUrl);
  await composer.getByRole('button',{name:'입력 되돌리기'}).click();
  assert.equal(await comparisonInput.inputValue(),comparisonUrl);
  for(const requestCount of [2,3]){
   await composer.getByRole('button',{name:'스타일 비교 시작'}).click();
   await waitUntil(async()=> (await service.workspace(workspace.workspaceId)).requests.length===requestCount&&calls.length===requestCount);
   assert.deepEqual(calls[requestCount-1].spec.autoStyleComparison,{comparisonUrl});
  }
  const comparisonUrls=[comparisonUrl,'https://app.example.test/settings','https://app.example.test/activity','https://app.example.test/inbox'];
  for(const [index,url] of comparisonUrls.slice(1).entries()){
   await composer.getByRole('button',{name:'비교 화면 추가'}).click();
   await composer.getByLabel(`비교 화면 ${index+2} URL`).fill(url);
  }
  assert.equal(await composer.getByRole('button',{name:'비교 화면 추가'}).count(),0);
  await composer.getByRole('button',{name:'스타일 비교 시작'}).click();
  await waitUntil(async()=> (await service.workspace(workspace.workspaceId)).requests.length===4&&calls.length===4);
  assert.deepEqual(calls[3].spec.autoStyleComparison,{comparisonUrls});
  const batch=(await service.workspace(workspace.workspaceId)).requests[3];
  assert.deepEqual(batch.comparisonUrls,comparisonUrls);
  assert.equal(batch.options.evaluator,'rules-only');

  await composer.getByRole('button',{name:'로그인 후 비교'}).click();
  await waitUntil(async()=>calls.length===5);
  assert.equal(calls[4].spec.isHeaded,true);
  assert.equal(calls[4].spec.shouldWaitForLogin,true);
  assert.equal(calls[4].runtime?.shouldResumeOnStyleReference,true);
  assert.equal(calls[4].runtime?.credentials,undefined);
  assert.equal(calls[4].spec.hasMutationPermission,false);

 }finally{
  await browser.close();
  await service.close();
  server.closeAllConnections();
  await new Promise<void>(done=>server.close(()=>done()));
  await vite.close();
  await rm(root,{recursive:true,force:true});
 }
});
