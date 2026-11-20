import { createHash } from 'node:crypto';
import { posix } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { z } from 'zod';
import type { FocusedReview } from './focused-review-contract.js';
import type { ReviewAsset, ReviewAttempt, ReviewReportContext, ReviewRevision, ReviewTarget, ReviewTask } from './review-contract.js';
import type { PublicWorkspaceRequest } from './workspace-contract.js';
import { emptyWorkspaceState, type WorkspaceState } from './workspace-state.js';

const id = z.uuid();
const hash = z.string().regex(/^[a-f0-9]{64}$/);
const submissionFingerprint = z.string().regex(/^(?:request(?:-v2)?:)?[a-f0-9]{64}$/);
const attemptSchema = z.looseObject({
 attemptId: id,
 status: z.enum(['awaiting-start', 'queued', 'running', 'completed', 'failed', 'cancelled']),
 reportId: hash.optional(),
 runId: z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,160}$/).optional(),
 credentialMethod: z.enum(['password', 'code']).optional(),
});
const targetIdentity = {targetId: id, attempts: z.array(attemptSchema).min(1), name: z.string()};
const targetSchema = z.discriminatedUnion('kind', [
 z.looseObject({...targetIdentity, kind: z.literal('url'), url: z.string()}),
 z.looseObject({...targetIdentity, kind: z.literal('image'), assetId: id}),
]);
const revisionSchema = z.looseObject({
 revisionId: id, workspaceRequestId: id.optional(), number: z.number().int().positive(),
 title: z.string(), options: z.looseObject({}), targets: z.array(targetSchema).min(1),
});
const taskSchema = z.looseObject({taskId: id, revisions: z.array(revisionSchema)});
const sourceImageSchema = z.looseObject({reportId: hash, imageId: hash, sha256: hash});
const workspaceStateSchema = z.looseObject({
 projects: z.array(z.looseObject({projectId: id})),
 workspaces: z.array(z.looseObject({workspaceId: id, projectId: id})),
 requests: z.array(z.looseObject({
  requestId: id, workspaceId: id, taskId: id, revisionId: id, targetId: id,
  kind: z.enum(['initial', 'followup', 'image-handoff']),
  executionBaseRequestId: id.optional(), queuePredecessorRequestId: id.optional(), parentRequestId: id.optional(),
  parentReportId: hash.optional(),
  source: z.looseObject({reportId: hash, reportSha256: hash, image: sourceImageSchema.optional()}).optional(),
  attempts: z.array(attemptSchema),
 })),
 memberships: z.array(z.looseObject({workspaceId: id, reportId: hash})),
 submissions: z.record(z.string(), z.looseObject({hash, requestId: id})),
 trash: z.record(id, z.looseObject({reportIds: z.array(hash)})).optional(),
 projectTrash: z.record(id, z.looseObject({reportIds: z.array(hash)})).optional(),
 pendingCleanup: z.record(id, z.looseObject({reportIds: z.array(hash)})).optional(),
});
const stateSchema = z.looseObject({
 version: z.literal(1),
 workspaceData: workspaceStateSchema.optional(),
 tasks: z.array(taskSchema),
 assets: z.array(z.looseObject({assetId: id})),
 submissions: z.record(z.string(), z.looseObject({hash: submissionFingerprint, taskId: id, revisionId: id})),
 compatibleConnections: z.record(id, hash).optional(),
 focusedReviews: z.array(z.looseObject({
  focusedReviewId: id, source: sourceImageSchema, attempts: z.array(attemptSchema).min(1),
 })).optional(),
 focusedSubmissions: z.record(z.string(), z.looseObject({hash: submissionFingerprint, focusedReviewId: id})).optional(),
});

interface V1Submission {
 hash: string;
 taskId: string;
 revisionId: string;
}
interface V1State {
 version: 1;
 workspaceData?: WorkspaceState;
 tasks: ReviewTask[];
 assets: ReviewAsset[];
 submissions: Record<string, V1Submission>;
 compatibleConnections?: Record<string, string>;
 focusedReviews?: FocusedReview[];
 focusedSubmissions?: Record<string, {hash: string; focusedReviewId: string}>;
}

interface V1ExecutionRef {
 taskId: string;
 revisionId: string;
 targetId: string;
}
interface ExecutionSnapshot {
 origin: V1ExecutionRef;
 dispatchOrder: number;
 submission: Omit<ReviewRevision, 'revisionId' | 'workspaceRequestId' | 'targets'>;
 target: Omit<Extract<ReviewTarget, {kind: 'url'}>, 'targetId' | 'attempts'> |
  Omit<Extract<ReviewTarget, {kind: 'image'}>, 'targetId' | 'attempts'>;
 compatibleConnectionFingerprint?: string;
}
export interface ConvertedWorkspaceRequest extends Omit<PublicWorkspaceRequest, 'attempts'> {
 execution: ExecutionSnapshot;
 attempts: ReviewAttempt[];
}
interface ArchivedExecution {
 execution: ExecutionSnapshot;
 attempts: ReviewAttempt[];
}
export interface ReportOwner {
 reportId: string;
 attemptId: string;
 runId?: string;
 reportPath?: string;
 requestId?: string;
 focusedReviewId?: string;
 context?: ReviewReportContext;
}
export interface WorkspaceStateCandidate {
 version: 2;
 workspaceData: Omit<WorkspaceState, 'requests'> & {requests: ConvertedWorkspaceRequest[]};
 archivedExecutions: ArchivedExecution[];
 reportOwners: ReportOwner[];
 legacyTaskHeaders: Omit<ReviewTask, 'revisions'>[];
 legacySubmissions: Record<string, V1Submission & {requestId?: string}>;
 assets: ReviewAsset[];
 focusedReviews: FocusedReview[];
 focusedSubmissions?: V1State['focusedSubmissions'];
 compatibleConnections?: V1State['compatibleConnections'];
}
interface ActiveRequest {
 requestId: string;
 workspaceId: string;
 attemptId: string;
 status: 'awaiting-start' | 'queued' | 'running';
}
export interface MigrationSummary {
 workspaceRequests: number;
 workspaceAttempts: number;
 archivedExecutions: number;
 archivedAttempts: number;
 focusedAttempts: number;
 workspaceStatusCounts: Record<ReviewAttempt['status'], number>;
 cachedAttemptDifferences: number;
 stateDiagnostics: Array<{code: string; scope: 'active' | 'historical'; count: number}>;
 reportOwners: number;
 memberships: number;
 hasPreservedRequestIds: boolean;
 hasPreservedAttemptIds: boolean;
 activeRequests: ActiveRequest[];
 activeArchivedAttempts: Array<{attemptId: string; status: ActiveRequest['status']}>;
 activeFocusedAttempts: Array<{attemptId: string; status: ActiveRequest['status']}>;
}

function migrationError(code: string): never {
 throw new Error(code);
}
function indexBy<T>(items: Iterable<T>, key: (item: T) => string, duplicateCode: string) {
 const index = new Map<string, T>();
 for (const item of items) {
  const itemKey = key(item);
  if (index.has(itemKey)) migrationError(duplicateCode);
  index.set(itemKey, item);
 }
 return index;
}
function isActiveStatus(status: ReviewAttempt['status']): status is ActiveRequest['status'] {
 return status === 'awaiting-start' || status === 'queued' || status === 'running';
}
function attemptReportPath(attempt: ReviewAttempt) {
 return attempt.runId && posix.join('review-attempts', attempt.attemptId, attempt.runId, 'report.json');
}
function attemptIdentity(attempts: ReviewAttempt[]) {
 return attempts.map(({attemptId, status}) => [attemptId, status]);
}
function v1AttemptInventory(state: V1State) {
 return [...state.tasks].reverse().flatMap(task =>
  task.revisions.flatMap(revision => revision.targets.map(target => ({
   origin: {taskId: task.taskId, revisionId: revision.revisionId, targetId: target.targetId},
   requestId: revision.workspaceRequestId,
   attempts: attemptIdentity(target.attempts),
  }))));
}
function collectActiveAttempts(executions: Iterable<{attempts: ReviewAttempt[]}>) {
 const activeAttempts: Array<{attemptId: string; status: ActiveRequest['status']}> = [];
 for (const {attempts} of executions) {
  const attempt = attempts.at(-1);
  if (attempt && isActiveStatus(attempt.status)) activeAttempts.push({attemptId: attempt.attemptId, status: attempt.status});
 }
 return activeAttempts;
}

/** Converts a detached snapshot only. Neither the viewer nor the worker accepts its v2 output yet. */
export function convertWorkspaceState(value: unknown): {candidate: WorkspaceStateCandidate; summary: MigrationSummary} {
 if (!stateSchema.safeParse(value).success) migrationError('invalid-v1-state');
 const source = value as V1State;
 const sourceAttemptInventory = v1AttemptInventory(source);
 const state = structuredClone(source);
 const {requests, ...workspaceMetadata} = state.workspaceData ?? emptyWorkspaceState();
 const requestIndex = indexBy(requests, request => request.requestId, 'duplicate-request-id');
 const projectIndex = indexBy(workspaceMetadata.projects, project => project.projectId, 'duplicate-project-id');
 const workspaceIndex = indexBy(workspaceMetadata.workspaces, workspace => workspace.workspaceId, 'duplicate-workspace-id');
 const focusedReviews = state.focusedReviews ?? [];
 const focusedIndex = indexBy(focusedReviews, review => review.focusedReviewId, 'duplicate-focused-review-id');
 indexBy(state.tasks, task => task.taskId, 'duplicate-task-id');
 indexBy(workspaceMetadata.memberships, membership => membership.reportId, 'duplicate-report-membership');
 const assets = indexBy(state.assets, asset => asset.assetId, 'duplicate-asset-id');

 for (const workspace of workspaceMetadata.workspaces) {
  if (!projectIndex.has(workspace.projectId)) migrationError('missing-workspace-project');
 }
 for (const membership of workspaceMetadata.memberships) {
  if (!workspaceIndex.has(membership.workspaceId)) migrationError('missing-report-workspace');
 }
 for (const {requestId} of Object.values(workspaceMetadata.submissions)) {
  if (!requestIndex.has(requestId)) migrationError('missing-workspace-submission-request');
 }
 for (const {focusedReviewId} of Object.values(state.focusedSubmissions ?? {})) {
  if (!focusedIndex.has(focusedReviewId)) migrationError('missing-focused-submission-review');
 }

 const reportOwners = new Map<string, ReportOwner>();
 const attemptsSeen = new Set<string>();
 function rememberAttempt(attempt: ReviewAttempt, ownership: Omit<ReportOwner, 'reportId' | 'attemptId' | 'runId' | 'reportPath'>) {
  if (attemptsSeen.has(attempt.attemptId)) migrationError('duplicate-attempt-id');
  attemptsSeen.add(attempt.attemptId);
  if (!attempt.reportId) return;
  if (reportOwners.has(attempt.reportId)) migrationError('duplicate-report-owner');
  const reportPath = attemptReportPath(attempt);
  if (!reportPath || createHash('sha256').update(reportPath).digest('hex') !== attempt.reportId) {
   migrationError('managed-report-path-mismatch');
  }
  reportOwners.set(attempt.reportId, {
   ...ownership, reportId: attempt.reportId, attemptId: attempt.attemptId, runId: attempt.runId, reportPath,
  });
 }

 const archivedExecutions: ArchivedExecution[] = [];
 const converted = new Map<string, ConvertedWorkspaceRequest>();
 const revisions = new Map<string, {taskId: string; requestId?: string}>();
 let dispatchOrder = 0;
 // Current worker considers oldest tasks first and iterates revisions and targets in stored order.
 for (const task of [...state.tasks].reverse()) {
  for (const revision of task.revisions) {
   const {revisionId, workspaceRequestId, targets, ...submission} = revision;
   if (revisions.has(revisionId)) migrationError('duplicate-revision-id');
   revisions.set(revisionId, {taskId: task.taskId, requestId: workspaceRequestId});
   if (workspaceRequestId && (!requestIndex.has(workspaceRequestId) || targets.length !== 1)) {
    migrationError('invalid-request-target-cardinality');
   }
   indexBy(targets, target => target.targetId, 'duplicate-revision-target-id');
   for (const {targetId, attempts, ...target} of targets) {
    const execution: ExecutionSnapshot = {
     origin: {taskId: task.taskId, revisionId, targetId}, dispatchOrder: dispatchOrder++, submission, target,
     compatibleConnectionFingerprint: state.compatibleConnections?.[revisionId],
    };
    if (workspaceRequestId) {
     const request = requestIndex.get(workspaceRequestId)!;
     if (!workspaceIndex.has(request.workspaceId) || request.taskId !== task.taskId ||
         request.revisionId !== revisionId || request.targetId !== targetId || converted.has(workspaceRequestId)) {
      migrationError('invalid-request-execution-reference');
     }
     const {taskId: _taskId, revisionId: _revisionId, targetId: _targetId, ...publicRequest} = request;
     converted.set(workspaceRequestId, {...publicRequest, execution, attempts});
    } else archivedExecutions.push({execution, attempts});

    attempts.forEach((attempt, index) => rememberAttempt(attempt, {
     requestId: workspaceRequestId,
     context: {
      taskId: task.taskId, taskTitle: revision.title, revisionId, revisionNumber: revision.number,
      targetId, targetName: target.name, attemptNumber: index + 1,
      ...(attempt.shouldReviewLoginPage && attempt.loginRedirect ? {loginRedirect: attempt.loginRedirect} : {}),
     },
    }));
   }
  }
 }
 for (const review of focusedReviews) {
  for (const attempt of review.attempts) rememberAttempt(attempt, {focusedReviewId: review.focusedReviewId});
 }
 const workspaceRequests = requests.map(request => {
  const next = converted.get(request.requestId);
  return next ?? migrationError('unresolved-workspace-request');
 });
 const legacySubmissions = Object.fromEntries(Object.entries(state.submissions).map(([key, submission]) => {
  const reference = revisions.get(submission.revisionId);
  if (!reference || reference.taskId !== submission.taskId) migrationError('invalid-submission-execution-reference');
  return [key, {...submission, requestId: reference.requestId}];
 }));
 const diagnostics = new Map<string, MigrationSummary['stateDiagnostics'][number]>();
 function recordDiagnostic(code: string, scope: 'active' | 'historical') {
  const key = scope + ':' + code;
  const previous = diagnostics.get(key);
  diagnostics.set(key, {code, scope, count: (previous?.count ?? 0) + 1});
 }
 const workspaceStatusCounts: MigrationSummary['workspaceStatusCounts'] = {
  'awaiting-start': 0, queued: 0, running: 0, completed: 0, failed: 0, cancelled: 0,
 };
 for (const request of workspaceRequests) {
  const latest = request.attempts.at(-1)!;
  workspaceStatusCounts[latest.status]++;
  const scope = isActiveStatus(latest.status) ? 'active' : 'historical';
  for (const [dependency, code] of [
   [request.parentRequestId, 'missing-parent-request'],
   [request.executionBaseRequestId, 'missing-execution-base'],
   [request.queuePredecessorRequestId, 'missing-queue-predecessor'],
  ] as const) {
   if (dependency === request.requestId) recordDiagnostic('self-referencing-request', scope);
   else if (dependency && !converted.has(dependency)) recordDiagnostic(code, scope);
  }
  if (request.kind === 'followup' && !request.source) recordDiagnostic('missing-followup-source', scope);
  const target = request.execution.target;
  const hasSourceImage = Boolean(workspaceMetadata.sourceImages?.[request.requestId]);
  if (target.kind === 'image' && !hasSourceImage && !assets.has(target.assetId)) recordDiagnostic('missing-image-asset', scope);
 }
 for (const archived of archivedExecutions) {
  const target = archived.execution.target;
  const latest = archived.attempts.at(-1)!;
  if (target.kind === 'image' && !assets.has(target.assetId)) {
   recordDiagnostic('missing-archived-image-asset', isActiveStatus(latest.status) ? 'active' : 'historical');
  }
 }
 const candidateAttemptInventory = [
  ...workspaceRequests,
  ...archivedExecutions.map(run => ({...run, requestId: undefined})),
 ].sort((left, right) => left.execution.dispatchOrder - right.execution.dispatchOrder).map(run => ({
  origin: run.execution.origin, requestId: run.requestId, attempts: attemptIdentity(run.attempts),
 }));
 const summary: MigrationSummary = {
  workspaceRequests: workspaceRequests.length,
  workspaceAttempts: workspaceRequests.reduce((sum, request) => sum + request.attempts.length, 0),
  archivedExecutions: archivedExecutions.length,
  archivedAttempts: archivedExecutions.reduce((sum, run) => sum + run.attempts.length, 0),
  reportOwners: reportOwners.size,
  memberships: workspaceMetadata.memberships.length,
  focusedAttempts: focusedReviews.reduce((sum, review) => sum + review.attempts.length, 0),
  workspaceStatusCounts,
  cachedAttemptDifferences: workspaceRequests.filter((request, index) =>
   !isDeepStrictEqual(attemptIdentity(request.attempts), attemptIdentity(requests[index].attempts))).length,
  stateDiagnostics: [...diagnostics.values()],
  hasPreservedRequestIds: workspaceRequests.every((request, index) =>
   request.requestId === source.workspaceData?.requests[index].requestId &&
   request.workspaceId === source.workspaceData?.requests[index].workspaceId),
  hasPreservedAttemptIds: isDeepStrictEqual(sourceAttemptInventory, candidateAttemptInventory) &&
   isDeepStrictEqual(
    (source.focusedReviews ?? []).map(review => [review.focusedReviewId, attemptIdentity(review.attempts)]),
    focusedReviews.map(review => [review.focusedReviewId, attemptIdentity(review.attempts)]),
   ),
  activeArchivedAttempts: collectActiveAttempts(archivedExecutions),
  activeFocusedAttempts: collectActiveAttempts(focusedReviews),
  activeRequests: workspaceRequests.flatMap(({requestId, workspaceId, attempts}) => {
   const attempt = attempts.at(-1);
   return attempt && isActiveStatus(attempt.status)
    ? [{requestId, workspaceId, attemptId: attempt.attemptId, status: attempt.status}] : [];
  }),
 };
 return {
  candidate: {
   version: 2,
   workspaceData: {...workspaceMetadata, requests: workspaceRequests},
   archivedExecutions,
   reportOwners: [...reportOwners.values()],
   legacyTaskHeaders: state.tasks.map(({revisions: _, ...task}) => task),
   legacySubmissions,
   assets: state.assets,
   focusedReviews,
   focusedSubmissions: state.focusedSubmissions,
   compatibleConnections: state.compatibleConnections,
  },
  summary,
 };
}
