import assert from 'node:assert/strict';
import { once } from 'node:events';
import { appendFile, mkdir, writeFile } from 'node:fs/promises';
import { basename, join } from 'node:path';
import type { inspect } from '../../src/core.js';
import { ReviewService } from '../../src/review-service.js';
import { createViewerServer } from '../../viewer/server/http.js';
import { ReportRepository } from '../../viewer/server/repository.js';

const [root, generation, reportAttemptId] = process.argv.slice(2);
assert.ok(root && (generation === 'before-crash' || generation === 'after-restart'));

const runner: typeof inspect = async (spec, output, runtime) => {
    const target = new URL(spec.targetUrl!);
    assert.equal(target.hostname, '127.0.0.1');
    const attemptId = basename(output);
    await appendFile(join(root, 'worker-starts.jsonl'), JSON.stringify({ generation, attemptId }) + '\n');

    if (target.pathname === '/cancel-running') {
        const signal = runtime?.signal;
        assert.ok(signal);
        if (!signal.aborted) await once(signal, 'abort');
        await writeFile(join(root, attemptId + '.aborted'), '');
        throw signal.reason;
    }

    const runId = 'fixture-run';
    const runDir = join(output, runId);
    if (generation === 'after-restart' || attemptId === reportAttemptId) {
        await mkdir(runDir, { recursive: true });
        await writeFile(join(runDir, 'report.json'), JSON.stringify({ runId, status: 'completed', findings: [] }));
    }
    // Hold both slots until the parent kills this process, including the slot
    // that finished writing a report but has yet to return to ReviewService.
    if (generation === 'before-crash') await new Promise<void>(() => {});
    return { runDir, result: {} as Awaited<ReturnType<typeof inspect>>['result'] };
};

const service = new ReviewService(root, { workspaceStateVersion: 2, maxConcurrentReviews: 2, inspect: runner });
await service.start();
const server = createViewerServer(new ReportRepository(root), root, service);
const listening = once(server, 'listening');
server.listen(0, '127.0.0.1');
await listening;
const address = server.address();
assert.ok(address && typeof address !== 'string');
process.on('disconnect', async () => {
    server.closeAllConnections();
    server.close();
    await service.close();
});
process.send!('http://127.0.0.1:' + address.port);
