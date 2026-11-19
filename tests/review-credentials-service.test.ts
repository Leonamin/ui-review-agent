import {readStoredReviewTask} from './helpers/review-state.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import type { inspect } from '../src/core.js';
import type { FollowupResult } from '../src/followup-types.js';
import { ReviewAuthenticationError, ReviewLoginRequired, type ReviewCredentials } from '../src/review-auth.js';
import type { ReviewTarget } from '../src/review-contract.js';
import type { PublicWorkspaceRequest } from '../src/workspace-contract.js';
import { ReviewService } from '../src/review-service.js';
import { createViewerServer } from '../viewer/server/http.js';
import { ReportRepository } from '../viewer/server/repository.js';

const targetUrl = 'https://staging.example.test/orders';
const loginUrl = 'https://staging.example.test/auth';
const oneTimeCode = 'fixture-once-183932';
const password = 'fixture-password-814239';
const submission = (url = targetUrl, shouldWaitForStart = true) => ({
    submissionId: randomUUID(),
    title: 'Orders',
    purpose: 'Review order screen',
    targets: [{ kind: 'url', name: 'Orders', url, shouldWaitForStart }],
});
const latest = (target: ReviewTarget) => target.attempts.at(-1)!;
async function eventually(predicate: () => Promise<boolean>) {
    const deadline = Date.now() + 5000;
    while (Date.now() < deadline) {
        if (await predicate()) return;
        await new Promise(resolve => setTimeout(resolve, 10));
    }
    assert.fail('Review attempt did not reach the expected state');
}
const mockExecution: typeof inspect = (async (_spec, output) => {
    const runId = randomUUID(), runDir = resolve(output, runId);
    await mkdir(runDir, { recursive: true });
    await writeFile(resolve(runDir, 'report.json'), JSON.stringify({ runId, status: 'completed' }));
    return { result: { runId }, runDir };
}) as typeof inspect;

test('an automatic login pause survives restart and explicit guest review keeps the requested URL', async () => {
    const root = await mkdtemp(resolve(tmpdir(), 'credentials-redirect-'));
    let service = new ReviewService(root, { inspect: async (_spec, _output, runtime) => {
        assert.equal(runtime?.shouldDetectRedirectedLogin, true);
        throw new ReviewLoginRequired(loginUrl + '?login_hint=private-hint#private-fragment', ['password']);
    } });
    try {
        await service.start();
        const { task, revision } = await service.submit(submission(targetUrl, false));
        const target = revision.targets[0];
        const readTarget = async () => (await readStoredReviewTask(service, task.taskId)).revisions[0].targets[0];
        await eventually(async () => latest(await readTarget()).status === 'awaiting-start');
        const waiting = latest(await readTarget());
        assert.equal(waiting.attemptId, target.attempts[0].attemptId);
        assert.equal(waiting.reportId, undefined);
        assert.deepEqual(waiting.loginRedirect, { loginUrl, methods: ['password'] });
        assert.equal(service.executionStatus.runningCount, 0);
        assert.doesNotMatch(await readFile(resolve(service.stateRoot, 'state.json'), 'utf8'), /private-hint|private-fragment/);

        await service.close();
        service = new ReviewService(root, { inspect: async (spec, output, runtime) => {
            assert.equal(spec.targetUrl, targetUrl);
            assert.match(spec.purpose, /현재 로그인 화면 검토/);
            assert.equal(runtime?.shouldDetectRedirectedLogin, false);
            assert.equal(runtime?.expectedRedirectedLoginUrl, loginUrl);
            assert.equal(runtime?.credentials, undefined);
            return mockExecution(spec, output, runtime);
        } });
        await service.start();
        assert.deepEqual(latest(await readTarget()).loginRedirect, waiting.loginRedirect);
        await assert.rejects(service.startReviewTarget(task.taskId, revision.revisionId, target.targetId, {
            attemptId: waiting.attemptId,
            credentials: { method: 'code', code: oneTimeCode },
        }), { status: 400 });
        await service.startReviewTarget(task.taskId, revision.revisionId, target.targetId, { attemptId: waiting.attemptId });
        await eventually(async () => latest(await readTarget()).status === 'completed');
        const completed = latest(await readTarget());
        assert.equal(completed.shouldReviewLoginPage, true);
        assert.deepEqual((await service.reportContexts())[completed.reportId!].loginRedirect, waiting.loginRedirect);
    } finally {
        await service.close();
        await rm(root, { recursive: true, force: true });
    }
});

test('a redirect on automatic workspace submission can resume with its configured Supabase grant', async () => {
    const root = await mkdtemp(resolve(tmpdir(), 'credentials-auto-workspace-'));
    const supabaseOrigin = 'https://stageproject.supabase.co';
    const service = new ReviewService(root, { inspect: async (spec, output, runtime) => {
        if (!runtime?.credentials) {
            assert.equal(runtime?.shouldDetectRedirectedLogin, true);
            assert.equal(runtime?.projectSupabaseAuth, undefined);
            throw new ReviewLoginRequired(loginUrl, ['password']);
        }
        assert.equal(runtime.shouldDetectRedirectedLogin, false);
        assert.equal(runtime.projectSupabaseAuth?.origin, supabaseOrigin);
        assert.equal(runtime.projectSupabaseAuth?.targetOrigin, new URL(targetUrl).origin);
        assert.equal(runtime.projectSupabaseAuth?.canSend(), true);
        return mockExecution(spec, output, runtime);
    } });
    try {
        await service.start();
        const project = await service.addProject({ name: 'Workspace automatic credentials' });
        await service.updateProjectSupabaseAuthBindings(project.projectId, { expectedVersion: project.version,
            supabaseAuthBindings: [{ targetOrigin: new URL(targetUrl).origin, origin: supabaseOrigin }],
        });
        const { workspaceId } = await service.addWorkspace({ projectId: project.projectId, name: 'Orders', goal: 'Review orders' });
        const { request } = await service.submitWorkspaceInitial(workspaceId, { submissionId: randomUUID(), target: submission(targetUrl, false).targets[0] });
        const readAttempt = async () => (await service.workspace(workspaceId)).requests[0].attempts.at(-1)!;
        await eventually(async () => (await readAttempt()).status === 'awaiting-start');
        const waiting = await readAttempt();
        assert.deepEqual(waiting.loginRedirect, { loginUrl, methods: ['password'] });
        await service.startReviewTarget(request.taskId, request.revisionId, request.targetId, {
            attemptId: waiting.attemptId,
            credentials: { method: 'password', username: 'fixture-user', password },
        });
        await eventually(async () => (await readAttempt()).status === 'completed');
        const completed = await readAttempt();
        assert.equal((await service.reportContexts())[completed.reportId!].loginRedirect, undefined);
        assert.doesNotMatch(await readFile(resolve(service.stateRoot, 'state.json'), 'utf8'), /fixture-(user|password)/);
    } finally {
        await service.close();
        await rm(root, { recursive: true, force: true });
    }
});

test('follow-up guest and sign-in choices capture the selected scope without replaying the other screen', async () => {
    const root = await mkdtemp(resolve(tmpdir(), 'credentials-auto-followup-'));
    const service = new ReviewService(root, { inspect: async (spec, output, runtime) => {
        if (spec.followup && runtime?.shouldDetectRedirectedLogin)
            throw new ReviewLoginRequired(loginUrl, ['code']);
        if (runtime?.expectedRedirectedLoginUrl) {
            assert.equal(runtime.expectedRedirectedLoginUrl, loginUrl);
            assert.equal(spec.followup, undefined);
            assert.equal(spec.projectPostPolicy, undefined);
            assert.match(spec.purpose, /처음 요청한 보호 화면은 확인 범위에서 제외/);
        }
        if (runtime?.credentials) {
            assert.equal(spec.followup, undefined);
            assert.equal(spec.targetUrl, targetUrl);
            assert.match(spec.purpose, /처음 요청한 화면의 새 관찰/);
        }
        return mockExecution(spec, output, runtime);
    } });
    try {
        await service.start();
        const { projectId, version } = await service.addProject({ name: 'Workspace guest follow-up' });
        await service.updateProjectPostHosts(projectId, { expectedVersion: version, postAllowedHosts: ['api.example.com'] });
        const { workspaceId } = await service.addWorkspace({ projectId, name: 'Orders', goal: 'Review orders' });
        await service.submitWorkspaceInitial(workspaceId, { submissionId: randomUUID(), target: submission(targetUrl, false).targets[0] });
        await eventually(async () => Boolean((await service.workspace(workspaceId)).workspace.latestReportId));
        const before = (await service.workspace(workspaceId)).workspace.latestReportId!;
        const { request } = await service.submitWorkspaceFollowup(workspaceId, {
            submissionId: randomUUID(), parentReportId: before, instruction: 'Review the orders page again',
        }, async reportId => ({ reportId, runId: 'fixture-run', reportSha256: 'a'.repeat(64) }));
        const readAttempt = async () => (await service.workspace(workspaceId)).requests[1].attempts.at(-1)!;
        await eventually(async () => (await readAttempt()).status === 'awaiting-start');
        assert.equal((await service.workspace(workspaceId)).workspace.latestReportId, before);
        const waiting = await readAttempt();
        await service.startReviewTarget(request.taskId, request.revisionId, request.targetId, { attemptId: waiting.attemptId });
        await eventually(async () => (await readAttempt()).status === 'completed');
        const guestReport = (await readAttempt()).reportId!;
        assert.deepEqual((await service.workspace(workspaceId)).reportIds, [before, guestReport]);

        const followup = await service.submitWorkspaceFollowup(workspaceId, {
            submissionId: randomUUID(), parentReportId: guestReport, instruction: 'Review the protected orders screen',
        }, async reportId => ({ reportId, runId: 'fixture-run', reportSha256: 'b'.repeat(64) }));
        const readProtectedAttempt = async () => (await service.workspace(workspaceId)).requests[2].attempts.at(-1)!;
        await eventually(async () => (await readProtectedAttempt()).status === 'awaiting-start');
        assert.equal((await service.workspace(workspaceId)).workspace.latestReportId, guestReport);
        await service.startReviewTarget(followup.request.taskId, followup.request.revisionId, followup.request.targetId, {
            attemptId: (await readProtectedAttempt()).attemptId, credentials: { method: 'code', code: oneTimeCode },
        });
        await eventually(async () => (await readProtectedAttempt()).status === 'completed');
        assert.deepEqual((await service.workspace(workspaceId)).reportIds, [before, guestReport, (await readProtectedAttempt()).reportId!]);
    } finally {
        await service.close();
        await rm(root, { recursive: true, force: true });
    }
});

test('login choices cannot replace an explicitly selected follow-up region with a different screen', async () => {
    const root = await mkdtemp(resolve(tmpdir(), 'credentials-scoped-followup-'));
    const region = { x: 20, y: 30, width: 100, height: 70 };
    const sourceSha256 = 'a'.repeat(64);
    const imageId = 'b'.repeat(64);
    const source = async (reportId: string) => ({
        reportId, runId: 'fixture-run', reportSha256: 'c'.repeat(64),
        image: { reportId, runId: 'fixture-run', imageId, sha256: sourceSha256, width: 1440, height: 900,
            observationId: 'obs-001', evidenceId: 'fixture-screen' },
    });
    let executions = 0;
    const service = new ReviewService(root, { inspect: async (spec, output, runtime) => {
        executions++;
        if (runtime?.shouldDetectRedirectedLogin && (spec.followup || spec.purpose === 'Review login-only baseline'))
            throw new ReviewLoginRequired(loginUrl, ['password']);
        if (runtime?.credentials) {
            assert.equal(spec.followup?.scopeMode, 'selected-only');
            assert.deepEqual(spec.followup?.region, region);
        }
        return mockExecution(spec, output, runtime);
    } });
    try {
        await service.start();
        const { projectId } = await service.addProject({ name: 'Selected review scope' });
        const { workspaceId } = await service.addWorkspace({ projectId, name: 'Orders', goal: 'Review orders' });
        await service.submitWorkspaceInitial(workspaceId, { submissionId: randomUUID(), target: submission(targetUrl, false).targets[0] });
        await eventually(async () => Boolean((await service.workspace(workspaceId)).workspace.latestReportId));
        const protectedReport = (await service.workspace(workspaceId)).workspace.latestReportId!;
        const { request } = await service.submitWorkspaceFollowup(workspaceId, {
            submissionId: randomUUID(), parentReportId: protectedReport, instruction: 'Review this region',
            scopeMode: 'selected-only', imageId, sourceSha256, region,
        }, source);
        const scopedAttempt = async () => (await service.workspace(workspaceId)).requests[1].attempts.at(-1)!;
        await eventually(async () => (await scopedAttempt()).status === 'awaiting-start');
        const guestAttemptId = (await scopedAttempt()).attemptId;
        await assert.rejects(service.startReviewTarget(request.taskId, request.revisionId, request.targetId,
            { attemptId: guestAttemptId }), { status: 409, message: /기존 선택 영역/ });
        assert.equal((await scopedAttempt()).status, 'awaiting-start');
        assert.equal(executions, 2);
        await service.startReviewTarget(request.taskId, request.revisionId, request.targetId, {
            attemptId: guestAttemptId, credentials: { method: 'password', username: 'fixture-user', password },
        });
        await eventually(async () => (await scopedAttempt()).status === 'completed');

        const loginWorkspace = await service.addWorkspace({ projectId, name: 'Guest orders', goal: 'Review login-only baseline' });
        await service.submitWorkspaceInitial(loginWorkspace.workspaceId, { submissionId: randomUUID(), target: submission(targetUrl, false).targets[0] });
        const loginRequest = async () => (await service.workspace(loginWorkspace.workspaceId)).requests[0];
        await eventually(async () => (await loginRequest()).attempts.at(-1)?.status === 'awaiting-start');
        const guest = await loginRequest();
        await service.startReviewTarget(guest.taskId, guest.revisionId, guest.targetId, { attemptId: guest.attempts[0].attemptId });
        await eventually(async () => Boolean((await service.workspace(loginWorkspace.workspaceId)).workspace.latestReportId));
        const loginReport = (await service.workspace(loginWorkspace.workspaceId)).workspace.latestReportId!;
        const {request: textRestricted} = await service.submitWorkspaceFollowup(loginWorkspace.workspaceId, {
            submissionId: randomUUID(), parentReportId: loginReport, instruction: '선택한 영역에서만 상품을 확인해 주세요.',
            scopeMode: 'related-screen', imageId, sourceSha256, region, shouldWaitForStart: true,
        }, source);
        const restrictedAttemptId = textRestricted.attempts[0].attemptId;
        await assert.rejects(service.startReviewTarget(textRestricted.taskId, textRestricted.revisionId, textRestricted.targetId, {
            attemptId: restrictedAttemptId, credentials: { method: 'password', username: 'fixture-user', password },
        }), { status: 409, message: /기존 선택 영역/ });
        const rejectedAttempt = (await service.workspace(loginWorkspace.workspaceId)).requests[1].attempts.at(-1)!;
        assert.equal(rejectedAttempt.status, 'awaiting-start');
        assert.equal(rejectedAttempt.credentialMethod, undefined);
        assert.equal(executions, 5);
        await service.cancelWorkspaceRequest(textRestricted.requestId, { attemptId: restrictedAttemptId });
        assert.equal((await service.workspace(loginWorkspace.workspaceId)).requests[1].attempts.at(-1)?.status, 'cancelled');
    } finally {
        await service.close();
        await rm(root, { recursive: true, force: true });
    }
});

test('a retry that reviews the login page keeps the old follow-up result only in its original report', async () => {
    const root = await mkdtemp(resolve(tmpdir(), 'credentials-followup-result-'));
    let lastFollowup: FollowupResult | undefined;
    const inspect: typeof mockExecution = async (spec, output, runtime) => {
        if (!spec.followup) return mockExecution(spec, output, runtime);
        if (spec.followup.instruction === 'Review again') {
            assert.equal(spec.followup.executionBase?.replay, undefined);
            assert.equal(spec.followup.executionBase?.state, undefined);
            return mockExecution(spec, output, runtime);
        }
        if (lastFollowup) throw new ReviewLoginRequired(loginUrl, ['password']);
        const runId = randomUUID(), runDir = resolve(output, runId);
        lastFollowup = {
            requestId: spec.followup.requestId, workspaceId: spec.followup.workspaceId,
            status: 'partial', reason: 'First follow-up', answer: 'Original follow-up answer',
            restoration: { status: 'replayed', reason: 'Original replay' }, history: [],
            replay: [{ type: 'click', role: 'button', label: 'Original filter' }],
            state: { url: targetUrl, anchors: ['Original orders'] }, needsImageHandoff: false,
        };
        const result = { runId, status: 'partial', evaluation: { status: 'failed' }, followup: lastFollowup };
        await mkdir(runDir, { recursive: true });
        await writeFile(resolve(runDir, 'report.json'), JSON.stringify(result));
        return { result, runDir } as Awaited<ReturnType<typeof mockExecution>>;
    };
    let service = new ReviewService(root, { inspect });
    try {
        await service.start();
        const {projectId} = await service.addProject({ name: 'Review retries' });
        const {workspaceId} = await service.addWorkspace({ projectId, name: 'Orders', goal: 'Review orders' });
        await service.submitWorkspaceInitial(workspaceId, { submissionId: randomUUID(), target: submission(targetUrl, false).targets[0] });
        await eventually(async () => Boolean((await service.workspace(workspaceId)).workspace.latestReportId));
        const parentReportId = (await service.workspace(workspaceId)).workspace.latestReportId!;
        const source = async (reportId: string) => ({ reportId, runId: 'fixture-run', reportSha256: 'd'.repeat(64) });
        const {request} = await service.submitWorkspaceFollowup(workspaceId, {
            submissionId: randomUUID(), parentReportId, instruction: 'Follow up on orders',
        }, source);
        const current = async () => (await service.workspace(workspaceId)).requests[1];
        await eventually(async () => Boolean((await current()).result));
        const previous = (await current()).attempts.at(-1)!;
        assert.equal(previous.runStatus, 'partial');
        await service.retryWorkspaceRequest(request.requestId, { submissionId: randomUUID(), attemptId: previous.attemptId });
        await eventually(async () => (await current()).attempts.at(-1)?.status === 'awaiting-start');
        const retry = (await current()).attempts.at(-1)!;
        assert.equal((await current()).result, undefined);
        await service.startReviewTarget(request.taskId, request.revisionId, request.targetId, { attemptId: retry.attemptId });
        await eventually(async () => (await current()).attempts.at(-1)?.status === 'completed');
        const newReport = (await current()).attempts.at(-1)!.reportId!;
        assert.equal((await current()).result, undefined);
        assert.equal((await new ReportRepository(root).detail(previous.reportId!)).followup?.answer, 'Original follow-up answer');
        assert.equal((await new ReportRepository(root).detail(newReport)).followup, undefined);

        await service.close();
        const statePath = resolve(service.stateRoot, 'state.json');
        const state = JSON.parse(await readFile(statePath, 'utf8'));
        state.workspaceData.requests.find((entry: {requestId: string}) => entry.requestId === request.requestId).result = lastFollowup;
        await writeFile(statePath, JSON.stringify(state));
        service = new ReviewService(root, { inspect });
        await service.start();
        assert.equal((await current()).result, undefined);
        await service.submitWorkspaceFollowup(workspaceId, {
            submissionId: randomUUID(), parentReportId: newReport, instruction: 'Review again',
        }, source);
        await eventually(async () => (await service.workspace(workspaceId)).requests[2].attempts.at(-1)?.status === 'completed');
    } finally {
        await service.close();
        await rm(root, { recursive: true, force: true });
    }
});

test('dashboard-only credential submission is one-shot, omitted from responses and state, and permits unauthenticated continuation after failure', async () => {
    const root = await mkdtemp(resolve(tmpdir(), 'credentials-http-'));
    const seen: Array<ReviewCredentials | undefined> = [];
    const service = new ReviewService(root, { inspect: async (spec, output, runtime) => {
        seen.push(runtime?.credentials);
        assert.doesNotMatch(JSON.stringify(spec), /fixture-(once|password)/);
        if (runtime?.credentials) throw new ReviewAuthenticationError('rejected');
        return mockExecution(spec, output, runtime);
    } });
    const server = createViewerServer(new ReportRepository(root), root, service);
    try {
        await service.start();
        server.listen(0, '127.0.0.1');
        await once(server, 'listening');
        const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
        const post = (path: string, payload: unknown, origin = base, contentType = 'application/json') => fetch(base + path, {
            method: 'POST',
            headers: { Origin: origin, 'Content-Type': contentType },
            body: JSON.stringify(payload),
        });
        const project = await service.addProject({ name: 'Credential checks' });
        const workspace = await service.addWorkspace({ projectId: project.projectId, name: 'Orders', goal: 'Review order screen' });
        const workspacePath = `/api/review-workspaces/${workspace.workspaceId}`;
        const input = { submissionId: randomUUID(), target: submission().targets[0] };
        const credentials = { method: 'code' as const, code: oneTimeCode };
        assert.equal((await post(workspacePath + '/reviews', { ...input, target: { ...input.target, credentials } })).status, 400);
        const response = await post(workspacePath + '/reviews', input);
        assert.equal(response.status, 202);
        const { request } = await response.json() as { request: PublicWorkspaceRequest };
        const first = request.attempts[0];
        assert.equal(first.status, 'awaiting-start');
        assert.deepEqual(seen, []);

        const path = `/api/workspace-requests/${request.requestId}/start`;
        const body = { attemptId: first.attemptId, credentials };
        assert.equal((await post(path, body, 'https://foreign.example.test')).status, 403);
        assert.equal((await post(path, body, base, 'text/plain')).status, 415);
        assert.equal((await post(path, { ...body, oversized: 'x'.repeat(17000) })).status, 413);
        assert.equal((await post(path, { ...body, taskId: randomUUID() })).status, 400);
        assert.equal((await post(`/api/workspace-requests/${randomUUID()}/start`, body)).status, 404);
        const { request: other } = await (await post(workspacePath + '/reviews', {
            ...input, submissionId: randomUUID(),
        })).json() as { request: PublicWorkspaceRequest };
        assert.equal((await post(`/api/workspace-requests/${other.requestId}/start`, body)).status, 409);
        assert.deepEqual(seen, []);
        const responses = await Promise.all([post(path, body), post(path, body)]);
        assert.deepEqual(responses.map(response => response.status).sort(), [202, 409]);
        for (const result of responses) {
            const raw = await result.text();
            assert.doesNotMatch(raw, /fixture-once/);
            if (result.status === 202) {
                assert.deepEqual(Object.keys(JSON.parse(raw)), ['attempt']);
                assert.equal(JSON.parse(raw).attempt.attemptId, first.attemptId);
                assert.equal(JSON.parse(raw).attempt.status, 'queued');
            }
        }

        const readRequest = async () => {
            const detail = await fetch(base + workspacePath);
            assert.equal(detail.status, 200);
            const raw = await detail.text();
            assert.doesNotMatch(raw, /fixture-(once|password)/);
            return (JSON.parse(raw).requests as PublicWorkspaceRequest[]).find(entry => entry.requestId === request.requestId)!;
        };
        await eventually(async () => (await readRequest()).attempts.length === 2);
        const retried = await readRequest();
        assert.equal(retried.attempts[0].status, 'failed');
        assert.equal(retried.attempts[0].reportId, undefined);
        const next = retried.attempts.at(-1)!;
        assert.equal(next.status, 'awaiting-start');
        assert.notEqual(next.attemptId, first.attemptId);
        assert.equal((await post(path, body)).status, 409, 'stale code approval cannot release the new attempt');
        assert.equal((await post(path, { attemptId: next.attemptId })).status, 202);

        await eventually(async () => (await readRequest()).attempts.at(-1)?.status === 'completed');
        assert.deepEqual(seen, [credentials, undefined]);
        assert.doesNotMatch(await readFile(resolve(service.stateRoot, 'state.json'), 'utf8'), /fixture-(once|password)/);
    } finally {
        if (server.listening) await new Promise<void>(resolve => server.close(() => resolve()));
        await service.close();
        await rm(root, { recursive: true, force: true });
    }
});

test('restart forgets queued credentials and reopens an explicit start under a new attempt ID', async () => {
    const root = await mkdtemp(resolve(tmpdir(), 'credentials-restart-'));
    const credentials = { method: 'password' as const, username: 'fixture-user', password };
    let hasBlocked = false;
    let unblock: () => void = () => {};
    let service = new ReviewService(root, { maxConcurrentReviews: 1, inspect: async (spec, output, runtime) => {
        assert.equal(runtime?.credentials, undefined);
        hasBlocked = true;
        await new Promise<void>(resolve => { unblock = resolve; });
        return mockExecution(spec, output, runtime);
    } });
    try {
        await service.start();
        await service.submit(submission('https://busy.example.test', false));
        await eventually(async () => hasBlocked);
        const { task, revision } = await service.submit(submission());
        const target = revision.targets[0], first = latest(target);
        const result = await service.startReviewTarget(task.taskId, revision.revisionId, target.targetId, { attemptId: first.attemptId, credentials });
        assert.equal(latest(result.revision.targets[0]).status, 'queued');
        assert.doesNotMatch(await readFile(resolve(service.stateRoot, 'state.json'), 'utf8'), /fixture-(user|password)/);

        const closing = service.close();
        unblock();
        await closing;
        service = new ReviewService(root, { inspect: mockExecution });
        await service.start();
        const attempts = (await readStoredReviewTask(service, task.taskId)).revisions[0].targets[0].attempts;
        assert.equal(attempts[0].status, 'failed');
        assert.equal(attempts[1].status, 'awaiting-start');
        assert.notEqual(attempts[1].attemptId, first.attemptId);
        assert.match(attempts[1].error!, /다시 입력/);
        assert.equal(service.executionStatus.queuedCount, 0);
    } finally {
        unblock();
        await service.close();
        await rm(root, { recursive: true, force: true });
    }
});

test('initial and follow-up URL reviews share the start path without changing the prior result', async () => {
    const root = await mkdtemp(resolve(tmpdir(), 'credentials-workspace-'));
    const seen: Array<ReviewCredentials | undefined> = [];
    const service = new ReviewService(root, { inspect: async (spec, output, runtime) => {
        seen.push(runtime?.credentials);
        return mockExecution(spec, output, runtime);
    } });
    try {
        await service.start();
        const { projectId } = await service.addProject({ name: 'Workspace credentials' });
        const { workspaceId } = await service.addWorkspace({ projectId, name: 'Orders', goal: 'Find usability issues' });
        const first = await service.submitWorkspaceInitial(workspaceId, { submissionId: randomUUID(), target: submission().targets[0] });
        assert.equal(first.request.targetUrl, targetUrl);
        assert.equal(first.request.attempts[0].status, 'awaiting-start');
        const start = (request: typeof first.request, credentials?: ReviewCredentials) =>
            service.startReviewTarget(request.taskId, request.revisionId, request.targetId, { attemptId: request.attempts[0].attemptId, credentials });
        const passwordCredentials = { method: 'password' as const, username: 'fixture-user', password };
        await start(first.request, passwordCredentials);
        await eventually(async () => Boolean((await service.workspace(workspaceId)).workspace.latestReportId));
        const before = (await service.workspace(workspaceId)).workspace.latestReportId!;
        const followup = await service.submitWorkspaceFollowup(workspaceId, {
            submissionId: randomUUID(), parentReportId: before, instruction: 'Review the orders page again', shouldWaitForStart: true,
        }, async reportId => ({ reportId, runId: 'fixture-run', reportSha256: 'a'.repeat(64) }));
        assert.equal(followup.request.targetUrl, targetUrl);
        assert.equal(followup.request.attempts[0].status, 'awaiting-start');
        assert.equal((await service.workspace(workspaceId)).workspace.latestReportId, before);
        const codeCredentials = { method: 'code' as const, code: oneTimeCode };
        await start(followup.request, codeCredentials);
        await eventually(async () => (await service.workspace(workspaceId)).requests[1].attempts[0].status === 'completed');
        assert.deepEqual(seen, [passwordCredentials, codeCredentials]);
        assert.equal((await service.workspace(workspaceId)).reportIds[0], before);
        assert.doesNotMatch(await readFile(resolve(service.stateRoot, 'state.json'), 'utf8'), /fixture-(user|password|once)/);
    } finally {
        await service.close();
        await rm(root, { recursive: true, force: true });
    }
});

test('a queued credential expires even when the dispatch slot remains occupied', async t => {
    const root = await mkdtemp(resolve(tmpdir(), 'credentials-expiry-'));
    let hasBlocked = false;
    let unblock: () => void = () => {};
    const service = new ReviewService(root, { maxConcurrentReviews: 1, inspect: async (spec, output, runtime) => {
        assert.equal(runtime?.credentials, undefined);
        hasBlocked = true;
        await new Promise<void>(resolve => { unblock = resolve; });
        return mockExecution(spec, output, runtime);
    } });
    try {
        await service.start();
        await service.submit(submission('https://busy.example.test', false));
        await eventually(async () => hasBlocked);
        const { task, revision } = await service.submit(submission());
        const target = revision.targets[0], first = latest(target);
        t.mock.timers.enable({ apis: ['setTimeout', 'Date'] });
        await service.startReviewTarget(task.taskId, revision.revisionId, target.targetId, {
            attemptId: first.attemptId,
            credentials: { method: 'code', code: oneTimeCode },
        });
        t.mock.timers.tick(10 * 60_000);
        t.mock.timers.reset();

        const readAttempts = async () => (await readStoredReviewTask(service, task.taskId)).revisions[0].targets[0].attempts;
        await eventually(async () => (await readAttempts()).length === 2);
        const attempts = await readAttempts();
        assert.equal(attempts[0].status, 'failed');
        assert.match(attempts[0].error!, /만료/);
        assert.equal(attempts[1].status, 'awaiting-start');
        assert.notEqual(attempts[1].attemptId, first.attemptId);
        assert.equal(service.executionStatus.runningCount, 1);
        assert.equal(service.executionStatus.queuedCount, 0);
    } finally {
        t.mock.timers.reset();
        unblock();
        await service.close();
        await rm(root, { recursive: true, force: true });
    }
});
