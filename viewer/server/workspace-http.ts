import type {IncomingMessage,ServerResponse} from 'node:http';
import {ReviewServiceError,type ReviewService} from '../../src/review-service.js';
import {canUseReviewCredentials} from '../../src/review-auth.js';
import type {PublicWorkspaceDetail,PublicWorkspaceRequest,WorkspaceRequest} from '../../src/workspace-contract.js';
import type {ReportRepository} from './repository.js';
import type {ProjectCatalogView} from '../features/projects/catalog.js';
import {projectCards} from './project-catalog.js';
import {reportIdsNeedingMetadata,workspaceReportAttempts} from '../features/workspaces/report-picker.js';
import {z} from 'zod';

function publicWorkspaceRequest({taskId: _taskId, revisionId: _revisionId, targetId: _targetId, ...request}:WorkspaceRequest):PublicWorkspaceRequest {
 return request;
}

export async function handleWorkspaceHttp(req:IncomingMessage,res:ServerResponse,path:string,origin:string,service:ReviewService,repository:ReportRepository,body:(maxBytes?:number)=>Promise<unknown>):Promise<boolean>{
 const json=(status:number,data:unknown)=>{res.writeHead(status,{'content-type':'application/json; charset=utf-8'});res.end(JSON.stringify(data));};
 if(path==='/api/review-projects'){
  if(req.method==='GET'){
   const url=new URL(req.url!,'http://localhost');
   if(url.searchParams.get('view')==='catalog'){
    const [catalog,reports]=await Promise.all([service.projectCatalog(),repository.list()]);
    const view:ProjectCatalogView={projects:projectCards(catalog,reports.reports),hasMoreReports:reports.hasMore};
    json(200,view);
   }else json(200,{projects:await service.projects()});
  }else if(req.method==='POST')json(201,{project:await service.addProject(await body())});else return false;
  return true;
 }
 if(path==='/api/review-project-trash'&&req.method==='GET'){
  json(200,{projects:await service.trashedProjects()});
  return true;
 }
 const projectDeletion=path.match(/^\/api\/review-projects\/([^/]+)\/(deletion-preview|delete|restore)$/);
 if(projectDeletion){
  const [,id,action]=projectDeletion;
  if(action==='deletion-preview'&&req.method==='GET'){
   json(200,{preview:await service.projectDeletionPreview(id)});
   return true;
  }
  if(req.method==='POST'&&action==='delete'){
   json(200,await service.deleteProject(id,await body()));
   return true;
  }
  if(req.method==='POST'&&action==='restore'){
   z.object({}).strict().parse(await body());
   json(200,{project:await service.restoreProject(id)});
   return true;
  }
  return false;
 }
 const postHosts=path.match(/^\/api\/review-projects\/([^/]+)\/post-hosts$/);
 if(postHosts&&req.method==='POST'){json(200,{project:await service.updateProjectPostHosts(postHosts[1],await body())});return true;}
 const supabaseAuth=path.match(/^\/api\/review-projects\/([^/]+)\/supabase-auth-bindings$/);
 if(supabaseAuth&&req.method==='POST'){
  json(200,{project:await service.updateProjectSupabaseAuthBindings(supabaseAuth[1],await body())});
  return true;
 }
 if(path==='/api/review-workspaces'){if(req.method==='GET'){const url=new URL(req.url!,'http://localhost');json(200,{workspaces:await service.workspaces(url.searchParams.get('projectId')??undefined)});}else if(req.method==='POST')json(201,{workspace:await service.addWorkspace(await body())});else return false;return true;}
 if(path==='/api/review-workspace-trash'&&req.method==='GET'){
  json(200,{workspaces:await service.trashedWorkspaces()});
  return true;
 }
 const trashAction=path.match(/^\/api\/review-workspaces\/([^/]+)\/(trash|restore)$/);
 if(trashAction&&req.method==='POST'){
  const [,id,action]=trashAction;
  const input=await body();
  if(action==='trash')json(200,{entry:await service.trashWorkspace(id,input)});
  else{
   z.object({}).strict().parse(input);
   json(200,{workspace:await service.restoreWorkspace(id)});
  }
  return true;
 }
 if(path==='/api/workspace-context'&&req.method==='GET'){const url=new URL(req.url!,'http://localhost');json(200,await service.workspaceContext(url.searchParams.get('reportId')??''));return true;}
 const reportMetadata=path.match(/^\/api\/review-workspaces\/([^/]+)\/reports$/);
 if(reportMetadata&&req.method==='GET'){
  const {reportIds,requests}=await service.workspace(reportMetadata[1]);
  const metadataIds=reportIdsNeedingMetadata(reportIds,workspaceReportAttempts(requests));
  const metadata=metadataIds.length ? await repository.workspaceReportMetadata(metadataIds,await service.reportContexts()) : {};
  json(200,{metadata});
  return true;
 }
 const match=path.match(/^\/api\/review-workspaces\/([^/]+)(?:\/(membership|reports|reviews|requests))?$/);
 if(match){
  const [,id,action]=match;
  if(req.method==='GET'&&!action){
   const detail=await service.workspace(id);
   const response:PublicWorkspaceDetail={...detail,requests:detail.requests.map(publicWorkspaceRequest)};
   json(200,response);
   return true;
  }
  if(req.method==='POST'){
   const input=await body();
   if(action==='membership')json(200,{workspace:await service.moveWorkspace(id,input)});
   else if(action==='reports')json(200,{workspace:await service.attachWorkspaceReport(id,input,report=>repository.followupSource(report))});
   else if(action==='reviews'||action==='requests'){
    const {workspace,request}=action==='reviews'
     ?await service.submitWorkspaceInitial(id,input)
     :await service.submitWorkspaceFollowup(id,input,(report,image)=>repository.followupSource(report,image));
    json(202,{workspace,request:publicWorkspaceRequest(request),dashboardUrl:`${origin}/?workspace=${workspace.workspaceId}`});
   }else return false;
   return true;
  }
 }
 const start=path.match(/^\/api\/workspace-requests\/([^/]+)\/start$/);
 if(start&&req.method==='POST'){
  const input=await body(16384);
  if(input&&typeof input==='object'&&'credentials' in input){
   const peer=req.socket.remoteAddress?.replace(/^::ffff:/,'');
   const isLocalConnection=peer==='127.0.0.1'||peer==='::1';
   if(!canUseReviewCredentials(origin)||(!origin.startsWith('https:')&&!isLocalConnection))
    throw new ReviewServiceError(403,'HTTPS 또는 서버 기기의 로컬 대시보드에서 로그인 정보를 입력하세요.');
  }
  json(202,{attempt:await service.startWorkspaceRequest(start[1],input)});
  return true;
 }
 const request=path.match(/^\/api\/workspace-requests\/([^/]+)\/(cancel|retry|membership|images)$/);
 if(request&&req.method==='POST'){
  const [,id,action]=request,input=await body();
  if(action==='cancel')json(200,{attempt:await service.cancelWorkspaceRequest(id,input)});
  else if(action==='retry')json(202,{request:publicWorkspaceRequest(await service.retryWorkspaceRequest(id,input))});
  else if(action==='membership')json(200,{request:publicWorkspaceRequest(await service.moveWorkspaceRequest(id,input))});
  else{
   const {request:accepted}=await service.submitWorkspaceImage(id,input);
   json(202,{request:publicWorkspaceRequest(accepted)});
  }
  return true;
 }
 return false;
}
