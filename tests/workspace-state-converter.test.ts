import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import {mkdir, mkdtemp, readFile, readdir, rm, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import test from 'node:test';
import {fileURLToPath} from 'node:url';
import type {ReviewAttempt, ReviewRevision, ReviewTask} from '../src/review-contract.js';
import type {WorkspaceRequest} from '../src/workspace-contract.js';
import {convertWorkspaceState} from '../src/workspace-state-converter.js';
import {createProject, createWorkspace, emptyWorkspaceState} from '../src/workspace-state.js';

const timestamp = '2026-11-19T00:00:00.000Z';
const fixtureUrl = 'https://example.test/catalog';
const options = {evaluator: 'codex', timeoutSeconds: 60, reviewPipeline: 'standard'} as const;

function id(index: number) {
 return `00000000-0000-4000-8000-${String(index).padStart(12, '0')}`;
}

function hash(value: string) {
 return createHash('sha256').update(value).digest('hex');
}

function attempt(index: number, status: ReviewAttempt['status']): ReviewAttempt {
 return {attemptId: id(index), status, createdAt: timestamp};
}

function completed(index: number, runId: string) {
 const attemptId = id(index);
 const reportPath = `review-attempts/${attemptId}/${runId}/report.json`;
 return {
  attempt: {...attempt(index, 'completed'), runId, reportId: hash(reportPath), runStatus: 'completed', endedAt: timestamp},
  reportPath,
  reportBytes: JSON.stringify({runId, status: 'completed'}),
 };
}

function revision(index: number, number: number, targets: ReviewRevision['targets'], workspaceRequestId?: string): ReviewRevision {
 return {revisionId: id(index), number, title: `Revision ${number}`, purpose: 'Check catalog', submittedAt: timestamp, targets, workspaceRequestId, externalLinks: [], options};
}

function task(index: number, revisions: ReviewRevision[]): ReviewTask {
 return {taskId: id(index), title: 'Catalog', purpose: 'Check catalog', externalLinks: [], createdAt: timestamp, updatedAt: timestamp, revisions};
}

function snapshotFixture() {
 const workspaceData = emptyWorkspaceState();
 const project = createProject(workspaceData, 'Example');
 const workspace = createWorkspace(workspaceData, project.projectId, 'Catalog', 'Check catalog');
 const archived = completed(1, 'archived-run');
 const prior = completed(2, 'prior-run');
 const queued = attempt(3, 'queued');
 const awaiting = {...attempt(4, 'awaiting-start'), loginRedirect: {loginUrl: 'https://example.test/login', methods: ['password' as const]}};
 const targetId = id(10);
 const firstRequestId = id(14);
 const secondRequestId = id(15);
 const mixed = task(21, [
  revision(11, 1, [{targetId, kind: 'url', name: 'Catalog', url: fixtureUrl, attempts: [archived.attempt]}]),
  revision(12, 2, [{targetId, kind: 'url', name: 'Catalog', url: fixtureUrl, shouldWaitForStart: true, attempts: [prior.attempt, awaiting]}], firstRequestId),
 ]);
 const followup = task(22, [revision(13, 1, [{targetId: id(16), kind: 'url', name: 'Detail', url: `${fixtureUrl}/details`, attempts: [queued]}], secondRequestId)]);
 const first: WorkspaceRequest = {
  requestId: firstRequestId, workspaceId: workspace.workspaceId, kind: 'initial',
  submissionId: 'first-request', instruction: 'Review the catalog', taskId: mixed.taskId,
  revisionId: id(12), targetId, createdAt: timestamp, maxOptions: 1, options,
  attempts: [prior.attempt], // Projection can lag the authoritative target attempt array.
 };
 const second: WorkspaceRequest = {
  requestId: secondRequestId, workspaceId: workspace.workspaceId, kind: 'followup',
  submissionId: 'followup-request', instruction: 'Review an item', taskId: followup.taskId,
  revisionId: id(13), targetId: id(16), createdAt: timestamp, maxOptions: 1, options,
  parentRequestId: firstRequestId, executionBaseRequestId: firstRequestId, queuePredecessorRequestId: firstRequestId,
  parentReportId: prior.attempt.reportId, attempts: [queued],
  source: {reportId: prior.attempt.reportId, reportSha256: hash(prior.reportBytes), runId: prior.attempt.runId},
 };
 workspaceData.requests.push(first, second);
 workspaceData.memberships.push(
  {workspaceId: workspace.workspaceId, reportId: archived.attempt.reportId, reason: 'Prior report', source: 'legacy'},
  {workspaceId: workspace.workspaceId, reportId: prior.attempt.reportId, reason: 'Current report', source: 'execution'},
 );
 workspaceData.submissions[first.submissionId] = {hash: hash(first.submissionId), requestId: firstRequestId};
 workspaceData.submissions[second.submissionId] = {hash: hash(second.submissionId), requestId: secondRequestId};
 return {
  state: {version: 1, tasks: [followup, mixed], workspaceData, assets: [],
   submissions: {[first.submissionId]: {hash: hash(first.submissionId), taskId: mixed.taskId, revisionId: first.revisionId}},
   compatibleConnections: {[first.revisionId]: hash('provider-fingerprint')}},
  workspace, archived, prior, first, second, awaiting, queued,
 };
}

test('request-centered conversion preserves mixed task reports, ordered retry history and authoritative awaiting/queued IDs', () => {
 const {state, workspace, archived, prior, first, second, awaiting, queued} = snapshotFixture();
 const before = JSON.stringify(state);
 const converted = convertWorkspaceState(state);
 const {candidate, summary} = converted;
 assert.equal(candidate.version, 2);
 assert.deepEqual(candidate.workspaceData.memberships, state.workspaceData.memberships);
 assert.deepEqual(candidate.workspaceData.submissions, state.workspaceData.submissions);
 assert.deepEqual(candidate.workspaceData.requests.map(request => request.requestId), [first.requestId, second.requestId]);
 assert.deepEqual(candidate.workspaceData.requests[0].attempts, [prior.attempt, awaiting]);
 assert.deepEqual(candidate.workspaceData.requests[1].attempts, [queued]);
 assert.equal(candidate.workspaceData.requests[1].queuePredecessorRequestId, first.requestId);
 assert.equal(candidate.workspaceData.requests[1].executionBaseRequestId, first.requestId);
 assert.equal(candidate.workspaceData.requests[1].parentReportId, prior.attempt.reportId);
 assert.deepEqual(candidate.workspaceData.requests[0].execution.submission.options, options);
 assert.equal(candidate.workspaceData.requests[0].execution.compatibleConnectionFingerprint, hash('provider-fingerprint'));
 assert.equal(candidate.legacySubmissions[first.submissionId].requestId, first.requestId);
 assert.equal(candidate.archivedExecutions[0].attempts[0].attemptId, archived.attempt.attemptId);
 assert.deepEqual(candidate.reportOwners.map(owner => [owner.reportId, owner.reportPath, owner.requestId, owner.context?.revisionNumber]), [
  [archived.attempt.reportId, archived.reportPath, undefined, 1],
  [prior.attempt.reportId, prior.reportPath, first.requestId, 2],
 ]);
 assert.deepEqual(summary.activeRequests, [
  {requestId: first.requestId, workspaceId: workspace.workspaceId, attemptId: awaiting.attemptId, status: 'awaiting-start'},
  {requestId: second.requestId, workspaceId: workspace.workspaceId, attemptId: queued.attemptId, status: 'queued'},
 ]);
 assert.equal(summary.hasPreservedRequestIds, true);
 assert.equal(summary.hasPreservedAttemptIds, true);
 assert.equal(JSON.stringify(state), before);
 assert.deepEqual(convertWorkspaceState(state), converted);
});

test('conversion rejects dangling execution references and a persisted managed report with an inconsistent link', () => {
 const dangling = snapshotFixture().state;
 dangling.workspaceData.requests[0].targetId = id(90);
 assert.throws(() => convertWorkspaceState(dangling), /invalid-request-execution-reference/);
 const misidentified = snapshotFixture().state;
 misidentified.tasks[1].revisions[0].targets[0].attempts[0].reportId = hash('incorrect-report-path');
 assert.throws(() => convertWorkspaceState(misidentified), /managed-report-path-mismatch/);
});

test('dry-run CLI is deterministic and does not change either the source state or artifact files', async t => {
 const temp = await mkdtemp(join(tmpdir(), 'workspace-converter-'));
 t.after(() => rm(temp, {recursive: true, force: true}));
 const {state, archived, prior, awaiting, queued} = snapshotFixture();
 const stateRoot = join(temp, '.review-service');
 await mkdir(stateRoot);
 const snapshot = JSON.stringify(state);
 const statePath = join(stateRoot, 'state.json');
 await writeFile(statePath, snapshot);
 for (const report of [archived, prior]) {
  await mkdir(join(temp, 'review-attempts', report.attempt.attemptId, report.attempt.runId), {recursive: true});
  await writeFile(join(temp, report.reportPath), report.reportBytes);
 }
 const pathsBefore = (await readdir(temp, {recursive: true})).sort();
 const command = fileURLToPath(new URL('../src/workspace-state-migration-cli.ts', import.meta.url));
 const run = () => execFileSync(process.execPath, ['--import', 'tsx', command, '--runs', temp], {encoding: 'utf8'});
 const output = run();
 const result = JSON.parse(output);
 assert.equal(result.isDryRun, true);
 assert.equal(result.hasPassed, true);
 assert.equal(result.artifacts.reportsOnDisk, 2);
 assert.equal(result.artifacts.issueCount, 0);
 assert.deepEqual(result.activeRequests.map((request: {attemptId: string}) => request.attemptId), [awaiting.attemptId, queued.attemptId]);
 assert.equal(run(), output);
 assert.equal(await readFile(statePath, 'utf8'), snapshot);
 assert.deepEqual((await readdir(temp, {recursive: true})).sort(), pathsBefore);
 assert.equal(await readFile(join(temp, archived.reportPath), 'utf8'), archived.reportBytes);
});
