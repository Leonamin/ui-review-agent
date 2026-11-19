import { createHash, randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { link, mkdir, open, readFile, rm, writeFile } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { join, posix, resolve } from 'node:path';
import { setTimeout as wait } from 'node:timers/promises';
import { promisify } from 'node:util';
import sharp from 'sharp';
import { z } from 'zod';
import { defaultStandardEvaluationTimeouts, deriveStandardReviewTimeouts } from './evaluation-budget.js';
import { reviewIdSchema, type ReviewAsset, type ReviewAttempt } from './review-contract.js';
import { workspaceInitialSchema, type WorkspaceAttempt, type PublicWorkspaceDetail, type PublicWorkspaceRequest } from './workspace-contract.js';
import { reviewEvaluatorSchema, reviewModelSchema, type ReviewEvaluator } from './review-settings.js';
import type { ReviewServiceClient } from './request-mcp.js';
import type { EvaluationCall, EvaluationUsage, ReasoningEffort, ReviewResult, RunStatus } from './types.js';

const MAX_PNG_BYTES = 5 * 1024 * 1024;
const MAX_PNG_PIXELS = 20_000_000;
const conditions = {
    pipeline: 'standard',
    reasoningEffort: 'medium',
    ...deriveStandardReviewTimeouts(defaultStandardEvaluationTimeouts),
} as const;
const sha256 = (value: string | Buffer) => createHash('sha256').update(value).digest('hex');
const tokenRate = z.number().nonnegative().finite();
const modelSchema = z.object({
    evaluator: reviewEvaluatorSchema,
    model: reviewModelSchema,
    rates: z.object({
        unit: z.enum(['USD', 'credits']),
        input: tokenRate,
        cachedInput: tokenRate,
        output: tokenRate,
        source: z.string().trim().min(1).max(500),
    }).strict().optional(),
}).strict();
const knownDefectSchema = z.object({
    id: z.string().trim().min(1).max(40).regex(/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/),
    description: z.string().trim().min(1).max(1000),
}).strict();
export const benchmarkManifestSchema = z.object({
    version: z.literal(1),
    name: z.string().trim().min(1).max(100),
    screenshot: z.string().trim().min(1),
    purpose: z.string().trim().min(1).max(4000),
    models: z.array(modelSchema).min(1).max(40),
    knownDefects: z.array(knownDefectSchema).max(30).default([]),
}).strict().superRefine((manifest, context) => {
    const models = manifest.models.map(model => JSON.stringify([model.evaluator, model.model]));
    if (new Set(models).size !== models.length) context.addIssue({ code: 'custom', path: ['models'], message: '평가기와 모델의 조합은 중복될 수 없습니다.' });
    const defectIds = manifest.knownDefects.map(({ id }) => id.toUpperCase());
    if (new Set(defectIds).size !== defectIds.length) context.addIssue({ code: 'custom', path: ['knownDefects'], message: '알려진 결함 ID는 중복될 수 없습니다.' });
});
export type BenchmarkManifest = z.infer<typeof benchmarkManifestSchema>;
type BenchmarkModel = z.infer<typeof modelSchema>;

export interface BenchmarkRun {
    code: string;
    evaluator: ReviewEvaluator;
    model: string;
    status: RunStatus;
    actualModel?: string;
    actualReasoningEffort?: ReasoningEffort;
    durationMs?: number;
    reportUrl?: string;
    runId?: string;
    reportId?: string;
    notes: string[];
    usage?: EvaluationUsage;
    rates?: BenchmarkModel['rates'];
    cost?: { amount: number; unit: 'USD' | 'credits'; basis: 'reported-estimate' | 'rate-estimate'; source: string };
    callCount?: number;
    omittedFindingCount?: number;
    findings: { id: string; title: string; facts: string[]; disposition: string }[];
    suggestions: { id: string; title: string; observation: string }[];
}

export interface BenchmarkResult {
    version: 1;
    benchmarkId: string;
    name: string;
    purpose: string;
    createdAt: string;
    screenshot: { fileName: string; sha256: string; width: number; height: number; path: string; evidenceSha256?: string };
    knownDefects: BenchmarkManifest['knownDefects'];
    conditions: typeof conditions;
    runs: BenchmarkRun[];
}

const stateSchema = z.object({
    version: z.union([z.literal(1), z.literal(2)]),
    benchmarkId: reviewIdSchema,
    inputHash: z.string().regex(/^[a-f0-9]{64}$/),
    createdAt: z.string(),
});
const assetSchema = z.object({
    assetId: reviewIdSchema,
    fileName: z.string(),
    mimeType: z.literal('image/png'),
    width: z.number().int().positive(),
    height: z.number().int().positive(),
    sha256: z.string().regex(/^[a-f0-9]{64}$/),
});
type Submission = { code: string; model: BenchmarkModel; workspaceId: string; requestId: string; attempt: WorkspaceAttempt };
type ServiceReport = {
    status: RunStatus;
    actualModel?: string;
    evaluation?: { status?: string; reason?: string };
    limitations: string[];
    findings: BenchmarkRun['findings'];
    suggestions: BenchmarkRun['suggestions'];
};

export async function readBenchmarkScreenshot(path: string) {
    const input = await open(path, constants.O_RDONLY | constants.O_NONBLOCK);
    const buffer = Buffer.alloc(MAX_PNG_BYTES + 1);
    let size = 0;
    try {
        const info = await input.stat();
        if (!info.isFile() || !info.size || info.size > MAX_PNG_BYTES) throw new Error('벤치마크 화면은 5 MiB 이하의 PNG 파일이어야 합니다.');
        while (size < buffer.length) {
            const { bytesRead } = await input.read(buffer, size, buffer.length - size, size);
            if (!bytesRead) break;
            size += bytesRead;
        }
    } finally {
        await input.close();
    }
    if (size > MAX_PNG_BYTES) throw new Error('벤치마크 화면이 5 MiB를 초과합니다.');
    const bytes = buffer.subarray(0, size);
    const image = sharp(bytes, { limitInputPixels: MAX_PNG_PIXELS, failOn: 'warning' });
    const { format, pages, width, height } = await image.metadata();
    if (format !== 'png' || (pages ?? 1) !== 1 || !width || !height || width * height > MAX_PNG_PIXELS) {
        throw new Error('벤치마크 화면은 20 MP 이하의 정지 PNG 1장이어야 합니다.');
    }
    const normalized = await image.rotate().png().toBuffer();
    if (normalized.length > MAX_PNG_BYTES) throw new Error('정규화한 PNG가 5 MiB를 초과합니다.');
    return { bytes, sha256: sha256(bytes), width, height };
}

async function readJson(path: string): Promise<unknown | undefined> {
    try {
        return JSON.parse(await readFile(path, 'utf8')) as unknown;
    } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
        throw error;
    }
}

async function writeOnce(path: string, value: string | Buffer) {
    const temporary = path + '.' + randomUUID() + '.tmp';
    await writeFile(temporary, value, { mode: 0o600, flag: 'wx' });
    try {
        await link(temporary, path);
    } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
    } finally {
        await rm(temporary);
    }
}

export interface BenchmarkOptions {
    manifest: BenchmarkManifest;
    screenshotPath: string;
    outputDir: string;
    client: Pick<ReviewServiceClient, 'origin' | 'request'>;
    /** Absolute path visible to the UI Review viewer. Defaults to viewer API output without usage. */
    runsRoot?: string;
    sshHost?: string;
    forwardedOrigin?: string;
    dashboardOrigin?: string;
    waitSeconds?: number;
    pollMs?: number;
    onProgress?: (model: BenchmarkModel, status: WorkspaceAttempt['status'], workspaceId: string, requestId: string) => void;
}

function dashboardOrigin(origin: string) {
    const url = new URL(origin);
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.pathname !== '/' || url.search || url.hash) {
        throw new Error('--dashboard-origin에는 HTTP(S) 출처만 입력하세요.');
    }
    return url.origin;
}

function readRawReport(options: BenchmarkOptions, attempt: ReviewAttempt) {
    const { runsRoot, sshHost } = options;
    const attemptId = reviewIdSchema.parse(attempt.attemptId);
    const runId = z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,160}$/).parse(attempt.runId);
    if (sshHost) {
        const path = posix.join(runsRoot!, 'review-attempts', attemptId, runId, 'report.json');
        const quotedPath = "'" + path.replaceAll("'", "'\\''") + "'";
        return promisify(execFile)('ssh', ['-o', 'BatchMode=yes', '-o', 'StrictHostKeyChecking=yes', '-o', 'ConnectTimeout=5', '--', sshHost, 'cat -- ' + quotedPath], {
            encoding: 'utf8',
            timeout: 15_000,
            maxBuffer: 16 * 1024 * 1024,
        }).then(({ stdout }) => JSON.parse(stdout) as ReviewResult);
    }
    return readFile(resolve(runsRoot!, 'review-attempts', attemptId, runId, 'report.json'), 'utf8').then(value => JSON.parse(value) as ReviewResult);
}

function costFromUsage(usage: EvaluationUsage | undefined, calls: EvaluationCall[] | undefined, model: BenchmarkModel): BenchmarkRun['cost'] {
    if (!usage) return undefined;
    const estimate = usage.estimatedCost;
    if (estimate !== undefined && Number.isFinite(estimate) && estimate >= 0 && (!calls?.length || calls.every(call => call.usage?.estimatedCost !== undefined))) {
        return { amount: estimate, unit: 'USD', basis: 'reported-estimate', source: '평가기 보고 추정치' };
    }
    const { rates } = model;
    const hasTokens = (record: EvaluationUsage | undefined): record is EvaluationUsage & Required<Pick<EvaluationUsage, 'inputTokens' | 'cacheReadInputTokens' | 'outputTokens'>> =>
        record?.inputTokens !== undefined && record.cacheReadInputTokens !== undefined && record.outputTokens !== undefined;
    if (!rates || !hasTokens(usage) || (usage.cacheCreationInputTokens ?? 0) > 0 ||
        (calls?.length && !calls.every(call => hasTokens(call.usage)))) return undefined;
    const { inputTokens, cacheReadInputTokens, outputTokens } = usage;
    if (cacheReadInputTokens > inputTokens) return undefined;
    const amount = ((inputTokens - cacheReadInputTokens) * rates.input + cacheReadInputTokens * rates.cachedInput + outputTokens * rates.output) / 1_000_000;
    return Number.isFinite(amount) ? { amount, unit: rates.unit, basis: 'rate-estimate', source: rates.source } : undefined;
}

async function collectRun(options: BenchmarkOptions, submission: Submission, screenshotSha: string, origin: string) {
    const { code, model, attempt } = submission;
    const run: BenchmarkRun = {
        code, evaluator: model.evaluator, model: model.model,
        status: attempt.status === 'cancelled' ? 'cancelled' : 'failed',
        runId: attempt.runId,
        reportId: attempt.reportId,
        notes: attempt.error ? [attempt.error] : [],
        rates: model.rates,
        findings: [],
        suggestions: [],
    };
    if (attempt.startedAt && attempt.endedAt) run.durationMs = Date.parse(attempt.endedAt) - Date.parse(attempt.startedAt);
    if (!attempt.reportId) return { run };
    const reportId = z.string().regex(/^[a-f0-9]{64}$/).parse(attempt.reportId);
    run.reportUrl = new URL(`/?report=${reportId}`, origin).href;
    let report: ReviewResult | undefined;
    if (options.runsRoot && attempt.runId) {
        try {
            report = await readRawReport(options, attempt);
        } catch {
            run.notes.push('원본 실행 기록을 읽을 수 없어 보고서 API를 사용했습니다.');
        }
    }
    if (report) {
        if (report.runId !== attempt.runId || (report.imageSource && report.imageSource.sourceSha256 !== screenshotSha)) throw new Error(`실행 ${code}의 보고서와 원본 이미지가 일치하지 않습니다.`);
        const screenshots = report.evidence.filter(evidence => evidence.kind === 'screenshot');
        if ((report.status === 'completed' || report.imageSource || screenshots.length) &&
            (!report.imageSource || screenshots.length !== 1 || !/^[a-f0-9]{64}$/.test(screenshots[0].sha256))) {
            throw new Error(`실행 ${code}의 평가 이미지 해시를 확인할 수 없습니다.`);
        }
        const evaluation = report.evaluation;
        run.status = evaluation.status === 'failed' && report.status !== 'cancelled' ? 'failed' : report.status;
        run.actualModel = evaluation.model;
        run.actualReasoningEffort = evaluation.calls?.find(call => call.actualReasoningEffort)?.actualReasoningEffort;
        run.notes = [...new Set([...run.notes, ...(report.terminationReason ? [report.terminationReason] : []), ...report.limitations, ...evaluation.limitations])];
        run.usage = evaluation.usage;
        run.cost = costFromUsage(evaluation.usage, evaluation.calls, model);
        if (!run.cost) run.notes.push('실행 비용을 계산할 만큼 단가와 사용량이 모두 기록되지 않았습니다.');
        run.callCount = evaluation.calls?.length;
        run.omittedFindingCount = evaluation.omittedFindings?.filter(finding => finding.disposition !== 'dismissed').length ?? 0;
        run.findings = evaluation.findings.filter(finding => finding.disposition !== 'dismissed').map(finding => ({
            id: finding.issueId, title: finding.title, disposition: finding.disposition, facts: finding.observedFacts.map(fact => fact.text),
        }));
        run.suggestions = (report.suggestions ?? evaluation.suggestions ?? []).map(suggestion => ({
            id: suggestion.suggestionId, title: suggestion.title, observation: suggestion.observation,
        }));
        return { run, evidenceSha256: screenshots[0]?.sha256 };
    }
    const detail = await options.client.request('/api/reports/' + reportId) as ServiceReport;
    run.status = detail.evaluation?.status === 'failed' && detail.status !== 'cancelled' ? 'failed' : detail.status;
    run.actualModel = detail.actualModel === '미확인' ? undefined : detail.actualModel;
    run.notes = [...new Set([...run.notes, ...(detail.evaluation?.reason ? [detail.evaluation.reason] : []), ...detail.limitations, '원본 실행 기록의 토큰과 비용을 확인할 수 없습니다.'])];
    run.findings = detail.findings.filter(finding => finding.disposition !== 'dismissed');
    run.suggestions = detail.suggestions;
    return { run };
}

function benchmarkWorkspaceId(benchmarkId: string, index: number) {
    const digest = sha256(`benchmark-workspace:${benchmarkId}:${index}`);
    // Fix the UUID version and variant while keeping the remaining digits stable across retries.
    return `${digest.slice(0, 8)}-${digest.slice(8, 12)}-8${digest.slice(13, 16)}-8${digest.slice(17, 20)}-${digest.slice(20, 32)}`;
}

async function prepareBenchmarkWorkspaces(manifest: BenchmarkManifest, client: BenchmarkOptions['client'], benchmarkId: string, path: string) {
    const projectId = benchmarkId;
    const workspaceIds = manifest.models.map((_, index) => benchmarkWorkspaceId(benchmarkId, index));
    const expected = JSON.stringify({ projectId, workspaceIds });
    const previous = await readJson(path);
    if (previous !== undefined) {
        if (JSON.stringify(previous) !== expected) throw new Error('저장된 벤치마크 작업공간과 실행 설정이 일치하지 않습니다.');
        return workspaceIds;
    }
    const { project } = await client.request('/api/review-projects', { projectId, name: manifest.name }) as { project: { projectId: string } };
    if (project.projectId !== projectId) throw new Error('서비스가 벤치마크 프로젝트 ID를 적용하지 않았습니다.');
    for (const [index, model] of manifest.models.entries()) {
        const workspaceId = workspaceIds[index];
        const name = `${manifest.name} · ${model.model}`.slice(0, 160).trimEnd();
        const { workspace } = await client.request('/api/review-workspaces', { workspaceId, projectId, name, goal: manifest.purpose }) as { workspace: { workspaceId: string } };
        if (workspace.workspaceId !== workspaceId) throw new Error('서비스가 벤치마크 작업공간 ID를 적용하지 않았습니다.');
    }
    // Record accepted destinations before any review submission; a resumed run never recreates deleted destinations.
    await writeOnce(path, expected);
    return workspaceIds;
}

export async function runBenchmark(options: BenchmarkOptions): Promise<BenchmarkResult> {
    const { manifest, client, onProgress, sshHost, runsRoot } = options;
    if (sshHost && (!/^[a-zA-Z0-9][a-zA-Z0-9.@_-]{0,254}$/.test(sshHost) || !runsRoot || !posix.isAbsolute(runsRoot))) {
        throw new Error('--ssh-host에는 SSH 호스트 별칭과 서버의 절대 --runs-root 경로가 필요합니다.');
    }
    const origin = dashboardOrigin(options.dashboardOrigin ?? client.origin);
    const screenshot = await readBenchmarkScreenshot(options.screenshotPath);
    const outputDir = resolve(options.outputDir);
    const statePath = join(outputDir, 'benchmark-state.json');
    const resultPath = join(outputDir, 'benchmark-result.json');
    const assetPath = join(outputDir, 'benchmark-asset.json');
    const workspacesPath = join(outputDir, 'benchmark-workspaces.json');
    const screenshotPath = join(outputDir, 'screenshot.png');
    const inputHash = sha256(JSON.stringify({ manifest, screenshotSha: screenshot.sha256, service: client.origin, forwardedOrigin: options.forwardedOrigin, sshHost, conditions }));
    await mkdir(outputDir, { recursive: true, mode: 0o700 });
    await writeOnce(statePath, JSON.stringify({ version: 2, benchmarkId: randomUUID(), inputHash, createdAt: new Date().toISOString() }, null, 2));
    const state = stateSchema.parse(await readJson(statePath));
    if (state.inputHash !== inputHash) throw new Error('이 출력 폴더는 다른 화면, 모델 목록 또는 서비스에 사용됐습니다. 새 출력 폴더를 선택하세요.');
    const previous = await readJson(resultPath) as BenchmarkResult | undefined;
    if (!previous && state.version === 1) throw new Error('이 폴더에는 구버전 작업 API로 시작한 미완료 벤치마크가 있습니다. 중복 평가를 막기 위해 이 실행은 재접수하지 않습니다. 기존 보고서는 대시보드에서 확인하세요.');
    await writeOnce(screenshotPath, screenshot.bytes);
    if (sha256(await readFile(screenshotPath)) !== screenshot.sha256) throw new Error('고정된 벤치마크 PNG의 해시가 달라졌습니다.');
    if (previous) {
        const runs = previous.runs.map(run => run.reportUrl || !run.reportId ? run : {
            ...run, reportUrl: new URL(`/?report=${run.reportId}`, origin).href,
        });
        return { ...previous, runs, screenshot: { ...previous.screenshot, path: screenshotPath } };
    }
    const workspaceIds = await prepareBenchmarkWorkspaces(manifest, client, state.benchmarkId, workspacesPath);
    let assetRecord = await readJson(assetPath);
    if (!assetRecord) {
        const uploaded = await client.request('/api/review-assets', { fileName: 'screenshot.png', base64: screenshot.bytes.toString('base64') }) as { asset: ReviewAsset };
        await writeOnce(assetPath, JSON.stringify(assetSchema.parse(uploaded.asset), null, 2));
        assetRecord = await readJson(assetPath);
    }
    const asset = assetSchema.parse(assetRecord);
    if (asset.sha256 !== screenshot.sha256 || asset.width !== screenshot.width || asset.height !== screenshot.height) throw new Error('서비스에 저장된 화면이 벤치마크 원본과 일치하지 않습니다.');

    const submissions: Submission[] = [];
    for (const [index, model] of manifest.models.entries()) {
        const code = 'R' + sha256(state.benchmarkId + ':' + index).slice(0, 12).toUpperCase();
        const input = workspaceInitialSchema.parse({
            submissionId: `benchmark:${state.benchmarkId}:${index}`,
            target: { kind: 'image', name: '기준 화면', assetId: asset.assetId },
            options: {
                evaluator: model.evaluator, model: model.model, reviewPipeline: conditions.pipeline,
                reasoningEffort: conditions.reasoningEffort, timeoutSeconds: conditions.timeoutSeconds,
                ...(model.evaluator === 'openai-compatible' ? { evaluationBudget: conditions.evaluationBudget } : {}),
            },
        });
        const { request } = await client.request(`/api/review-workspaces/${workspaceIds[index]}/reviews`, input) as { request: PublicWorkspaceRequest };
        const workspaceId = reviewIdSchema.parse(request.workspaceId);
        const requestId = reviewIdSchema.parse(request.requestId);
        const attempt = request.attempts[0];
        submissions.push({ code, model, workspaceId, requestId, attempt });
        onProgress?.(model, attempt.status, workspaceId, requestId);
    }

    const deadline = Date.now() + (options.waitSeconds ?? 7200) * 1000;
    const isPending = ({ attempt }: Submission) => attempt.status === 'queued' || attempt.status === 'running';
    while (submissions.some(isPending)) {
        if (Date.now() >= deadline) throw new Error('대기 시간이 종료됐습니다. 같은 명령과 출력 폴더를 사용해 기존 실행을 확인하세요.');
        await wait(Math.min(options.pollMs ?? 3000, deadline - Date.now()));
        await Promise.all(submissions.filter(isPending).map(async submission => {
            const { requests } = await client.request(`/api/review-workspaces/${submission.workspaceId}`) as PublicWorkspaceDetail;
            const attempt = requests.find(request => request.requestId === submission.requestId)?.attempts
                .find(item => item.attemptId === submission.attempt.attemptId);
            if (!attempt) throw new Error(`실행 ${submission.code}의 기존 시도를 조회할 수 없습니다.`);
            if (attempt.status !== submission.attempt.status) onProgress?.(submission.model, attempt.status, submission.workspaceId, submission.requestId);
            submission.attempt = attempt;
        }));
    }
    const collected = [];
    for (const submission of submissions) collected.push(await collectRun(options, submission, screenshot.sha256, origin));
    const imageHashes = [...new Set(collected.flatMap(entry => entry.evidenceSha256 ? [entry.evidenceSha256] : []))];
    if (imageHashes.length > 1) throw new Error('평가기별 정규화 이미지 해시가 일치하지 않습니다.');
    const result: BenchmarkResult = {
        version: 1, benchmarkId: state.benchmarkId, createdAt: state.createdAt,
        name: manifest.name, purpose: manifest.purpose, knownDefects: manifest.knownDefects, conditions,
        screenshot: { fileName: 'screenshot.png', path: screenshotPath, sha256: screenshot.sha256, width: screenshot.width, height: screenshot.height, evidenceSha256: imageHashes[0] },
        runs: collected.map(entry => entry.run),
    };
    await writeOnce(resultPath, JSON.stringify(result, null, 2));
    return result;
}
