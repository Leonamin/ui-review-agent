import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { DEFAULT_REVIEW_TIMEOUT_SECONDS, MAX_REVIEW_TIMEOUT_SECONDS, defaultStandardEvaluationTimeouts, deriveStandardReviewTimeouts, standardEvaluationTimeoutsSchema } from '../src/evaluation-budget.js';
import { reviewOptionsSchema } from '../src/review-contract.js';
import { focusOptionsSchema } from '../src/focused-review-contract.js';
import { ReviewService } from '../src/review-service.js';
import { createViewerServer } from '../viewer/server/http.js';
import { ReportRepository } from '../viewer/server/repository.js';
import { validateSpec } from '../src/policy.js';
import type { inspect } from '../src/core.js';
import type { RunSpec } from '../src/types.js';

test('twenty-minute defaults, split and strict public boundaries agree across URL and focused reviews', () => {
    assert.equal(DEFAULT_REVIEW_TIMEOUT_SECONDS, 1200);
    assert.equal(MAX_REVIEW_TIMEOUT_SECONDS, 1200);
    assert.deepEqual(deriveStandardReviewTimeouts(defaultStandardEvaluationTimeouts), {
        timeoutSeconds: 1200,
        evaluationBudget: { initialTimeoutSeconds: 960, repairTimeoutSeconds: 180, stageTimeoutSeconds: 1170 },
    });
    for (const schema of [reviewOptionsSchema, focusOptionsSchema]) {
        assert.equal(schema.parse({ evaluator: 'codex' }).timeoutSeconds, 1200);
        assert.equal(schema.parse({ evaluator: 'codex', timeoutSeconds: 1200 }).timeoutSeconds, 1200);
        assert.equal(schema.safeParse({ evaluator: 'codex', timeoutSeconds: 1201 }).success, false);
    }
    assert.equal(standardEvaluationTimeoutsSchema.safeParse({initialTimeoutSeconds: 960, repairTimeoutSeconds: 180}).success, true);
    assert.equal(standardEvaluationTimeoutsSchema.safeParse({initialTimeoutSeconds: 961, repairTimeoutSeconds: 180}).success, false);
});

test('HTTP accepts twenty minutes, rejects overflow, and preserves an explicitly shorter accepted run', async () => {
    const root = await mkdtemp(resolve(tmpdir(), 'review-20min-http-'));
    const specs: RunSpec[] = [];
    const service = new ReviewService(root, { inspect: (async (spec, output) => {
        specs.push(spec);
        const runId = randomUUID(), dir = resolve(output, runId);
        await mkdir(dir, {recursive: true});
        await writeFile(resolve(dir, 'report.json'), JSON.stringify({runId, status: 'partial'}));
        return {} as never;
    }) as typeof inspect });
    await service.start();
    const project = await service.addProject({name: 'Budget project'});
    const workspace = await service.addWorkspace({projectId: project.projectId, name: 'Budget', goal: 'Check'});
    const server = createViewerServer(new ReportRepository(root), root, service);
    server.listen(0, '127.0.0.1'); await once(server, 'listening');
    const base = `http://127.0.0.1:${(server.address() as {port: number}).port}`;
    const post = (submissionId: string, timeoutSeconds?: number) => fetch(base + '/api/review-workspaces/' + workspace.workspaceId + '/reviews', {
        method: 'POST', headers: {origin: base, 'content-type': 'application/json'},
        body: JSON.stringify({submissionId, target: {kind: 'url', name: 'Page', url: 'https://example.com'}, options: {timeoutSeconds}}),
    });
    try {
        assert.equal((await post('overflow', 1201)).status, 400);
        const full = await post('full', 1200);
        assert.equal(full.status, 202);
        assert.equal((await full.json() as any).request.options.timeoutSeconds, 1200);
        const prior = await post('short', 600);
        const accepted = await prior.json() as any;
        assert.equal(accepted.request.options.timeoutSeconds, 600);
        const replay = await (await post('short', 600)).json() as any;
        assert.equal(replay.request.requestId, accepted.request.requestId);
        assert.equal(replay.request.options.timeoutSeconds, 600);
        assert.equal((await post('short', 1200)).status, 409);
    } finally {
        await service.close(); await new Promise<void>(done => server.close(() => done()));
        await rm(root, {recursive: true, force: true});
    }
    assert.equal(specs.some(spec => spec.limits.maxDurationMs === 1200000), true);
    assert.equal(specs.every(spec => spec.limits.maxDurationMs <= 1200000), true);
});

test('CLI advertises the shared default and rejects a duration above the public cap before collection', () => {
    const help = execFileSync(process.execPath, ['--import', 'tsx', 'src/cli.ts', '--help'], {encoding: 'utf8'});
    assert.match(help, /--timeout 1200/);
    assert.match(help, /max 1200/);
    const result = spawnSync(process.execPath, ['--import', 'tsx', 'src/cli.ts', '--url', 'https://must-not-request.invalid', '--timeout', '1201'], {encoding: 'utf8'});
    assert.equal(result.status, 1);
    assert.match(result.stderr, /must not exceed 1200/);
    assert.throws(() => validateSpec({limits: {maxDurationMs: 1200001}} as RunSpec), /must not exceed 1200/);
});
