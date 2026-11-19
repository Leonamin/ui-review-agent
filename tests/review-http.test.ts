import {readStoredReviewTask, readStoredReviewTasks} from './helpers/review-state.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { request } from 'node:http';
import { ReviewService } from '../src/review-service.js';
import { createViewerServer, parsePublicOrigin } from '../viewer/server/http.js';
import { ReportRepository } from '../viewer/server/repository.js';
import type { inspect } from '../src/core.js';
test('HTTP intake enforces same-origin writes for direct and proxied requests', async () => { const root = await mkdtemp(resolve(tmpdir(), 'review-http-')); const service = new ReviewService(root, { inspect: (async (_spec, output) => { const runId = randomUUID(), runDir = resolve(output, runId); await mkdir(runDir, { recursive: true }); await writeFile(resolve(runDir, 'report.json'), JSON.stringify({ runId, status: 'partial', findings: [], verificationCandidates: [], observations: [], evidence: [], limitations: [] })); return { result: { runId }, runDir }; }) as typeof inspect }); await service.start(); const publicOrigin = parsePublicOrigin('https://viewer.example:8893'); const server = createViewerServer(new ReportRepository(root), root, service, undefined, publicOrigin); server.listen(0, '127.0.0.1'); await once(server, 'listening'); const base = `http://127.0.0.1:${(server.address() as {
    port: number;
}).port}`; const project = await service.addProject({ name: '검토 프로젝트' }); const workspace = await service.addWorkspace({ projectId: project.projectId, name: '화면', goal: '휴리스틱 검토' }); const workspacePath = '/api/review-workspaces/' + workspace.workspaceId; const reviewPath = workspacePath + '/reviews'; const submit = { submissionId: randomUUID(), target: { kind: 'url', name: '홈', url: 'http://localhost:3000' } }; const post = (path: string, value: unknown, origin: string | undefined = base) => fetch(base + path, { method: 'POST', headers: { 'Content-Type': 'application/json', ...(origin ? { Origin: origin } : {}) }, body: JSON.stringify(value) }); try {
    assert.equal((await fetch(base + '/api/review-service')).status, 200);
    assert.equal((await post(reviewPath, submit, 'https://evil.example')).status, 403);
    assert.equal((await post(reviewPath, submit, '')).status, 403);
    assert.equal((await post(reviewPath, { ...submit, unexpected: true })).status, 400);
    const response = await post(reviewPath, submit);
    assert.equal(response.status, 202);
    const created = await response.json() as any;
    assert.equal(created.request.workspaceId, workspace.workspaceId);
    assert.equal(created.dashboardUrl, base + '/?workspace=' + workspace.workspaceId);
    const repeated = await (await post(reviewPath, submit)).json() as any;
    assert.equal(repeated.request.requestId, created.request.requestId);
    const proxyRequest = (path: string, headers: Record<string, string> = {}, value?: unknown, method = value === undefined ? 'GET' : 'POST') => new Promise<{ status: number; data: any }>((resolve, reject) => {
        const body = value === undefined ? undefined : JSON.stringify(value);
        const req = request(base + path, {
            method,
            headers: { Host: publicOrigin.host, 'Content-Type': 'application/json', ...headers },
        }, res => {
            res.setEncoding('utf8');
            let response = '';
            res.on('data', chunk => { response += chunk; });
            res.on('end', () => resolve({ status: res.statusCode!, data: JSON.parse(response) }));
            res.on('error', reject);
        });
        req.on('error', reject);
        req.end(body);
    });
    const proxyPost = (path: string, value: unknown, headers?: Record<string, string>) => proxyRequest(path, headers, value);
    assert.equal((await proxyRequest('/api/review-service')).status, 200);
    const settingsPath = '/api/review-settings';
    const settingsChange = { revision: 0, defaultEvaluator: 'claude', providers: { 'openai-compatible': { baseUrl: 'https://example.invalid/v1', model: 'vision', apiKey: 'test-api-key' } } };
    assert.equal((await proxyRequest(settingsPath, {}, settingsChange, 'PUT')).status, 403);
    const savedSettings = await proxyRequest(settingsPath, { Origin: publicOrigin.origin }, settingsChange, 'PUT');
    assert.equal(savedSettings.status, 200);
    assert.equal(savedSettings.data.settings.providers['openai-compatible'].hasApiKey, true);
    assert.doesNotMatch(JSON.stringify(savedSettings.data), /test-api-key/);
    assert.equal((await proxyRequest(settingsPath, { Origin: publicOrigin.origin }, settingsChange, 'PUT')).status, 409);
    const loadedSettings = await proxyRequest(settingsPath);
    assert.equal(loadedSettings.data.settings.defaultEvaluator, 'claude');
    assert.doesNotMatch(JSON.stringify(loadedSettings.data), /test-api-key/);
    assert.equal((await proxyPost(reviewPath, submit)).status, 403);
    assert.equal((await proxyPost(reviewPath, submit, { Origin: base })).status, 403);
    assert.equal((await proxyPost(reviewPath, submit, { Origin: `http://${publicOrigin.host}` })).status, 403);
    assert.equal((await proxyPost(reviewPath, submit, { Origin: publicOrigin.origin, 'Sec-Fetch-Site': 'cross-site' })).status, 403);
    assert.equal((await proxyPost(reviewPath, submit, {
        Host: 'untrusted.example:8893', Origin: publicOrigin.origin, 'X-Forwarded-Host': publicOrigin.host, 'X-Forwarded-Proto': 'https',
    })).status, 403);
    assert.equal((await proxyPost(reviewPath, submit, {
        Host: new URL(base).host, Origin: publicOrigin.origin, 'X-Forwarded-Host': publicOrigin.host, 'X-Forwarded-Proto': 'https',
    })).status, 403);
    const proxied = await proxyPost(reviewPath, submit, { Origin: publicOrigin.origin });
    assert.equal(proxied.status, 202);
    assert.equal(proxied.data.request.requestId, created.request.requestId);
    assert.equal(proxied.data.dashboardUrl, publicOrigin.origin + '/?workspace=' + workspace.workspaceId);
    const revised = await proxyPost(reviewPath, {
        ...submit, target: { ...submit.target, name: '바뀐 홈' }, submissionId: randomUUID(),
    }, { Origin: publicOrigin.origin });
    assert.equal(revised.status, 202);
    assert.equal(revised.data.request.options.evaluator, 'claude');
    assert.notEqual(revised.data.request.requestId, created.request.requestId);
    assert.equal((await post(reviewPath, { ...submit, target: { ...submit.target, name: '다른 입력' } })).status, 409);
    assert.equal((await post(reviewPath, { ...submit, oversized: 'x'.repeat(40000) })).status, 413);
    assert.equal((await post('/api/review-assets', { fileName: 'x', base64: 'AAAA', path: '/etc/passwd' })).status, 400);

    // Seed old persisted records without going through the retired API.
    const legacy = await service.submit({
        submissionId: randomUUID(), title: '이전 작업', purpose: '보고서 보존 확인', targets: [submit.target],
    });
    const legacyRevision = await service.submit({
        submissionId: randomUUID(), title: '이전 작업 수정', purpose: '보고서 보존 확인',
        targets: [{ ...submit.target, name: '이전 회차' }],
    }, legacy.task.taskId);
    const retiredTaskPath = '/api/review-tasks/' + legacy.task.taskId;
    const retiredTargetPath = retiredTaskPath + '/revisions/' + legacy.revision.revisionId + '/targets/' + legacy.revision.targets[0].targetId;
    assert.equal((await fetch(base + '/api/review-tasks')).status, 404);
    assert.equal((await fetch(base + retiredTaskPath)).status, 404);
    for (const path of ['/api/review-tasks', retiredTaskPath + '/revisions', retiredTargetPath + '/start', retiredTargetPath + '/retry']) {
        assert.equal((await post(path, {})).status, 405);
    }

    await service.close();
    const workspaceDetail = await (await fetch(base + workspacePath)).json() as any;
    const attempt = workspaceDetail.requests.find((row: any) => row.requestId === created.request.requestId).attempts[0];
    assert.equal(attempt.status, 'completed');
    const detail = await fetch(base + '/api/reports/' + attempt.reportId);
    assert.equal(detail.status, 200);
    const report = await detail.json() as any;
    assert.equal(report.runId, attempt.runId);
    const workspaceTask = (await readStoredReviewTasks(service)).find(task => task.revisions.some(revision => revision.workspaceRequestId === created.request.requestId));
    assert.ok(workspaceTask);
    const workspaceRevision = workspaceTask.revisions[0];
    assert.deepEqual(report.taskContext, {
        taskId: workspaceTask.taskId, taskTitle: '화면', revisionId: workspaceRevision.revisionId,
        revisionNumber: 1, targetId: workspaceRevision.targets[0].targetId, targetName: '홈', attemptNumber: 1,
    });
    const reportList = await (await fetch(base + '/api/reports')).json() as any;
    assert.deepEqual(reportList.reports.find((item: any) => item.id === attempt.reportId).taskContext, report.taskContext);

    const legacyTask = await readStoredReviewTask(service, legacy.task.taskId);
    for (const [index, submitted] of [legacy, legacyRevision].entries()) {
        const revision = legacyTask.revisions[index];
        assert.equal(revision.revisionId, submitted.revision.revisionId);
        const reportId = revision.targets[0].attempts[0].reportId;
        assert.ok(reportId);
        const legacyResponse = await fetch(base + '/api/reports/' + reportId);
        assert.equal(legacyResponse.status, 200);
        const legacyReport = await legacyResponse.json() as any;
        assert.equal(legacyReport.taskContext.revisionNumber, index + 1);
        assert.equal(legacyReport.taskContext.targetName, index === 0 ? '홈' : '이전 회차');
        assert.equal(reportList.reports.some((item: any) => item.id === reportId), true);
    }
    await writeFile(resolve(root, 'ui-review-agent-icon.svg'), '<svg xmlns="http://www.w3.org/2000/svg"/>');
    const icon = await fetch(base + '/ui-review-agent-icon.svg');
    assert.equal(icon.status, 200);
    assert.equal(icon.headers.get('content-type'), 'image/svg+xml');
    assert.match(await icon.text(), /<svg/);
    assert.equal((await fetch(base + '/other.svg')).status, 404);
    assert.equal((await fetch(base + '/assets/other.svg')).status, 404);
    assert.equal((await fetch(base + '/ui-review-agent-icon.png')).status, 404);
    assert.equal((await fetch(base + '/other.png')).status, 404);
    const recommendation = `/api/reports/${attempt.reportId}/recommendation/ensure`;
    assert.equal((await proxyPost(recommendation, { unexpected: true })).status, 403);
    assert.equal((await proxyPost(recommendation, { unexpected: true }, { Origin: publicOrigin.origin })).status, 400);
    assert.equal((await fetch(base + '/api/review-assets/../../.review-service/state.json')).status, 404);
}
finally {
    await service.close();
    await new Promise<void>(r => server.close(() => r()));
    await rm(root, { recursive: true, force: true });
} });
