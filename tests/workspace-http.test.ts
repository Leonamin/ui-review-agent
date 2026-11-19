import test from 'node:test';import assert from 'node:assert/strict';import {mkdtemp,rm,mkdir,writeFile} from 'node:fs/promises';import {tmpdir} from 'node:os';import {resolve} from 'node:path';import {once} from 'node:events';import {randomUUID} from 'node:crypto';import {ReviewService} from '../src/review-service.js';import {ReportRepository} from '../viewer/server/repository.js';import {createViewerServer} from '../viewer/server/http.js';import type {inspect} from '../src/core.js';
import type {ReportList} from '../viewer/features/reports/types.js';
import type {PublicWorkspaceDetail,PublicWorkspaceRequest} from '../src/workspace-contract.js';
import {readStoredReviewTasks} from './helpers/review-state.js';
import sharp from 'sharp';

function assertNoTaskIdentifiers(response: unknown) {
 assert.doesNotMatch(JSON.stringify(response), /"(?:taskId|revisionId|targetId)"\s*:/);
}

test('workspace HTTP enforces write origin, validates contracts, and connects initial and followup reports',async()=>{const root=await mkdtemp(resolve(tmpdir(),'workspace-http-'));const service=new ReviewService(root,{inspect:(async(_spec,out)=>{const runId=randomUUID(),runDir=resolve(out,runId);await mkdir(runDir,{recursive:true});const result={runId,status:'partial',endedAt:new Date().toISOString(),observations:[],evidence:[],findings:[],limitations:[]};await writeFile(resolve(runDir,'report.json'),JSON.stringify(result));return{result,runDir};}) as typeof inspect});await service.start();const server=createViewerServer(new ReportRepository(root),root,service);server.listen(0,'127.0.0.1');await once(server,'listening');const base='http://127.0.0.1:'+(server.address() as {port:number}).port;const post=(path:string,value:unknown,origin=base)=>fetch(base+path,{method:'POST',headers:{origin,'content-type':'application/json'},body:JSON.stringify(value)});try{assert.equal((await post('/api/review-projects',{name:'Test'},'https://evil.test')).status,403);assert.equal((await post('/api/review-projects',{name:'Test',extra:true})).status,400);const {project}=await(await post('/api/review-projects',{name:'Test'})).json();
assert.deepEqual(project.postAllowedHosts,[]);
const postPath=`/api/review-projects/${project.projectId}/post-hosts`;
const input={postAllowedHosts:[' API.EXAMPLE.TEST ','api.example.test'],expectedVersion:project.version};
assert.equal((await post(postPath,input,'https://evil.test')).status,403);
for(const host of ['https://api.example.test','api.example.test:443','*.example.test','127.0.0.1','localhost','api.example.test/path']){
    assert.equal((await post(postPath,{...input,postAllowedHosts:[host]})).status,400);
}
assert.equal((await post(postPath,{...input,postAllowedHosts:Array.from({length:11},(_,i)=>`host${i}.example.test`)})).status,400);
const saved=await post(postPath,input);assert.equal(saved.status,200);
const {project:updated}=await saved.json();
assert.deepEqual(updated.postAllowedHosts,['api.example.test']);
assert.equal(updated.version,project.version+1);
assert.equal((await post(postPath,{...input,postAllowedHosts:[]})).status,409);
assert.deepEqual(updated.supabaseAuthBindings,[]);
const supabasePath=`/api/review-projects/${project.projectId}/supabase-auth-bindings`;
const binding={targetOrigin:'https://example.test',origin:'https://exampleproject.supabase.co'};
const supabaseInput={supabaseAuthBindings:[binding],expectedVersion:updated.version};
assert.equal((await post(supabasePath,supabaseInput,'https://evil.test')).status,403);
for(const origin of ['http://exampleproject.supabase.co','https://*.supabase.co','https://exampleproject.supabase.co:443','https://exampleproject.supabase.co/auth','https://exampleproject.supabase.co.evil.test']){
 assert.equal((await post(supabasePath,{...supabaseInput,supabaseAuthBindings:[{...binding,origin}]})).status,400);
}
for(const targetOrigin of ['http://example.test','https://example.test/path','https://test@example.test','https://127.0.0.1','https://example.test?']){
 assert.equal((await post(supabasePath,{...supabaseInput,supabaseAuthBindings:[{...binding,targetOrigin}]})).status,400);
}
assert.equal((await post(supabasePath,{...supabaseInput,supabaseAuthBindings:[binding,{...binding,origin:'https://anotherproject.supabase.co'}]})).status,400);
const configured=await post(supabasePath,supabaseInput);assert.equal(configured.status,200);
const {project:withSupabase}=await configured.json();assert.deepEqual(withSupabase.supabaseAuthBindings,[binding]);
assert.equal(withSupabase.version,updated.version+1);
assert.equal((await post(supabasePath,supabaseInput)).status,409);
const {projects}=await(await fetch(base+'/api/review-projects')).json();assert.deepEqual(projects,[withSupabase]);
const namePrefix='가'.repeat(119);
const workspaceName=namePrefix+'💡 홈';
const {workspace}=await(await post('/api/review-workspaces',{projectId:project.projectId,name:workspaceName,goal:'Check navigation'})).json();
const reviewPath=`/api/review-workspaces/${workspace.workspaceId}/reviews`;
const target={kind:'url',url:'https://example.test/?scope=all#home'};
assert.equal((await post(reviewPath,{submissionId:randomUUID(),target:{...target,name:workspaceName}})).status,400);
const created=await post(reviewPath,{submissionId:randomUUID(),target});
assert.equal(created.status,202);
const {workspace:createdWorkspace,request:createdRequest}=await created.json();
assertNoTaskIdentifiers(createdRequest);
const createdTask=(await readStoredReviewTasks(service)).find(task=>task.revisions.some(revision=>revision.workspaceRequestId===createdRequest.requestId));
assert.ok(createdTask);
assert.equal(createdWorkspace.name,workspaceName);
assert.equal(createdTask.title,workspaceName);
assert.equal(createdTask.revisions[0].targets[0].name,namePrefix);
let detail:any;for(let i=0;i<100;i++){detail=await(await fetch(base+`/api/review-workspaces/${workspace.workspaceId}`)).json();if(detail.workspace.latestReportId)break;await new Promise(r=>setTimeout(r,10));}assert.equal(detail.requests.length,1);const context=await(await fetch(base+'/api/workspace-context?reportId='+detail.workspace.latestReportId)).json();assert.equal(context.workspace.workspaceId,workspace.workspaceId);const followup=await post(`/api/review-workspaces/${workspace.workspaceId}/requests`,{submissionId:randomUUID(),parentReportId:detail.workspace.latestReportId,instruction:'Try a category'});assert.equal(followup.status,202);const body=await followup.json();assertNoTaskIdentifiers(body);assert.equal(body.request.source.targetUrl,'https://example.test/?scope=all#home');assert.match(body.request.source.reportSha256,/^[a-f0-9]{64}$/);assert.equal((await post(`/api/review-workspaces/${workspace.workspaceId}/requests`,{submissionId:randomUUID(),parentReportId:'a'.repeat(64),instruction:'Other'})).status,409);}finally{await service.close();server.closeAllConnections();await new Promise<void>((done,reject)=>server.close(e=>e?reject(e):done()));await rm(root,{recursive:true,force:true});}});

test('workspace HTTP hides task identifiers while retaining attempt state and report links', async()=>{
 const root=await mkdtemp(resolve(tmpdir(),'workspace-public-http-'));
 const {promise:allowCompletion,resolve:finish}=Promise.withResolvers<void>();
 const service=new ReviewService(root,{inspect:(async(_spec,out)=>{
  await allowCompletion;
  const runId=randomUUID(),runDir=resolve(out,runId);
  await mkdir(runDir,{recursive:true});
  const result={runId,status:'partial',evaluation:{status:'failed'},endedAt:new Date().toISOString(),observations:[],evidence:[],findings:[],limitations:[]};
  await writeFile(resolve(runDir,'report.json'),JSON.stringify(result));
  return {result,runDir};
 }) as typeof inspect});
 await service.start();
 const server=createViewerServer(new ReportRepository(root),root,service);
 server.listen(0,'127.0.0.1');
 await once(server,'listening');
 const base=`http://127.0.0.1:${(server.address() as {port:number}).port}`;
 const get=(path:string)=>fetch(base+path);
 const post=(path:string,value:unknown)=>fetch(base+path,{
  method:'POST',headers:{origin:base,'content-type':'application/json'},body:JSON.stringify(value),
 });
 const readPublicDetail=async(path:string):Promise<PublicWorkspaceDetail>=>{
  const response=await get(path);
  assert.equal(response.status,200);
  const detail=await response.json() as PublicWorkspaceDetail;
  assertNoTaskIdentifiers(detail);
  return detail;
 };
 const readAcceptedRequest=async(response:Response,expectedStatus=202):Promise<PublicWorkspaceRequest>=>{
  assert.equal(response.status,expectedStatus);
  const body=await response.json() as {request:PublicWorkspaceRequest};
  assertNoTaskIdentifiers(body);
  return body.request;
 };
 try{
  const project=await service.addProject({name:'Public review'});
  const workspace=await service.addWorkspace({projectId:project.projectId,name:'Original',goal:'Check navigation'});
  const destination=await service.addWorkspace({projectId:project.projectId,name:'Destination',goal:'Check links'});
  const workspacePath=`/api/review-workspaces/${workspace.workspaceId}`;
  const destinationPath=`/api/review-workspaces/${destination.workspaceId}`;
  const input={submissionId:randomUUID(),target:{kind:'url',url:'https://example.test/',shouldWaitForStart:true}};
  const accepted=await readAcceptedRequest(await post(workspacePath+'/reviews',input));
  const requestPath=`/api/workspace-requests/${accepted.requestId}`;
  const attempt=accepted.attempts[0];
  assert.equal(attempt.status,'awaiting-start');
  assert.equal((await readAcceptedRequest(await post(workspacePath+'/reviews',input))).requestId,accepted.requestId);
  assert.deepEqual((await readPublicDetail(workspacePath)).requests[0].attempts,[attempt]);

  const started=await post(requestPath+'/start',{attemptId:attempt.attemptId});
  assert.equal(started.status,202);
  assert.equal((await started.json()).attempt.attemptId,attempt.attemptId);
  const waitForStatus=async(status:'running'|'completed')=>{
   for(let remaining=100;remaining>0;remaining--){
    const attempt=(await readPublicDetail(workspacePath)).requests[0].attempts[0];
    if(attempt.status===status)return attempt;
    await new Promise(resolve=>setTimeout(resolve,10));
   }
   assert.fail(`Expected workspace attempt to be ${status}`);
  };
  assert.equal((await waitForStatus('running')).attemptId,attempt.attemptId);
  finish();
  const completed=await waitForStatus('completed');
  assert.equal(completed.attemptId,attempt.attemptId);
  const {reportId}=completed;
  assert.ok(reportId);
  const reportPath=`/api/reports/${reportId}`;
  const opened=await get(reportPath);
  assert.equal(opened.status,200);
  const report=await opened.json();
  assert.equal(report.id,reportId);
  assert.equal(report.taskContext.attemptNumber,1);

  const retryInput={submissionId:randomUUID(),attemptId:attempt.attemptId};
  const retried=await readAcceptedRequest(await post(requestPath+'/retry',retryInput));
  assert.deepEqual(retried.attempts[0],completed);
  const retry=retried.attempts.at(-1)!;
  assert.equal(retry.status,'awaiting-start');
  assert.notEqual(retry.attemptId,attempt.attemptId);
  assert.equal((await readAcceptedRequest(await post(requestPath+'/retry',retryInput))).attempts.at(-1)?.attemptId,retry.attemptId);
  const cancelled=await post(requestPath+'/cancel',{attemptId:retry.attemptId});
  assert.equal(cancelled.status,200);
  assert.equal((await cancelled.json()).attempt.status,'cancelled');

  const current=await readPublicDetail(workspacePath);
  const moved=await readAcceptedRequest(await post(requestPath+'/membership',{
   workspaceId:destination.workspaceId,expectedVersion:current.workspace.version,
  }),200);
  assert.equal(moved.requestId,accepted.requestId);
  assert.equal(moved.workspaceId,destination.workspaceId);
  assert.deepEqual(await (await get(reportPath)).json(),report);
  const {workspace:linked}=await (await get('/api/workspace-context?reportId='+reportId)).json();
  assert.equal(linked.workspaceId,destination.workspaceId);

  const followupInput={submissionId:randomUUID(),parentReportId:reportId,instruction:'Inspect navigation',shouldWaitForStart:true};
  const followup=await readAcceptedRequest(await post(destinationPath+'/requests',followupInput));
  assert.equal(followup.parentReportId,reportId);
  assert.equal((await readAcceptedRequest(await post(destinationPath+'/requests',followupInput))).requestId,followup.requestId);
  const png=await sharp({create:{width:8,height:8,channels:3,background:'white'}}).png().toBuffer();
  const uploaded=await post('/api/review-assets',{fileName:'test.png',base64:png.toString('base64')});
  assert.equal(uploaded.status,201);
  const {asset}=await uploaded.json();
  const handoffPath=`/api/workspace-requests/${followup.requestId}/images`;
  const handoffInput={submissionId:randomUUID(),assetId:asset.assetId,comment:'Use this screenshot'};
  const handoff=await readAcceptedRequest(await post(handoffPath,handoffInput));
  assert.equal(handoff.parentRequestId,followup.requestId);
  assert.equal((await readAcceptedRequest(await post(handoffPath,handoffInput))).requestId,handoff.requestId);
  assert.equal((await readPublicDetail(destinationPath)).requests.length,3);
 }finally{
  finish();
  await service.close();
  server.closeAllConnections();
  await new Promise<void>((done,reject)=>server.close(error=>error?reject(error):done()));
  await rm(root,{recursive:true,force:true});
 }
});

test('workspace trash hides cached reports and restores their existing links',async()=>{
 const root=await mkdtemp(resolve(tmpdir(),'workspace-trash-http-'));
 const png=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jF9sAAAAASUVORK5CYII=','base64');
 const service=new ReviewService(root,{inspect:(async(_spec,out)=>{
  const runId=randomUUID(),runDir=resolve(out,runId);
  await mkdir(runDir,{recursive:true});
  await writeFile(resolve(runDir,'screen.png'),png);
  const result={
   runId,status:'completed',endedAt:new Date().toISOString(),observations:[],findings:[],limitations:[],
   evidence:[{kind:'screenshot',evidenceId:'screen',relativePath:'screen.png'}],
  };
  await writeFile(resolve(runDir,'report.json'),JSON.stringify(result));
  return {result,runDir};
 }) as typeof inspect});
 await service.start();
 const server=createViewerServer(new ReportRepository(root),root,service);
 server.listen(0,'127.0.0.1');
 await once(server,'listening');
 const base='http://127.0.0.1:'+(server.address() as {port:number}).port;
 const get=(path:string)=>fetch(base+path);
 const post=(path:string,value:unknown,origin?:string)=>fetch(base+path,{
  method:'POST',headers:{...(origin?{origin}:{}),'content-type':'application/json'},body:JSON.stringify(value),
 });
 try{
  const {project}=await (await post('/api/review-projects',{name:'Trash test'},base)).json();
  const {workspace}=await (await post('/api/review-workspaces',{projectId:project.projectId,name:'Review',goal:'Check navigation'},base)).json();
  const workspacePath='/api/review-workspaces/'+workspace.workspaceId;
  assert.equal((await post(workspacePath+'/reviews',{submissionId:randomUUID(),target:{kind:'url',url:'https://example.test/'}},base)).status,202);
  let detail;
  for(let i=0;i<100;i++){
   detail=await (await get(workspacePath)).json();
   if(detail.workspace.latestReportId)break;
   await new Promise(resolve=>setTimeout(resolve,10));
  }
  const reportId=detail.workspace.latestReportId;
  assert.match(reportId,/^[a-f0-9]{64}$/);
  const reportPath='/api/reports/'+reportId;
  const response=await get(reportPath);
  assert.equal(response.status,200);
  const report=await response.json();
  const imagePath=report.images[0].url;
  assert.equal((await get(imagePath)).status,200);

  const trashPath=workspacePath+'/trash';
  const restorePath=workspacePath+'/restore';
  const version={expectedVersion:detail.workspace.version};
  assert.equal((await post(trashPath,version)).status,403);
  assert.equal((await post(trashPath,version,'https://evil.test')).status,403);
  assert.equal((await post(trashPath,{expectedVersion:version.expectedVersion+1},base)).status,409);
  const result=await post(trashPath,version,base);
  assert.equal(result.status,200);
  const {entry}=await result.json();
  assert.equal(entry.workspace.workspaceId,workspace.workspaceId);
  assert.equal(entry.reportCount,1);
  assert.equal(Date.parse(entry.expiresAt)-Date.parse(entry.trashedAt),14*24*60*60*1000);
  assert.deepEqual(await (await get('/api/review-workspace-trash')).json(),{workspaces:[entry]});
  assert.equal((await get(workspacePath)).status,404);
  assert.deepEqual(await (await get('/api/review-workspaces')).json(),{workspaces:[]});
  assert.equal((await get(reportPath)).status,404);
  assert.equal((await get(imagePath)).status,404);
  assert.equal((await get(reportPath+'/recommendation')).status,404);
  assert.deepEqual(await (await get('/api/workspace-context?reportId='+reportId)).json(),{});
  assert.deepEqual((await (await get('/api/reports')).json()).reports,[]);
  assert.deepEqual((await (await get('/api/reports?scope=linked')).json()).reports,[]);
  assert.deepEqual((await (await get('/api/reports?scope=unlinked')).json()).reports,[]);
  const catalog=await (await get('/api/review-projects?view=catalog')).json();
  assert.equal(catalog.projects[0].workspaceCount,0);
  assert.equal(catalog.projects[0].hasReports,false);

  assert.equal((await post(restorePath,{})).status,403);
  assert.equal((await post(restorePath,{unexpected:true},base)).status,400);
  const restored=await post(restorePath,{},base);
  assert.equal(restored.status,200);
  assert.equal((await restored.json()).workspace.workspaceId,workspace.workspaceId);
  assert.deepEqual(await (await get('/api/review-workspace-trash')).json(),{workspaces:[]});
  assert.equal((await get(reportPath)).status,200);
  assert.equal((await get(imagePath)).status,200);
  assert.deepEqual((await (await get('/api/reports')).json()).reports.map((item:{id:string})=>item.id),[reportId]);
 }finally{
  await service.close();
  server.closeAllConnections();
  await new Promise<void>((done,reject)=>server.close(error=>error?reject(error):done()));
  await rm(root,{recursive:true,force:true});
 }
});

test('report list scopes use current workspace membership and keep unlinked detail accessible',async()=>{
 const root=await mkdtemp(resolve(tmpdir(),'report-list-scopes-'));
 const service=new ReviewService(root);
 const server=createViewerServer(new ReportRepository(root),root,service);
 const startedAt='2025-06-07T02:30:00.000Z';
 try{
  for(const runId of ['attached-run','imported-run']){
   const runDir=resolve(root,runId);
   await mkdir(runDir);
   await writeFile(resolve(runDir,'report.json'),JSON.stringify({
    runId,status:'completed',startedAt,observations:[{pageTitle:runId+' title'}],findings:[],
   }));
  }
  await service.start();
  server.listen(0,'127.0.0.1');
  await once(server,'listening');
  const base='http://127.0.0.1:'+(server.address() as {port:number}).port;
  const list=async(scope?:'linked'|'unlinked')=>{
   const response=await fetch(base+'/api/reports'+(scope?'?scope='+scope:''));
   assert.equal(response.status,200);
   return await response.json() as ReportList;
  };
  const post=(path:string,value:unknown)=>fetch(base+path,{
   method:'POST',headers:{origin:base,'content-type':'application/json'},body:JSON.stringify(value),
  });
  const project=await service.addProject({name:'Store'});
  const workspace=await service.addWorkspace({projectId:project.projectId,name:'Cart',goal:'Check cart'});
  const reportsPath='/api/review-workspaces/'+workspace.workspaceId+'/reports';
  assert.equal((await fetch(base+'/api/reports?scope=unknown')).status,400);
  const {reports}=await list();
  const linked=reports.find(report=>report.runId==='attached-run')!;
  const unlinked=reports.find(report=>report.runId==='imported-run')!;
  assert.equal(reports.length,2);
  assert.equal((await list('linked')).reports.length,0);
  assert.deepEqual(await (await fetch(base+reportsPath)).json(),{metadata:{}});
  const attach=await post(reportsPath,{
   reportId:linked.id,expectedVersion:workspace.version,
  });
  assert.equal(attach.status,200);
  const {workspace:updatedWorkspace}=await attach.json();
  assert.deepEqual(await (await fetch(base+reportsPath)).json(),{
   metadata:{[linked.id]:{title:'attached-run title',startedAt}},
  });
  const attachedReports=(await list('linked')).reports;
  assert.deepEqual(attachedReports.map(report=>report.id),[linked.id]);
  assert.deepEqual(attachedReports[0].workspaceContext,{
   workspaceId:workspace.workspaceId,workspaceName:'Cart',projectId:project.projectId,projectName:'Store',
  });
  assert.deepEqual((await list('unlinked')).reports.map(report=>[report.id,report.workspaceContext]),[[unlinked.id,undefined]]);

  const destination=await service.addProject({name:'Checkout'});
  await service.moveWorkspace(workspace.workspaceId,{projectId:destination.projectId,expectedVersion:updatedWorkspace.version});
  const moved=(await list('linked')).reports[0];
  assert.equal(moved.id,linked.id);
  assert.deepEqual(moved.workspaceContext,{
   workspaceId:workspace.workspaceId,workspaceName:'Cart',projectId:destination.projectId,projectName:'Checkout',
  });
  const original=await fetch(base+'/api/reports/'+unlinked.id);
  assert.equal(original.status,200);
  assert.equal((await original.json()).runId,'imported-run');
  assert.deepEqual(await service.workspaceContext(unlinked.id),{});
 }finally{
  await service.close();
  if(server.listening){
   server.closeAllConnections();
   await new Promise<void>((done,reject)=>server.close(error=>error?reject(error):done()));
  }
  await rm(root,{recursive:true,force:true});
 }
});

test('project and workspace provisioning can be replayed by ID across concurrent requests and conflicts',async()=>{
 const root=await mkdtemp(resolve(tmpdir(),'workspace-provision-http-'));
 const service=new ReviewService(root);
 const server=createViewerServer(new ReportRepository(root),root,service);
 try{
  await service.start();
  server.listen(0,'127.0.0.1');
  await once(server,'listening');
  const base='http://127.0.0.1:'+(server.address() as {port:number}).port;
  const projectsPath='/api/review-projects',workspacesPath='/api/review-workspaces';
  const post=(path:string,value:unknown)=>fetch(base+path,{
   method:'POST',headers:{origin:base,'content-type':'application/json'},body:JSON.stringify(value),
  });
  const project={projectId:randomUUID(),name:'Benchmark fixture',description:'Verify replay'};
  const projectResponses=await Promise.all([post(projectsPath,project),post(projectsPath,project)]);
  assert.deepEqual(projectResponses.map(response=>response.status),[201,201]);
  const projectBodies=await Promise.all(projectResponses.map(async response=>(await response.json()).project));
  assert.equal(projectBodies[0].projectId,project.projectId);
  assert.deepEqual(projectBodies[1],projectBodies[0]);
  assert.equal((await post(projectsPath,{...project,description:'Changed input'})).status,409);
  assert.deepEqual((await (await fetch(base+projectsPath)).json()).projects,[projectBodies[0]]);

  const workspace={workspaceId:randomUUID(),projectId:project.projectId,name:'Model one',goal:'Review the same screenshot'};
  const workspaceResponses=await Promise.all([post(workspacesPath,workspace),post(workspacesPath,workspace)]);
  assert.deepEqual(workspaceResponses.map(response=>response.status),[201,201]);
  const workspaceBodies=await Promise.all(workspaceResponses.map(async response=>(await response.json()).workspace));
  assert.equal(workspaceBodies[0].workspaceId,workspace.workspaceId);
  assert.deepEqual(workspaceBodies[1],workspaceBodies[0]);
  assert.equal((await post(workspacesPath,{...workspace,goal:'Changed input'})).status,409);
  assert.deepEqual((await (await fetch(base+workspacesPath)).json()).workspaces,[workspaceBodies[0]]);
 }finally{
  server.closeAllConnections();
  if(server.listening)await new Promise<void>(done=>server.close(()=>done()));
  await service.close();
  await rm(root,{recursive:true,force:true});
 }
});
