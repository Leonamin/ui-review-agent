import { ReviewService } from '../../src/review-service.js';
import { isIP } from 'node:net';
import { networkInterfaces } from 'node:os';
import { parseArgs } from 'node:util';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ReportRepository } from './repository.js';
import { createViewerServer, parsePublicOrigin, trustedViewerOrigin } from './http.js';
const { values } = parseArgs({ options: {
    runs: { type: 'string', default: 'runs' },
    port: { type: 'string', default: '4317' },
    host: { type: 'string', default: '0.0.0.0' },
    dev: { type: 'boolean', default: false },
    'public-origin': { type: 'string' },
    'review-concurrency': { type: 'string', default: '2' },
} });
const port = Number(values.port);
if (!Number.isInteger(port) || port < 1024 || port > 65535)
    throw new Error('port must be 1024..65535');
const host = values.host!;
if (host !== 'localhost' && !isIP(host))
    throw new Error('host must be an IP address or localhost');
const publicOrigin = values['public-origin'] === undefined ? undefined : parsePublicOrigin(values['public-origin']);
const runsRoot = resolve(values.runs!);
const reviews = new ReviewService(runsRoot, { maxConcurrentReviews: Number(values['review-concurrency']) });
await reviews.start();
let vite: import('vite').ViteDevServer | undefined;
const server = createViewerServer(new ReportRepository(runsRoot), fileURLToPath(new URL('../dist/', import.meta.url)), reviews, values.dev ? (req, res, next) => vite!.middlewares(req, res, next) : undefined, publicOrigin);
if (values.dev) {
    server.on('upgrade', (req, socket) => {
        const origin = trustedViewerOrigin(req, publicOrigin);
        if (!origin || req.headers.origin !== origin) socket.destroy();
    });
    try {
        const { createServer } = await import('vite');
        vite = await createServer({
            configFile: fileURLToPath(new URL('../vite.config.ts', import.meta.url)),
            server: { middlewareMode: true, ws: { server }, allowedHosts: publicOrigin ? [publicOrigin.hostname] : undefined },
        });
    } catch (error) {
        await reviews.close();
        throw error;
    }
}
let isClosing = false;
const close = async () => { if (isClosing)
    return; isClosing = true; server.close(); await vite?.close(); await reviews.close(); };
process.once('SIGINT', () => void close());
process.once('SIGTERM', () => void close());
server.on('error', error => { console.error(error.message); void Promise.all([vite?.close(), reviews.close()]).then(() => { process.exitCode = 1; }); });
server.listen(port, host, () => {
    const addresses = host === '0.0.0.0'
        ? ['127.0.0.1', ...Object.values(networkInterfaces()).flatMap(entries =>
            (entries ?? []).filter(entry => entry.family === 'IPv4' && !entry.internal).map(entry => entry.address))]
        : [host === '::' ? '::1' : host];
    const urls = [...new Set(addresses)].map(address => `http://${address.includes(':') ? `[${address}]` : address}:${port}`);
    if (publicOrigin) urls.push(publicOrigin.origin);
    console.log(`UI 리뷰 서비스${values.dev ? ' (개발 모드: 화면 변경 자동 반영)' : ''} (${host}:${port}):\n${urls.join('\n')}\n작업 접수 및 실행, 보고서 조회. Ctrl+C로 종료 (진행 중 실행 완료 후 종료).`);
});
