import type {ReviewCredentials} from '../../../src/review-credentials';
import type {ProjectDeletionPreview,ProjectDeletionResult,ReviewProject,ReviewWorkspace,TrashedProject,TrashedWorkspace,PublicWorkspaceRequest,PublicWorkspaceDetail,WorkspaceAttempt} from '../../../src/workspace-contract';
import type {WorkspaceReportMetadata} from './report-picker';
export class WorkspaceRequestError extends Error {
 constructor(message:string,readonly status:number){super(message);this.name='WorkspaceRequestError';}
}
export async function workspaceRequest<T>(path:string,body?:unknown,signal?:AbortSignal):Promise<T>{
 const response=await fetch(path,{signal,credentials:'same-origin',...(body===undefined?{}:{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(body)})});
 const result=await response.json().catch(()=>null);if(!response.ok)throw new WorkspaceRequestError(result?.error??'요청을 처리하지 못했습니다.',response.status);if(result===null)throw new Error('서버 응답을 읽지 못했습니다.');return result;
}
export const workspacesApi={
 projects:(signal?:AbortSignal)=>workspaceRequest<{projects:ReviewProject[]}>('/api/review-projects',undefined,signal),
 workspaces:(projectId?:string,signal?:AbortSignal)=>workspaceRequest<{workspaces:ReviewWorkspace[]}>(`/api/review-workspaces${projectId?`?projectId=${encodeURIComponent(projectId)}`:''}`,undefined,signal),
 detail:(id:string,signal?:AbortSignal)=>workspaceRequest<PublicWorkspaceDetail>(`/api/review-workspaces/${encodeURIComponent(id)}`,undefined,signal),
 reportMetadata:(id:string,signal?:AbortSignal)=>workspaceRequest<{metadata:Record<string,WorkspaceReportMetadata>}>(`/api/review-workspaces/${encodeURIComponent(id)}/reports`,undefined,signal),
 trashList:(signal?:AbortSignal)=>workspaceRequest<{workspaces:TrashedWorkspace[]}>('/api/review-workspace-trash',undefined,signal),
 trash:(id:string,expectedVersion:number)=>workspaceRequest<{entry:TrashedWorkspace}>(`/api/review-workspaces/${encodeURIComponent(id)}/trash`,{expectedVersion}),
 restore:(id:string)=>workspaceRequest<{workspace:ReviewWorkspace}>(`/api/review-workspaces/${encodeURIComponent(id)}/restore`,{}),
 context:(reportId:string,signal?:AbortSignal)=>workspaceRequest<{workspace?:ReviewWorkspace;project?:ReviewProject}>(`/api/workspace-context?reportId=${encodeURIComponent(reportId)}`,undefined,signal),
 createProject:(body:{name:string;description?:string})=>workspaceRequest<{project:ReviewProject}>('/api/review-projects',body),
 projectDeletionPreview:(id:string,signal?:AbortSignal)=>workspaceRequest<{preview:ProjectDeletionPreview}>(`/api/review-projects/${encodeURIComponent(id)}/deletion-preview`,undefined,signal),
 deleteProject:(id:string,body:{mode:ProjectDeletionResult['mode'];scopeVersion:string})=>workspaceRequest<ProjectDeletionResult>(`/api/review-projects/${encodeURIComponent(id)}/delete`,body),
 projectTrashList:(signal?:AbortSignal)=>workspaceRequest<{projects:TrashedProject[]}>('/api/review-project-trash',undefined,signal),
 restoreProject:(id:string)=>workspaceRequest<{project:ReviewProject}>(`/api/review-projects/${encodeURIComponent(id)}/restore`,{}),
 saveProjectPostHosts:(projectId:string,postAllowedHosts:string[],expectedVersion:number)=>workspaceRequest<{project:ReviewProject}>(`/api/review-projects/${encodeURIComponent(projectId)}/post-hosts`,{postAllowedHosts,expectedVersion}),
 saveProjectSupabaseAuthBindings:(projectId:string,supabaseAuthBindings:ReviewProject['supabaseAuthBindings'],expectedVersion:number)=>workspaceRequest<{project:ReviewProject}>(`/api/review-projects/${encodeURIComponent(projectId)}/supabase-auth-bindings`,{supabaseAuthBindings,expectedVersion}),
 createWorkspace:(body:{projectId:string;name:string;goal:string})=>workspaceRequest<{workspace:ReviewWorkspace}>('/api/review-workspaces',body),
 submit:(workspaceId:string,body:unknown)=>workspaceRequest<{request:PublicWorkspaceRequest}>(`/api/review-workspaces/${encodeURIComponent(workspaceId)}/requests`,body),
 initial:(workspaceId:string,body:unknown)=>workspaceRequest<{workspace:ReviewWorkspace;request:PublicWorkspaceRequest}>(`/api/review-workspaces/${encodeURIComponent(workspaceId)}/reviews`,body),
 attach:(workspaceId:string,body:{reportId:string;expectedVersion:number})=>workspaceRequest<unknown>(`/api/review-workspaces/${encodeURIComponent(workspaceId)}/reports`,body),
 start:(requestId:string,attemptId:string,credentials?:ReviewCredentials)=>workspaceRequest<{attempt:WorkspaceAttempt}>(`/api/workspace-requests/${encodeURIComponent(requestId)}/start`,{attemptId,credentials}),
 cancel:(requestId:string,attemptId:string)=>workspaceRequest<unknown>(`/api/workspace-requests/${encodeURIComponent(requestId)}/cancel`,{attemptId}),
 retry:(requestId:string,attemptId:string,submissionId:string)=>workspaceRequest<{request:PublicWorkspaceRequest}>(`/api/workspace-requests/${encodeURIComponent(requestId)}/retry`,{attemptId,submissionId}),
 moveWorkspace:(workspaceId:string,projectId:string,expectedVersion:number)=>workspaceRequest<unknown>(`/api/review-workspaces/${encodeURIComponent(workspaceId)}/membership`,{projectId,expectedVersion}),
 moveRequest:(requestId:string,workspaceId:string,expectedVersion:number)=>workspaceRequest<{request:PublicWorkspaceRequest}>(`/api/workspace-requests/${encodeURIComponent(requestId)}/membership`,{workspaceId,expectedVersion}),
 importImage:(requestId:string,body:{assetId:string;comment:string;submissionId:string})=>workspaceRequest<{request:PublicWorkspaceRequest}>(`/api/workspace-requests/${encodeURIComponent(requestId)}/images`,body),
};
