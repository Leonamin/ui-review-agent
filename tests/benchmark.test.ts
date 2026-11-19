import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import sharp from 'sharp';
import { benchmarkManifestSchema, runBenchmark } from '../src/benchmark.js';
import { inspect } from '../src/core.js';
import { ReviewServiceClient } from '../src/request-mcp.js';
import { ReviewService } from '../src/review-service.js';
import type { ReviewProject, WorkspaceDetail } from '../src/workspace-contract.js';
import type { EvaluationInput } from '../src/types.js';
import { createViewerServer } from '../viewer/server/http.js';
import { ReportRepository } from '../viewer/server/repository.js';

test('benchmark resumes workspaces and accepted requests without duplicate evaluations or exposing grading keys', async () => {
    const root = await mkdtemp(join(tmpdir(), 'ui-review-benchmark-'));
    const runsRoot = join(root, 'runs');
    const screenshotPath = join(root, 'screen.png');
    await sharp({ create: { width: 32, height: 32, channels: 3, background: '#ffffff' } }).png().toFile(screenshotPath);
    const inputs: EvaluationInput[] = [];
    const service = new ReviewService(runsRoot, { inspect: (spec, output, dependencies) => inspect(spec, output, {
        ...dependencies,
        evaluate: async input => {
            inputs.push(input);
            return {
                provider: spec.evaluator,
                status: 'completed', findings: [], screenMap: [], interpretations: [], limitations: [],
                ...(spec.evaluator === 'codex' ? { usage: { inputTokens: 1_000, cacheReadInputTokens: 100, outputTokens: 200 } } : {}),
            };
        },
    }) });
    await service.start();
    const server = createViewerServer(new ReportRepository(runsRoot), root, service);
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    const client = new ReviewServiceClient('http://127.0.0.1:' + (server.address() as { port: number }).port);
    const manifest = benchmarkManifestSchema.parse({
        version: 1, name: 'Modal review', screenshot: 'screen.png', purpose: 'Review the dialog.',
        knownDefects: [{ id: 'G01', description: 'Private grading answer.' }],
        models: [
            { evaluator: 'codex', model: 'codex-fixture', rates: { unit: 'credits', input: 50, cachedInput: 2.5, output: 250, source: 'Fixture rates' } },
            { evaluator: 'antigravity', model: 'agy-fixture' },
        ],
    });
    const options = { manifest, screenshotPath, outputDir: join(root, 'output'), runsRoot, client, pollMs: 10, waitSeconds: 10 };
    let uploadCount = 0;
    let submitCount = 0;
    let workspaceCount = 0;
    const interruptedClient = { origin: client.origin, async request(path: string, input?: unknown) {
        const response = await client.request(path, input);
        if (path === '/api/review-assets') uploadCount++;
        if (path === '/api/review-workspaces' && ++workspaceCount === 1) throw new Error('Connection lost after workspace creation');
        if (path.endsWith('/reviews') && ++submitCount === 2) throw new Error('Connection lost after accepted request');
        return response;
    } };
    try {
        await assert.rejects(runBenchmark({ ...options, client: interruptedClient }), /after workspace creation/);
        await assert.rejects(runBenchmark({ ...options, client: interruptedClient }), /after accepted/);
        const result = await runBenchmark({ ...options, client: interruptedClient });
        assert.equal(uploadCount, 1);
        const { projects } = await client.request('/api/review-projects') as { projects: ReviewProject[] };
        assert.deepEqual(projects.map(project => project.projectId), [result.benchmarkId]);
        const workspaces = await service.workspaces(result.benchmarkId);
        assert.equal(workspaces.length, 2);
        for (const [index, workspace] of workspaces.entries()) {
            const detail = await client.request(`/api/review-workspaces/${workspace.workspaceId}`) as WorkspaceDetail;
            assert.equal(detail.requests.length, 1);
            assert.equal(detail.requests[0].attempts.length, 1);
            assert.equal(detail.requests[0].attempts[0].reportId, result.runs[index].reportId);
        }
        await assert.rejects(client.request('/api/review-projects', { projectId: result.benchmarkId, name: '이름 변경' }), /HTTP 409/);
        await assert.rejects(client.request('/api/review-workspaces', {
            workspaceId: workspaces[0].workspaceId, projectId: result.benchmarkId, name: workspaces[0].name, goal: '목적 변경',
        }), /HTTP 409/);
        assert.equal(inputs.length, 2);
        assert.equal(new Set(inputs.map(input => input.observations[0].source?.sourceSha256)).size, 1);
        for (const input of inputs) {
            assert.equal(input.observations[0].source?.sourceSha256, result.screenshot.sha256);
            assert.equal(input.evidence[0].sha256, result.screenshot.evidenceSha256);
            assert.equal(input.spec.purpose, manifest.purpose);
            assert.equal(input.spec.reviewPipeline, 'standard');
            assert.equal(input.spec.reasoningEffort, 'medium');
            assert.equal(input.spec.limits.maxDurationMs, 1_200_000);
            assert.ok(!JSON.stringify(input.spec).includes('Private grading answer.'));
        }
        assert.deepEqual(result.knownDefects, manifest.knownDefects);
        assert.deepEqual(result.runs.map(run => run.status), ['completed', 'completed']);
        for (const run of result.runs) {
            assert.match(run.reportId ?? '', /^[a-f0-9]{64}$/);
            assert.equal(run.reportUrl, `${client.origin}/?report=${run.reportId}`);
        }
        assert.deepEqual(result.runs[0].cost, { amount: 0.09525, unit: 'credits', basis: 'rate-estimate', source: 'Fixture rates' });
        assert.equal(result.runs[1].usage, undefined);
        assert.equal(result.runs[1].cost, undefined);
        const offline = { origin: client.origin, request: async () => { throw new Error('Unexpected service call'); } };
        const resumed = await runBenchmark({ ...options, client: offline });
        assert.equal(resumed.benchmarkId, result.benchmarkId);
        assert.deepEqual(resumed.runs.map(run => run.code), result.runs.map(run => run.code));

        const oldOutputDir = join(root, 'old-output');
        await mkdir(oldOutputDir);
        const state = JSON.parse(await readFile(join(options.outputDir, 'benchmark-state.json'), 'utf8'));
        await writeFile(join(oldOutputDir, 'benchmark-state.json'), JSON.stringify({ ...state, version: 1 }));
        const oldOptions = { ...options, client: offline, outputDir: oldOutputDir };
        await assert.rejects(runBenchmark(oldOptions), /미완료 벤치마크/);
        const { runs, ...oldResult } = result;
        await writeFile(join(oldOutputDir, 'benchmark-result.json'), JSON.stringify({
            ...oldResult, runs: runs.map(({ reportUrl, ...run }) => run),
        }));
        const legacy = await runBenchmark(oldOptions);
        assert.deepEqual(legacy.runs.map(run => run.reportUrl), result.runs.map(run => run.reportUrl));
    } finally {
        await service.close();
        await new Promise<void>(done => server.close(() => done()));
        await rm(root, { recursive: true, force: true });
    }
});
