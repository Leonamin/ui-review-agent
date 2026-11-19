#!/usr/bin/env node
import { access, readFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { benchmarkManifestSchema, readBenchmarkScreenshot, runBenchmark } from './benchmark.js';
import { exportBenchmarkWorkbook } from './benchmark-workbook.js';
import { ReviewServiceClient } from './request-mcp.js';

async function main() {
    const { values } = parseArgs({ options: {
        manifest: { type: 'string' },
        output: { type: 'string' },
        service: { type: 'string', default: 'http://127.0.0.1:4317' },
        'forwarded-origin': { type: 'string' },
        'dashboard-origin': { type: 'string' },
        'runs-root': { type: 'string' },
        'ssh-host': { type: 'string' },
        'wait-seconds': { type: 'string', default: '7200' },
        'dry-run': { type: 'boolean' },
        help: { type: 'boolean', short: 'h' },
    } });
    if (values.help) {
        console.log([
            'Usage: pnpm run benchmark --manifest benchmark.json --output directory',
            '  [--service http://127.0.0.1:4317] [--forwarded-origin http://127.0.0.1:4317]',
            '  [--runs-root /path/to/viewer/runs] [--ssh-host review-server] [--dashboard-origin https://viewer.example]',
            '  [--wait-seconds 7200] [--dry-run]',
            'Reuse the output folder for benchmarks started with the workspace API. Use a new folder for a new benchmark.',
            '--dry-run validates the manifest and PNG without contacting the service. The output folder is optional for dry runs.',
        ].join('\n'));
        return;
    }
    if (!values.manifest || (!values.output && !values['dry-run'])) throw new Error('--manifest와 --output을 지정하세요.');
    const manifestPath = resolve(values.manifest);
    const manifest = benchmarkManifestSchema.parse(JSON.parse(await readFile(manifestPath, 'utf8')));
    const screenshotPath = resolve(dirname(manifestPath), manifest.screenshot);
    if (values['dry-run']) {
        const { sha256, width, height } = await readBenchmarkScreenshot(screenshotPath);
        console.log(JSON.stringify({ name: manifest.name, screenshot: { sha256, width, height }, reviews: manifest.models.length }, null, 2));
        return;
    }
    const waitSeconds = Number(values['wait-seconds']);
    if (!Number.isSafeInteger(waitSeconds) || waitSeconds < 1 || waitSeconds > 86_400) throw new Error('--wait-seconds는 1~86400초 사이의 정수로 입력하세요.');
    const outputDir = resolve(values.output!);
    const client = new ReviewServiceClient(values.service, values['forwarded-origin']);
    const result = await runBenchmark({
        manifest, screenshotPath, outputDir, client,
        runsRoot: values['runs-root'],
        sshHost: values['ssh-host'],
        forwardedOrigin: values['forwarded-origin'],
        dashboardOrigin: values['dashboard-origin'] ?? values['forwarded-origin'],
        waitSeconds,
        onProgress: (model, status, workspaceId, requestId) => console.error(JSON.stringify({
            evaluator: model.evaluator, model: model.model, status, workspaceId, requestId,
        })),
    });
    const workbookPath = join(outputDir, 'grading.xlsx');
    let hasWorkbook = true;
    try {
        await access(workbookPath);
    } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
        hasWorkbook = false;
    }
    if (!hasWorkbook) {
        try {
            await exportBenchmarkWorkbook(result, workbookPath);
        } catch (error) {
            if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
        }
    }
    console.log(JSON.stringify({
        summary: join(outputDir, 'benchmark-result.json'),
        workbook: workbookPath,
        completed: result.runs.filter(run => run.status === 'completed').length,
        runs: result.runs.length,
    }, null, 2));
}

try {
    await main();
} catch (error) {
    console.error(error instanceof Error ? error.message : '벤치마크 실행에 실패했습니다.');
    process.exitCode = 1;
}
