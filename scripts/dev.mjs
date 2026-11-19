import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';

const [target = 'viewer', ...args] = process.argv.slice(2);
if (target !== 'viewer') {
    console.error('사용법: pnpm dev viewer [--host 0.0.0.0] [--port 4317] [--runs runs]');
    process.exitCode = 1;
} else {
    const child = spawn(process.execPath, ['--import', 'tsx', 'viewer/server/main.ts', '--dev', ...args], { stdio: 'inherit', cwd: fileURLToPath(new URL('../', import.meta.url)) });
    for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => child.kill(signal));
    child.on('error', error => { console.error(error.message); process.exitCode = 1; });
    child.on('exit', code => { process.exitCode = code ?? 1; });
}
