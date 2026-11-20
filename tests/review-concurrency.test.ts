import {readStoredReviewTask} from './helpers/review-state.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { ReviewService } from '../src/review-service.js';
import type { inspect } from '../src/core.js';

async function waitFor(check: () => boolean | Promise<boolean>) {
    const deadline = Date.now() + 3000;
    while (Date.now() < deadline) {
        if (await check()) return;
        await new Promise(resolve => setTimeout(resolve, 5));
    }
    throw new Error('scheduler did not reach expected state');
}
function request() {
    return { submissionId: randomUUID(), title: '동시 검토', purpose: '확인', targets: Array.from({ length: 3 }, (_, index) => ({ kind: 'url', name: `화면 ${index}`, url: `https://example.com/${index}` })) };
}
function controlledEngine() {
    const releases: (() => void)[] = [];
    const urls: string[] = [];
    const run = (async (spec, output) => {
        urls.push(spec.targetUrl!);
        await new Promise<void>(resolve => releases.push(resolve));
        const runId = randomUUID(), path = resolve(output, runId);
        await mkdir(path, { recursive: true });
        await writeFile(resolve(path, 'report.json'), JSON.stringify({ runId, status: urls.indexOf(spec.targetUrl!) === 0 ? 'cancelled' : 'partial', terminationReason: 'cancelled upstream' }));
        return {} as never;
    }) as typeof inspect;
    return { run, releases, urls };
}

test('two slots claim unique attempts, leave third queued, and advance after a cancelled engine report', async () => {
    const root = await mkdtemp(resolve(tmpdir(), 'reviews-pool-'));
    const engine = controlledEngine();
    const service = new ReviewService(root, { inspect: engine.run });
    try {
        await service.start();
        const input = request();
        const [created, duplicate] = await Promise.all([service.submit(input), service.submit(input)]);
        assert.equal(created.task.taskId, duplicate.task.taskId);
        await waitFor(() => engine.urls.length === 2);
        assert.deepEqual(service.executionStatus, { maxConcurrentReviews: 2, runningCount: 2, queuedCount: 1 });
        assert.equal(new Set(engine.urls).size, 2);
        engine.releases[0]();
        await waitFor(() => engine.urls.length === 3);
        assert.equal(service.executionStatus.runningCount, 2);
        engine.releases[1](); engine.releases[2]();
        await waitFor(async () => {
            const targets = (await readStoredReviewTask(service, created.task.taskId)).revisions[0].targets;
            return targets.every(target => ['failed', 'completed'].includes(target.attempts[0].status));
        });
        const targets = (await readStoredReviewTask(service, created.task.taskId)).revisions[0].targets;
        assert.equal(targets[0].attempts[0].status, 'failed');
        assert.equal(targets[0].attempts[0].runStatus, 'cancelled');
        assert.equal(targets[1].attempts[0].status, 'completed');
        assert.equal(targets[2].attempts[0].status, 'completed');
        assert.equal(targets.every(target => target.attempts.length === 1), true);
    } finally {
        engine.releases.forEach(release => release());
        await service.close(); await rm(root, { recursive: true, force: true });
    }
});

test('close waits for every running slot and leaves queued attempts for restart', async () => {
    const root = await mkdtemp(resolve(tmpdir(), 'reviews-close-'));
    const engine = controlledEngine();
    const service = new ReviewService(root, { inspect: engine.run, maxConcurrentReviews: 2 });
    let isClosed = false;
    try {
        await service.start();
        const created = await service.submit(request());
        await waitFor(() => engine.urls.length === 2);
        const closing = service.close().then(() => { isClosed = true; });
        assert.equal(service.isReady, false);
        engine.releases[0]();
        await waitFor(() => service.executionStatus.runningCount === 1);
        assert.equal(isClosed, false);
        assert.equal(engine.urls.length, 2);
        engine.releases[1](); await closing;
        assert.equal(service.executionStatus.queuedCount, 1);
        const restarted = new ReviewService(root, { maxConcurrentReviews: 1, inspect: (async (_spec, output) => {
            const runId = randomUUID(), path = resolve(output, runId);
            await mkdir(path, { recursive: true });
            await writeFile(resolve(path, 'report.json'), JSON.stringify({ runId, status: 'partial' }));
            return {} as never;
        }) as typeof inspect });
        try {
            await restarted.start();
            await waitFor(async () => (await readStoredReviewTask(restarted, created.task.taskId)).revisions[0].targets[2].attempts[0].status === 'completed');
            assert.equal(restarted.executionStatus.maxConcurrentReviews, 1);
        } finally { await restarted.close(); }
    } finally {
        engine.releases.forEach(release => release());
        await service.close(); await rm(root, { recursive: true, force: true });
    }
});

test('worker count rejects invalid or unbounded concurrency', () => {
    for (const maxConcurrentReviews of [0, 9, 1.5, NaN])
        assert.throws(() => new ReviewService('/tmp/unused-review-pool', { maxConcurrentReviews }), /concurrency/);
});
