import {randomUUID} from 'node:crypto';
import type {ReviewRevision, ReviewTarget, ReviewTask} from './review-contract.js';
import type {ReviewProject,ReviewWorkspace,WorkspaceRequest,WorkspaceMembership,WorkspaceDetail,WorkspaceMovement} from './workspace-contract.js';
import type {ProjectSupabaseAuthBinding} from './supabase-auth-policy.js';
/** Private acceptance snapshot: removals and moves permanently narrow it. */
export interface WorkspacePostGrant {workspaceId:string; projectId:string; hosts:string[];}
export interface WorkspaceSupabaseAuthGrant extends ProjectSupabaseAuthBinding {workspaceId:string; projectId:string; isRevoked?:true;}
export interface WorkspaceTrash {
 trashedAt: string;
 expiresAt: string;
 requestIds: string[];
 attemptIds: string[];
 reportIds: string[];
 focusedReviewIds: string[];
}
export interface ProjectTrash extends WorkspaceTrash {workspaceIds:string[];}
interface LegacyPlacement {projectId:string;workspaceId?:string;}
export interface PendingWorkspaceCleanup {
 reportIds: string[];
 files: Array<{path: string; isDirectory: boolean}>;
}
export interface WorkspaceState {trash?:Record<string,WorkspaceTrash>;projectTrash?:Record<string,ProjectTrash>;pendingCleanup?:Record<string,PendingWorkspaceCleanup>;movements?:WorkspaceMovement[];postGrants?:Record<string,WorkspacePostGrant>;supabaseAuthGrants?:Record<string,WorkspaceSupabaseAuthGrant>;projects:ReviewProject[];workspaces:ReviewWorkspace[];requests:WorkspaceRequest[];memberships:WorkspaceMembership[];sourceImages?:Record<string,string>;legacyKeys:Record<string,string>;legacyPlacements?:Record<string,LegacyPlacement>;submissions:Record<string,{hash:string;requestId:string}>;}
export const allWorkspaceTrash = (state: WorkspaceState) => [...Object.values(state.trash ?? {}), ...Object.values(state.projectTrash ?? {})];
export const isWorkspaceTrashed = (state: WorkspaceState, id: string) =>
 Boolean(state.trash?.[id] || Object.values(state.projectTrash ?? {}).some(trash => trash.workspaceIds.includes(id)));
const timestamp=()=>new Date().toISOString();
export function emptyWorkspaceState():WorkspaceState{return{projects:[],workspaces:[],requests:[],memberships:[],legacyKeys:{},submissions:{}};}
export function createProject(state:WorkspaceState,name:string,description='',projectId:string=randomUUID()){const date=timestamp();const project:ReviewProject={projectId,name,description,postAllowedHosts:[],supabaseAuthBindings:[],version:1,createdAt:date,updatedAt:date};state.projects.push(project);return project;}
export function createWorkspace(state:WorkspaceState,projectId:string,name:string,goal:string,workspaceId:string=randomUUID()){const date=timestamp();const workspace:ReviewWorkspace={workspaceId,projectId,name,goal,version:1,createdAt:date,updatedAt:date};state.workspaces.push(workspace);return workspace;}
function legacyProjectName(revision: ReviewRevision, target: ReviewTarget) {
 return revision.project?.trim() || (target.kind === 'url' ? new URL(target.url).host : '미분류');
}
function legacyWorkspaceKey(projectId: string, target: ReviewTarget) {
 return 'workspace:' + JSON.stringify([projectId, target.kind, target.kind === 'url' ? target.url : target.assetId, target.kind === 'url' ? target.viewport ?? {width: 1440, height: 900} : null, target.name]);
}
function findLegacyProject(state: WorkspaceState, name: string) {
 const active = state.projects.filter(project => !project.isUncategorized && !state.projectTrash?.[project.projectId]);
 return active.find(p => p.projectId === state.legacyKeys['project:' + name]) ?? active.find(p => p.name === name);
}
function projectForLegacyTarget(state: WorkspaceState, revision: ReviewRevision, target: ReviewTarget) {
 if (target.kind === 'image' && !revision.project?.trim()) {
  const uncategorized = state.projects.find(project => project.isUncategorized);
  if (uncategorized) return uncategorized;
 }
 return findLegacyProject(state,legacyProjectName(revision,target));
}
const legacyPlacementKey = (revision: ReviewRevision, target: ReviewTarget) => revision.revisionId + ':' + target.targetId;
export function legacyProjectId(state:WorkspaceState, revision:ReviewRevision, target:ReviewTarget) {
 return state.legacyPlacements?.[legacyPlacementKey(revision,target)]?.projectId ?? projectForLegacyTarget(state,revision,target)?.projectId;
}
export function legacyWorkspaceId(state: WorkspaceState, revision: ReviewRevision, target: ReviewTarget) {
 const placement = state.legacyPlacements?.[legacyPlacementKey(revision,target)];
 const projectId=legacyProjectId(state,revision,target);
 return placement?.workspaceId ?? (projectId && state.legacyKeys[legacyWorkspaceKey(projectId,target)]);
}
export function preserveLegacyPlacements(state:WorkspaceState,tasks:ReviewTask[],projectId:string,destinationId?:string) {
 const reportWorkspaces=new Map(state.memberships.map(({reportId,workspaceId})=>[reportId,workspaceId]));
 const workspaceProjects=new Map(state.workspaces.map(workspace=>[workspace.workspaceId,workspace.projectId]));
 const isCreatingUncategorized=Boolean(destinationId) && !state.projects.some(project=>project.isUncategorized);
 const movedTargets=new Set<string>();
 for(const task of tasks)for(const revision of task.revisions)for(const target of revision.targets){
  if(revision.workspaceRequestId)continue;
  const legacyId=legacyWorkspaceId(state,revision,target);
  const legacyParent=legacyId ? workspaceProjects.get(legacyId) : undefined;
  const legacyProject=legacyProjectId(state,revision,target);
  const existingProjectId=legacyParent??legacyProject;
  const isSourceProject=legacyProject===projectId;
  const shouldPreserveDefault=isCreatingUncategorized && target.kind==='image' && !revision.project?.trim();
  const key=legacyPlacementKey(revision,target);
  // A report can move independently of the workspace used by retries of its legacy target.
  if(existingProjectId && existingProjectId!==projectId && (legacyParent || shouldPreserveDefault)){
   if(isSourceProject || shouldPreserveDefault)
    (state.legacyPlacements??={})[key]={projectId:existingProjectId,workspaceId:legacyParent ? legacyId : undefined};
  }else if(destinationId){
   const reportInProject=legacyParent ? undefined : target.attempts.findLast(attempt=>attempt.reportId &&
    workspaceProjects.get(reportWorkspaces.get(attempt.reportId) ?? '')===projectId);
   const workspaceId=legacyParent ? legacyId : reportInProject?.reportId && reportWorkspaces.get(reportInProject.reportId);
   if(workspaceId || (!legacyParent && isSourceProject)){
    (state.legacyPlacements??={})[key]={projectId:destinationId,workspaceId};
    movedTargets.add(key);
   }
  }
 }
 return movedTargets;
}
export function forgetLegacyProjectKeys(state:WorkspaceState,projectId:string){
 for(const [key,value] of Object.entries(state.legacyKeys))
  if(value===projectId || key.startsWith('workspace:["'+projectId+'",'))delete state.legacyKeys[key];
}
export function migrateWorkspaces(state:WorkspaceState,tasks:ReviewTask[],movedTargets?:ReadonlySet<string>){
 const trashedAttemptIds = new Set(allWorkspaceTrash(state).flatMap(entry => entry.attemptIds));
 const placedReportIds = new Set(state.memberships.map(membership => membership.reportId));
 for(const task of [...tasks].reverse())for(const revision of task.revisions)for(const target of revision.targets){
  if(revision.workspaceRequestId)continue;
  const placementKey=legacyPlacementKey(revision,target);
  if(movedTargets && !movedTargets.has(placementKey))continue;
  const attempts = target.attempts.filter(attempt => !trashedAttemptIds.has(attempt.attemptId));
  if (!attempts.length) continue;
  const unplacedReports = attempts.flatMap(attempt => attempt.reportId && !placedReportIds.has(attempt.reportId) ? [attempt.reportId] : []);
  if (!unplacedReports.length && attempts.every(attempt => attempt.reportId)) continue;
  const projectName=legacyProjectName(revision,target);
  const placement=state.legacyPlacements?.[placementKey];
  let project=placement?state.projects.find(candidate=>candidate.projectId===placement.projectId):projectForLegacyTarget(state,revision,target);
  if(project && state.projectTrash?.[project.projectId])continue;
  if(!project){project=createProject(state,projectName);state.legacyKeys['project:'+projectName]=project.projectId;}
  const key=legacyWorkspaceKey(project.projectId,target);
  let workspace=state.workspaces.find(w=>w.workspaceId===(placement?.workspaceId??state.legacyKeys[key]));
  if(workspace && isWorkspaceTrashed(state,workspace.workspaceId)) workspace = undefined;
  if(!workspace){workspace=createWorkspace(state,project.projectId,target.name,revision.purpose);state.legacyKeys[key]=workspace.workspaceId;}
  if(placement){placement.workspaceId=workspace.workspaceId;placement.projectId=workspace.projectId;}
  for(const reportId of unplacedReports){
   state.memberships.push({reportId,workspaceId:workspace.workspaceId,source:'legacy',reason:'기존 제품명·전체 URL·뷰포트·화면 이름으로 초기 분류'});
   workspace.latestReportId=reportId;
   placedReportIds.add(reportId);
  }
 }
}
export function workspaceDetail(state:WorkspaceState,tasks:ReviewTask[],workspaceId:string):WorkspaceDetail|undefined{const workspace=state.workspaces.find(w=>w.workspaceId===workspaceId);if(!workspace)return;const project=state.projects.find(p=>p.projectId===workspace.projectId)!;const requests=state.requests.filter(r=>r.workspaceId===workspaceId).map(r=>{const task=tasks.find(t=>t.taskId===r.taskId),revision=task?.revisions.find(v=>v.revisionId===r.revisionId),target=revision?.targets.find(t=>t.targetId===r.targetId);return{...r,targetUrl:target?.kind==='url'?target.url:undefined,attempts:target?.attempts??r.attempts};});const reportIds=state.memberships.filter(m=>m.workspaceId===workspaceId).map(m=>m.reportId);const relatedIds=new Set(state.requests.filter(r=>r.classification?.fromWorkspaceId===workspaceId).map(r=>r.workspaceId));return{workspace,project,requests,reportIds,membershipEvents:(state.movements??[]).filter(e=>e.entityId===workspaceId||e.fromId===workspaceId||e.toId===workspaceId),linkedWorkspaces:state.workspaces.filter(w=>relatedIds.has(w.workspaceId))};}
