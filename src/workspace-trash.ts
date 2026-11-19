import {createHash} from 'node:crypto';
import {open, readdir, realpath, rm} from 'node:fs/promises';
import {constants} from 'node:fs';
import {basename, dirname, isAbsolute, join, relative, resolve, sep} from 'node:path';
import type {FocusedReview} from './focused-review-contract.js';
import type {ReviewAttempt, ReviewTask} from './review-contract.js';
import type {WorkspaceRequest} from './workspace-contract.js';
import {allWorkspaceTrash, legacyProjectId, legacyWorkspaceId, type PendingWorkspaceCleanup, type WorkspaceState} from './workspace-state.js';

export const WORKSPACE_RETENTION_MS = 14 * 24 * 60 * 60 * 1000;

export function collectWorkspaceTrash(state: WorkspaceState, tasks: ReviewTask[], focusedReviews: FocusedReview[], workspaceIds: ReadonlySet<string>, projectId?: string) {
 const memberships = new Map(state.memberships.map(membership => [membership.reportId, membership.workspaceId]));
 const reportIds = new Set(state.memberships.filter(membership => workspaceIds.has(membership.workspaceId)).map(membership => membership.reportId));
 const requestIds = new Set(state.requests.filter(request => workspaceIds.has(request.workspaceId)).map(request => request.requestId));
 const attempts = new Map<string, ReviewAttempt>();
 const existingTrash = new Set(allWorkspaceTrash(state).flatMap(entry => entry.attemptIds));
 const focusedReviewIds = new Set<string>();
 const collectAttempt = (attempt: ReviewAttempt) => {
  attempts.set(attempt.attemptId, attempt);
  if (attempt.reportId) reportIds.add(attempt.reportId);
 };
 for (const task of tasks) for (const revision of task.revisions) for (const target of revision.targets) {
  const ownsRequest = revision.workspaceRequestId && requestIds.has(revision.workspaceRequestId);
  const legacyId = !revision.workspaceRequestId ? legacyWorkspaceId(state, revision, target) : undefined;
  const hasUnplacedProject = projectId !== undefined && !revision.workspaceRequestId && !legacyId &&
   legacyProjectId(state, revision, target) === projectId;
  for (const attempt of target.attempts) {
   const memberOf = attempt.reportId ? memberships.get(attempt.reportId) : undefined;
   const owner = memberOf ?? legacyId;
   if (!existingTrash.has(attempt.attemptId) && (ownsRequest || (owner ? workspaceIds.has(owner) : hasUnplacedProject))) collectAttempt(attempt);
  }
 }
 // Focused reviews can themselves supply the capture for another focused review.
 let hasAdded = true;
 while (hasAdded) {
  hasAdded = false;
  for (const review of focusedReviews) {
   if (!reportIds.has(review.source.reportId) || focusedReviewIds.has(review.focusedReviewId)) continue;
   focusedReviewIds.add(review.focusedReviewId);
   for (const attempt of review.attempts) collectAttempt(attempt);
   hasAdded = true;
  }
 }
 return {attempts, requestIds, reportIds, focusedReviewIds};
}

export function usesTrashedHistory(request: WorkspaceRequest, requestIds: ReadonlySet<string>, reportIds: ReadonlySet<string>) {
 return [request.parentRequestId, request.executionBaseRequestId].some(id => id && requestIds.has(id)) ||
  [request.parentReportId, request.source?.reportId].some(id => id && reportIds.has(id));
}

export function removeTaskAttempts(task: ReviewTask, attemptIds: ReadonlySet<string>): ReviewTask | undefined {
 if (!task.revisions.some(revision => revision.targets.some(target => target.attempts.some(attempt => attemptIds.has(attempt.attemptId)))))
  return task;
 const revisions = task.revisions.flatMap(revision => {
  const targets = revision.targets.flatMap(target => {
   const attempts = target.attempts.filter(attempt => !attemptIds.has(attempt.attemptId));
   return attempts.length ? [{...target, attempts}] : [];
  });
  return targets.length ? [{...revision, targets}] : [];
 });
 if (!revisions.length) return;
 const metadataRevision = task.revisions.findLast(revision => !revision.workspaceRequestId) ?? task.revisions[0];
 if (revisions.some(revision => revision.revisionId === metadataRevision.revisionId)) return {...task, revisions};
 const {title, purpose, project, externalLinks} = revisions.findLast(revision => !revision.workspaceRequestId) ?? revisions[0];
 return {...task, title, purpose, project, externalLinks, revisions};
}

const GENERATED_RUN = /^\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-\d{3}Z-[a-f0-9]{8}$/;
const RUN_FILES = ['report.md', 'manifest.json', 'check-plan.json', 'verification-input.json', 'verification-replay.json'];
type CleanupFiles = PendingWorkspaceCleanup['files'];

async function* reportFiles(directory: string): AsyncGenerator<string> {
 const stack = [directory];
 while (stack.length) {
  const current = stack.pop()!;
  let entries;
  try { entries = await readdir(current, {withFileTypes: true}); }
  catch (error) {
   if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue;
   throw error;
  }
  for (const entry of entries) {
   const file = join(current, entry.name);
   if (entry.isSymbolicLink()) continue;
   if (entry.isDirectory()) stack.push(file);
   else if (entry.isFile() && entry.name === 'report.json') yield file;
  }
 }
}

async function ownedReportFiles(root: string, file: string, isManaged: boolean): Promise<CleanupFiles> {
 const reportFile = {path: relative(root, file), isDirectory: false};
 const files: CleanupFiles = [];
 const directory = dirname(file);
 const runName = basename(directory);
 if (directory === root || (!isManaged && !GENERATED_RUN.test(runName)) || await realpath(directory) !== directory) return [reportFile];
 try {
  const handle = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
   if ((await handle.stat()).size > 32 * 1024 * 1024) return [reportFile];
   const report = JSON.parse(await handle.readFile('utf8')) as {
    runId?: unknown;
    observations?: unknown;
    evidence?: unknown;
   } | null;
   if (!report || report.runId !== runName) return [reportFile];
   for (const name of RUN_FILES) files.push({path: relative(root, join(directory, name)), isDirectory: false});
   const observations: Array<{evidenceRefs?: unknown} | null> = Array.isArray(report.observations) ? report.observations : [];
   const evidence: Array<{relativePath?: unknown} | null> = [
    ...(Array.isArray(report.evidence) ? report.evidence : []),
    ...observations.flatMap(observation => Array.isArray(observation?.evidenceRefs) ? observation.evidenceRefs : []),
   ];
   for (const item of evidence) {
    if (typeof item?.relativePath === 'string' && /^observations\/[\w-]+\/[\w-]+\.(png|txt|json)$/.test(item.relativePath))
     files.push({path: relative(root, join(directory, item.relativePath)), isDirectory: false});
   }
  } finally {
   await handle.close();
  }
 } catch (error) {
  if (!(error instanceof SyntaxError) && (error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
 }
 // Keep the evidence index available if a sibling file fails to be removed.
 return [...files, reportFile];
}

/**
 * Older CLI reports can be attached from anywhere in the configured runs root.
 * For conventional generated runs we own the named artifacts only. For other
 * layouts the indexed report file is the only artifact we can identify safely.
 */
export async function attachedReportFiles(root: string, reportIds: Set<string>): Promise<CleanupFiles> {
 const files: CleanupFiles = [];
 if (!reportIds.size) return files;
 for await (const file of reportFiles(root)) {
  if (!reportIds.delete(createHash('sha256').update(relative(root, file)).digest('hex'))) continue;
  files.push(...await ownedReportFiles(root, file, false));
  if (!reportIds.size) break;
 }
 return files;
}

export async function managedAttemptFiles(root: string, attemptPath: string, reportIds: ReadonlySet<string>): Promise<CleanupFiles> {
 const directory = join(root, attemptPath);
 const wholeAttempt = [{path: attemptPath, isDirectory: true}];
 try {
  if (await realpath(directory) !== directory) return wholeAttempt;
 } catch (error) {
  if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
  throw error;
 }
 let hasOtherReports = false;
 const owned: string[] = [];
 for await (const file of reportFiles(directory)) {
  const reportId = createHash('sha256').update(relative(root, file)).digest('hex');
  if (reportIds.has(reportId)) owned.push(file);
  else hasOtherReports = true;
 }
 if (!hasOtherReports) return wholeAttempt;
 const files: CleanupFiles = [];
 for (const file of owned) files.push(...await ownedReportFiles(root, file, true));
 return files;
}

export async function removeWorkspaceFile(root: string, file: CleanupFiles[number]) {
 const path = resolve(root, file.path);
 if (isAbsolute(file.path) || !path.startsWith(root + sep)) throw new Error('Invalid workspace cleanup path');
 try {
  const parent = dirname(path);
  if (await realpath(parent) !== parent) throw new Error('Workspace cleanup path traverses a symbolic link');
  await rm(path, {force: true, recursive: file.isDirectory});
 } catch (error) {
  if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
 }
}
