import {readStoredReviewTask} from './helpers/review-state.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash, randomUUID} from 'node:crypto';
import {access, mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile} from 'node:fs/promises';
import fsPromises from 'node:fs/promises';
import {syncBuiltinESMExports} from 'node:module';
import {tmpdir} from 'node:os';
import {relative, resolve} from 'node:path';
import sharp from 'sharp';
import type {inspect} from '../src/core.js';
import {ReviewService, ReviewServiceError} from '../src/review-service.js';
import type {RunSpec} from '../src/types.js';

const retention = 14 * 86_400_000;
const isMissing = (error: unknown) => error instanceof ReviewServiceError && error.status === 404;
const isConflict = (error: unknown) => error instanceof ReviewServiceError && error.status === 409;

async function engine(spec: RunSpec, root: string) {
 const runId = randomUUID();
 const runDir = resolve(root, runId);
 await mkdir(runDir, {recursive: true});
 const result = {runId, status: 'completed', endedAt: new Date().toISOString(), ...(spec.followup ? {
  followup: {requestId: spec.followup.requestId, workspaceId: spec.followup.workspaceId, status: 'completed', history: [], replay: [], needsImageHandoff: false},
 } : {})};
 await writeFile(resolve(runDir, 'report.json'), JSON.stringify(result));
 return {result, runDir};
}

async function waitFor<T>(get: () => Promise<T | undefined>): Promise<T> {
 const deadline = Date.now() + 4_000;
 while (Date.now() < deadline) {
  const value = await get();
  if (value) return value;
  await new Promise(resolve => setTimeout(resolve, 10));
 }
 throw new Error('Timed out waiting for review');
}

const source = async (reportId: string) => ({reportId, reportSha256: 'a'.repeat(64), runId: 'source'});
const url = {kind: 'url', url: 'https://example.test'};
const statePath = (service: ReviewService) => resolve(service.stateRoot, 'state.json');
const reportPath = (root: string, attemptId: string, runId: string) => resolve(root, 'review-attempts', attemptId, runId, 'report.json');

test('workspace trash is hidden, survives restart, restores in place and expires at 14 days while retaining shared assets', async () => {
 const root = await mkdtemp(resolve(tmpdir(), 'workspace-trash-'));
 let timestamp = Date.UTC(2026, 10, 17);
 const create = () => new ReviewService(root, {inspect: engine as typeof inspect, workspaceClock: () => timestamp});
 let service = create();
 try {
  await service.start();
  const project = await service.addProject({name: 'Project'});
  const first = await service.addWorkspace({projectId: project.projectId, name: 'First', goal: 'Inspect'});
  const second = await service.addWorkspace({projectId: project.projectId, name: 'Second', goal: 'Inspect'});
  const png = await sharp({create: {width: 10, height: 10, channels: 3, background: 'pink'}}).png().toBuffer();
  const image = await service.upload({fileName: 'shared.png', base64: png.toString('base64')});
  const exclusive = await service.upload({fileName: 'exclusive.png', base64: png.toString('base64')});
  for (const [workspaceId, assetId] of [
   [first.workspaceId, image.assetId], [first.workspaceId, exclusive.assetId], [second.workspaceId, image.assetId],
  ]) await service.submitWorkspaceInitial(workspaceId, {submissionId: randomUUID(), target: {kind: 'image', assetId}});
  await waitFor(async () => (await service.workspace(first.workspaceId)).reportIds.length === 2 ? true : undefined);
  await waitFor(async () => (await service.workspace(second.workspaceId)).workspace.latestReportId);
  const original = await service.workspace(first.workspaceId);
  const attempts = original.requests.map(request => request.attempts[0]);
  const trash = await service.trashWorkspace(first.workspaceId, {expectedVersion: original.workspace.version});
  assert.equal(Date.parse(trash.expiresAt) - Date.parse(trash.trashedAt), retention);
  assert.equal(trash.reportCount, 2);
  assert.deepEqual((await service.workspaces()).map(workspace => workspace.workspaceId), [second.workspaceId]);
  assert.deepEqual(Object.keys(await service.reportContexts()), (await service.workspace(second.workspaceId)).reportIds);
  assert.deepEqual(new Set(service.trashedReportIds()), new Set(original.reportIds));
  await assert.rejects(service.workspace(first.workspaceId), isMissing);
  await service.close();

  service = create();
  await service.start();
  assert.deepEqual((await service.trashedWorkspaces()).map(entry => entry.workspace.workspaceId), [first.workspaceId]);
  await assert.rejects(service.workspace(first.workspaceId), isMissing);
  for (const attempt of attempts) await access(reportPath(root, attempt.attemptId, attempt.runId!));
  timestamp += retention - 1;
  const restored = await service.restoreWorkspace(first.workspaceId);
  assert.deepEqual((await service.workspace(first.workspaceId)).reportIds, original.reportIds);
  assert.equal(service.trashedReportIds().size, 0);

  await service.trashWorkspace(first.workspaceId, {expectedVersion: restored.version});
  timestamp += retention;
  await assert.rejects(service.restoreWorkspace(first.workspaceId), isConflict);
  assert.deepEqual(await service.trashedWorkspaces(), []);
  await service.close();

  service = create();
  await service.start();
  for (const attempt of attempts) await assert.rejects(access(reportPath(root, attempt.attemptId, attempt.runId!)), {code: 'ENOENT'});
  await access(resolve(service.stateRoot, 'assets', image.assetId));
  await assert.rejects(access(resolve(service.stateRoot, 'assets', exclusive.assetId)), {code: 'ENOENT'});
  assert.equal((await service.workspace(second.workspaceId)).reportIds.length, 1);
  assert.deepEqual((await service.projects()).map(project => project.name), ['Project']);
 } finally {
  await service.close();
  await rm(root, {recursive: true, force: true});
 }
});

test('cancelled in-flight workers and external follow-up dependencies protect workspace history', async () => {
 const root = await mkdtemp(resolve(tmpdir(), 'workspace-trash-links-'));
 let release!: () => void;
 const gate = new Promise<void>(resolve => {release = resolve;});
 const service = new ReviewService(root, {inspect: (async (spec, output) => {
  if (spec.followup) await gate;
  return engine(spec, output);
 }) as typeof inspect});
 try {
  await service.start();
  const project = await service.addProject({name: 'Project'});
  const parent = await service.addWorkspace({projectId: project.projectId, name: 'Parent', goal: 'Inspect'});
  const child = await service.addWorkspace({projectId: project.projectId, name: 'Child', goal: 'Inspect'});
  await service.submitWorkspaceInitial(parent.workspaceId, {submissionId: randomUUID(), target: url});
  const parentReportId = await waitFor(async () => (await service.workspace(parent.workspaceId)).workspace.latestReportId);
  const {request} = await service.submitWorkspaceFollowup(parent.workspaceId, {
   submissionId: randomUUID(), parentReportId, instruction: 'Detail',
  }, source);
  const currentAttempt = async () => (await service.workspace(parent.workspaceId)).requests.at(-1)!.attempts.at(-1)!;
  await waitFor(async () => (await currentAttempt()).status === 'running' ? true : undefined);
  await service.cancelWorkspaceRequest(request.requestId, {attemptId: request.attempts[0].attemptId});
  await assert.rejects(service.trashWorkspace(parent.workspaceId, {expectedVersion: parent.version}), isConflict);
  release();
  await waitFor(async () => (await currentAttempt()).reportId);
  await service.moveWorkspaceRequest(request.requestId, {workspaceId: child.workspaceId, expectedVersion: parent.version});
  await assert.rejects(service.trashWorkspace(parent.workspaceId, {expectedVersion: parent.version + 1}), isConflict);
  await service.trashWorkspace(child.workspaceId, {expectedVersion: child.version + 1});
  await service.trashWorkspace(parent.workspaceId, {expectedVersion: parent.version + 1});
  await assert.rejects(service.restoreWorkspace(child.workspaceId), isConflict);
  await service.restoreWorkspace(parent.workspaceId);
  await service.restoreWorkspace(child.workspaceId);
  assert.equal((await service.workspace(child.workspaceId)).requests[0].parentReportId, parentReportId);
 } finally {
  release();
  await service.close();
  await rm(root, {recursive: true, force: true});
 }
});

test('purge removes linked legacy report data without erasing unrelated nested reports and replays pending filesystem cleanup', async context => {
 const root = await mkdtemp(resolve(tmpdir(), 'workspace-trash-files-'));
 const external = await mkdtemp(resolve(tmpdir(), 'workspace-trash-external-'));
 let timestamp = Date.UTC(2026, 10, 17);
 const service = new ReviewService(root, {inspect: engine as typeof inspect, workspaceClock: () => timestamp});
 context.mock.method(console, 'error', () => {});
 try {
  await service.start();
  const legacy = await service.submit({
   title: 'Legacy', purpose: 'Inspect', submissionId: randomUUID(), targets: [{...url, name: 'Legacy screen'}],
  });
  const attempt = await waitFor(async () => {
   const result = (await readStoredReviewTask(service, legacy.task.taskId)).revisions[0].targets[0].attempts[0];
   return result.reportId ? result : undefined;
  });
  const [workspace] = await service.workspaces();
  const projectId = workspace.projectId;
  const other = await service.addWorkspace({projectId, name: 'Other', goal: 'Inspect'});
  const raw = async (path: string) => {
   await mkdir(resolve(path, '..'), {recursive: true});
   await writeFile(path, '{}');
   return createHash('sha256').update(relative(root, path)).digest('hex');
  };
  const hiddenFolderReport = resolve(root, '.archive', 'fixture', 'report.json');
  const rawId = await raw(hiddenFolderReport);
  const siblingReport = resolve(root, 'review-attempts', attempt.attemptId, 'other', 'report.json');
  const siblingId = await raw(siblingReport);
  await service.attachWorkspaceReport(other.workspaceId, {reportId: siblingId, expectedVersion: other.version}, source);
  const linked = await service.attachWorkspaceReport(workspace.workspaceId, {
   reportId: rawId, expectedVersion: workspace.version,
  }, source);
  await symlink(external, resolve(root, '.viewer-metadata'));
  const externalRecommendation = resolve(external, rawId + '.json');
  await writeFile(externalRecommendation, 'preserve');
  await service.trashWorkspace(workspace.workspaceId, {expectedVersion: linked.version});
  timestamp += retention;
  await service.purgeExpiredWorkspaces();
  assert.equal(service.trashedReportIds().has(rawId), true);
  const state = JSON.parse(await readFile(statePath(service), 'utf8'));
  assert.ok(state.workspaceData.pendingCleanup[workspace.workspaceId]);
  assert.deepEqual(state.workspaceData.workspaces.map((entry: {workspaceId: string}) => entry.workspaceId), [other.workspaceId]);
  await assert.rejects(access(hiddenFolderReport), {code: 'ENOENT'});
  await assert.rejects(access(reportPath(root, attempt.attemptId, attempt.runId!)), {code: 'ENOENT'});
  await access(siblingReport);
  assert.equal(await readFile(externalRecommendation, 'utf8'), 'preserve');

  await rm(resolve(root, '.viewer-metadata'));
  await mkdir(resolve(root, '.viewer-metadata'));
  const recommendation = resolve(root, '.viewer-metadata', rawId + '.json');
  await writeFile(recommendation, '{}');
  await service.purgeExpiredWorkspaces();
  await assert.rejects(access(recommendation), {code: 'ENOENT'});
  assert.equal(service.trashedReportIds().size, 0);
 } finally {
  await service.close();
  await rm(root, {recursive: true, force: true});
  await rm(external, {recursive: true, force: true});
 }
});

test('a failed report scan leaves only its own expired batch and still drains earlier cleanup', async context => {
 const root = await mkdtemp(resolve(tmpdir(), 'workspace-trash-isolation-'));
 let timestamp = Date.UTC(2026, 10, 17);
 const service = new ReviewService(root, {inspect: engine as typeof inspect, workspaceClock: () => timestamp});
 context.mock.method(console, 'error', () => {});
 const metadata = resolve(root, '.viewer-metadata');
 const blockedDirectory = resolve(root, 'unreadable-reports');
 try {
  await service.start();
  const project = await service.addProject({name: 'Purge isolation'});
  const createWorkspace = (name: string) => service.addWorkspace({projectId: project.projectId, name, goal: 'Inspect'});
  const complete = async (name: string) => {
   const workspace = await createWorkspace(name);
   await service.submitWorkspaceInitial(workspace.workspaceId, {submissionId: randomUUID(), target: url});
   const attempt = await waitFor(async () => {
    const current = (await service.workspace(workspace.workspaceId)).requests[0].attempts[0];
    return current.reportId ? current : undefined;
   });
   return {workspace: (await service.workspace(workspace.workspaceId)).workspace, attempt};
  };

  const earlier = await complete('Earlier cleanup');
  await symlink(service.stateRoot, metadata);
  await service.trashWorkspace(earlier.workspace.workspaceId, {expectedVersion: earlier.workspace.version});
  timestamp += retention;
  await service.purgeExpiredWorkspaces();
  assert.ok(service.trashedReportIds().has(earlier.attempt.reportId!));
  await rm(metadata);
  await mkdir(metadata);
  const pendingFile = resolve(metadata, earlier.attempt.reportId + '.json');
  await writeFile(pendingFile, '{}');

  const blocked = await createWorkspace('Legacy report');
  const blockedReport = resolve(blockedDirectory, 'report.json');
  await mkdir(blockedDirectory);
  await writeFile(blockedReport, '{}');
  const blockedId = createHash('sha256').update(relative(root, blockedReport)).digest('hex');
  const attached = await service.attachWorkspaceReport(blocked.workspaceId, {
   reportId: blockedId, expectedVersion: blocked.version,
  }, source);
  const independent = await complete('Independent cleanup');
  await service.trashWorkspace(blocked.workspaceId, {expectedVersion: attached.version});
  await service.trashWorkspace(independent.workspace.workspaceId, {expectedVersion: independent.workspace.version});

  const blockedPath = await realpath(blockedDirectory);
  const {readdir} = fsPromises;
  const failingRead = context.mock.method(fsPromises, 'readdir', (...args: Parameters<typeof readdir>) => {
   if (args[0] === blockedPath)
    return Promise.reject(Object.assign(new Error('Report directory is inaccessible'), {code: 'EACCES'}));
   return Reflect.apply(readdir, fsPromises, args);
  });
  syncBuiltinESMExports();
  timestamp += retention;
  try {
   await service.purgeExpiredWorkspaces();
  } finally {
   failingRead.mock.restore();
   syncBuiltinESMExports();
  }
  assert.deepEqual([...service.trashedReportIds()], [blockedId]);
  await access(blockedReport);
  await assert.rejects(access(reportPath(root, independent.attempt.attemptId, independent.attempt.runId!)), {code: 'ENOENT'});
  await assert.rejects(access(pendingFile), {code: 'ENOENT'});
 } finally {
  await service.close();
  await rm(root, {recursive: true, force: true});
 }
});
