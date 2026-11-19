import {readStoredReviewTask} from './helpers/review-state.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {once} from 'node:events';
import {access,mkdir,mkdtemp,rm,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {resolve} from 'node:path';
import sharp from 'sharp';
import type {inspect} from '../src/core.js';
import {ReviewService,ReviewServiceError} from '../src/review-service.js';
import type {ProjectDeletionPreview,ReviewProject,ReviewWorkspace,WorkspaceRequest} from '../src/workspace-contract.js';
import type {ReportList} from '../viewer/features/reports/types.js';
import {createViewerServer} from '../viewer/server/http.js';
import {ReportRepository} from '../viewer/server/repository.js';

const retention = 14 * 86_400_000;
const url = 'https://example.test/products';
const origin = 'https://exampleproject.supabase.co';
const postHost = 'api.example.test';
const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jF9sAAAAASUVORK5CYII=','base64');

async function fixtureInspect(_spec: Parameters<typeof inspect>[0], out: string) {
 const runId = randomUUID();
 const runDir = resolve(out, runId);
 await mkdir(runDir,{recursive:true});
 await writeFile(resolve(runDir,'screen.png'),png);
 const result = {runId,status:'completed',targetUrl:url,endedAt:new Date().toISOString(),
  observations:[],findings:[],limitations:[],evidence:[{kind:'screenshot',evidenceId:'screen',relativePath:'screen.png'}]};
 await writeFile(resolve(runDir,'report.json'),JSON.stringify(result));
 return {result,runDir};
}

async function waitFor<T>(read: () => Promise<T | undefined>): Promise<T> {
 const deadline = Date.now() + 4000;
 while (Date.now() < deadline) {
  const value = await read();
  if (value !== undefined) return value;
  await new Promise(resolve => setTimeout(resolve,10));
 }
 throw new Error('Timed out waiting for a review result');
}

const workspacePath = (workspace: ReviewWorkspace) => `/api/review-workspaces/${workspace.workspaceId}`;
const projectPath = (project: ReviewProject) => `/api/review-projects/${project.projectId}`;
const submit = (service: ReviewService, workspace: ReviewWorkspace, shouldWaitForStart = false) => service.submitWorkspaceInitial(workspace.workspaceId, {
 submissionId:randomUUID(),target:{kind:'url',url,shouldWaitForStart},
});
const start = (service: ReviewService, request: WorkspaceRequest, credentials?: {method:'password';username:string;password:string}) =>
 service.startReviewTarget(request.taskId,request.revisionId,request.targetId,{attemptId:request.attempts[0].attemptId,credentials});

test('project deletion HTTP preserves moved report and image URLs and restores grouped trash to original URLs', async () => {
 const root = await mkdtemp(resolve(tmpdir(),'project-deletion-http-'));
 let timestamp = Date.UTC(2026,10,19);
 const service = new ReviewService(root,{inspect:fixtureInspect as typeof inspect,workspaceClock:() => timestamp});
 const server = createViewerServer(new ReportRepository(root),root,service);
 try {
  await service.start();
  server.listen(0,'127.0.0.1');
  await once(server,'listening');
  const base = 'http://127.0.0.1:' + (server.address() as {port:number}).port;
  const get = (path:string) => fetch(base + path);
  const post = (path:string,body:unknown,requestedOrigin:string|null = base) => fetch(base + path,{
   method:'POST',headers:{...(requestedOrigin === null ? {} : {origin:requestedOrigin}),'content-type':'application/json'},body:JSON.stringify(body),
  });
  const readPreview = async (project: ReviewProject): Promise<ProjectDeletionPreview> => {
   const response = await get(projectPath(project) + '/deletion-preview');
   assert.equal(response.status,200);
   return (await response.json()).preview;
  };
  const linked = async () => (await get('/api/reports?scope=linked')).json() as Promise<ReportList>;
  const removed = await service.addProject({name:'Removed group'});
  const workspace = await service.addWorkspace({projectId:removed.projectId,name:'Products',goal:'Review'});
  const alreadyTrashed = await service.addWorkspace({projectId:removed.projectId,name:'Already trashed',goal:'Review'});
  await service.trashWorkspace(alreadyTrashed.workspaceId,{expectedVersion:alreadyTrashed.version});
  await submit(service,workspace);
  const reportId = await waitFor(async () => (await service.workspace(workspace.workspaceId)).workspace.latestReportId);
  const report = `/api/reports/${reportId}`;
  const image = (await (await get(report)).json()).images[0].url as string;
  assert.equal((await get(image)).status,200);
  const preview = await readPreview(removed);
  assert.equal(preview.workspaceCount,1);
  assert.equal(preview.trashedWorkspaceCount,1);
  assert.equal(preview.reportCount,1);
  const path = projectPath(removed) + '/delete';
  const body = {mode:'project-only',scopeVersion:preview.scopeVersion};
  assert.equal((await post(path,body,null)).status,403);
  assert.equal((await post(path,body,'https://other.test')).status,403);
  assert.equal((await post(path,{...body,mode:'unknown'})).status,400);
  await service.addWorkspace({projectId:removed.projectId,name:'New child',goal:'Review'});
  assert.equal((await post(path,body)).status,409);
  const moved = await post(path,{...body,scopeVersion:(await readPreview(removed)).scopeVersion});
  assert.equal(moved.status,200);
  const destinationId = (await moved.json()).destinationProjectId;
  const detail = await (await get(workspacePath(workspace))).json();
  assert.equal(detail.workspace.workspaceId,workspace.workspaceId);
  assert.equal(detail.project.projectId,destinationId);
  assert.equal(detail.project.isUncategorized,true);
  assert.equal(detail.workspace.latestReportId,reportId);
  assert.equal((await get(report)).status,200);
  assert.equal((await get(image)).status,200);
  assert.deepEqual((await linked()).reports[0].workspaceContext,{
   workspaceId:workspace.workspaceId,workspaceName:'Products',projectId:destinationId,projectName:'미분류',
  });
  assert.equal((await get(projectPath(removed)+'/deletion-preview')).status,404);
  const restoredWorkspace = await post(workspacePath(alreadyTrashed)+'/restore',{});
  assert.equal(restoredWorkspace.status,200);
  assert.equal((await restoredWorkspace.json()).workspace.projectId,destinationId);

  const parent = await service.addProject({name:'Grouped trash'});
  const withPost = await service.updateProjectPostHosts(parent.projectId,{expectedVersion:parent.version,postAllowedHosts:[postHost]});
  const binding = {targetOrigin:new URL(url).origin,origin};
  await service.updateProjectSupabaseAuthBindings(parent.projectId,{expectedVersion:withPost.version,supabaseAuthBindings:[binding]});
  const child = await service.addWorkspace({projectId:parent.projectId,name:'Cart',goal:'Review'});
  const independent = await service.addWorkspace({projectId:parent.projectId,name:'Earlier trash',goal:'Review'});
  const earlier = await service.trashWorkspace(independent.workspaceId,{expectedVersion:independent.version});
  timestamp += 60_000;
  await service.moveWorkspace(workspace.workspaceId,{projectId:parent.projectId,expectedVersion:detail.workspace.version});
  const cascade = await post(projectPath(parent)+'/delete',{mode:'cascade',scopeVersion:(await readPreview(parent)).scopeVersion});
  assert.equal(cascade.status,200);
  const {entry} = await cascade.json();
  assert.equal(entry.project.projectId,parent.projectId);
  assert.equal(Date.parse(entry.expiresAt)-Date.parse(entry.trashedAt),retention);
  assert.deepEqual(await (await get('/api/review-project-trash')).json(),{projects:[entry]});
  assert.deepEqual(await (await get('/api/review-workspace-trash')).json(),{workspaces:[]});
  assert.equal((await get(workspacePath(workspace))).status,404);
  assert.equal((await get(report)).status,404);
  assert.equal((await get(image)).status,404);
  assert.deepEqual((await linked()).reports,[]);
  assert.ok(!(await service.projects()).some(project => project.projectId === parent.projectId));
  assert.equal((await post('/api/review-workspaces',{projectId:parent.projectId,name:'Hidden child',goal:'Review'})).status,404);
  const restore = projectPath(parent)+'/restore';
  assert.equal((await post(restore,{},null)).status,403);
  assert.equal((await post(restore,{extra:true})).status,400);
  const response = await post(restore,{});
  assert.equal(response.status,200);
  const {project:restoredProject} = await response.json();
  assert.equal(restoredProject.projectId,parent.projectId);
  assert.deepEqual(restoredProject.postAllowedHosts,[postHost]);
  assert.deepEqual(restoredProject.supabaseAuthBindings,[binding]);
  assert.equal((await get(workspacePath(child))).status,200);
  assert.equal((await get(workspacePath(workspace))).status,200);
  assert.equal((await get(workspacePath(independent))).status,404);
  const {workspaces} = await (await get('/api/review-workspace-trash')).json();
  assert.equal(workspaces[0].workspace.workspaceId,independent.workspaceId);
  assert.equal(workspaces[0].expiresAt,earlier.expiresAt);
  assert.equal((await get(report)).status,200);
  assert.equal((await get(image)).status,200);
  assert.equal((await linked()).reports[0].workspaceContext?.projectId,parent.projectId);
 } finally {
  await service.close();
  if (server.listening) {
   server.closeAllConnections();
   await new Promise<void>((done,reject) => server.close(error => error ? reject(error) : done()));
  }
  await rm(root,{recursive:true,force:true});
 }
});

test('project-only revokes accepted permissions while grouped trash suspends them until restore',async () => {
 const root = await mkdtemp(resolve(tmpdir(),'project-deletion-policy-'));
 let release!: () => void;
 const gate = new Promise<void>(resolve => {release = resolve;});
 const executed: Array<{
  postPolicy:Parameters<typeof inspect>[0]['projectPostPolicy'];
  auth:NonNullable<Parameters<typeof inspect>[2]>['projectSupabaseAuth'];
 }> = [];
 const service = new ReviewService(root,{inspect:(async (spec,out,runtime) => {
  executed.push({postPolicy:spec.projectPostPolicy,auth:runtime.projectSupabaseAuth});
  if(spec.purpose === 'Hold') await gate;
  return fixtureInspect(spec,out);
 }) as typeof inspect});
 const isConflict = (error:unknown) => error instanceof ReviewServiceError && error.status === 409;
 const binding = {targetOrigin:new URL(url).origin,origin};
 const addConfiguredProject = async (name:string) => {
  const project = await service.addProject({name});
  const saved = await service.updateProjectPostHosts(project.projectId,{expectedVersion:project.version,postAllowedHosts:[postHost]});
  return service.updateProjectSupabaseAuthBindings(project.projectId,{expectedVersion:saved.version,supabaseAuthBindings:[binding]});
 };
 try {
  await service.start();
  const project = await addConfiguredProject('Configured');
  const hold = await service.addWorkspace({projectId:project.projectId,name:'Active',goal:'Hold'});
  const waiting = await service.addWorkspace({projectId:project.projectId,name:'Waiting',goal:'Review'});
  await submit(service,hold);
  await waitFor(async () => executed[0]);
  assert.deepEqual(executed[0].postPolicy,{projectId:project.projectId,hosts:[postHost]});
  const activePreview = await service.projectDeletionPreview(project.projectId);
  assert.equal(activePreview.hasActiveReviews,true);
  await assert.rejects(service.deleteProject(project.projectId,{mode:'project-only',scopeVersion:activePreview.scopeVersion}),isConflict);
  await assert.rejects(service.deleteProject(project.projectId,{mode:'cascade',scopeVersion:activePreview.scopeVersion}),isConflict);
  const {request} = await submit(service,waiting,true);
  release();
  await waitFor(async () => (await service.workspace(hold.workspaceId)).workspace.latestReportId);
  const preview = await service.projectDeletionPreview(project.projectId);
  assert.equal(preview.hasActiveReviews,false);
  const deletion = await service.deleteProject(project.projectId,{mode:'project-only',scopeVersion:preview.scopeVersion});
  assert.equal(deletion.mode,'project-only');
  const {project:uncategorized} = await service.workspace(waiting.workspaceId);
  assert.equal(uncategorized.isUncategorized,true);
  assert.deepEqual(uncategorized.postAllowedHosts,[]);
  assert.deepEqual(uncategorized.supabaseAuthBindings,[]);
  await assert.rejects(service.updateProjectPostHosts(uncategorized.projectId,{expectedVersion:uncategorized.version,postAllowedHosts:[postHost]}),isConflict);
  await assert.rejects(service.updateProjectSupabaseAuthBindings(uncategorized.projectId,{expectedVersion:uncategorized.version,supabaseAuthBindings:[binding]}),isConflict);
  const password = {method:'password' as const,username:'test-user',password:'test-password'};
  await assert.rejects(start(service,request,password),/Supabase 로그인 허용이 변경/);
  assert.equal(executed.length,1);
  await start(service,request);
  await waitFor(async () => (await service.workspace(waiting.workspaceId)).workspace.latestReportId);
  assert.deepEqual(executed[1],{postPolicy:undefined,auth:undefined});
  const fresh = await submit(service,waiting,true);
  await start(service,fresh.request,password);
  await waitFor(async () => executed[2]);
  assert.deepEqual(executed[2],{postPolicy:undefined,auth:undefined});

  const restorable = await addConfiguredProject('Restorable');
  const protectedWorkspace = await service.addWorkspace({projectId:restorable.projectId,name:'Protected',goal:'Review'});
  const protectedRequest = (await submit(service,protectedWorkspace,true)).request;
  const toTrash = await service.projectDeletionPreview(restorable.projectId);
  await service.deleteProject(restorable.projectId,{mode:'cascade',scopeVersion:toTrash.scopeVersion});
  await assert.rejects(start(service,protectedRequest,password),error => error instanceof ReviewServiceError && error.status === 404);
  assert.equal(executed.length,3);
  await service.restoreProject(restorable.projectId);
  await start(service,protectedRequest,password);
  const restored = await waitFor(async () => executed[3]);
  assert.deepEqual(restored.postPolicy,{projectId:restorable.projectId,hosts:[postHost]});
  assert.equal(restored.auth?.origin,origin);
  assert.equal(restored.auth?.targetOrigin,binding.targetOrigin);
 } finally {
  release();
  await service.close();
  await rm(root,{recursive:true,force:true});
 }
});

test('project trash blocks external history dependencies and purges internal chains together after restart',async () => {
 const root = await mkdtemp(resolve(tmpdir(),'project-deletion-expiry-'));
 let timestamp = Date.UTC(2026,10,19);
 const create = () => new ReviewService(root,{inspect:fixtureInspect as typeof inspect,workspaceClock:() => timestamp});
 let service = create();
 const isConflict = (error:unknown) => error instanceof ReviewServiceError && error.status === 409;
 try {
  await service.start();
  const project = await service.addProject({name:'Grouped history'});
  const outside = await service.addProject({name:'Outside project'});
  const primary = await service.addWorkspace({projectId:project.projectId,name:'Parent',goal:'Review'});
  const secondary = await service.addWorkspace({projectId:outside.projectId,name:'Child',goal:'Review'});
  await submit(service,primary);
  const parentReportId = await waitFor(async () => (await service.workspace(primary.workspaceId)).workspace.latestReportId);
  const {request} = await service.submitWorkspaceFollowup(primary.workspaceId,{
   submissionId:randomUUID(),parentReportId,instruction:'Check cart',
  },async reportId => ({reportId,reportSha256:'a'.repeat(64),runId:'fixture'}));
  await waitFor(async () => (await service.workspace(primary.workspaceId)).requests.at(-1)?.attempts[0].reportId);
  const original = await service.workspace(primary.workspaceId);
  const reportFiles = original.requests.map(item => {
   const attempt = item.attempts[0];
   return resolve(root,'review-attempts',attempt.attemptId,attempt.runId!,'report.json');
  });
  await service.moveWorkspaceRequest(request.requestId,{workspaceId:secondary.workspaceId,expectedVersion:original.workspace.version});
  const blocked = await service.projectDeletionPreview(project.projectId);
  assert.equal(blocked.hasExternalDependencies,true);
  await assert.rejects(service.deleteProject(project.projectId,{mode:'cascade',scopeVersion:blocked.scopeVersion}),isConflict);
  assert.equal((await service.workspace(primary.workspaceId)).workspace.latestReportId,parentReportId);

  const child = (await service.workspace(secondary.workspaceId)).workspace;
  await service.moveWorkspace(secondary.workspaceId,{projectId:project.projectId,expectedVersion:child.version});
  const preview = await service.projectDeletionPreview(project.projectId);
  assert.equal(preview.hasExternalDependencies,false);
  assert.equal(preview.reportCount,2);
  await service.deleteProject(project.projectId,{mode:'cascade',scopeVersion:preview.scopeVersion});
  await service.close();

  service = create();
  await service.start();
  assert.deepEqual((await service.trashedProjects()).map(entry => entry.project.projectId),[project.projectId]);
  for (const file of reportFiles) await access(file);
  timestamp += retention;
  await service.purgeExpiredWorkspaces();
  assert.deepEqual(await service.trashedProjects(),[]);
  assert.deepEqual((await service.projects()).map(item => item.projectId),[outside.projectId]);
  assert.equal(service.trashedReportIds().size,0);
  for (const file of reportFiles) await assert.rejects(access(file),{code:'ENOENT'});
 } finally {
  await service.close();
  await rm(root,{recursive:true,force:true});
 }
});

test('unfinished legacy targets keep their migrated workspace while new submissions group normally',async () => {
 const root = await mkdtemp(resolve(tmpdir(),'project-deletion-legacy-'));
 const create = () => new ReviewService(root,{inspect:fixtureInspect as typeof inspect});
 let service = create();
 const legacySubmission = {title:'Legacy',purpose:'Review',targets:[{kind:'url',name:'Products',url}]};
 try {
  await service.start();
  const first = await service.submit({...legacySubmission,submissionId:randomUUID()});
  const original = await waitFor(async () => (await service.workspaces())[0]);
  const prior = await service.workspace(original.workspaceId);
  const awaiting = await service.submit({...legacySubmission,submissionId:randomUUID(),targets:[{
   ...legacySubmission.targets[0],targetId:first.revision.targets[0].targetId,shouldWaitForStart:true,
  }]},first.task.taskId);
  const {scopeVersion} = await service.projectDeletionPreview(prior.project.projectId);
  await service.deleteProject(prior.project.projectId,{mode:'project-only',scopeVersion});
  await service.close();

  service = create();
  await service.start();
  assert.deepEqual((await service.projects()).map(project => project.name),['미분류']);
  const target = awaiting.revision.targets[0];
  await service.startReviewTarget(first.task.taskId,awaiting.revision.revisionId,target.targetId,{attemptId:target.attempts[0].attemptId});
  await waitFor(async () => (await service.workspace(original.workspaceId)).reportIds.length === 2 ? true : undefined);
  assert.deepEqual((await service.projects()).map(project => project.name),['미분류']);
  await service.submit({...legacySubmission,submissionId:randomUUID()});
  const newProject = await waitFor(async () => (await service.projects()).find(project => project.name === new URL(url).host));
  assert.notEqual(newProject.projectId,prior.project.projectId);
  const reparented = await service.workspace(original.workspaceId);
  assert.equal(reparented.project.isUncategorized,true);
  assert.equal(reparented.reportIds.length,2);
 } finally {
  await service.close();
  await rm(root,{recursive:true,force:true});
 }
});

for (const mode of ['project-only','cascade'] as const) test(`deleting a legacy target’s former project via ${mode} preserves manual placement on retry`, async () => {
 const root = await mkdtemp(resolve(tmpdir(),'project-deletion-legacy-retry-'));
 let shouldFail = true;
 const service = new ReviewService(root,{inspect:(async (spec,out) => {
  if (shouldFail) throw new Error('Fixture failure');
  return fixtureInspect(spec,out);
 }) as typeof inspect});
 try {
  await service.start();
  const {task,revision} = await service.submit({
   title:'Legacy',purpose:'Review',submissionId:randomUUID(),targets:[{kind:'url',name:'Products',url}],
  });
  const [target] = revision.targets;
  const workspace = await waitFor(async () => (await service.workspaces())[0]);
  const previousProjectId = workspace.projectId;
  const manuallySelected = await service.addProject({name:'Manually selected'});
  await service.moveWorkspace(workspace.workspaceId,{projectId:manuallySelected.projectId,expectedVersion:workspace.version});
  const {scopeVersion} = await service.projectDeletionPreview(previousProjectId);
  await service.deleteProject(previousProjectId,{mode,scopeVersion});
  shouldFail = false;
  await service.retry(task.taskId,revision.revisionId,target.targetId,randomUUID(),target.attempts[0].attemptId);
  const reportId = await waitFor(async () => {
   const current = (await readStoredReviewTask(service, task.taskId)).revisions[0].targets[0];
   return current.attempts.at(-1)?.reportId;
  });
  const context = await service.workspaceContext(reportId);
  assert.equal(context.workspace?.workspaceId,workspace.workspaceId);
  assert.equal(context.project?.projectId,manuallySelected.projectId);
  assert.deepEqual((await service.projects()).map(project => project.projectId),[manuallySelected.projectId]);
 } finally {
  await service.close();
  await rm(root,{recursive:true,force:true});
 }
});

async function failedFixtureInspect(spec:Parameters<typeof inspect>[0],out:string){
 const {result,runDir}=await fixtureInspect(spec,out);
 const failedResult={...result,status:'failed'};
 await writeFile(resolve(runDir,'report.json'),JSON.stringify(failedResult));
 return {result:failedResult,runDir};
}

test('deleting a project that contains only a moved legacy report does not reassign its running retry',async()=>{
 const root=await mkdtemp(resolve(tmpdir(),'project-deletion-legacy-report-'));
 let release!:()=>void;
 const gate=new Promise<void>(resolve=>{release=resolve;});
 let runCount=0;
 const service=new ReviewService(root,{inspect:(async(spec,out)=>{
  if(++runCount===1)return failedFixtureInspect(spec,out);
  await gate;
  return fixtureInspect(spec,out);
 }) as typeof inspect});
 try{
  await service.start();
  const {task,revision}=await service.submit({
   title:'Legacy',purpose:'Review',submissionId:randomUUID(),targets:[{kind:'url',name:'Products',url}],
  });
  const readAttempts=async()=>(await readStoredReviewTask(service, task.taskId)).revisions[0].targets[0].attempts;
  const first=await waitFor(async()=>{
   const [attempt]=await readAttempts();
   return attempt.reportId ? attempt : undefined;
  });
  assert.ok(first.reportId);
  const original=(await service.workspaceContext(first.reportId)).workspace;
  assert.ok(original);
  const recipient=await service.addProject({name:'Recipient'});
  const recipientWorkspace=await service.addWorkspace({projectId:recipient.projectId,name:'Imported result',goal:'Review'});
  await service.attachWorkspaceReport(recipientWorkspace.workspaceId,{
   reportId:first.reportId,expectedVersion:recipientWorkspace.version,
  },async()=>({}));
  assert.equal((await service.workspaceContext(first.reportId)).workspace?.workspaceId,recipientWorkspace.workspaceId);

  await service.retry(task.taskId,revision.revisionId,revision.targets[0].targetId,randomUUID(),first.attemptId);
  await waitFor(async()=>(await readAttempts()).at(-1)?.status==='running' ? true : undefined);
  const preview=await service.projectDeletionPreview(recipient.projectId);
  assert.equal(preview.hasActiveReviews,false);
  await service.deleteProject(recipient.projectId,{mode:'project-only',scopeVersion:preview.scopeVersion});
  release();

  const retryReportId=await waitFor(async()=>(await readAttempts()).at(-1)?.reportId);
  const retryContext=await service.workspaceContext(retryReportId);
  assert.equal(retryContext.workspace?.workspaceId,original.workspaceId);
  assert.equal(retryContext.project?.projectId,original.projectId);
  const movedContext=await service.workspaceContext(first.reportId);
  assert.equal(movedContext.workspace?.workspaceId,recipientWorkspace.workspaceId);
  assert.equal(movedContext.project?.isUncategorized,true);
 }finally{
  release();
  await service.close();
  await rm(root,{recursive:true,force:true});
 }
});

test('creating the system uncategorized project preserves legacy explicit and unnamed project placement',async()=>{
 const root=await mkdtemp(resolve(tmpdir(),'project-deletion-system-project-'));
 let shouldFailOldImage=true;
 const service=new ReviewService(root,{inspect:(async(spec,out)=>
  shouldFailOldImage&&spec.purpose==='Old image review' ? failedFixtureInspect(spec,out) : fixtureInspect(spec,out)) as typeof inspect});
 try{
  await service.start();
  const submitNamed=()=>service.submit({
   title:'Explicit project',project:'미분류',purpose:'Named review',submissionId:randomUUID(),
   targets:[{kind:'url',name:'Products',url}],
  });
  const readLatest=async(taskId:string)=>(await readStoredReviewTask(service, taskId)).revisions[0].targets[0].attempts.at(-1);
  const first=await submitNamed();
  const firstReportId=await waitFor(async()=>(await readLatest(first.task.taskId))?.reportId);
  const namedContext=await service.workspaceContext(firstReportId);
  assert.ok(namedContext.project);
  assert.equal(namedContext.project.isUncategorized,undefined);

  const image=await sharp({create:{width:16,height:16,channels:3,background:'white'}}).png().toBuffer();
  const asset=await service.upload({fileName:'screen.png',base64:image.toString('base64')});
  const submitImage=(purpose:string)=>service.submit({
   title:'Unnamed image task',purpose,submissionId:randomUUID(),targets:[{kind:'image',name:'Screen',assetId:asset.assetId}],
  });
  const oldImage=await submitImage('Old image review');
  const oldImageReportId=await waitFor(async()=>(await readLatest(oldImage.task.taskId))?.reportId);
  const oldImageContext=await service.workspaceContext(oldImageReportId);
  assert.equal(oldImageContext.project?.projectId,namedContext.project.projectId);

  const deleted=await service.addProject({name:'Different project'});
  await service.addWorkspace({projectId:deleted.projectId,name:'Migrated workspace',goal:'Review'});
  const {scopeVersion}=await service.projectDeletionPreview(deleted.projectId);
  const outcome=await service.deleteProject(deleted.projectId,{mode:'project-only',scopeVersion});
  assert.equal(outcome.mode,'project-only');
  assert.notEqual(outcome.destinationProjectId,namedContext.project.projectId);
  await service.projectDeletionPreview(namedContext.project.projectId);

  const next=await submitNamed();
  const nextReportId=await waitFor(async()=>(await readLatest(next.task.taskId))?.reportId);
  assert.equal((await service.workspaceContext(nextReportId)).project?.projectId,namedContext.project.projectId);
  assert.equal((await service.projects()).filter(project=>project.name==='미분류').length,2);

  shouldFailOldImage=false;
  const [oldImageTarget]=oldImage.revision.targets;
  await service.retry(oldImage.task.taskId,oldImage.revision.revisionId,oldImageTarget.targetId,randomUUID(),oldImageTarget.attempts[0].attemptId);
  const retryReportId=await waitFor(async()=>{
   const attempt=await readLatest(oldImage.task.taskId);
   return attempt?.attemptId!==oldImageTarget.attempts[0].attemptId ? attempt?.reportId : undefined;
  });
  assert.equal((await service.workspaceContext(retryReportId)).workspace?.workspaceId,oldImageContext.workspace?.workspaceId);

  const freshImage=await submitImage('New image review');
  const freshReportId=await waitFor(async()=>(await readLatest(freshImage.task.taskId))?.reportId);
  const systemContext=await service.workspaceContext(freshReportId);
  assert.equal(systemContext.project?.projectId,outcome.destinationProjectId);
  assert.equal(systemContext.project?.isUncategorized,true);
 }finally{
  await service.close();
  await rm(root,{recursive:true,force:true});
 }
});
