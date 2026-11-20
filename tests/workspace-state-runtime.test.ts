import assert from 'node:assert/strict';
import { execFile, fork, type ChildProcess } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { access, cp, mkdir, mkdtemp, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import test from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import type { inspect } from '../src/core.js';
import type { ReviewAttempt, ReviewRevision, ReviewTarget, ReviewTask } from '../src/review-contract.js';
import { ReviewService } from '../src/review-service.js';
import type { PublicWorkspaceDetail, PublicWorkspaceRequest, WorkspaceRequest } from '../src/workspace-contract.js';
import { convertWorkspaceState, type LegacyReviewState, type WorkspaceStateCandidate } from '../src/workspace-state-converter.js';
import { createProject, createWorkspace, emptyWorkspaceState } from '../src/workspace-state.js';
import { createViewerServer } from '../viewer/server/http.js';
import { ReportRepository } from '../viewer/server/repository.js';
import type { ReportDetail, ReportList } from '../viewer/features/reports/types.js';

const timestamp = '2026-01-01T00:00:00.000Z';
const options = { evaluator: 'rules-only', timeoutSeconds: 60, reviewPipeline: 'standard' } as const;
const credentials = { method: 'password', username: 'fixture-user', password: 'fixture-password' } as const;
const hash = (value: string) => createHash('sha256').update(value).digest('hex');
const stateFile = (root: string) => join(root, '.review-service', 'state.json');

async function writeReport(root: string, label: string, runId: string) {
    const path = join(root, label, 'report.json');
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, JSON.stringify({ runId, status: 'completed', endedAt: timestamp, findings: [] }));
    return { id: hash(label + '/report.json'), label, runId };
}

async function createSnapshot(root: string) {
    const workspaceData = emptyWorkspaceState();
    const project = createProject(workspaceData, 'Example Shop');
    const workspace = createWorkspace(workspaceData, project.projectId, 'Catalog', 'Review catalog');
    const destination = createWorkspace(workspaceData, project.projectId, 'Moved reports', 'Review moved reports');
    const trash = createWorkspace(workspaceData, project.projectId, 'Trash', 'Review hidden reports');

    const standalone = await writeReport(root, 'standalone/run', 'run');
    async function completed(runId: string) {
        const attemptId = randomUUID();
        const report = await writeReport(root, 'review-attempts/' + attemptId + '/' + runId, runId);
        return {
            report,
            attempt: { attemptId, reportId: report.id, runId, status: 'completed', createdAt: timestamp } satisfies ReviewAttempt,
        };
    }
    const archived = await completed('archived');
    const moved = await completed('moved');
    const current = await completed('current');
    const hidden = await completed('hidden');
    for (const [entry, member, source] of [
        [archived, workspace, 'legacy'], [moved, destination, 'user'],
        [current, workspace, 'execution'], [hidden, trash, 'legacy'],
    ] as const) {
        workspaceData.memberships.push({ reportId: entry.report.id, workspaceId: member.workspaceId, source, reason: 'Fixture placement' });
    }
    workspaceData.trash = {
        [trash.workspaceId]: {
            trashedAt: timestamp, expiresAt: '2099-01-01T00:00:00.000Z',
            reportIds: [hidden.report.id], attemptIds: [hidden.attempt.attemptId], requestIds: [], focusedReviewIds: [],
        },
    };

    function task(): ReviewTask {
        return { taskId: randomUUID(), title: 'Catalog', purpose: 'Review catalog', externalLinks: [], createdAt: timestamp, updatedAt: timestamp, revisions: [] };
    }
    function target(name: string, attempts: ReviewAttempt[], shouldWaitForStart = false): ReviewTarget {
        return { kind: 'url', targetId: randomUUID(), name, url: 'http://127.0.0.1/' + name, attempts, shouldWaitForStart };
    }
    function revision(owner: ReviewTask, targets: ReviewTarget[], workspaceRequestId?: string): ReviewRevision {
        const entry = {
            revisionId: randomUUID(), number: owner.revisions.length + 1, title: owner.title, purpose: owner.purpose,
            externalLinks: [], options, submittedAt: timestamp, targets, workspaceRequestId,
        };
        owner.revisions.push(entry);
        return entry;
    }
    function request(owner: ReviewTask, name: string, status: ReviewAttempt['status'], predecessor?: WorkspaceRequest, prior?: ReviewAttempt) {
        const requestId = randomUUID();
        const isAwaitingLogin = status === 'awaiting-start';
        const attempt: ReviewAttempt = {
            attemptId: randomUUID(), status, createdAt: timestamp,
            ...(isAwaitingLogin ? { loginRedirect: { loginUrl: 'http://127.0.0.1/sign-in', methods: ['password'] } } : {}),
        };
        const attempts = prior ? [prior, attempt] : [attempt];
        const entry = target(name, attempts, isAwaitingLogin);
        const request: WorkspaceRequest = {
            requestId, workspaceId: workspace.workspaceId, taskId: owner.taskId,
            revisionId: revision(owner, [entry], requestId).revisionId, targetId: entry.targetId,
            kind: 'initial', submissionId: name, instruction: 'Review ' + name, createdAt: timestamp,
            queuePredecessorRequestId: predecessor?.requestId, maxOptions: 1, options, attempts,
        };
        workspaceData.requests.push(request);
        return { request, attempt };
    }

    const oldest = task();
    const newest = task();
    revision(oldest, [target('archived', [archived.attempt]), target('moved', [moved.attempt]), target('hidden', [hidden.attempt])]);
    const first = request(oldest, 'first', 'queued', undefined, current.attempt);
    const second = request(newest, 'second', 'queued');
    const login = request(newest, 'protected', 'awaiting-start', second.request);
    const afterLogin = request(newest, 'after-login', 'queued', login.request);
    const state: LegacyReviewState = { version: 1, workspaceData, tasks: [newest, oldest], assets: [], submissions: {} };
    await mkdir(dirname(stateFile(root)), { recursive: true });
    await writeFile(stateFile(root), JSON.stringify(state));
    return {
        state, workspace, destination, requests: [first, second, login, afterLogin], hidden: hidden.report,
        reports: [
            { ...archived.report, workspaceId: workspace.workspaceId, revisionNumber: 1 },
            { ...current.report, workspaceId: workspace.workspaceId, revisionNumber: 2 },
            { ...moved.report, workspaceId: destination.workspaceId, revisionNumber: 1 },
            { ...standalone, workspaceId: undefined, revisionNumber: undefined },
        ],
    };
}

async function waitFor(check: () => Promise<boolean>) {
    const deadline = Date.now() + 5000;
    while (!await check()) {
        assert.ok(Date.now() < deadline, 'Timed out waiting for review state');
        await delay(10);
    }
}

test('viewer reads the v2 copy and worker completes the original queue once, waiting for login input', { timeout: 20000 }, async () => {
    const temporary = await mkdtemp(join(tmpdir(), 'workspace-v2-runtime-'));
    const source = join(temporary, 'source');
    const root = join(temporary, 'copy');
    let service: ReviewService | undefined;
    let server: ReturnType<typeof createViewerServer> | undefined;
    const firstRun = Promise.withResolvers<void>();
    const started: string[] = [];
    try {
        const fixture = await createSnapshot(source);
        const snapshot = await readFile(stateFile(source), 'utf8');
        await cp(source, root, { recursive: true });
        const { candidate } = convertWorkspaceState(JSON.parse(snapshot));
        await writeFile(stateFile(root), JSON.stringify(candidate));
        const [first, second, login, afterLogin] = fixture.requests;
        const runner: typeof inspect = async (spec, output, runtime) => {
            const attemptId = basename(output);
            started.push(attemptId);
            assert.equal(new URL(spec.targetUrl!).hostname, '127.0.0.1');
            assert.deepEqual(runtime?.credentials, attemptId === login.attempt.attemptId ? credentials : undefined);
            const snapshot: WorkspaceStateCandidate = JSON.parse(await readFile(stateFile(root), 'utf8'));
            assert.equal(snapshot.version, 2);
            const running = snapshot.workspaceData.requests.find(request => request.attempts.at(-1)?.attemptId === attemptId);
            assert.equal(running?.attempts.at(-1)?.status, 'running');
            if (attemptId === first.attempt.attemptId) await firstRun.promise;
            await writeReport(dirname(output), attemptId + '/fixture-run', 'fixture-run');
            return { result: {} as Awaited<ReturnType<typeof inspect>>['result'], runDir: join(output, 'fixture-run') };
        };
        const makeService = () => new ReviewService(root, { workspaceStateVersion: 2, inspect: runner, maxConcurrentReviews: 1 });
        service = makeService();
        await service.start();
        server = createViewerServer(new ReportRepository(root), root, service);
        const listening = once(server, 'listening');
        server.listen(0, '127.0.0.1');
        await listening;
        const address = server.address();
        assert.ok(address && typeof address !== 'string');
        const origin = 'http://127.0.0.1:' + address.port;
        async function get<T>(path: string): Promise<T> {
            const response = await fetch(origin + path);
            assert.equal(response.status, 200, path);
            return response.json() as Promise<T>;
        }
        const list = await get<ReportList>('/api/reports');
        assert.deepEqual(list.reports.map(report => report.id).sort(), fixture.reports.map(report => report.id).sort());
        for (const expected of fixture.reports) {
            const row = list.reports.find(report => report.id === expected.id);
            const detail = await get<ReportDetail>('/api/reports/' + expected.id);
            assert.equal(row?.workspaceContext?.workspaceId, expected.workspaceId);
            assert.equal(row?.label, expected.label);
            assert.equal(detail.id, expected.id);
            assert.equal(detail.label, expected.label);
            assert.equal(detail.runId, expected.runId);
            assert.equal(detail.taskContext?.revisionNumber, expected.revisionNumber);
        }
        assert.equal((await fetch(origin + '/api/reports/' + fixture.hidden.id)).status, 404);
        assert.ok(await readFile(join(root, fixture.hidden.label, 'report.json'), 'utf8'));

        const current = async () => (await get<PublicWorkspaceDetail>('/api/review-workspaces/' + fixture.workspace.workspaceId))
            .requests.map(request => [request.requestId, request.attempts.at(-1)?.attemptId, request.attempts.at(-1)?.status]);
        function expected(statuses: ReviewAttempt['status'][]) {
            return fixture.requests.map(({ request, attempt }, index) => [request.requestId, attempt.attemptId, statuses[index]]);
        }

        await waitFor(async () => started.length === 1);
        assert.deepEqual(await current(), expected(['running', 'queued', 'awaiting-start', 'queued']));
        firstRun.resolve();
        await waitFor(async () => (await current())[1][2] === 'completed');
        assert.deepEqual(await current(), expected(['completed', 'completed', 'awaiting-start', 'queued']));
        assert.deepEqual(started, [first.attempt.attemptId, second.attempt.attemptId]);

        const start = await fetch(origin + '/api/workspace-requests/' + login.request.requestId + '/start', {
            method: 'POST',
            headers: { Origin: origin, 'Content-Type': 'application/json' },
            body: JSON.stringify({ attemptId: login.attempt.attemptId, credentials }),
        });
        assert.equal(start.status, 202);
        const { attempt } = await start.json() as { attempt: ReviewAttempt };
        assert.equal(attempt.attemptId, login.attempt.attemptId);
        assert.equal(attempt.status, 'queued');
        await waitFor(async () => (await current())[3][2] === 'completed');
        assert.deepEqual(await current(), expected(['completed', 'completed', 'completed', 'completed']));
        const expectedOrder = [first, second, login, afterLogin].map(({ attempt }) => attempt.attemptId);
        assert.deepEqual(started, expectedOrder);

        await service.close();
        const persisted = await readFile(stateFile(root), 'utf8');
        const saved: WorkspaceStateCandidate = JSON.parse(persisted);
        assert.equal(saved.version, 2);
        assert.deepEqual(saved.workspaceData.requests.map(request => request.attempts.at(-1)?.status),
            ['completed', 'completed', 'completed', 'completed']);
        assert.ok(!persisted.includes(credentials.password));
        service = makeService();
        await service.start();
        await service.close();
        assert.deepEqual(started, expectedOrder);
        assert.equal(await readFile(stateFile(source), 'utf8'), snapshot);
    } finally {
        firstRun.resolve();
        try {
            if (server) {
                server.closeAllConnections();
                await new Promise<void>(resolve => server!.close(() => resolve()));
            }
            await service?.close();
        } finally {
            await rm(temporary, { recursive: true, force: true });
        }
    }
});

test('a v2 candidate requires opt-in and inconsistent report ownership is rejected before writing', async t => {
    const root = await mkdtemp(join(tmpdir(), 'workspace-v2-invalid-'));
    t.after(() => rm(root, { recursive: true, force: true }));
    await createSnapshot(root);
    const { candidate } = convertWorkspaceState(JSON.parse(await readFile(stateFile(root), 'utf8')));
    const snapshot = JSON.stringify(candidate);
    await writeFile(stateFile(root), snapshot);
    await assert.rejects(new ReviewService(root).start(), /Unsupported review state/);
    assert.equal(await readFile(stateFile(root), 'utf8'), snapshot);

    candidate.reportOwners[0].reportPath = 'wrong/report.json';
    const inconsistent = JSON.stringify(candidate);
    await writeFile(stateFile(root), inconsistent);
    const runner: typeof inspect = async () => assert.fail('Invalid state reached the test runner');
    await assert.rejects(new ReviewService(root, { workspaceStateVersion: 2, inspect: runner }).start(),
        /Invalid workspace state v2 candidate/);
    assert.equal(await readFile(stateFile(root), 'utf8'), inconsistent);
});

test('offline cutover and rollback preserve requests and reports written under v2', { timeout: 20000 }, async t => {
    const temporary = await mkdtemp(join(tmpdir(), 'workspace-cutover-'));
    t.after(() => rm(temporary, { recursive: true, force: true }));
    const source = join(temporary, 'source');
    const root = join(temporary, 'copy');
    const fixture = await createSnapshot(source);
    await cp(source, root, { recursive: true });
    const original = await readFile(stateFile(source), 'utf8');
    const cli = fileURLToPath(new URL('../src/workspace-state-migration-cli.ts', import.meta.url));
    const exportState = (version: '1' | '2', output: string) => promisify(execFile)(process.execPath,
        ['--import', 'tsx', cli, '--runs', root, '--to', version, '--output', output]);
    async function switchState(version: '1' | '2') {
        const output = join(temporary, 'version-' + version + '.json');
        const sourceBefore = await readFile(stateFile(root), 'utf8');
        assert.equal(JSON.parse((await exportState(version, output)).stdout).hasWritten, true);
        await assert.rejects(exportState(version, output));
        await assert.rejects(exportState(version, stateFile(root)));
        assert.equal(await readFile(stateFile(root), 'utf8'), sourceBefore);
        await rename(output, stateFile(root));
    }

    // An interrupted in-flight attempt is a cutover blocker even if its artifacts pass.
    const running = fixture.requests[0].attempt;
    running.status = 'running';
    await writeFile(stateFile(root), JSON.stringify(fixture.state));
    const blockedOutput = join(temporary, 'blocked.json');
    await assert.rejects(exportState('2', blockedOutput), (error: unknown) => {
        const result = JSON.parse((error as {stdout: string}).stdout);
        return result.hasWritten === false && result.cutoverBlockers.includes('running-attempt');
    });
    await assert.rejects(access(blockedOutput), { code: 'ENOENT' });
    await writeFile(stateFile(root), original);
    await switchState('2');

    const ran: string[] = [];
    const runner: typeof inspect = async (spec, output) => {
        assert.equal(new URL(spec.targetUrl!).hostname, '127.0.0.1');
        ran.push(basename(output));
        await writeReport(dirname(output), basename(output) + '/fixture-run', 'fixture-run');
        return { result: {} as Awaited<ReturnType<typeof inspect>>['result'], runDir: join(output, 'fixture-run') };
    };
    const v2 = new ReviewService(root, { workspaceStateVersion: 2, inspect: runner });
    const input = { submissionId: 'fixture-post-cutover', target: { kind: 'url', url: 'http://127.0.0.1/after-cutover' } };
    let acceptedId: string;
    let completed: ReviewAttempt;
    try {
        await v2.start();
        const accepted = await v2.submitWorkspaceInitial(fixture.destination.workspaceId, input);
        acceptedId = accepted.request.requestId;
        const findRequest = async () => (await v2.workspace(fixture.destination.workspaceId)).requests.find(r => r.requestId === acceptedId)!;
        await waitFor(async () => (await findRequest()).attempts[0].status === 'completed' && v2.executionStatus.runningCount === 0);
        completed = (await findRequest()).attempts[0];
        assert.equal(completed.attemptId, accepted.request.attempts[0].attemptId);
    } finally {
        await v2.close();
    }

    const reportPath = 'review-attempts/' + completed.attemptId + '/' + completed.runId + '/report.json';
    const reportBytes = await readFile(join(root, reportPath));
    await switchState('1');
    assert.equal(JSON.parse(await readFile(stateFile(root), 'utf8')).version, 1);
    const v1 = new ReviewService(root, { inspect: runner });
    const callsBefore = ran.length;
    try {
        await v1.start();
        const restored = await v1.submitWorkspaceInitial(fixture.destination.workspaceId, input);
        assert.equal(restored.request.requestId, acceptedId);
        assert.deepEqual(restored.request.attempts, JSON.parse(JSON.stringify([completed])));
        const repository = new ReportRepository(root);
        assert.equal((await repository.detail(completed.reportId!)).id, hash(reportPath));
        assert.deepEqual(await readFile(join(root, reportPath)), reportBytes);
        assert.equal((await v1.workspaceContext(completed.reportId!)).workspace?.workspaceId, fixture.destination.workspaceId);
        assert.equal(v1.executionStatus.runningCount, 0);
    } finally {
        await v1.close();
    }
    assert.equal(ran.length, callsBefore);
    assert.equal(await readFile(stateFile(source), 'utf8'), original);
});

test('parallel v2 workers recover after SIGKILL and preserve retry, cancellation and deduplication', { timeout: 20000 }, async t => {
    const temporary = await mkdtemp(join(tmpdir(), 'workspace-v2-crash-'));
    const source = join(temporary, 'source');
    const root = join(temporary, 'copy');
    let child: ChildProcess | undefined;
    try {
        const fixture = await createSnapshot(source);
        const [interrupted, recoverable, , queued] = fixture.requests;
        recoverable.request.workspaceId = fixture.destination.workspaceId;
        queued.request.queuePredecessorRequestId = interrupted.request.requestId;
        const original = JSON.stringify(fixture.state);
        await writeFile(stateFile(source), original);
        await cp(source, root, { recursive: true });
        const { candidate } = convertWorkspaceState(fixture.state);
        await writeFile(stateFile(root), JSON.stringify(candidate));

        const script = fileURLToPath(new URL('./fixtures/workspace-v2-worker.ts', import.meta.url));
        async function start(generation: 'before-crash' | 'after-restart') {
            const workerProcess = fork(script, [root, generation, recoverable.attempt.attemptId], { execArgv: ['--import', 'tsx'] });
            child = workerProcess;
            const [origin] = await Promise.race([
                once(workerProcess, 'message'),
                once(workerProcess, 'exit').then(([code, signal]) => assert.fail(`Fixture exited before listening (${code ?? signal})`)),
            ]);
            assert.equal(typeof origin, 'string');
            assert.match(origin, /^http:\/\/127\.0\.0\.1:\d+$/);
            return { process: workerProcess, origin };
        }
        async function workspace(origin: string, workspaceId: string) {
            const response = await fetch(origin + '/api/review-workspaces/' + workspaceId);
            assert.equal(response.status, 200);
            return await response.json() as PublicWorkspaceDetail;
        }
        async function post<T>(origin: string, path: string, input: object, status: number) {
            const response = await fetch(origin + path, {
                method: 'POST',
                headers: { Origin: origin, 'Content-Type': 'application/json' },
                body: JSON.stringify(input),
            });
            assert.equal(response.status, status, path);
            return await response.json() as T;
        }
        async function stop(workerProcess: ChildProcess) {
            const finished = once(workerProcess, 'exit');
            workerProcess.disconnect();
            assert.deepEqual(await finished, [0, null]);
        }
        async function attempts(origin: string) {
            const [catalog, destination] = await Promise.all([
                workspace(origin, fixture.workspace.workspaceId),
                workspace(origin, fixture.destination.workspaceId),
            ]);
            return Object.fromEntries([...catalog.requests, ...destination.requests].map(
                request => [request.requestId, request.attempts.map(attempt => [attempt.attemptId, attempt.status])],
            ));
        }
        async function persistedAttempts() {
            const state: WorkspaceStateCandidate = JSON.parse(await readFile(stateFile(root), 'utf8'));
            assert.equal(state.version, 2);
            return Object.fromEntries(state.workspaceData.requests.map(request => [
                request.requestId,
                request.attempts.map(attempt => [attempt.attemptId, attempt.status]),
            ]));
        }
        function expected(statuses: ReviewAttempt['status'][]) {
            return Object.fromEntries(fixture.requests.map(({ request, attempt }, index) => [
                request.requestId, request.attempts.map(item => [
                    item.attemptId, item.attemptId === attempt.attemptId ? statuses[index] : item.status,
                ]),
            ]));
        }
        async function starts() {
            const contents = await readFile(join(root, 'worker-starts.jsonl'), 'utf8');
            return contents.trim().split('\n').map(line => JSON.parse(line) as { generation: string; attemptId: string });
        }

        const lockPath = join(root, '.review-service', 'service.lock');
        const reportPath = 'review-attempts/' + recoverable.attempt.attemptId + '/fixture-run/report.json';
        const before = await start('before-crash');
        await waitFor(async () => {
            try {
                const report = await readFile(join(root, reportPath), 'utf8');
                return report.includes('"status":"completed"') && (await starts()).length === 2;
            } catch (error) {
                if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
                throw error;
            }
        });
        const beforeStates = expected(['running', 'running', 'awaiting-start', 'queued']);
        assert.deepEqual(await attempts(before.origin), beforeStates);
        const serviceStatus = await fetch(before.origin + '/api/review-service');
        assert.equal(serviceStatus.status, 200);
        assert.deepEqual((await serviceStatus.json()).execution, { maxConcurrentReviews: 2, runningCount: 2, queuedCount: 1 });
        assert.deepEqual((await starts()).map(entry => entry.attemptId).sort(),
            [interrupted.attempt.attemptId, recoverable.attempt.attemptId].sort());

        const exited = once(before.process, 'exit');
        assert.ok(before.process.kill('SIGKILL'));
        assert.deepEqual(await exited, [null, 'SIGKILL']);
        assert.equal(await readFile(lockPath, 'utf8'), String(before.process.pid));
        assert.deepEqual(await persistedAttempts(), beforeStates);

        const after = await start('after-restart');
        assert.equal(await readFile(lockPath, 'utf8'), String(after.process.pid));
        await waitFor(async () => (await attempts(after.origin))[queued.request.requestId].at(-1)?.[1] === 'completed');
        const afterStates = expected(['failed', 'completed', 'awaiting-start', 'completed']);
        assert.deepEqual(await attempts(after.origin), afterStates);

        async function interruptedHistory(origin: string) {
            const detail = await workspace(origin, fixture.workspace.workspaceId);
            return detail.requests.find(request => request.requestId === interrupted.request.requestId)!.attempts;
        }
        const previousHistory = await interruptedHistory(after.origin);
        const failure = previousHistory.at(-1)!;
        assert.match(failure.error ?? '', /서비스 중단/);
        assert.equal(failure.reportId, undefined);
        const recovered = (await workspace(after.origin, fixture.destination.workspaceId)).requests[0].attempts.at(-1);
        assert.equal(recovered?.reportId, hash(reportPath));
        const report = await fetch(after.origin + '/api/reports/' + recovered?.reportId);
        assert.equal(report.status, 200);
        assert.equal((await report.json()).id, hash(reportPath));

        assert.deepEqual(await persistedAttempts(), afterStates);
        assert.deepEqual((await starts()).filter(entry => entry.generation === 'after-restart'),
            [{ generation: 'after-restart', attemptId: queued.attempt.attemptId }]);

        type Accepted = { request: PublicWorkspaceRequest };
        const requestPath = '/api/workspace-requests/' + interrupted.request.requestId;
        const retryInput = { submissionId: 'fixture-crash-retry', attemptId: failure.attemptId };
        const retries = await Promise.all([
            post<Accepted>(after.origin, requestPath + '/retry', retryInput, 202),
            post<Accepted>(after.origin, requestPath + '/retry', retryInput, 202),
        ]);
        const retryId = retries[0].request.attempts.at(-1)!.attemptId;
        assert.ok(previousHistory.every(attempt => attempt.attemptId !== retryId));
        for (const { request } of retries) {
            assert.equal(request.requestId, interrupted.request.requestId);
            assert.deepEqual(request.attempts.slice(0, -1), previousHistory);
            assert.equal(request.attempts.at(-1)?.attemptId, retryId);
        }
        await waitFor(async () => (await interruptedHistory(after.origin)).at(-1)?.status === 'completed');
        const retriedHistory = await interruptedHistory(after.origin);
        assert.deepEqual(retriedHistory.slice(0, -1), previousHistory);
        assert.equal(retriedHistory.at(-1)?.attemptId, retryId);
        await post(after.origin, requestPath + '/retry', { ...retryInput, attemptId: retryId }, 409);
        await post(after.origin, requestPath + '/cancel', { attemptId: failure.attemptId }, 409);

        const intakePath = '/api/review-workspaces/' + fixture.destination.workspaceId + '/reviews';
        const runningInput = { submissionId: 'fixture-cancel-running', target: { kind: 'url', url: 'http://127.0.0.1/cancel-running' } };
        const intakes = await Promise.all([
            post<Accepted>(after.origin, intakePath, runningInput, 202),
            post<Accepted>(after.origin, intakePath, runningInput, 202),
        ]);
        const running = intakes[0].request;
        assert.equal(intakes[1].request.requestId, running.requestId);
        assert.deepEqual(intakes[1].request.attempts.map(attempt => attempt.attemptId), [running.attempts[0].attemptId]);
        const runningId = running.attempts[0].attemptId;
        await waitFor(async () => (await starts()).some(entry => entry.attemptId === runningId));
        assert.deepEqual((await attempts(after.origin))[running.requestId], [[runningId, 'running']]);
        await post(after.origin, intakePath, { ...runningInput, target: { ...runningInput.target, url: 'http://127.0.0.1/different' } }, 409);

        const queuedInput = { submissionId: 'fixture-cancel-queued', target: { kind: 'url', url: 'http://127.0.0.1/cancel-queued' } };
        const waiting = (await post<Accepted>(after.origin, intakePath, queuedInput, 202)).request;
        const waitingId = waiting.attempts[0].attemptId;
        assert.deepEqual((await attempts(after.origin))[waiting.requestId], [[waitingId, 'queued']]);
        for (const request of [waiting, running]) {
            const path = '/api/workspace-requests/' + request.requestId + '/cancel';
            const input = { attemptId: request.attempts[0].attemptId };
            const first = await post<{ attempt: ReviewAttempt }>(after.origin, path, input, 200);
            assert.equal(first.attempt.attemptId, input.attemptId);
            assert.equal(first.attempt.status, 'cancelled');
            assert.deepEqual(await post(after.origin, path, input, 200), first);
        }
        await stop(after.process);
        await access(join(root, runningId + '.aborted'));

        const finalStates = {
            ...afterStates,
            [interrupted.request.requestId]: [...afterStates[interrupted.request.requestId], [retryId, 'completed']],
            [running.requestId]: [[runningId, 'cancelled']],
            [waiting.requestId]: [[waitingId, 'cancelled']],
        };
        assert.deepEqual(await persistedAttempts(), finalStates);

        const reopened = await start('after-restart');
        const duplicateRetry = await post<Accepted>(reopened.origin, requestPath + '/retry', retryInput, 202);
        assert.equal(duplicateRetry.request.requestId, interrupted.request.requestId);
        assert.deepEqual(duplicateRetry.request.attempts, retriedHistory);
        for (const [input, request] of [[runningInput, running], [queuedInput, waiting]] as const) {
            const duplicate = await post<Accepted>(reopened.origin, intakePath, input, 202);
            assert.equal(duplicate.request.requestId, request.requestId);
            assert.deepEqual(duplicate.request.attempts.map(attempt => [attempt.attemptId, attempt.status]),
                [[request.attempts[0].attemptId, 'cancelled']]);
        }
        assert.deepEqual(await attempts(reopened.origin), finalStates);
        await stop(reopened.process);
        assert.deepEqual(await persistedAttempts(), finalStates);
        assert.deepEqual((await starts()).map(entry => entry.attemptId).sort(),
            [interrupted.attempt.attemptId, recoverable.attempt.attemptId, queued.attempt.attemptId, retryId, runningId].sort());
        assert.equal(await readFile(stateFile(source), 'utf8'), original);
        t.diagnostic(JSON.stringify({
            requestId: interrupted.request.requestId,
            attempts: finalStates[interrupted.request.requestId],
        }));
    } finally {
        if (child?.pid && child.exitCode === null && child.signalCode === null) {
            const exited = once(child, 'exit');
            child.kill('SIGKILL');
            await exited;
        }
        await rm(temporary, { recursive: true, force: true });
    }
});
