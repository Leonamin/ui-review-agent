import type {FollowupResult} from './followup-types.js';
import {z} from 'zod';
import {normalizeProjectPostHost,PROJECT_POST_HOST_LIMIT} from './post-host-policy.js';
import {normalizeReviewTargetOrigin,normalizeSupabaseAuthOrigin,PROJECT_SUPABASE_AUTH_BINDING_LIMIT,type ProjectSupabaseAuthBinding} from './supabase-auth-policy.js';
import {reviewIdSchema,reviewOptionsSchema,reviewTargetSchema,type ReviewRevisionOptions,type ReviewAttempt} from './review-contract.js';
import {focusRegionSchema,type FocusRegion,type FocusSource} from './focused-review-contract.js';
const reportIdSchema=z.string().regex(/^[a-f0-9]{64}$/);
export const projectInputSchema=z.object({projectId:reviewIdSchema.optional(),name:z.string().trim().min(1).max(160),description:z.string().trim().max(2000).optional()}).strict();
export const projectDeletionSchema = z.object({
 mode: z.enum(['cascade', 'project-only']),
 scopeVersion: z.string().regex(/^[a-f0-9]{64}$/),
}).strict();
export const projectPostHostsSchema=z.object({
 expectedVersion:z.number().int().min(1),
 postAllowedHosts:z.array(z.string().max(253).transform((value,ctx)=>{
  const host=normalizeProjectPostHost(value);
  if(!host){ctx.addIssue({code:'custom',message:'URL, 포트, IP, 와일드카드 없이 공개 DNS 호스트명만 입력하세요.'});return z.NEVER;}
  return host;
 })).max(PROJECT_POST_HOST_LIMIT).transform(hosts=>[...new Set(hosts)]),
}).strict();
export const projectSupabaseAuthBindingsSchema = z.array(z.object({
 targetOrigin: z.string().max(300).transform((value, ctx) => {
  const origin = normalizeReviewTargetOrigin(value);
  if (origin) return origin;
  ctx.addIssue({code:'custom', message:'검토 사이트의 HTTPS 출처만 경로 없이 입력하세요.'});
  return z.NEVER;
 }),
 origin: z.string().max(300).transform((value, ctx) => {
  const origin = normalizeSupabaseAuthOrigin(value);
  if (origin) return origin;
  ctx.addIssue({code:'custom', message:'https://<프로젝트>.supabase.co 형식의 출처만 입력하세요.'});
  return z.NEVER;
 }),
}).strict().refine(binding => binding.targetOrigin !== binding.origin, {path:['origin'], message:'검토 사이트와 다른 Supabase 출처를 지정하세요.'})).max(PROJECT_SUPABASE_AUTH_BINDING_LIMIT).superRefine((bindings, ctx) => {
 if (new Set(bindings.map(binding => binding.targetOrigin)).size !== bindings.length)
  ctx.addIssue({code:'custom', message:'검토 사이트마다 Supabase 출처를 하나만 지정하세요.'});
});
export const projectSupabaseAuthSettingsSchema = z.object({
 expectedVersion: z.number().int().min(1),
 supabaseAuthBindings: projectSupabaseAuthBindingsSchema,
}).strict();
export const workspaceInputSchema=z.object({workspaceId:reviewIdSchema.optional(),projectId:reviewIdSchema,name:z.string().trim().min(1).max(160),goal:z.string().trim().min(1).max(4000)}).strict();
export const workspaceInitialSchema=z.object({submissionId:z.string().trim().min(1).max(200),target:z.discriminatedUnion('kind',[reviewTargetSchema.options[0].omit({targetId:true}).partial({name:true}),reviewTargetSchema.options[1].omit({targetId:true}).partial({name:true})]),options:reviewOptionsSchema.partial().strict().optional()}).strict();
export const workspaceFollowupSchema=z.object({submissionId:z.string().trim().min(1).max(200),parentReportId:reportIdSchema,instruction:z.string().trim().min(1).max(4000),imageId:reportIdSchema.optional(),sourceSha256:reportIdSchema.optional(),region:focusRegionSchema.optional(),scopeMode:z.enum(['selected-only','related-screen']).optional(),shouldWaitForStart:z.boolean().optional(),maxOptions:z.number().int().min(1).max(3).optional(),options:reviewOptionsSchema.partial().strict().optional()}).strict().superRefine((v,c)=>{if(v.region&&(!v.imageId||!v.sourceSha256))c.addIssue({code:'custom',message:'선택 영역에는 이미지 ID와 원본 해시가 필요합니다.'});});
export interface ReviewProject {projectId:string;name:string;description:string;postAllowedHosts:string[];supabaseAuthBindings:ProjectSupabaseAuthBinding[];version:number;createdAt:string;updatedAt:string;isUncategorized?:true;}
export interface ReviewWorkspace {workspaceId:string;projectId:string;name:string;goal:string;version:number;createdAt:string;updatedAt:string;latestReportId?:string;}
export interface ReportWorkspaceContext {
 workspaceId: string;
 workspaceName: string;
 projectId: string;
 projectName: string;
}
export interface TrashedWorkspace {
 workspace: ReviewWorkspace;
 project: ReviewProject;
 trashedAt: string;
 expiresAt: string;
 reportCount: number;
 requestCount: number;
}
export interface ProjectDeletionPreview {
 projectId: string;
 scopeVersion: string;
 workspaceCount: number;
 trashedWorkspaceCount: number;
 reportCount: number;
 requestCount: number;
 hasActiveReviews: boolean;
 hasExternalDependencies: boolean;
}
export interface TrashedProject {
 project: ReviewProject;
 trashedAt: string;
 expiresAt: string;
 workspaceCount: number;
 reportCount: number;
 requestCount: number;
}
export type ProjectDeletionResult =
 | {mode: 'cascade'; entry: TrashedProject}
 | {mode: 'project-only'; destinationProjectId?: string};
export interface WorkspaceSource {reportId:string;reportSha256:string;runId:string;targetUrl?:string;viewport?:{width:number;height:number;deviceScaleFactor:number};image?:FocusSource;}
export interface WorkspaceAttempt extends Omit<ReviewAttempt,'status'> {status:ReviewAttempt['status']|'cancelled';phase?:string;reason?:string;}
export interface WorkspaceRequest {requestId:string;workspaceId:string;kind:'initial'|'followup'|'image-handoff';submissionId:string;parentReportId?:string;parentRequestId?:string;instruction:string;targetUrl?:string;comparisonUrl?:string;source?:WorkspaceSource;region?:FocusRegion;scopeMode?:'selected-only'|'related-screen';maxOptions:number;executionBaseRequestId?:string;queuePredecessorRequestId?:string;createdAt:string;options:ReviewRevisionOptions;taskId:string;revisionId:string;targetId:string;attempts:WorkspaceAttempt[];canRetry?:boolean;classification?:{reason:string;fromWorkspaceId:string};needsImageHandoff?:boolean;phase?:string;reason?:string;result?:FollowupResult;}
export interface WorkspaceMovement {movementId:string;entityType:'workspace'|'request'|'report';entityId:string;fromId?:string;toId:string;reason:string;createdAt:string;reportIds?:string[];}
export interface WorkspaceDetail {membershipEvents?:WorkspaceMovement[];workspace:ReviewWorkspace;project:ReviewProject;requests:WorkspaceRequest[];reportIds:string[];linkedWorkspaces:ReviewWorkspace[];}
export type PublicWorkspaceRequest = Omit<WorkspaceRequest, 'taskId' | 'revisionId' | 'targetId'>;
export type PublicWorkspaceDetail = Omit<WorkspaceDetail, 'requests'> & {requests: PublicWorkspaceRequest[]};
export interface WorkspaceMembership {reportId:string;workspaceId:string;reason:string;source:'legacy'|'user'|'execution';}
