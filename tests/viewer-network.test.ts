import test from 'node:test';
import assert from 'node:assert/strict';
import { request } from 'node:http';
import { once } from 'node:events';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { networkInterfaces, tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { ReviewService } from '../src/review-service.js';
import { createViewerServer } from '../viewer/server/http.js';
import { ReportRepository } from '../viewer/server/repository.js';

test('wildcard listener accepts its LAN address and requires exact same-origin writes', async t => {
    const root = await mkdtemp(resolve(tmpdir(), 'viewer-network-'));
    const service = new ReviewService(root);
    await service.start();
    const project = await service.addProject({ name: 'LAN checks' });
    const workspace = await service.addWorkspace({ projectId: project.projectId, name: 'Protected URL', goal: 'Check network access' });
    const { request: waiting } = await service.submitWorkspaceInitial(workspace.workspaceId, {
        submissionId: randomUUID(),
        target: { kind: 'url', url: 'https://example.test', shouldWaitForStart: true },
    });
    const server = createViewerServer(new ReportRepository(root), root, service, (_req, res) => {
        res.writeHead(200, { 'Content-Type': 'text/html' }); res.end('development middleware');
    });
    server.listen(0, '0.0.0.0');
    await once(server, 'listening');
    const address = server.address() as { address: string; port: number };
    assert.equal(address.address, '0.0.0.0');
    const lanAddresses = [...new Set(Object.values(networkInterfaces()).flatMap(entries =>
        (entries ?? []).filter(entry => entry.family === 'IPv4' && !entry.internal).map(entry => entry.address)))];
    if (!lanAddresses.length) t.diagnostic('No LAN interface: loopback wildcard coverage only.');
    try {
        for (const host of ['127.0.0.1', ...lanAddresses]) {
            const base = `http://${host}:${address.port}`;
            assert.equal((await fetch(base + '/api/review-service')).status, 200);
            assert.equal(await (await fetch(base + '/@vite/client')).text(), 'development middleware');
            assert.equal((await fetch(base + '/api/unknown')).status, 404);
            assert.equal((await fetch(base + '/@vite/client', { headers: { Origin: 'http://evil.example' } })).status, 403);
            // A valid JSON body with invalid fields reaches validation, without starting a model.
            const post = (origin?: string, extraHeaders = {}) => fetch(base + '/api/review-projects', {
                method: 'POST', headers: { 'Content-Type': 'application/json', ...(origin ? { Origin: origin } : {}), ...extraHeaders }, body: '{}'
            });
            assert.equal((await post(base)).status, 400);
            assert.equal((await post()).status, 403);
            assert.equal((await post(`http://localhost:${address.port}`)).status, 403);
            assert.equal((await post('https://evil.example')).status, 403);
            assert.equal((await post(base, { 'Sec-Fetch-Site': 'cross-site' })).status, 403);
            assert.equal(await new Promise<number>((done, reject) => {
                const req = request(base + '/api/review-service', { headers: { Host: `evil.example:${address.port}` } }, res => {
                    res.resume(); done(res.statusCode!);
                });
                req.on('error', reject); req.end();
            }), 403);
            if (host !== '127.0.0.1') {
                const start = await fetch(base + `/api/workspace-requests/${waiting.requestId}/start`, {
                    method: 'POST', headers: { Origin: base, 'Content-Type': 'application/json' },
                    body: JSON.stringify({attemptId: waiting.attempts[0].attemptId, credentials:{method:'code',code:'fixture-code'}}),
                });
                assert.equal(start.status, 403);
                assert.equal((await service.workspace(workspace.workspaceId)).requests[0].attempts[0].status, 'awaiting-start');
            }
            t.diagnostic(`Wildcard listener and Origin checks verified via ${host}`);
        }
    } finally {
        await service.close();
        await new Promise<void>(done => server.close(() => done()));
        await rm(root, { recursive: true, force: true });
    }
});
