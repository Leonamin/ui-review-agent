import type {FollowupResult,FollowupReplayStep,FollowupExecutionBase,FollowupSource,ReplayDismissalEvidence} from './followup-types.js';
import {hasExplicitRegionRestriction} from './followup.js';
import {deriveReplayDismissalEvidence} from './replay-dismissal.js';
import {closeBrowserLeases} from './browser-lease.js';
import {z} from 'zod';
import {allWorkspaceTrash,emptyWorkspaceState,isWorkspaceTrashed,migrateWorkspaces,createProject,createWorkspace,forgetLegacyProjectKeys,preserveLegacyPlacements,workspaceDetail,type ProjectTrash,type WorkspaceState,type WorkspaceSupabaseAuthGrant,type WorkspaceTrash} from './workspace-state.js';
import {projectDeletionSchema,projectInputSchema,projectPostHostsSchema,projectSupabaseAuthBindingsSchema,projectSupabaseAuthSettingsSchema,workspaceInputSchema,workspaceInitialSchema,workspaceFollowupSchema,type ProjectDeletionPreview,type ProjectDeletionResult,type ReportWorkspaceContext,type ReviewProject,type ReviewWorkspace,type TrashedProject,type TrashedWorkspace,type WorkspaceRequest,type WorkspaceSource} from './workspace-contract.js';
import {attachedReportFiles, collectWorkspaceTrash, managedAttemptFiles, removeTaskAttempts, removeWorkspaceFile, usesTrashedHistory, WORKSPACE_RETENTION_MS} from './workspace-trash.js';
import { focusedSubmissionSchema, type FocusSource, type FocusedReview } from './focused-review-contract.js';
import { inspectFocused, validateFocusImage, validateFocusRegion } from './focused-review.js';
import { mkdir, readFile, writeFile, rename, open, unlink, readdir, realpath } from 'node:fs/promises';
import { resolve, relative, basename, sep } from 'node:path';
import { randomUUID, createHash } from 'node:crypto';
import {isDeepStrictEqual} from 'node:util';
import sharp, { type Metadata } from 'sharp';
import { inspect } from './core.js';
import { REVIEW_TARGET_NAME_MAX_LENGTH, reviewSubmissionSchema, reviewStartSchema, reviewIdSchema, type ReviewTask, type ReviewRevision, type ReviewAttempt, type ReviewAsset, type ReviewTarget, type ReviewOptions, type ReviewReportContext, type ReviewSubmission, type ReviewLoginRedirect } from './review-contract.js';
import { canUseReviewCredentials, ReviewAuthenticationError, ReviewLoginRequired, type ReviewCredentials } from './review-auth.js';
import { initialReviewSettings, publicReviewSettings, reviewSettingsSchema, reviewSettingsUpdateSchema, type StoredReviewSettings } from './review-settings.js';
import { DEFAULT_REVIEW_TIMEOUT_SECONDS, defaultStandardEvaluationTimeouts, deriveStandardReviewTimeouts } from './evaluation-budget.js';
import { runWithOpenAiCompatible } from './review-settings-runtime.js';
import type { RunSpec } from './types.js';
import {normalizeProjectPostHost,PROJECT_POST_HOST_LIMIT} from './post-host-policy.js';
export class ReviewServiceError extends Error {
    constructor(public status: number, message: string) { super(message); }
}
type State = {
    version: 1;
    workspaceData?: WorkspaceState;
    compatibleConnections?: Record<string, string>;
    focusedReviews?: FocusedReview[];
    focusedSubmissions?: Record<string, {
        hash: string;
        focusedReviewId: string;
    }>;
    tasks: ReviewTask[];
    assets: ReviewAsset[];
    submissions: Record<string, {
        hash: string;
        taskId: string;
        revisionId: string;
    }>;
};
type TrashPurgeUnit = {id: string; projectId?: string; workspaceIds: string[]; entries: WorkspaceTrash[]};
const hash = (value: string | Buffer) => createHash('sha256').update(value).digest('hex');
const now = () => new Date().toISOString();
const copy = <T>(value: T): T => structuredClone(value);
const credentialQueueLifetimeMs = 10 * 60_000;
const expiredCredentialMessage = '대기 중 로그인 정보가 만료되었습니다. 다시 입력하세요.';
const revokedSupabaseAuthMessage = '이 검토의 Supabase 로그인 허용이 변경되었습니다. 현재 설정으로 새 검토를 만들거나 로그인 없이 검토하세요.';
const changedReviewScopeMessage = '다른 화면에는 기존 선택 영역을 적용할 수 없습니다. 이 검토를 취소하고 검토할 화면의 새 캡처에서 영역을 선택하세요.';
const hasRestrictedFollowupScope = (request: WorkspaceRequest) => request.kind === 'followup' &&
    (request.scopeMode === 'selected-only' || hasExplicitRegionRestriction(request.instruction));
export class ReviewService {
    private state: State = { version: 1, tasks: [], assets: [], submissions: {} };
    private settings: StoredReviewSettings = initialReviewSettings;
    private chain: Promise<unknown> = Promise.resolve();
    private workers = new Set<Promise<void>>();
    private runningControllers=new Map<string,AbortController>();
    private pendingCredentials = new Map<string, { credentials: ReviewCredentials; expiresAt: number; timer: NodeJS.Timeout }>();
    readonly maxConcurrentReviews: number;
    private hasStarted = false;
    private isClosing = false;
    private hasLock = false;
    private isStorageHealthy = true;
    private trashTimer?: ReturnType<typeof setTimeout>;
    readonly stateRoot: string;
    readonly runsRoot: string;
    constructor(runsRoot: string, private dependencies: {
        inspect?: typeof inspect;
        inspectFocused?: typeof inspectFocused;
        maxConcurrentReviews?: number;
        workspaceClock?: () => number;
    } = {}) {
        this.maxConcurrentReviews = dependencies.maxConcurrentReviews ?? 2;
        if (!Number.isInteger(this.maxConcurrentReviews) || this.maxConcurrentReviews < 1 || this.maxConcurrentReviews > 8)
            throw new Error('review concurrency must be an integer from 1 to 8');
        this.runsRoot = resolve(runsRoot); this.stateRoot = resolve(this.runsRoot, '.review-service'); }
    private async withStateRollback<T>(fn: () => Promise<T>): Promise<T> {
        const previous = copy(this.state);
        try {
            return await fn();
        }
        catch (error) {
            this.state = previous;
            throw error;
        }
    }
    private serial<T>(fn: () => Promise<T>): Promise<T> {
        const execute = () => this.withStateRollback(fn);
        const p = this.chain.then(execute, execute);
        this.chain = p.catch(() => { });
        return p;
    }
    private async save() { const path = resolve(this.stateRoot, 'state.json'), tmp = path + '.' + randomUUID() + '.tmp'; await writeFile(tmp, JSON.stringify(this.state), { mode: 0o600 }); await rename(tmp, path); }
    async getSettings() { await this.chain; this.assertStarted(); return copy(publicReviewSettings(this.settings)); }
    async updateSettings(input: unknown) {
        const parsed = reviewSettingsUpdateSchema.safeParse(input);
        if (!parsed.success) {
            const budgetError = parsed.error.issues.find(issue => issue.path.includes('standardEvaluationTimeouts'));
            throw new ReviewServiceError(400, budgetError
                ? '최초 평가와 자동 보정의 시간 예산을 확인하세요. ' + budgetError.message
                : '평가자, 모델 또는 OpenAI 호환 API 설정을 확인하세요.');
        }
        return this.serial(async () => {
            this.assertStarted();
            const { revision, defaultEvaluator, providers } = parsed.data;
            if (revision !== undefined && revision !== this.settings.revision)
                throw new ReviewServiceError(409, '다른 곳에서 설정을 변경했습니다. 설정을 다시 불러오세요.');
            const { 'openai-compatible': compatible, ...otherProviders } = providers;
            const previous = this.settings.providers['openai-compatible'];
            const settings: StoredReviewSettings = { revision: this.settings.revision + 1, defaultEvaluator, providers: otherProviders };
            if (compatible) {
                const { apiKey, baseUrl, standardEvaluationTimeouts, ...options } = compatible;
                if (apiKey && !baseUrl)
                    throw new ReviewServiceError(400, 'API 키를 저장하려면 먼저 API 주소를 입력하세요.');
                const retainedKey = baseUrl && baseUrl === previous?.baseUrl ? previous.apiKey : undefined;
                settings.providers['openai-compatible'] = {
                    ...options,
                    baseUrl,
                    standardEvaluationTimeouts: standardEvaluationTimeouts ?? previous?.standardEvaluationTimeouts,
                    apiKey: apiKey === undefined ? retainedKey : apiKey ?? undefined,
                };
            }
            if (defaultEvaluator === 'openai-compatible' && (!compatible?.baseUrl || !compatible.model))
                throw new ReviewServiceError(400, 'OpenAI 호환 API를 기본값으로 쓰려면 주소와 모델을 설정하세요.');
            const path = resolve(this.stateRoot, 'settings.json');
            const temporary = path + '.' + randomUUID() + '.tmp';
            try {
                await writeFile(temporary, JSON.stringify(settings), { mode: 0o600, flag: 'wx' });
                await rename(temporary, path);
            }
            finally {
                await unlink(temporary).catch(() => {});
            }
            this.settings = settings;
            return copy(publicReviewSettings(settings));
        });
    }
    private resolveOptions<T extends { model?: string; reasoningEffort?: ReviewOptions['reasoningEffort']; evaluator?: ReviewOptions['evaluator']; evaluationBudget?: ReviewOptions['evaluationBudget'] }>(options: T) {
        const evaluator = options.evaluator ?? this.settings.defaultEvaluator;
        if(options.evaluationBudget && evaluator!=='openai-compatible')throw new ReviewServiceError(400,'명시 평가 예산은 OpenAI 호환 API에서만 지원합니다.');
        const saved = this.settings.providers[evaluator];
        const model = options.model ?? saved?.model;
        if (evaluator === 'openai-compatible' && (!model || !this.settings.providers[evaluator]?.baseUrl))
            throw new ReviewServiceError(400, 'OpenAI 호환 API의 주소와 모델을 설정하세요.');
        return { ...options, evaluator, model, reasoningEffort: options.reasoningEffort ?? saved?.reasoningEffort };
    }
    private resolveRevisionOptions(options: ReviewSubmission['options']): ReviewOptions {
        const resolved = this.resolveOptions(options);
        if (resolved.evaluator !== 'openai-compatible' || options.reviewPipeline !== 'standard' ||
            options.evaluationBudget !== undefined || options.timeoutSeconds !== undefined)
            return { ...resolved, timeoutSeconds: options.timeoutSeconds ?? DEFAULT_REVIEW_TIMEOUT_SECONDS };
        const configured = this.settings.providers['openai-compatible']?.standardEvaluationTimeouts ?? defaultStandardEvaluationTimeouts;
        return { ...resolved, ...deriveStandardReviewTimeouts(configured) };
    }
    private rememberConnection(id: string, evaluator: ReviewOptions['evaluator']) {
        if (evaluator !== 'openai-compatible')
            return;
        const config = this.settings.providers['openai-compatible']!;
        (this.state.compatibleConnections ??= {})[id] = hash(JSON.stringify([config.baseUrl, config.apiFormat]));
    }
    private runEvaluation<T>(id: string, evaluator: ReviewOptions['evaluator'], run: () => T): T {
        if (evaluator !== 'openai-compatible')
            return run();
        const config = this.settings.providers['openai-compatible'];
        if (!config?.baseUrl || hash(JSON.stringify([config.baseUrl, config.apiFormat])) !== this.state.compatibleConnections?.[id])
            throw new Error('접수 이후 OpenAI 호환 API 주소 또는 형식이 변경되었습니다. 현재 설정으로 새 검토를 접수하세요.');
        return runWithOpenAiCompatible({ baseUrl: config.baseUrl, apiFormat: config.apiFormat, apiKey: config.apiKey }, run);
    }
    async start(): Promise<void> {
        if (this.hasStarted)
            return;
        await mkdir(this.stateRoot, { recursive: true, mode: 0o700 });
        const lockPath = resolve(this.stateRoot, 'service.lock');
        const claim = async () => {
            const lock = await open(lockPath, 'wx', 0o600);
            try {
                await lock.writeFile(String(process.pid));
                this.hasLock = true;
            }
            finally {
                await lock.close();
            }
        };
        try {
            await claim();
        }
        catch (error) {
            if ((error as NodeJS.ErrnoException).code !== 'EEXIST')
                throw error;
            // Only one contender may remove a stale lock. Fresh claimants never remove it.
            const recoveryPath = lockPath + '.recovery';
            let recovery;
            try {
                recovery = await open(recoveryPath, 'wx', 0o600);
            }
            catch {
                throw new ReviewServiceError(409, '다른 서비스가 잠금을 복구 중입니다. 잠시 후 다시 실행하세요.');
            }
            try {
                let pid: number;
                try {
                    pid = Number(await readFile(lockPath, 'utf8'));
                    if (!Number.isInteger(pid) || pid < 1)
                        throw new Error();
                }
                catch {
                    throw new ReviewServiceError(409, '서비스 잠금이 손상되었습니다. 실행 중인 서비스가 없는지 확인하세요.');
                }
                let isAlive = true;
                try {
                    process.kill(pid, 0);
                }
                catch (e) {
                    if ((e as NodeJS.ErrnoException).code === 'ESRCH')
                        isAlive = false;
                }
                if (isAlive)
                    throw new ReviewServiceError(409, '같은 보고서 폴더의 리뷰 서비스가 이미 실행 중입니다.');
                await unlink(lockPath);
                try {
                    await claim();
                }
                catch {
                    throw new ReviewServiceError(409, '다른 서비스가 먼저 실행되었습니다.');
                }
            }
            finally {
                await recovery.close();
                await unlink(recoveryPath).catch(() => { });
            }
        }
        try {
            try {
                this.settings = reviewSettingsSchema.parse(JSON.parse(await readFile(resolve(this.stateRoot, 'settings.json'), 'utf8')));
            }
            catch (error) {
                if ((error as NodeJS.ErrnoException).code !== 'ENOENT')
                    throw new Error('저장된 리뷰 설정을 읽을 수 없습니다.');
            }
            try {
                this.state = JSON.parse(await readFile(resolve(this.stateRoot, 'state.json'), 'utf8'));
                if (this.state.version !== 1 || !Array.isArray(this.state.tasks) || !Array.isArray(this.state.assets) || !this.state.submissions)
                    throw new Error('Unsupported review state');
            }
            catch (e) {
                if ((e as NodeJS.ErrnoException).code !== 'ENOENT')
                    throw e;
            }
            for(const project of this.workspaceState.projects){
                const hosts=Array.isArray(project.postAllowedHosts)?project.postAllowedHosts:[];
                project.postAllowedHosts=hosts.length<=PROJECT_POST_HOST_LIMIT&&hosts.every(host=>typeof host==='string'&&normalizeProjectPostHost(host)===host)?[...new Set(hosts)]:[];
                const bindings=projectSupabaseAuthBindingsSchema.safeParse(project.supabaseAuthBindings);
                project.supabaseAuthBindings=bindings.success?bindings.data:[];
            }
            for (const task of this.state.tasks)
                for (const revision of task.revisions)
                    for (const target of revision.targets)
                        for (const attempt of [...target.attempts])
                            if (attempt.status === 'running') {
                                const report = await this.recoverReport(attempt);
                                if (report)
                                    Object.assign(attempt, report);
                                else if (attempt.credentialMethod)
                                    this.requireNewCredentials(target, attempt, '서비스가 다시 시작되었습니다. 로그인 정보를 다시 입력하세요.');
                                else
                                    Object.assign(attempt, { status: 'failed', endedAt: now(), error: '서비스 중단으로 실행이 종료되었습니다. 실패 대상만 재시도하세요.' });
                            }
                            else if (attempt.status === 'queued' && attempt.credentialMethod) {
                                this.requireNewCredentials(target, attempt, '서비스가 다시 시작되었습니다. 로그인 정보를 다시 입력하세요.');
                            }
            for (const review of this.state.focusedReviews ?? [])
                for (const attempt of review.attempts)
                    if (attempt.status === 'running') {
                        const report = await this.recoverReport(attempt);
                        if (report)
                            Object.assign(attempt, report);
                        else
                            Object.assign(attempt, { status: 'failed', endedAt: now(), error: '서비스 중단으로 집중 검토가 종료되었습니다.' });
                        await this.loadFocusedAnswer(review, attempt);
                    }
            for (const request of this.workspaceState.requests) {
                if (isWorkspaceTrashed(this.workspaceState,request.workspaceId)) continue;
                const task = this.state.tasks.find(item => item.taskId === request.taskId);
                const revision = task?.revisions.find(item => item.revisionId === request.revisionId);
                const target = revision?.targets.find(item => item.targetId === request.targetId);
                const attempt = target?.attempts.at(-1);
                if (!target || !attempt) continue;
                request.attempts = target.attempts;
                // The cache describes the latest attempt; older results still live in their reports.
                delete request.result;
                if (attempt.reportId && attempt.runId) {
                    delete request.needsImageHandoff;
                    try {
                        const saved = JSON.parse(await readFile(resolve(this.outputRoot(attempt), attempt.runId, 'report.json'), 'utf8'));
                        if (saved.followup?.requestId === request.requestId) {
                            request.result = saved.followup;
                            request.needsImageHandoff = saved.followup.needsImageHandoff;
                        }
                    } catch {}
                }
                this.synchronizeWorkspaceResult(request, attempt);
            }
            migrateWorkspaces(this.workspaceState,this.state.tasks);
            await this.save();
            this.hasStarted = true;
            await this.purgeExpiredWorkspaces();
            this.kick();
        }
        catch (error) {
            await this.release();
            throw error;
        }
    }
    private async release() {
        if (this.hasLock) {
            await unlink(resolve(this.stateRoot, 'service.lock')).catch(() => { });
            this.hasLock = false;
        }
    }
    async close() { this.isClosing = true;clearTimeout(this.trashTimer);for(const controller of this.runningControllers.values())controller.abort(); await Promise.all([...this.workers]);await closeBrowserLeases(); await this.chain; for(const id of this.pendingCredentials.keys())this.forgetCredentials(id); await this.release(); }
    get isReady(): boolean { return this.hasStarted && !this.isClosing && this.isStorageHealthy; }
    private assertStarted() {
        if (!this.hasStarted || this.isClosing || !this.isStorageHealthy)
            throw new ReviewServiceError(503, '리뷰 서비스가 실행 중이 아닙니다.');
    }
    private trashedAttemptIds() { return new Set(allWorkspaceTrash(this.workspaceState).flatMap(entry => entry.attemptIds)); }
    private visibleTask(task: ReviewTask, attemptIds = this.trashedAttemptIds()) {
        return attemptIds.size ? removeTaskAttempts(task, attemptIds) : task;
    }
    private requireVisibleTask(task: ReviewTask) {
        const visible = this.visibleTask(task);
        if (!visible) throw new ReviewServiceError(404, '작업을 찾을 수 없습니다.');
        return visible;
    }
    async reportContexts(): Promise<Record<string, ReviewReportContext>> {
        await this.chain;
        const contexts: Record<string, ReviewReportContext> = {};
        const trashed = this.trashedReportIds();
        for (const task of this.state.tasks)
            for (const revision of task.revisions)
                for (const target of revision.targets)
                    target.attempts.forEach((attempt, index) => {
                        if (attempt.reportId && !trashed.has(attempt.reportId)) contexts[attempt.reportId] = {
                            taskId: task.taskId, taskTitle: revision.title,
                            revisionId: revision.revisionId, revisionNumber: revision.number,
                            targetId: target.targetId, targetName: target.name, attemptNumber: index + 1,
                            ...(attempt.shouldReviewLoginPage && attempt.loginRedirect ? { loginRedirect: copy(attempt.loginRedirect) } : {}),
                        };
                    });
        return contexts;
    }

    private get workspaceState(){return this.state.workspaceData??=(emptyWorkspaceState());}
    private requireProject(id: string) {
        const project = this.workspaceState.projects.find(candidate => candidate.projectId === id);
        if (!project || this.workspaceState.projectTrash?.[id]) throw new ReviewServiceError(404, '프로젝트를 찾을 수 없습니다.');
        return project;
    }
    private requireEditableProject(id: string) {
        const project = this.requireProject(id);
        if (project.isUncategorized) throw new ReviewServiceError(409, '미분류는 시스템 프로젝트로 삭제하거나 설정을 변경할 수 없습니다.');
        return project;
    }
    private requireWorkspace(id:string){const workspace=this.workspaceState.workspaces.find(w=>w.workspaceId===id);if(!workspace||isWorkspaceTrashed(this.workspaceState,id))throw new ReviewServiceError(404,'UI 검토 작업공간을 찾을 수 없습니다.');return workspace;}
    private requireRequest(id:string){const request=this.workspaceState.requests.find(r=>r.requestId===id);if(!request||isWorkspaceTrashed(this.workspaceState,request.workspaceId))throw new ReviewServiceError(404,'후속 요청을 찾을 수 없습니다.');return request;}
    private activeProjects() { return this.workspaceState.projects.filter(project => !this.workspaceState.projectTrash?.[project.projectId]); }
    async projects(){await this.chain;return copy(this.activeProjects());}
    async projectCatalog(){
        await this.chain;
        const {memberships}=this.workspaceState;
        const projects=this.activeProjects();
        const workspaces=this.workspaceState.workspaces.filter(workspace=>!isWorkspaceTrashed(this.workspaceState,workspace.workspaceId));
        const projectNames=new Map(projects.map(project=>[project.projectId,project.name]));
        const workspaceContexts=new Map<string,ReportWorkspaceContext>();
        for(const {workspaceId,name:workspaceName,projectId} of workspaces){
            const projectName=projectNames.get(projectId);
            if(projectName!==undefined)workspaceContexts.set(workspaceId,{workspaceId,workspaceName,projectId,projectName});
        }
        const reportWorkspaceContexts=new Map<string,ReportWorkspaceContext>();
        for(const {reportId,workspaceId} of memberships){
            const context=workspaceContexts.get(workspaceId);
            if(context)reportWorkspaceContexts.set(reportId,context);
        }
        return {projects:copy(projects),workspaces:copy(workspaces),reportWorkspaceContexts};
    }
    async workspaces(projectId?:string){await this.chain;return copy(this.workspaceState.workspaces.filter(w=>!isWorkspaceTrashed(this.workspaceState,w.workspaceId)&&(!projectId||w.projectId===projectId)));}
    async workspace(id: string) {
        await this.chain;
        this.requireWorkspace(id);
        const detail = copy(workspaceDetail(this.workspaceState, this.state.tasks, id)!);
        const isTrashed = (id: string) => isWorkspaceTrashed(this.workspaceState, id);
        const reportIds = this.trashedReportIds();
        const requests = await Promise.all(detail.requests.map(async request => {
            const attempt = request.attempts.at(-1);
            return attempt && await this.canRetryAttempt(attempt) ? {...request, canRetry: true} : request;
        }));
        return {...detail,
            requests,
            linkedWorkspaces: detail.linkedWorkspaces.filter(link => !isTrashed(link.workspaceId)),
            membershipEvents: detail.membershipEvents?.filter(event =>
                !(event.fromId && isTrashed(event.fromId)) && !isTrashed(event.toId) &&
                !reportIds.has(event.entityId) && !event.reportIds?.some(reportId => reportIds.has(reportId))),
        };
    }
    async workspaceContext(reportId:string){await this.chain;if(this.trashedReportIds().has(reportId))return {};const membership=this.workspaceState.memberships.find(m=>m.reportId===reportId);return membership?{workspace:copy(this.requireWorkspace(membership.workspaceId)),project:copy(this.workspaceState.projects.find(p=>p.projectId===this.requireWorkspace(membership.workspaceId).projectId)!)}:{};}
    trashedReportIds(): ReadonlySet<string> {
        return new Set([
            ...allWorkspaceTrash(this.workspaceState).flatMap(entry => entry.reportIds),
            ...Object.values(this.workspaceState.pendingCleanup ?? {}).flatMap(entry => entry.reportIds),
        ]);
    }
    private trashEntry(workspace: ReviewWorkspace, trash: WorkspaceTrash): TrashedWorkspace {
        const project = this.workspaceState.projects.find(project => project.projectId === workspace.projectId)!;
        return {workspace, project, trashedAt: trash.trashedAt, expiresAt: trash.expiresAt,
            reportCount: trash.reportIds.length, requestCount: trash.requestIds.length};
    }
    private workspaceNow() { return this.dependencies.workspaceClock?.() ?? Date.now(); }
    private collectTrash(workspaceIds: ReadonlySet<string>, projectId?: string) {
        return collectWorkspaceTrash(this.workspaceState, this.state.tasks, this.state.focusedReviews ?? [], workspaceIds, projectId);
    }
    private hasActiveReviews(attempts: Iterable<ReviewAttempt>) {
        return [...attempts].some(attempt => attempt.status === 'queued' || attempt.status === 'running' ||
            this.runningControllers.has(attempt.attemptId));
    }
    private hasExternalTrashDependencies(workspaceIds: ReadonlySet<string>, selection: ReturnType<typeof collectWorkspaceTrash>) {
        const {reportIds, focusedReviewIds, requestIds} = selection;
        return this.workspaceState.memberships.some(member => !workspaceIds.has(member.workspaceId) && reportIds.has(member.reportId)) ||
            Boolean(this.state.focusedReviews?.some(review => !focusedReviewIds.has(review.focusedReviewId) &&
                review.attempts.some(attempt => attempt.reportId && reportIds.has(attempt.reportId)))) ||
            this.workspaceState.requests.some(request => !workspaceIds.has(request.workspaceId) &&
                !isWorkspaceTrashed(this.workspaceState, request.workspaceId) && usesTrashedHistory(request, requestIds, reportIds));
    }
    private createTrash(selection: ReturnType<typeof collectWorkspaceTrash>, timestamp: number): WorkspaceTrash {
        return {
            trashedAt: new Date(timestamp).toISOString(),
            expiresAt: new Date(timestamp + WORKSPACE_RETENTION_MS).toISOString(),
            attemptIds: [...selection.attempts.keys()],
            requestIds: [...selection.requestIds],
            reportIds: [...selection.reportIds],
            focusedReviewIds: [...selection.focusedReviewIds],
        };
    }
    private projectDeletionScope(project: ReviewProject) {
        const workspaces = this.workspaceState.workspaces.filter(workspace => workspace.projectId === project.projectId);
        const active = workspaces.filter(workspace => !isWorkspaceTrashed(this.workspaceState, workspace.workspaceId));
        const workspaceIds = new Set(active.map(workspace => workspace.workspaceId));
        const selection = this.collectTrash(workspaceIds, project.projectId);
        const hasActiveReviews = this.hasActiveReviews(selection.attempts.values());
        const hasExternalDependencies = this.hasExternalTrashDependencies(workspaceIds, selection);
        const scopeVersion = hash(JSON.stringify([
            project.version,
            workspaces.map(workspace => [workspace.workspaceId, workspace.version, this.workspaceState.trash?.[workspace.workspaceId]?.trashedAt]),
            [...selection.requestIds], [...selection.reportIds], [...selection.focusedReviewIds],
            [...selection.attempts.values()].map(attempt => [attempt.attemptId, attempt.status]),
            hasActiveReviews, hasExternalDependencies,
        ]));
        return {workspaces, workspaceIds, selection, preview: {
            projectId: project.projectId, scopeVersion,
            workspaceCount: active.length, trashedWorkspaceCount: workspaces.length - active.length,
            reportCount: selection.reportIds.size, requestCount: selection.requestIds.size,
            hasActiveReviews, hasExternalDependencies,
        } satisfies ProjectDeletionPreview};
    }
    async projectDeletionPreview(id: string): Promise<ProjectDeletionPreview> {
        await this.chain;
        this.assertStarted();
        return this.projectDeletionScope(this.requireEditableProject(reviewIdSchema.parse(id))).preview;
    }
    private projectTrashEntry(project: ReviewProject, trash: ProjectTrash): TrashedProject {
        return {project, trashedAt: trash.trashedAt, expiresAt: trash.expiresAt, workspaceCount: trash.workspaceIds.length,
            reportCount: trash.reportIds.length, requestCount: trash.requestIds.length};
    }
    async trashedProjects(): Promise<TrashedProject[]> {
        await this.chain;
        const entries = this.workspaceState.projects.flatMap(project => {
            const trash = this.workspaceState.projectTrash?.[project.projectId];
            return trash && Date.parse(trash.expiresAt) > this.workspaceNow() ? [this.projectTrashEntry(project, trash)] : [];
        });
        return copy(entries.sort((a, b) => b.trashedAt.localeCompare(a.trashedAt)));
    }
    private uncategorizedProject(): ReviewProject {
        const state = this.workspaceState;
        return state.projects.find(project => project.isUncategorized) ?? createProject(state, '미분류');
    }
    async deleteProject(id: string, raw: unknown): Promise<ProjectDeletionResult> {
        const projectId = reviewIdSchema.parse(id);
        const input = projectDeletionSchema.parse(raw);
        const result = await this.serial(async (): Promise<ProjectDeletionResult> => {
            this.assertStarted();
            const project = this.requireEditableProject(projectId);
            const {workspaces, workspaceIds, selection, preview} = this.projectDeletionScope(project);
            if (input.scopeVersion !== preview.scopeVersion)
                throw new ReviewServiceError(409, '프로젝트 또는 삭제 대상이 변경되었습니다. 삭제 범위를 다시 확인하세요.');
            if (preview.hasActiveReviews)
                throw new ReviewServiceError(409, '대기 중이거나 실행 중인 검토가 끝난 뒤 프로젝트를 삭제하세요.');
            const timestamp = this.workspaceNow();
            if (input.mode === 'cascade') {
                if (preview.hasExternalDependencies)
                    throw new ReviewServiceError(409, '다른 작업공간에서 이 검토 기록을 사용 중입니다. 연결된 검토를 먼저 정리하세요.');
                preserveLegacyPlacements(this.workspaceState, this.state.tasks, projectId);
                const trash = {...this.createTrash(selection, timestamp), workspaceIds: [...workspaceIds]};
                for (const workspace of workspaces) if (workspaceIds.has(workspace.workspaceId)) {
                    workspace.version++;
                    workspace.updatedAt = trash.trashedAt;
                }
                (this.workspaceState.projectTrash ??= {})[projectId] = trash;
                await this.save();
                return copy({mode: 'cascade', entry: this.projectTrashEntry(project, trash)});
            }
            const destination = workspaces.length || selection.attempts.size ? this.uncategorizedProject() : undefined;
            // Resolve unnamed legacy image targets against their original project before marking a new default.
            const movedTargets = preserveLegacyPlacements(this.workspaceState, this.state.tasks, projectId, destination?.projectId);
            if (destination) {
                destination.isUncategorized = true;
                destination.description ||= '프로젝트를 지정하지 않았거나 프로젝트 삭제로 이동한 작업공간입니다.';
                const allChildIds = new Set(workspaces.map(workspace => workspace.workspaceId));
                for (const request of this.workspaceState.requests)
                    if (allChildIds.has(request.workspaceId)) this.revokeWorkspaceRequestGrants(request.requestId);
                const updatedAt = new Date(timestamp).toISOString();
                for (const workspace of workspaces) {
                    this.recordWorkspaceMovement('workspace', workspace.workspaceId, projectId, destination.projectId, '프로젝트 삭제로 미분류로 이동함');
                    workspace.projectId = destination.projectId;
                    workspace.version++;
                    workspace.updatedAt = updatedAt;
                }
            }
            forgetLegacyProjectKeys(this.workspaceState, projectId);
            this.workspaceState.projects = this.workspaceState.projects.filter(candidate => candidate.projectId !== projectId);
            if (movedTargets.size) migrateWorkspaces(this.workspaceState, this.state.tasks, movedTargets);
            await this.save();
            return {mode: 'project-only', destinationProjectId: destination?.projectId};
        });
        this.scheduleTrashSweep();
        return result;
    }
    private assertCanRestore(trash: WorkspaceTrash, kind: '프로젝트' | '작업공간') {
        if (Date.parse(trash.expiresAt) <= this.workspaceNow())
            throw new ReviewServiceError(409, `보관 기간이 끝나${kind === '프로젝트' ? ' 프로젝트를' : ' 작업공간을'} 복원할 수 없습니다.`);
        const ownRequests = new Set(trash.requestIds);
        for (const other of allWorkspaceTrash(this.workspaceState)) {
            if (other === trash) continue;
            const requestIds = new Set(other.requestIds);
            const reportIds = new Set(other.reportIds);
            if (this.workspaceState.requests.some(request => ownRequests.has(request.requestId) &&
                usesTrashedHistory(request, requestIds, reportIds)))
                throw new ReviewServiceError(409, '기준 검토가 있는 작업공간 또는 프로젝트를 먼저 복원하세요.');
        }
    }
    async restoreProject(id: string): Promise<ReviewProject> {
        const projectId = reviewIdSchema.parse(id);
        const restored = await this.serial(async () => {
            this.assertStarted();
            const trash = this.workspaceState.projectTrash?.[projectId];
            const project = this.workspaceState.projects.find(candidate => candidate.projectId === projectId);
            if (!trash || !project) throw new ReviewServiceError(404, '휴지통에서 프로젝트를 찾을 수 없습니다.');
            this.assertCanRestore(trash, '프로젝트');
            const updatedAt = new Date(this.workspaceNow()).toISOString();
            for (const workspace of this.workspaceState.workspaces) if (trash.workspaceIds.includes(workspace.workspaceId)) {
                workspace.version++;
                workspace.updatedAt = updatedAt;
            }
            project.version++;
            project.updatedAt = updatedAt;
            delete this.workspaceState.projectTrash![projectId];
            await this.save();
            return copy(project);
        });
        this.scheduleTrashSweep();
        return restored;
    }
    async trashedWorkspaces() {
        await this.chain;
        const entries = this.workspaceState.workspaces.flatMap(workspace => {
            const trash = this.workspaceState.trash?.[workspace.workspaceId];
            return trash && !this.workspaceState.projectTrash?.[workspace.projectId] &&
                Date.parse(trash.expiresAt) > this.workspaceNow() ? [this.trashEntry(workspace, trash)] : [];
        });
        return copy(entries.sort((a, b) => b.trashedAt.localeCompare(a.trashedAt)));
    }
    async trashWorkspace(id: string, raw: unknown) {
        const input = z.object({expectedVersion: z.number().int().min(1)}).strict().parse(raw);
        const entry = await this.serial(async () => {
            this.assertStarted();
            const existing = this.workspaceState.trash?.[id];
            const workspace = this.workspaceState.workspaces.find(workspace => workspace.workspaceId === id);
            if (!workspace || this.workspaceState.projectTrash?.[workspace.projectId])
                throw new ReviewServiceError(404, 'UI 검토 작업공간을 찾을 수 없습니다.');
            if (existing) return copy(this.trashEntry(workspace, existing));
            if (workspace.version !== input.expectedVersion)
                throw new ReviewServiceError(409, '소속 정보가 변경되었습니다. 새로고침하세요.');
            const workspaceIds = new Set([id]);
            const selection = this.collectTrash(workspaceIds);
            if (this.hasActiveReviews(selection.attempts.values()))
                throw new ReviewServiceError(409, '대기 중이거나 실행 중인 검토가 끝난 뒤 휴지통으로 이동하세요.');
            if (this.hasExternalTrashDependencies(workspaceIds, selection))
                throw new ReviewServiceError(409, '다른 작업공간에서 이 검토 기록을 사용 중입니다. 연결된 검토를 먼저 정리하세요.');
            const trash = this.createTrash(selection, this.workspaceNow());
            workspace.version++;
            workspace.updatedAt = trash.trashedAt;
            (this.workspaceState.trash ??= {})[id] = trash;
            await this.save();
            return copy(this.trashEntry(workspace, trash));
        });
        this.scheduleTrashSweep();
        return entry;
    }
    async restoreWorkspace(id: string) {
        const restored = await this.serial(async () => {
            this.assertStarted();
            const trash = this.workspaceState.trash?.[id];
            const workspace = this.workspaceState.workspaces.find(candidate => candidate.workspaceId === id);
            if (!trash || !workspace) throw new ReviewServiceError(404, '휴지통에서 작업공간을 찾을 수 없습니다.');
            if (this.workspaceState.projectTrash?.[workspace.projectId])
                throw new ReviewServiceError(409, '이 작업공간의 프로젝트를 먼저 복원하세요.');
            this.assertCanRestore(trash, '작업공간');
            delete this.workspaceState.trash![id];
            workspace.version++;
            workspace.updatedAt = new Date(this.workspaceNow()).toISOString();
            await this.save();
            return copy(workspace);
        });
        this.scheduleTrashSweep();
        return restored;
    }
    private scheduleTrashSweep() {
        clearTimeout(this.trashTimer);
        if (!this.isReady) return;
        const nextExpiry = Math.min(...allWorkspaceTrash(this.workspaceState).map(entry => Date.parse(entry.expiresAt)));
        const hasPendingCleanup = Object.keys(this.workspaceState.pendingCleanup ?? {}).length > 0;
        if (!Number.isFinite(nextExpiry) && !hasPendingCleanup) return;
        const untilExpiry = nextExpiry - this.workspaceNow();
        const retryDelay = 60_000;
        const delay = untilExpiry <= 0 ? retryDelay : Math.min(untilExpiry, hasPendingCleanup ? retryDelay : 2_147_483_647);
        this.trashTimer = setTimeout(() => void this.purgeExpiredWorkspaces(), delay);
        this.trashTimer.unref();
    }
    private expiredTrashUnits(): TrashPurgeUnit[] {
        const state = this.workspaceState;
        const timestamp = this.workspaceNow();
        const units: TrashPurgeUnit[] = [];
        const groupedWorkspaceIds = new Set<string>();
        for (const [projectId, trash] of Object.entries(state.projectTrash ?? {})) {
            if (Date.parse(trash.expiresAt) > timestamp) continue;
            const workspaces = state.workspaces.filter(workspace => workspace.projectId === projectId);
            const workspaceIds = workspaces.map(workspace => workspace.workspaceId);
            const separateTrash = workspaceIds.flatMap(id => state.trash?.[id] ?? []);
            if (separateTrash.some(entry => Date.parse(entry.expiresAt) > timestamp)) continue;
            for (const id of workspaceIds) groupedWorkspaceIds.add(id);
            units.push({id: projectId, projectId, workspaceIds, entries: [trash, ...separateTrash]});
        }
        for (const [id, trash] of Object.entries(state.trash ?? {}))
            if (!groupedWorkspaceIds.has(id) && Date.parse(trash.expiresAt) <= timestamp)
                units.push({id, workspaceIds: [id], entries: [trash]});

        // Expired groups can depend on each other. Remove them together, but let any work still
        // eligible for restore keep the underlying data until its own retention ends.
        let eligible = units;
        while (eligible.length) {
            const requestIds = new Set(eligible.flatMap(unit => unit.entries.flatMap(entry => entry.requestIds)));
            const workspaceIds = new Set(eligible.flatMap(unit => unit.workspaceIds));
            const survivingRequests = state.requests.filter(request => !requestIds.has(request.requestId));
            const next = eligible.filter(unit => {
                const unitRequests = new Set(unit.entries.flatMap(entry => entry.requestIds));
                const unitReports = new Set(unit.entries.flatMap(entry => entry.reportIds));
                return !survivingRequests.some(request => usesTrashedHistory(request, unitRequests, unitReports)) &&
                    !state.memberships.some(membership => !workspaceIds.has(membership.workspaceId) && unitReports.has(membership.reportId));
            });
            if (next.length === eligible.length) return eligible;
            eligible = next;
        }
        return eligible;
    }
    private trashPurgeBatches(units: TrashPurgeUnit[]): TrashPurgeUnit[][] {
        const requestOwners = new Map<string, TrashPurgeUnit>();
        const workspaceOwners = new Map<string, TrashPurgeUnit>();
        const neighbours = new Map(units.map(unit => [unit, new Set<TrashPurgeUnit>()]));
        for (const unit of units) {
            for (const entry of unit.entries)
                for (const id of entry.requestIds) requestOwners.set(id, unit);
            for (const id of unit.workspaceIds) workspaceOwners.set(id, unit);
        }
        const connect = (unit: TrashPurgeUnit, other: TrashPurgeUnit | undefined) => {
            if (!other || other === unit) return;
            neighbours.get(unit)!.add(other);
            neighbours.get(other)!.add(unit);
        };
        for (const unit of units) {
            const requestIds = new Set(unit.entries.flatMap(entry => entry.requestIds));
            const reportIds = new Set(unit.entries.flatMap(entry => entry.reportIds));
            for (const request of this.workspaceState.requests)
                if (usesTrashedHistory(request, requestIds, reportIds))
                    connect(unit, requestOwners.get(request.requestId));
            for (const membership of this.workspaceState.memberships)
                if (reportIds.has(membership.reportId))
                    connect(unit, workspaceOwners.get(membership.workspaceId));
        }

        const batches: TrashPurgeUnit[][] = [];
        const unvisited = new Set(units);
        for (const first of unvisited) {
            const batch = [first];
            unvisited.delete(first);
            for (const unit of batch)
                for (const neighbour of neighbours.get(unit)!)
                    if (unvisited.delete(neighbour)) batch.push(neighbour);
            batches.push(batch);
        }
        return batches;
    }
    private async detachExpiredWorkspaces(units: TrashPurgeUnit[]) {
        const state = this.workspaceState;
        const workspaceIds = new Set(units.flatMap(unit => unit.workspaceIds));
        const projectIds = new Set(units.flatMap(unit => unit.projectId ? [unit.projectId] : []));
        const entries = units.flatMap(unit => unit.entries);
        const attemptIds = new Set(entries.flatMap(entry => entry.attemptIds));
        const reportIds = new Set(entries.flatMap(entry => entry.reportIds));
        const requestIds = new Set(entries.flatMap(entry => entry.requestIds));
        const focusedIds = new Set(entries.flatMap(entry => entry.focusedReviewIds));

        const managedReportIds = new Set<string>();
        const removedTargetAssets = new Set<string>();
        for (const task of this.state.tasks) for (const revision of task.revisions) for (const target of revision.targets) {
            for (const attempt of target.attempts) {
                if (!attemptIds.has(attempt.attemptId)) continue;
                if (attempt.reportId) managedReportIds.add(attempt.reportId);
                if (target.kind === 'image') removedTargetAssets.add(target.assetId);
            }
        }
        for (const review of this.state.focusedReviews ?? []) if (focusedIds.has(review.focusedReviewId))
            for (const attempt of review.attempts) if (attempt.reportId) managedReportIds.add(attempt.reportId);

        const root = await realpath(this.runsRoot);
        const files = await attachedReportFiles(root, new Set([...reportIds].filter(reportId => !managedReportIds.has(reportId))));
        files.push(
            ...[...attemptIds].map(attemptId => ({path: 'review-attempts/' + reviewIdSchema.parse(attemptId), isDirectory: true})),
            ...[...focusedIds].map(reviewId => ({path: '.review-service/focused/' + reviewIdSchema.parse(reviewId), isDirectory: true})),
            ...[...requestIds].filter(requestId => state.sourceImages?.[requestId]).map(requestId => ({
                path: '.review-service/followup-sources/' + reviewIdSchema.parse(requestId) + '.png', isDirectory: false,
            })),
            ...[...reportIds].filter(reportId => /^[a-f0-9]{64}$/.test(reportId)).map(reportId => ({
                path: '.viewer-metadata/' + reportId + '.json', isDirectory: false,
            })),
        );
        this.state.tasks = this.state.tasks.flatMap(task => removeTaskAttempts(task, attemptIds) ?? []);
        const survivingRevisions = new Set<string>();
        for (const task of this.state.tasks) for (const revision of task.revisions) {
            survivingRevisions.add(revision.revisionId);
            for (const target of revision.targets) if (target.kind === 'image') removedTargetAssets.delete(target.assetId);
        }
        this.state.assets = this.state.assets.filter(asset => !removedTargetAssets.has(asset.assetId));
        files.push(...[...removedTargetAssets].map(assetId => ({
            path: '.review-service/assets/' + reviewIdSchema.parse(assetId), isDirectory: false,
        })));
        for (const [key, submission] of Object.entries(this.state.submissions))
            if (!survivingRevisions.has(submission.revisionId)) delete this.state.submissions[key];
        for (const [key, submission] of Object.entries(this.state.focusedSubmissions ?? {}))
            if (focusedIds.has(submission.focusedReviewId)) delete this.state.focusedSubmissions![key];
        for (const key of Object.keys(this.state.compatibleConnections ?? {}))
            if (focusedIds.has(key) || !survivingRevisions.has(key) &&
                !this.state.focusedReviews?.some(review => review.focusedReviewId === key))
                delete this.state.compatibleConnections![key];
        this.state.focusedReviews = this.state.focusedReviews?.filter(review => !focusedIds.has(review.focusedReviewId));
        state.requests = state.requests.filter(request => !requestIds.has(request.requestId));
        state.memberships = state.memberships.filter(membership => !reportIds.has(membership.reportId));
        state.workspaces = state.workspaces.filter(workspace => !workspaceIds.has(workspace.workspaceId));
        state.projects = state.projects.filter(project => !projectIds.has(project.projectId));
        state.movements = state.movements?.filter(movement => !(movement.fromId && workspaceIds.has(movement.fromId)) && !workspaceIds.has(movement.toId) &&
            !workspaceIds.has(movement.entityId) && !requestIds.has(movement.entityId) && !reportIds.has(movement.entityId) &&
            !movement.reportIds?.some(reportId => reportIds.has(reportId)));
        for (const request of state.requests)
            if (request.classification && workspaceIds.has(request.classification.fromWorkspaceId)) delete request.classification;
        for (const [key, value] of Object.entries(state.legacyKeys))
            if (workspaceIds.has(value)) delete state.legacyKeys[key];
        for (const projectId of projectIds) forgetLegacyProjectKeys(state, projectId);
        for (const [key, placement] of Object.entries(state.legacyPlacements ?? {})) {
            if (projectIds.has(placement.projectId) || !survivingRevisions.has(key.split(':')[0])) delete state.legacyPlacements![key];
            else if (placement.workspaceId && workspaceIds.has(placement.workspaceId)) delete placement.workspaceId;
        }
        for (const [key, submission] of Object.entries(state.submissions))
            if (requestIds.has(submission.requestId)) delete state.submissions[key];
        for (const requestId of requestIds) {
            if (state.sourceImages) delete state.sourceImages[requestId];
            this.revokeWorkspaceRequestGrants(requestId);
            if (state.supabaseAuthGrants) delete state.supabaseAuthGrants[requestId];
        }
        if (files.length) (state.pendingCleanup ??= {})[units[0].id] = {reportIds: [...reportIds], files};
        for (const id of workspaceIds) if (state.trash) delete state.trash[id];
        for (const id of projectIds) delete state.projectTrash![id];
        await this.save();
    }
    async purgeExpiredWorkspaces() {
        const reportCleanupFailure = (error: unknown) =>
            console.error('Workspace cleanup will retry:', error instanceof Error ? error.message : 'unknown error');
        try {
            await this.serial(async () => {
                if (!this.isReady) return;
                const batches = this.trashPurgeBatches(this.expiredTrashUnits());
                // Dependents are detached together. Keep a failed batch from rolling back a
                // separate batch that has already been saved.
                for (const batch of batches)
                    await this.withStateRollback(() => this.detachExpiredWorkspaces(batch)).catch(reportCleanupFailure);
            }).catch(reportCleanupFailure);
            await this.serial(async () => {
                if (!this.isReady) return;
                const pending = this.workspaceState.pendingCleanup;
                if (!pending || !Object.keys(pending).length) return;
                const root = await realpath(this.runsRoot);
                for (const [id, cleanup] of Object.entries(pending)) {
                    try {
                        const reportIds = new Set(cleanup.reportIds);
                        for (const file of cleanup.files) {
                            const paths = file.isDirectory && file.path.startsWith('review-attempts/')
                                ? await managedAttemptFiles(root, file.path, reportIds) : [file];
                            for (const path of paths) await removeWorkspaceFile(root, path);
                        }
                        delete pending[id];
                    } catch (error) {
                        console.error('Workspace files remain pending:', error instanceof Error ? error.message : 'unknown error');
                    }
                }
                await this.save();
            });
        } catch (error) {
            reportCleanupFailure(error);
        } finally {
            this.scheduleTrashSweep();
        }
    }
    async addProject(raw: unknown) {
        const { projectId, name, description = '' } = projectInputSchema.parse(raw);
        return this.serial(async () => {
            this.assertStarted();
            const existing = projectId && this.workspaceState.projects.find(project => project.projectId === projectId);
            if (existing) {
                if (existing.isUncategorized || this.workspaceState.projectTrash?.[existing.projectId] || existing.name !== name || existing.description !== description)
                    throw new ReviewServiceError(409, '같은 프로젝트 ID의 기존 프로젝트가 요청과 일치하지 않습니다.');
                return copy(existing);
            }
            const project = createProject(this.workspaceState, name, description, projectId);
            await this.save();
            return copy(project);
        });
    }
    async updateProjectPostHosts(id:string,raw:unknown){
        const projectId=reviewIdSchema.parse(id),input=projectPostHostsSchema.parse(raw);
        return this.serial(async()=>{
            this.assertStarted();
            const project=this.requireEditableProject(projectId);
            if(project.version!==input.expectedVersion)throw new ReviewServiceError(409,'프로젝트 설정이 변경되었습니다. 다시 불러오세요.');
            project.postAllowedHosts=input.postAllowedHosts;
            project.version++;
            project.updatedAt=now();
            for(const [requestId,grant] of Object.entries(this.workspaceState.postGrants??{})){
                if(grant.projectId!==projectId)continue;
                grant.hosts=grant.hosts.filter(host=>project.postAllowedHosts.includes(host));
                if(!grant.hosts.length)delete this.workspaceState.postGrants![requestId];
            }
            await this.save();
            return copy(project);
        });
    }
    async updateProjectSupabaseAuthBindings(id: string, raw: unknown) {
        const projectId = reviewIdSchema.parse(id);
        const input = projectSupabaseAuthSettingsSchema.parse(raw);
        return this.serial(async () => {
            this.assertStarted();
            const project = this.requireEditableProject(projectId);
            if (project.version !== input.expectedVersion)
                throw new ReviewServiceError(409, '프로젝트 설정이 변경되었습니다. 다시 불러오세요.');
            project.supabaseAuthBindings = input.supabaseAuthBindings;
            project.version++;
            project.updatedAt = now();
            for (const grant of Object.values(this.workspaceState.supabaseAuthGrants ?? {})) {
                if (grant.projectId === projectId && !project.supabaseAuthBindings.some(binding =>
                    binding.targetOrigin === grant.targetOrigin && binding.origin === grant.origin)) grant.isRevoked = true;
            }
            await this.save();
            return copy(project);
        });
    }
    private revokeWorkspaceRequestGrants(requestId:string){
        if(this.workspaceState.postGrants)delete this.workspaceState.postGrants[requestId];
        // Keep the accepted provider boundary, even after revocation, so retries cannot use another form transport.
        const grant=this.workspaceState.supabaseAuthGrants?.[requestId];
        if(grant)grant.isRevoked=true;
    }
    private revokeWorkspaceGrantsForReport(reportId:string){
        for(const request of this.workspaceState.requests)
            if(request.parentReportId===reportId)this.revokeWorkspaceRequestGrants(request.requestId);
    }
    private revokeMovedRequestGrants(requestId:string){
        this.revokeWorkspaceRequestGrants(requestId);
        for(const request of this.workspaceState.requests)
            if(request.executionBaseRequestId===requestId)this.revokeWorkspaceRequestGrants(request.requestId);
    }
    private currentWorkspacePostPolicy(requestId:string){
        const grant=this.workspaceState.postGrants?.[requestId];
        if(!grant?.hosts.length)return undefined;
        const request=this.requireRequest(requestId);
        if(request.workspaceId!==grant.workspaceId)return undefined;
        if(request.executionBaseRequestId&&!this.workspaceState.requests.some(prior=>prior.requestId===request.executionBaseRequestId&&prior.workspaceId===request.workspaceId))return undefined;
        const workspace=this.requireWorkspace(request.workspaceId);
        if(workspace.projectId!==grant.projectId)return undefined;
        if(request.parentReportId&&!this.workspaceState.memberships.some(m=>m.reportId===request.parentReportId&&m.workspaceId===workspace.workspaceId))return undefined;
        const project=this.workspaceState.projects.find(p=>p.projectId===grant.projectId);
        const hosts=grant.hosts.filter(host=>project?.postAllowedHosts.includes(host));
        return hosts.length?{projectId:grant.projectId,hosts}:undefined;
    }
    private canUseWorkspaceSupabaseAuth(requestId: string, attemptId: string, grant: WorkspaceSupabaseAuthGrant, targetOrigin: string) {
        const request = this.workspaceState.requests.find(candidate => candidate.requestId === requestId);
        const activeGrant = this.workspaceState.supabaseAuthGrants?.[requestId];
        const attempt = request?.attempts.at(-1);
        if (!request || attempt?.attemptId !== attemptId || attempt.status !== 'running' || activeGrant?.isRevoked ||
            request.workspaceId !== grant.workspaceId || targetOrigin !== grant.targetOrigin ||
            !isDeepStrictEqual(activeGrant, grant) || isWorkspaceTrashed(this.workspaceState,grant.workspaceId)) return false;
        const workspace = this.workspaceState.workspaces.find(candidate => candidate.workspaceId === grant.workspaceId);
        if (workspace?.projectId !== grant.projectId) return false;
        if (request.executionBaseRequestId && !this.workspaceState.requests.some(prior =>
            prior.requestId === request.executionBaseRequestId && prior.workspaceId === workspace.workspaceId)) return false;
        if (request.parentReportId && !this.workspaceState.memberships.some(membership =>
            membership.reportId === request.parentReportId && membership.workspaceId === workspace.workspaceId)) return false;
        const project = this.workspaceState.projects.find(candidate => candidate.projectId === grant.projectId);
        return project?.supabaseAuthBindings.some(binding => binding.targetOrigin === grant.targetOrigin && binding.origin === grant.origin) ?? false;
    }
    async addWorkspace(raw: unknown) {
        const { workspaceId, projectId, name, goal } = workspaceInputSchema.parse(raw);
        return this.serial(async () => {
            this.assertStarted();
            this.requireProject(projectId);
            const existing = workspaceId && this.workspaceState.workspaces.find(workspace => workspace.workspaceId === workspaceId);
            if (existing) {
                if (isWorkspaceTrashed(this.workspaceState, existing.workspaceId) || existing.projectId !== projectId || existing.name !== name || existing.goal !== goal)
                    throw new ReviewServiceError(409, '같은 작업공간 ID의 기존 작업공간이 요청과 일치하지 않습니다.');
                return copy(existing);
            }
            const workspace = createWorkspace(this.workspaceState, projectId, name, goal, workspaceId);
            await this.save();
            return copy(workspace);
        });
    }
    async moveWorkspace(id:string,raw:unknown){const input=z.object({projectId:reviewIdSchema,expectedVersion:z.number().int().min(1)}).strict().parse(raw);return this.serial(async()=>{this.assertStarted();const workspace=this.requireWorkspace(id);if(workspace.version!==input.expectedVersion)throw new ReviewServiceError(409,'소속 정보가 변경되었습니다. 새로고침하세요.');this.requireProject(input.projectId);if(workspace.projectId!==input.projectId){
        for(const request of this.workspaceState.requests)if(request.workspaceId===workspace.workspaceId)this.revokeWorkspaceRequestGrants(request.requestId);
        this.recordWorkspaceMovement('workspace',workspace.workspaceId,workspace.projectId,input.projectId,'사용자가 프로젝트 소속을 변경함');
      }workspace.projectId=input.projectId;workspace.version++;workspace.updatedAt=now();await this.save();return copy(workspace);});}
    private owningReport(reportId:string){for(const task of this.state.tasks)for(const revision of task.revisions)for(const target of revision.targets)for(const attempt of target.attempts)if(attempt.reportId===reportId)return{task,revision,target,attempt};return undefined;}
    private followupExecutionBase(request: WorkspaceRequest | undefined) {
        if (request?.kind !== 'followup' || !request.executionBaseRequestId) return {};
        const previous = this.workspaceState.requests.find(candidate => candidate.requestId === request.executionBaseRequestId);
        if (!previous || previous.options.evaluator === 'rules-only') return {};
        const baseAttempt = this.findTask(previous.taskId).revisions.find(item => item.revisionId === previous.revisionId)
            ?.targets.find(item => item.targetId === previous.targetId)?.attempts.at(-1);
        return {previous, baseAttempt};
    }
    private hasLoginOnlyBaseline(request: WorkspaceRequest, baseAttempt?: ReviewAttempt) {
        return request.kind === 'followup' && Boolean(baseAttempt?.shouldReviewLoginPage ||
            (request.parentReportId && this.owningReport(request.parentReportId)?.attempt.shouldReviewLoginPage));
    }
    private async readVerifiedDismissalReport(request:WorkspaceRequest, source:FollowupSource, targetUrl:string, baseRequestId?:string) {
        if(source.targetUrl!==targetUrl||!this.workspaceState.memberships.some(m=>m.reportId===source.reportId&&m.workspaceId===request.workspaceId))return;
        const owner=this.owningReport(source.reportId);
        if(!owner||owner.target.kind!=='url'||owner.target.url!==targetUrl||owner.attempt.status!=='completed'||owner.attempt.runId!==source.runId||
           (baseRequestId&&owner.revision.workspaceRequestId!==baseRequestId)||
           basename(owner.attempt.attemptId)!==owner.attempt.attemptId||basename(source.runId)!==source.runId)return;
        try{
            const root=await realpath(this.runsRoot);
            const relativePath=relative(this.runsRoot,resolve(this.outputRoot(owner.attempt),source.runId,'report.json'));
            const expectedPath=resolve(root,relativePath),file=await realpath(expectedPath);
            if(file!==expectedPath||!file.startsWith(root+sep)||hash(relativePath)!==source.reportId)return;
            const bytes=await readFile(file);
            if(hash(bytes)!==source.reportSha256||
               !this.workspaceState.memberships.some(m=>m.reportId===source.reportId&&m.workspaceId===request.workspaceId))return;
            const report=JSON.parse(bytes.toString('utf8')) as {runId:unknown;followup?:FollowupResult};
            if(report.runId!==source.runId)return;
            return report;
        }catch{return undefined;}
    }
    private async verifiedReplayDismissals(request:WorkspaceRequest, base:FollowupExecutionBase,
        previous:WorkspaceRequest|undefined, replay:FollowupReplayStep[], targetUrl:string) {
        if(!replay.some(step=>step.dismissMethod))return {evidence:[],conflictingIndices:[]};
        const source=request.source;
        const [parent,execution]=await Promise.all([
            source&&source.reportId===request.parentReportId?this.readVerifiedDismissalReport(request,source,targetUrl):undefined,
            previous?.workspaceId===request.workspaceId?this.readVerifiedDismissalReport(request,base,targetUrl,previous.requestId):undefined,
        ]);
        const baseMatches=execution?.followup&&previous?.result&&Array.isArray(previous.result.history)&&execution.followup.requestId===previous.requestId&&
            execution.followup.workspaceId===previous.result.workspaceId&&
            isDeepStrictEqual(execution.followup.history,JSON.parse(JSON.stringify(previous.result.history)))&&
            isDeepStrictEqual(execution.followup.replay,JSON.parse(JSON.stringify(replay)));
        const proved=[...deriveReplayDismissalEvidence(parent,replay),...(baseMatches?deriveReplayDismissalEvidence(execution,replay):[])];
        const results=new Map<number,ReplayDismissalEvidence>(),conflicts=new Set<number>();
        for(const evidence of proved){
            const known=results.get(evidence.replayIndex);
            if(known&&known.modalFingerprint!==evidence.modalFingerprint)conflicts.add(evidence.replayIndex);
            results.set(evidence.replayIndex,evidence);
        }
        return {evidence:[...results.values()].filter(evidence=>!conflicts.has(evidence.replayIndex)),conflictingIndices:[...conflicts]};
    }
    private recordWorkspaceMovement(entityType:'workspace'|'request'|'report',entityId:string,fromId:string|undefined,toId:string,reason:string,reportIds?:string[]){(this.workspaceState.movements??=[]).push({movementId:randomUUID(),entityType,entityId,fromId,toId,reason,createdAt:now(),...(reportIds?{reportIds}:{})});}
    private moveRequestRecords(request:WorkspaceRequest,toId:string){const from=this.requireWorkspace(request.workspaceId),to=this.requireWorkspace(toId);if(from.workspaceId===to.workspaceId)return;const target=this.findTask(request.taskId).revisions.find(r=>r.revisionId===request.revisionId)!.targets.find(t=>t.targetId===request.targetId)!;if(target.attempts.some(a=>a.status==='running'||a.status==='queued'))throw new ReviewServiceError(409,'실행 중인 요청은 종료한 뒤 이동하세요.');this.recordWorkspaceMovement('request',request.requestId,from.workspaceId,toId,'사용자가 요청 소속을 변경함',target.attempts.flatMap(a=>a.reportId?[a.reportId]:[]));this.revokeMovedRequestGrants(request.requestId);request.workspaceId=toId;request.classification={fromWorkspaceId:from.workspaceId,reason:'사용자가 소속을 변경함'};for(const attempt of target.attempts)if(attempt.reportId){this.revokeWorkspaceGrantsForReport(attempt.reportId);const membership=this.workspaceState.memberships.find(m=>m.reportId===attempt.reportId);if(membership)Object.assign(membership,{workspaceId:toId,source:'user',reason:'사용자가 요청 소속을 변경함'});else this.workspaceState.memberships.push({reportId:attempt.reportId,workspaceId:toId,source:'user',reason:'사용자가 요청 소속을 변경함'});to.latestReportId=attempt.reportId;}from.latestReportId=this.workspaceState.memberships.filter(m=>m.workspaceId===from.workspaceId).at(-1)?.reportId;from.version++;to.version++;from.updatedAt=to.updatedAt=now();}
    private synchronizeWorkspaceResult(request:WorkspaceRequest,attempt:ReviewAttempt){let workspace=this.requireWorkspace(request.workspaceId);request.phase=attempt.status;request.reason=attempt.error;if(attempt.reportId){const membership=this.workspaceState.memberships.find(m=>m.reportId===attempt.reportId);if(!membership)this.workspaceState.memberships.push({reportId:attempt.reportId,workspaceId:workspace.workspaceId,source:'execution',reason:'작업공간 검토 실행'});workspace.latestReportId=attempt.reportId;}
      const suggestion=request.result?.scopeSuggestion;if(suggestion?.kind==='new-workspace'&&!request.classification&&attempt.reportId){const destination=createWorkspace(this.workspaceState,workspace.projectId,suggestion.name,suggestion.goal);this.recordWorkspaceMovement('request',request.requestId,workspace.workspaceId,destination.workspaceId,suggestion.reason,[attempt.reportId]);request.classification={fromWorkspaceId:workspace.workspaceId,reason:suggestion.reason};this.revokeMovedRequestGrants(request.requestId);request.workspaceId=destination.workspaceId;const membership=this.workspaceState.memberships.find(m=>m.reportId===attempt.reportId)!;membership.workspaceId=destination.workspaceId;membership.reason=suggestion.reason;destination.latestReportId=attempt.reportId;workspace.latestReportId=this.workspaceState.memberships.filter(m=>m.workspaceId===workspace.workspaceId).at(-1)?.reportId;workspace.updatedAt=now();workspace=destination;}workspace.updatedAt=now();}
    async attachWorkspaceReport(id:string,raw:unknown,validate:(reportId:string)=>Promise<unknown>){const input=z.object({reportId:z.string().regex(/^[a-f0-9]{64}$/),expectedVersion:z.number().int().min(1)}).strict().parse(raw);await validate(input.reportId);return this.serial(async()=>{this.assertStarted();if(this.trashedReportIds().has(input.reportId))throw new ReviewServiceError(404,'보고서를 찾을 수 없습니다.');const workspace=this.requireWorkspace(id);if(workspace.version!==input.expectedVersion)throw new ReviewServiceError(409,'소속 정보가 변경되었습니다. 새로고침하세요.');const owner=this.owningReport(input.reportId),request=owner?.revision.workspaceRequestId?this.requireRequest(owner.revision.workspaceRequestId):undefined;if(request){this.moveRequestRecords(request,id);await this.save();return copy(workspace);}let membership=this.workspaceState.memberships.find(m=>m.reportId===input.reportId);if(membership){const from=this.requireWorkspace(membership.workspaceId);if(from.workspaceId!==id){this.revokeWorkspaceGrantsForReport(input.reportId);this.recordWorkspaceMovement('report',input.reportId,from.workspaceId,id,'사용자가 보고서 소속을 변경함');}Object.assign(membership,{workspaceId:id,source:'user',reason:'사용자가 소속을 변경함'});if(from.workspaceId!==id){from.latestReportId=this.workspaceState.memberships.filter(m=>m.workspaceId===from.workspaceId).at(-1)?.reportId;from.version++;from.updatedAt=now();}}else{this.recordWorkspaceMovement('report',input.reportId,undefined,id,'사용자가 기존 보고서를 연결함');this.workspaceState.memberships.push({reportId:input.reportId,workspaceId:id,source:'user',reason:'사용자가 기존 보고서를 연결함'});}workspace.latestReportId=input.reportId;workspace.version++;workspace.updatedAt=now();await this.save();return copy(workspace);});}
    async moveWorkspaceRequest(id:string,raw:unknown){const input=z.object({workspaceId:reviewIdSchema,expectedVersion:z.number().int().min(1)}).strict().parse(raw);return this.serial(async()=>{this.assertStarted();const request=this.requireRequest(id),from=this.requireWorkspace(request.workspaceId);if(from.version!==input.expectedVersion)throw new ReviewServiceError(409,'소속 정보가 변경되었습니다. 새로고침하세요.');this.moveRequestRecords(request,input.workspaceId);await this.save();return copy(request);});}
    private duplicateWorkspaceRequest(submissionId:string,fingerprint:string){const prior=this.workspaceState.submissions[submissionId];if(!prior)return;if(prior.hash!==fingerprint)throw new ReviewServiceError(409,'같은 제출 ID에 다른 후속 입력을 보낼 수 없습니다.');return this.requireRequest(prior.requestId);}
    async submitWorkspaceInitial(id: string, raw: unknown) {
        const input = workspaceInitialSchema.parse(raw);
        await this.chain;
        const requestFingerprint = hash(JSON.stringify({workspaceId:id,kind:'initial',input}));
        const duplicate = this.duplicateWorkspaceRequest(input.submissionId, requestFingerprint);
        const workspace = this.requireWorkspace(id);
        if (duplicate) return {workspace:copy(workspace),request:copy(duplicate)};
        const project = this.workspaceState.projects.find(p=>p.projectId===workspace.projectId)!;
        // Omitted target names use the workspace title without splitting a Unicode surrogate pair.
        const name = input.target.name ?? workspace.name.slice(0, REVIEW_TARGET_NAME_MAX_LENGTH).replace(/[\uD800-\uDBFF]$/, '');
        const result = await this.submit({
            submissionId:'workspace:'+input.submissionId,title:workspace.name,purpose:workspace.goal,project:project.name,
            targets:[{...input.target,name}],options:input.options,
        },undefined,{workspaceId:id,kind:'initial',submissionId:input.submissionId,instruction:workspace.goal,requestFingerprint});
        return {workspace:copy(this.requireWorkspace(id)),request:copy(this.workspaceState.requests.find(r=>r.revisionId===result.revision.revisionId)!)};
    }
    async submitWorkspaceFollowup(id:string,raw:unknown,loadSource:(reportId:string,imageId?:string)=>Promise<WorkspaceSource&{imageBytes?:Buffer}>){const input=workspaceFollowupSchema.parse(raw);await this.chain;const requestFingerprint=hash(JSON.stringify({workspaceId:id,kind:'followup',input})),duplicate=this.duplicateWorkspaceRequest(input.submissionId,requestFingerprint);if(duplicate)return{workspace:copy(this.requireWorkspace(id)),request:copy(duplicate)};const workspace=this.requireWorkspace(id),membership=this.workspaceState.memberships.find(m=>m.reportId===input.parentReportId);if(membership?.workspaceId!==id)throw new ReviewServiceError(409,'현재 작업공간에 속한 보고서를 기준으로 요청하세요.');const owner=this.owningReport(input.parentReportId);if(!owner)throw new ReviewServiceError(400,'원본 전체 URL을 확인할 수 없습니다. URL로 첫 검토를 접수하세요.');if(owner.target.kind==='url'&&owner.target.comparisonUrl)throw new ReviewServiceError(400,'두 화면을 다시 검사하려면 검토 탭에서 스타일 비교를 시작하세요.');if(input.shouldWaitForStart&&owner.target.kind!=='url')throw new ReviewServiceError(400,'URL 검토에서만 실행 전 로그인 정보를 선택할 수 있습니다.');const {imageBytes,...source}=await loadSource(input.parentReportId,input.imageId);if(owner.target.kind==='url'){source.targetUrl=owner.target.url;source.viewport={...(owner.target.viewport??{width:1440,height:900}),deviceScaleFactor:1};}if(input.sourceSha256&&source.image?.sha256!==input.sourceSha256)throw new ReviewServiceError(409,'원본 캡처가 변경되었습니다.');if(input.region){if(source.image?.sha256!==input.sourceSha256)throw new ReviewServiceError(409,'원본 캡처가 변경되었습니다.');validateFocusRegion(input.region,source.image!);}
      const result=await this.submit({submissionId:'workspace:'+input.submissionId,title:owner.task.title,purpose:input.instruction,project:owner.task.project,externalLinks:owner.task.externalLinks,targets:[owner.target.kind==='url'?{kind:'url',name:owner.target.name,url:owner.target.url,viewport:owner.target.viewport,themeReview:owner.target.themeReview,alignmentContracts:owner.target.alignmentContracts,targetId:owner.target.targetId,shouldWaitForStart:input.shouldWaitForStart}:{kind:'image',name:owner.target.name,assetId:owner.target.assetId,targetId:owner.target.targetId}],options:input.options},owner.task.taskId,{workspaceId:id,kind:'followup',submissionId:input.submissionId,instruction:input.instruction,parentReportId:input.parentReportId,source,sourceImageBytes:imageBytes,region:input.region,scopeMode:input.scopeMode,maxOptions:input.maxOptions,requestFingerprint});return{workspace:copy(this.requireWorkspace(id)),request:copy(this.workspaceState.requests.find(r=>r.revisionId===result.revision.revisionId)!)};
    }
    async submitWorkspaceImage(id:string,raw:unknown){const input=z.object({submissionId:z.string().trim().min(1).max(200),assetId:reviewIdSchema,comment:z.string().trim().min(1).max(4000)}).strict().parse(raw);await this.chain;const previous=this.requireRequest(id),workspace=this.requireWorkspace(previous.workspaceId);const requestFingerprint=hash(JSON.stringify({workspaceId:workspace.workspaceId,kind:'image-handoff',parentRequestId:id,input})),duplicate=this.duplicateWorkspaceRequest(input.submissionId,requestFingerprint);if(duplicate)return{request:copy(duplicate)};const result=await this.submit({submissionId:'workspace:'+input.submissionId,title:this.findTask(previous.taskId).title,purpose:input.comment,targets:[{kind:'image',name:workspace.name,assetId:input.assetId}],options:{}},previous.taskId,{workspaceId:workspace.workspaceId,kind:'image-handoff',submissionId:input.submissionId,instruction:input.comment,parentReportId:previous.parentReportId,parentRequestId:id,source:previous.source,requestFingerprint});return{request:copy(this.workspaceState.requests.find(r=>r.revisionId===result.revision.revisionId)!)};}
    async retryWorkspaceRequest(id:string,raw:unknown){const input=z.object({submissionId:z.string().min(1).max(200),attemptId:reviewIdSchema}).strict().parse(raw);const request=this.requireRequest(id);await this.retry(request.taskId,request.revisionId,request.targetId,'workspace:'+input.submissionId,input.attemptId);return copy((await this.workspace(request.workspaceId)).requests.find(r=>r.requestId===id)!);}
    async startWorkspaceRequest(id: string, raw: unknown) {
        await this.chain;
        const { taskId, revisionId, targetId } = this.requireRequest(id);
        const { revision } = await this.startReviewTarget(taskId, revisionId, targetId, raw);
        return revision.targets.find(target => target.targetId === targetId)!.attempts.at(-1)!;
    }
    async cancelWorkspaceRequest(id: string, raw: unknown) {
        const input = z.object({ attemptId: reviewIdSchema }).strict().parse(raw);
        const result = await this.serial(async () => {
            this.assertStarted();
            const request = this.requireRequest(id), task = this.findTask(request.taskId);
            const target = task.revisions.find(item => item.revisionId === request.revisionId)!.targets.find(item => item.targetId === request.targetId)!;
            const attempt = target.attempts.at(-1)!;
            if (attempt.attemptId !== input.attemptId) throw new ReviewServiceError(409, '오래된 실행 시도입니다.');
            if (attempt.status === 'cancelled') return copy(attempt);
            if (!['awaiting-start', 'queued', 'running'].includes(attempt.status)) throw new ReviewServiceError(409, '이미 종료된 요청입니다.');
            Object.assign(attempt, { status: 'cancelled', endedAt: now(), error: '사용자가 검증을 취소했습니다.' });
            request.attempts = target.attempts;
            this.synchronizeWorkspaceResult(request, attempt);
            await this.save();
            this.forgetCredentials(attempt.attemptId);
            this.runningControllers.get(attempt.attemptId)?.abort();
            return copy(attempt);
        });
        this.kick();
        return result;
    }


    private findTask(id: string) {
        if (!reviewIdSchema.safeParse(id).success)
            throw new ReviewServiceError(400, '잘못된 작업 ID입니다.');
        const task = this.state.tasks.find(t => t.taskId === id);
        if (!task)
            throw new ReviewServiceError(404, '작업을 찾을 수 없습니다.');
        return task;
    }
    async upload(input: {
        fileName: string;
        base64: string;
    }) {
        this.assertStarted();
        if (typeof input.fileName !== 'string' || !input.fileName.trim() || input.fileName.length > 200 || typeof input.base64 !== 'string' || input.base64.length > 7 * 1024 * 1024 || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(input.base64))
            throw new ReviewServiceError(400, '파일 이름과 base64 이미지가 필요합니다.');
        const bytes = Buffer.from(input.base64, 'base64');
        if (!bytes.length || bytes.length > 5 * 1024 * 1024)
            throw new ReviewServiceError(413, '이미지는 최대 5 MiB입니다.');
        let meta: Metadata;
        try {
            meta = await sharp(bytes, { limitInputPixels: 20000000, animated: false }).metadata();
            if (!['png', 'jpeg', 'webp'].includes(meta.format ?? '') || !meta.width || !meta.height || meta.width * meta.height > 20000000 || (meta.pages ?? 1) > 1)
                throw new Error();
            await sharp(bytes, { limitInputPixels: 20000000 }).stats();
        }
        catch {
            throw new ReviewServiceError(415, '단일 PNG/JPEG/WebP 이미지만 지원합니다 (최대 20 MP).');
        }
        return this.serial(async () => { this.assertStarted(); const asset: ReviewAsset = { assetId: randomUUID(), fileName: basename(input.fileName).replace(/[\x00-\x1f]/g, '_'), mimeType: 'image/' + meta.format, width: meta.width!, height: meta.height!, sha256: hash(bytes) }; await mkdir(resolve(this.stateRoot, 'assets'), { recursive: true, mode: 0o700 }); await writeFile(resolve(this.stateRoot, 'assets', asset.assetId), bytes, { mode: 0o600, flag: 'wx' }); this.state.assets.push(asset); await this.save(); return copy(asset); });
    }
    async submit(raw: unknown, taskId?: string, workspaceInput?: {workspaceId:string;kind:WorkspaceRequest['kind'];submissionId:string;instruction:string;source?:WorkspaceSource;region?:WorkspaceRequest['region'];scopeMode?:WorkspaceRequest['scopeMode'];maxOptions?:number;parentReportId?:string;parentRequestId?:string;sourceImageBytes?:Buffer;requestFingerprint?:string}) {
        this.assertStarted();
        const parsed = reviewSubmissionSchema.safeParse(raw);
        if (!parsed.success)
            throw new ReviewServiceError(400, parsed.error.issues.map(x => x.message).join('; '));
        const input = parsed.data;
        const result = await this.serial(async () => {
            this.assertStarted();
            if (workspaceInput) {
                this.requireWorkspace(workspaceInput.workspaceId);
                if (workspaceInput.parentRequestId && this.requireRequest(workspaceInput.parentRequestId).workspaceId !== workspaceInput.workspaceId)
                    throw new ReviewServiceError(409, '이전 요청의 소속이 변경되었습니다. 새로고침하세요.');
            }
            const previousTask = taskId ? this.findTask(taskId) : undefined;
            const visiblePrevious = previousTask ? this.requireVisibleTask(previousTask) : undefined;
            const key = 'submit:' + input.submissionId;
            const hashRequest = (request: ReviewSubmission) => hash(JSON.stringify({ taskId: taskId ?? null, input: request,...(workspaceInput?{workspaceInput}: {}) }));
            const fingerprint = 'request-v2:' + hashRequest(input);
            const prior = this.state.submissions[key];
            if (prior) {
                // Earlier versions hashed the parsed default timeout even when it was absent in the request.
                const { timeoutSeconds = 180, reviewPipeline, ...rest } = input.options;
                const previousOptions = { ...rest, timeoutSeconds, reviewPipeline };
                const { evaluator = 'codex', ...legacyOptions } = previousOptions;
                const previousFingerprint = 'request:' + hashRequest({ ...input, options: previousOptions });
                const legacyFingerprint = hashRequest({ ...input, options: { evaluator, ...legacyOptions } });
                if (![fingerprint, previousFingerprint, legacyFingerprint].includes(prior.hash))
                    throw new ReviewServiceError(409, '같은 제출 ID에 다른 입력을 보낼 수 없습니다.');
                const task = this.requireVisibleTask(this.findTask(prior.taskId));
                const revision = task.revisions.find(r => r.revisionId === prior.revisionId);
                if (!revision) throw new ReviewServiceError(404, '검토를 찾을 수 없습니다.');
                return { task: copy(task), revision: copy(revision) };
            }
            for (const target of input.targets)
                if (target.kind === 'image') {
                    const asset = this.state.assets.find(a => a.assetId === target.assetId);
                    if (!asset)
                        throw new ReviewServiceError(400, '업로드한 이미지가 없습니다.');
                    const bytes = await readFile(resolve(this.stateRoot, 'assets', asset.assetId));
                    if (hash(bytes) !== asset.sha256)
                        throw new ReviewServiceError(409, '저장된 이미지 해시가 달라졌습니다.');
                }
            const timestamp = now(), task = previousTask ?? { taskId: randomUUID(), title: input.title, purpose: input.purpose, project: input.project, externalLinks: input.externalLinks, createdAt: timestamp, updatedAt: timestamp, revisions: [] } satisfies ReviewTask;
            if (visiblePrevious) {
                const known = new Set(visiblePrevious.revisions.flatMap(r => r.targets.map(t => t.targetId)));
                if (input.targets.some(t => t.targetId && !known.has(t.targetId)))
                    throw new ReviewServiceError(400, '이 작업에 속하지 않는 대상 ID입니다.');
            }
            else if (input.targets.some(t => t.targetId))
                throw new ReviewServiceError(400, '새 작업의 대상 ID는 서비스에서 생성합니다.');
            const firstTarget = input.targets[0];
            const isStyleComparison = firstTarget.kind === 'url' && Boolean(firstTarget.comparisonUrl);
            if (visiblePrevious?.revisions.at(-1)?.options.evaluator === 'rules-only' && !isStyleComparison)
                throw new ReviewServiceError(400, '스타일 비교를 다시 실행하려면 기준과 비교 화면 URL을 함께 지정하세요.');
            const options: ReviewRevision['options'] = isStyleComparison
                ? { evaluator: 'rules-only', reviewPipeline: 'standard', timeoutSeconds: input.options.timeoutSeconds ?? DEFAULT_REVIEW_TIMEOUT_SECONDS }
                : this.resolveRevisionOptions(input.options);
            const revision: ReviewRevision = { revisionId: randomUUID(), number: (task.revisions.at(-1)?.number ?? 0) + 1, submittedAt: timestamp, title: input.title, purpose: input.purpose, project: input.project, externalLinks: input.externalLinks, options, targets: input.targets.map(t => ({ ...t, targetId: t.targetId ?? randomUUID(), attempts: [this.newAttempt(t.kind === 'url' && t.shouldWaitForStart ? 'awaiting-start' : 'queued')] })) };
            if (options.evaluator !== 'rules-only') this.rememberConnection(revision.revisionId, options.evaluator);
            if (workspaceInput) {
                const workspace = this.requireWorkspace(workspaceInput.workspaceId);
                if (workspaceInput.kind === 'followup' && this.workspaceState.memberships.find(m=>m.reportId===workspaceInput.parentReportId)?.workspaceId !== workspace.workspaceId)
                    throw new ReviewServiceError(409,'부모 보고서 소속이 변경되었습니다. 새로고침하세요.');
                const priorTail = this.workspaceState.requests.findLast(request => request.workspaceId === workspace.workspaceId);
                // A comparison still takes its place in the queue, but its two captures cannot become a live replay base.
                const replayBase = workspaceInput.kind === 'followup' && priorTail?.options.evaluator === 'rules-only'
                    ? this.workspaceState.requests.findLast(request => request.workspaceId === workspace.workspaceId &&
                        request.options.evaluator !== 'rules-only' && (firstTarget.kind !== 'url' || request.targetUrl === firstTarget.url))
                    : priorTail;
                const request: WorkspaceRequest = {
                    requestId: randomUUID(), workspaceId: workspace.workspaceId, kind: workspaceInput.kind,
                    submissionId: workspaceInput.submissionId, parentReportId: workspaceInput.parentReportId,
                    parentRequestId: workspaceInput.parentRequestId, instruction: workspaceInput.instruction,
                    targetUrl: firstTarget.kind === 'url' ? firstTarget.url : undefined,
                    ...(firstTarget.kind === 'url' && firstTarget.comparisonUrl ? { comparisonUrl: firstTarget.comparisonUrl } : {}),
                    source: workspaceInput.source, region: workspaceInput.region, scopeMode: workspaceInput.scopeMode,
                    maxOptions: workspaceInput.maxOptions ?? 1, executionBaseRequestId: replayBase?.requestId,
                    ...(priorTail && priorTail !== replayBase ? { queuePredecessorRequestId: priorTail.requestId } : {}),
                    createdAt: timestamp, options: copy(revision.options), taskId: task.taskId,
                    revisionId: revision.revisionId, targetId: revision.targets[0].targetId, attempts: revision.targets[0].attempts,
                };
                if (workspaceInput.sourceImageBytes) {
                    if (hash(workspaceInput.sourceImageBytes) !== request.source?.image?.sha256)
                        throw new ReviewServiceError(409,'원본 이미지 해시가 다릅니다.');
                    const folder = resolve(this.stateRoot,'followup-sources');
                    await mkdir(folder,{recursive:true,mode:0o700});
                    const path = resolve(folder,request.requestId+'.png');
                    await writeFile(path,workspaceInput.sourceImageBytes,{mode:0o600,flag:'wx'});
                    (this.workspaceState.sourceImages ??= {})[request.requestId] = path;
                }
                revision.workspaceRequestId = request.requestId;
                this.workspaceState.requests.push(request);
                const target=revision.targets[0],project=this.workspaceState.projects.find(p=>p.projectId===workspace.projectId);
                if (target.kind === 'url' && !target.comparisonUrl && request.kind !== 'image-handoff' && project) {
                    const url = new URL(target.url);
                    if (url.protocol === 'https:' && project.postAllowedHosts.length) {
                        (this.workspaceState.postGrants ??= {})[request.requestId] = {
                            workspaceId: workspace.workspaceId, projectId: project.projectId, hosts: [...project.postAllowedHosts],
                        };
                    }
                    const binding = project.supabaseAuthBindings.find(item => item.targetOrigin === url.origin);
                    if (binding) {
                        (this.workspaceState.supabaseAuthGrants ??= {})[request.requestId] = {
                            ...binding, workspaceId: workspace.workspaceId, projectId: project.projectId,
                        };
                    }
                }
                if(workspaceInput.requestFingerprint)this.workspaceState.submissions[workspaceInput.submissionId]={hash:workspaceInput.requestFingerprint,requestId:request.requestId};workspace.updatedAt=timestamp;}
            task.revisions.push(revision);
            if(!workspaceInput||!taskId)Object.assign(task, { title: input.title, purpose: input.purpose, project: input.project, externalLinks: input.externalLinks, updatedAt: timestamp });
            else task.updatedAt=timestamp;
            if (!taskId)
                this.state.tasks.unshift(task);
            this.state.submissions[key] = { hash: fingerprint, taskId: task.taskId, revisionId: revision.revisionId };
            await this.save();
            return { task: copy(this.requireVisibleTask(task)), revision: copy(revision) };
        });
        this.kick();
        return result;
    }
    private newAttempt(status: 'queued' | 'awaiting-start' = 'queued'): ReviewAttempt {
        return { attemptId: randomUUID(), status, createdAt: now() };
    }
    private requireNewCredentials(target: ReviewTarget, attempt: ReviewAttempt, message: string): ReviewAttempt {
        Object.assign(attempt, { status: 'failed', endedAt: now(), error: message });
        const nextAttempt = {
            ...this.newAttempt('awaiting-start'), error: message,
            ...(attempt.loginRedirect ? { loginRedirect: attempt.loginRedirect } : {}),
        };
        target.attempts.push(nextAttempt);
        return nextAttempt;
    }
    private reopenCredentialAttempt(revision: ReviewRevision, target: ReviewTarget, attempt: ReviewAttempt, message: string) {
        const waiting = this.requireNewCredentials(target, attempt, message);
        if (revision.workspaceRequestId) {
            const request = this.requireRequest(revision.workspaceRequestId);
            request.attempts = target.attempts;
            this.synchronizeWorkspaceResult(request, waiting);
        }
    }
    private forgetCredentials(attemptId: string) {
        const pending = this.pendingCredentials.get(attemptId);
        if (pending) clearTimeout(pending.timer);
        this.pendingCredentials.delete(attemptId);
    }
    private retainCredentials(taskId: string, revisionId: string, targetId: string, attemptId: string, credentials: ReviewCredentials) {
        const expiresAt = Date.now() + credentialQueueLifetimeMs;
        const timer = setTimeout(() => {
            this.forgetCredentials(attemptId);
            void this.serial(async () => {
                if (!this.isReady) return;
                const task = this.findTask(taskId);
                const revision = task.revisions.find(item => item.revisionId === revisionId);
                const target = revision?.targets.find(item => item.targetId === targetId);
                const attempt = target?.attempts.at(-1);
                if (!revision || !target || attempt?.attemptId !== attemptId || attempt.status !== 'queued') return;
                this.reopenCredentialAttempt(revision, target, attempt, expiredCredentialMessage);
                task.updatedAt = now();
                await this.save();
            }).then(() => this.kick()).catch(() => {});
        }, credentialQueueLifetimeMs);
        timer.unref();
        this.pendingCredentials.set(attemptId, { credentials, expiresAt, timer });
    }
    async startReviewTarget(taskId: string, revisionId: string, targetId: string, raw: unknown) {
        const parsed = reviewStartSchema.safeParse(raw);
        if (!parsed.success)
            throw new ReviewServiceError(400, '실행 시도와 로그인 정보를 확인하세요.');
        const { attemptId, credentials } = parsed.data;
        const result = await this.serial(async () => {
            this.assertStarted();
            const task = this.findTask(taskId);
            const revision = task.revisions.find(item => item.revisionId === revisionId);
            const target = revision?.targets.find(item => item.targetId === targetId);
            const attempt = target?.attempts.at(-1);
            if (!revision || !target || !attempt || this.trashedAttemptIds().has(attempt.attemptId))
                throw new ReviewServiceError(404, '검토 대상을 찾을 수 없습니다.');
            if (attempt.attemptId !== attemptId || target.kind !== 'url' || attempt.status !== 'awaiting-start')
                throw new ReviewServiceError(409, '이미 시작했거나 변경된 검토입니다. 새로고침하세요.');
            if (credentials && !canUseReviewCredentials(target.url))
                throw new ReviewServiceError(400, 'HTTPS 또는 이 기기의 로컬 URL에 로그인 정보를 사용할 수 있습니다.');
            if (credentials && attempt.loginRedirect && !attempt.loginRedirect.methods.includes(credentials.method))
                throw new ReviewServiceError(400, '확인된 로그인 화면에서 사용할 수 있는 입력 방식을 선택하세요.');
            const request = revision.workspaceRequestId ? this.requireRequest(revision.workspaceRequestId) : undefined;
            if (request && hasRestrictedFollowupScope(request) && (credentials
                ? this.hasLoginOnlyBaseline(request, this.followupExecutionBase(request).baseAttempt)
                : attempt.loginRedirect)) throw new ReviewServiceError(409, changedReviewScopeMessage);
            const supabaseGrant = credentials?.method === 'password' && revision.workspaceRequestId &&
                this.workspaceState.supabaseAuthGrants?.[revision.workspaceRequestId];
            if (supabaseGrant && supabaseGrant.isRevoked) throw new ReviewServiceError(409, revokedSupabaseAuthMessage);

            attempt.status = 'queued';
            attempt.credentialMethod = credentials?.method;
            if (attempt.loginRedirect && !credentials) attempt.shouldReviewLoginPage = true;
            delete attempt.error;
            task.updatedAt = now();
            if (request) {
                request.attempts = target.attempts;
                request.phase = attempt.status;
                delete request.reason;
            }
            await this.save();
            if (credentials) this.retainCredentials(taskId, revisionId, targetId, attemptId, credentials);
            return { task: copy(this.requireVisibleTask(task)), revision: copy(revision) };
        });
        this.kick();
        return result;
    }
    async retry(taskId: string, revisionId: string, targetId: string, submissionId: string, attemptId: string) {
        this.assertStarted();
        if (typeof submissionId !== 'string' || !submissionId.trim() || submissionId.length > 200)
            throw new ReviewServiceError(400, '제출 ID가 필요합니다.');
        const result = await this.serial(async () => {
            const task = this.findTask(taskId), revision = task.revisions.find(r => r.revisionId === revisionId), target = revision?.targets.find(t => t.targetId === targetId);
            if (!revision || !target || this.trashedAttemptIds().has(target.attempts.at(-1)!.attemptId))
                throw new ReviewServiceError(404, '검토 대상을 찾을 수 없습니다.');
            const key = 'retry:' + submissionId, fingerprint = hash(JSON.stringify({ taskId, revisionId, targetId, attemptId })), prior = this.state.submissions[key];
            if (prior) {
                if (prior.hash !== fingerprint)
                    throw new ReviewServiceError(409, '같은 제출 ID에 다른 입력을 보낼 수 없습니다.');
                const visible = this.requireVisibleTask(task);
                return { task: copy(visible), revision: copy(visible.revisions.find(rev => rev.revisionId === revisionId)!) };
            }
            if (target.attempts.at(-1)?.attemptId !== attemptId)
                throw new ReviewServiceError(409, '오래된 실행 시도입니다. 작업을 새로고침하세요.');
            if (!await this.canRetryAttempt(target.attempts.at(-1)!))
                throw new ReviewServiceError(409, '실행 또는 AI 평가가 실패한 최신 대상만 재시도할 수 있습니다.');
            const previous = target.attempts.at(-1)!;
            const shouldWaitForStart = target.kind === 'url' && Boolean(target.shouldWaitForStart || previous.credentialMethod);
            target.attempts.push({
                ...this.newAttempt(shouldWaitForStart ? 'awaiting-start' : 'queued'),
                ...(previous.loginRedirect ? { loginRedirect: previous.loginRedirect } : {}),
                ...(!shouldWaitForStart && previous.shouldReviewLoginPage ? { shouldReviewLoginPage: true } : {}),
            });
            if (revision.workspaceRequestId) {
                const request = this.requireRequest(revision.workspaceRequestId);
                delete request.result;
                delete request.needsImageHandoff;
            }
            task.updatedAt = now();
            this.state.submissions[key] = { hash: fingerprint, taskId, revisionId };
            await this.save();
            const visible = this.requireVisibleTask(task);
            return { task: copy(visible), revision: copy(visible.revisions.find(rev => rev.revisionId === revisionId)!) };
        });
        this.kick();
        return result;
    }
    /** Authorize against this attempt's persisted report, never a client-supplied outcome. */
    private async canRetryAttempt(attempt: ReviewAttempt): Promise<boolean> {
        if (attempt.status === 'failed') return true;
        if (attempt.status !== 'completed' || attempt.runStatus !== 'partial' || !attempt.runId || !attempt.reportId) return false;
        try {
            const attemptRoot = await realpath(this.outputRoot(attempt));
            const reportPath = await realpath(resolve(attemptRoot, attempt.runId, 'report.json'));
            const withinAttempt = relative(attemptRoot, reportPath);
            const runsRoot = await realpath(this.runsRoot);
            if (withinAttempt.startsWith('..' + sep) || withinAttempt === '..' || !reportPath.startsWith(runsRoot + sep) || hash(relative(runsRoot, reportPath)) !== attempt.reportId) return false;
            const report = JSON.parse(await readFile(reportPath, 'utf8'));
            return report.runId === attempt.runId && report.status === 'partial' && report.evaluation?.status === 'failed';
        } catch { return false; }
    }
    async focusedList(reportId: string, imageId: string) { await this.chain; if (this.trashedReportIds().has(reportId)) return []; return copy((this.state.focusedReviews ?? []).filter(r => r.source.reportId === reportId && r.source.imageId === imageId)); }
    async focusedGet(id: string) { await this.chain; const review = (this.state.focusedReviews ?? []).find(r => r.focusedReviewId === id); if (!review || this.trashedReportIds().has(review.source.reportId))
        throw new ReviewServiceError(404, '집중 검토를 찾을 수 없습니다.'); return copy(review); }
    async submitFocused(raw: unknown, loadSource: (reportId: string, imageId: string) => Promise<{
        source: FocusSource;
        bytes: Buffer;
    }>) {
        this.assertStarted();
        const parsed = focusedSubmissionSchema.safeParse(raw);
        if (!parsed.success)
            throw new ReviewServiceError(400, parsed.error.issues.map(i => i.message).join('; '));
        const input = parsed.data;
        const result = await this.serial(async () => {
            this.assertStarted();
            if (this.trashedReportIds().has(input.reportId))
                throw new ReviewServiceError(404, '보고서를 찾을 수 없습니다.');
            const fingerprint = 'request:' + hash(JSON.stringify(input)), prior = this.state.focusedSubmissions?.['submit:' + input.submissionId];
            if (prior) {
                const { evaluator = 'codex', ...rest } = input.options;
                const legacyInput = { ...input, options: { evaluator, ...rest } };
                // Before the twenty-minute default, focused requests parsed an omitted timeout as 180.
                const hasExplicitTimeout = (raw as {options?: {timeoutSeconds?: number}}).options?.timeoutSeconds !== undefined;
                const previousInput = { ...input, options: { ...input.options, timeoutSeconds: 180 } };
                const { evaluator: previousEvaluator = 'codex', ...previousOptions } = previousInput.options;
                const acceptedHashes = [fingerprint, hash(JSON.stringify(legacyInput))];
                if (!hasExplicitTimeout) acceptedHashes.push('request:' + hash(JSON.stringify(previousInput)), hash(JSON.stringify({...previousInput,options:{evaluator:previousEvaluator,...previousOptions}})));
                if (!acceptedHashes.includes(prior.hash))
                    throw new ReviewServiceError(409, '같은 제출 ID에 다른 집중 검토 입력을 보낼 수 없습니다.');
                return copy(this.state.focusedReviews!.find(r => r.focusedReviewId === prior.focusedReviewId)!);
            }
            const { source, bytes } = await loadSource(input.reportId, input.imageId);
            const decoded = await validateFocusImage(bytes);
            if (decoded.sha256 !== source.sha256 || decoded.width !== source.width || decoded.height !== source.height || input.sourceSha256 !== source.sha256)
                throw new ReviewServiceError(409, '선택한 캡처가 변경되었습니다. 다시 불러오세요.');
            try {
                validateFocusRegion(input.region, source);
            }
            catch (error) {
                throw new ReviewServiceError(400, (error as Error).message);
            }
            const review: FocusedReview = { focusedReviewId: randomUUID(), createdAt: now(), source: copy(source), region: input.region, comment: input.comment, options: this.resolveOptions(input.options), attempts: [this.newAttempt()] };
            this.rememberConnection(review.focusedReviewId, review.options.evaluator);
            const dir = resolve(this.stateRoot, 'focused', review.focusedReviewId);
            await mkdir(dir, { recursive: true, mode: 0o700 });
            await writeFile(resolve(dir, 'source.png'), bytes, { mode: 0o600, flag: 'wx' });
            (this.state.focusedReviews ??= []).push(review);
            (this.state.focusedSubmissions ??= {})['submit:' + input.submissionId] = { hash: fingerprint, focusedReviewId: review.focusedReviewId };
            await this.save();
            return copy(review);
        });
        this.kick();
        return result;
    }
    async retryFocused(id: string, submissionId: string, attemptId: string) { this.assertStarted(); if (!reviewIdSchema.safeParse(id).success || !reviewIdSchema.safeParse(attemptId).success || typeof submissionId !== 'string' || !submissionId.trim() || submissionId.length > 200)
        throw new ReviewServiceError(400, '올바른 집중 검토 및 최신 시도 ID가 필요합니다.'); const result = await this.serial(async () => { const review = (this.state.focusedReviews ?? []).find(r => r.focusedReviewId === id); if (!review || this.trashedReportIds().has(review.source.reportId))
        throw new ReviewServiceError(404, '집중 검토를 찾을 수 없습니다.'); const key = 'retry:' + submissionId, fingerprint = hash(JSON.stringify({ id, attemptId })), prior = this.state.focusedSubmissions?.[key]; if (prior) {
        if (prior.hash !== fingerprint)
            throw new ReviewServiceError(409, '같은 제출 ID에 다른 재시도를 요청할 수 없습니다.');
        return copy(review);
    } const previous = review.attempts.at(-1)!; if (previous.attemptId !== attemptId || previous.status !== 'failed')
        throw new ReviewServiceError(409, '최신 실패 시도만 재시도할 수 있습니다.'); review.attempts.push(this.newAttempt()); delete review.answer; (this.state.focusedSubmissions ??= {})[key] = { hash: fingerprint, focusedReviewId: id }; await this.save(); return copy(review); }); this.kick(); return result; }
    private async loadFocusedAnswer(review: FocusedReview, attempt: ReviewAttempt) { if (!attempt.runId)
        return; try {
        const report = JSON.parse(await readFile(resolve(this.outputRoot(attempt), attempt.runId, 'report.json'), 'utf8'));
        review.answer = report.focusedReview?.answer;
    }
    catch { } }
    private async runNextFocused(): Promise<boolean> {
        const review = await this.serial(async () => { if (this.isClosing || !this.isStorageHealthy) return undefined; const queued = (this.state.focusedReviews ?? []).find(r => r.attempts.at(-1)?.status === 'queued'); if (!queued)
            return undefined; const attempt = queued.attempts.at(-1)!; const hasEarlierNormal = this.state.tasks.some(t => t.revisions.some(r => r.targets.some(target => { const a = target.attempts.at(-1)!; return a.status === 'queued' && a.createdAt < attempt.createdAt; }))); if (hasEarlierNormal)
            return undefined; attempt.status = 'running'; attempt.startedAt = now(); await this.save(); return copy(queued); });
        if (!review)
            return false;
        const attempt = review.attempts.at(-1)!;
        let result: Partial<ReviewAttempt>;
        try {
            await this.runEvaluation(review.focusedReviewId, review.options.evaluator, () =>
                (this.dependencies.inspectFocused ?? inspectFocused)(review, resolve(this.stateRoot, 'focused', review.focusedReviewId, 'source.png'), this.outputRoot(attempt)));
            const recovered = await this.recoverReport(attempt);
            if (!recovered)
                throw new Error('집중 검토 보고서를 읽을 수 없습니다.');
            result = recovered;
        }
        catch (error) {
            result = await this.recoverReport(attempt) ?? { status: 'failed', endedAt: now(), error: error instanceof Error ? error.message.slice(0, 500) : '집중 검토 실패' };
        }
        await this.serial(async () => { const stored = this.state.focusedReviews!.find(r => r.focusedReviewId === review.focusedReviewId)!; Object.assign(stored.attempts.at(-1)!, result); await this.loadFocusedAnswer(stored, stored.attempts.at(-1)!); await this.save(); });
        return true;
    }
    private outputRoot(attempt: ReviewAttempt) { return resolve(this.runsRoot, 'review-attempts', attempt.attemptId); }
    private async recoverReport(attempt: ReviewAttempt): Promise<Partial<ReviewAttempt> | undefined> {
        try {
            const root = this.outputRoot(attempt);
            for (const item of await readdir(root, { withFileTypes: true })) {
                if (!item.isDirectory() || item.isSymbolicLink())
                    continue;
                const path = resolve(root, item.name, 'report.json');
                try {
                    const report = JSON.parse(await readFile(path, 'utf8'));
                    if (!report.runId || !['completed', 'partial', 'failed', 'cancelled'].includes(report.status))
                        continue;
                    return { status: report.status === 'failed' || report.status === 'cancelled' ? 'failed' : 'completed', runId: report.runId, runStatus: report.status, reportId: hash(relative(await realpath(this.runsRoot), await realpath(path))), endedAt: report.endedAt ?? now(), error: report.status === 'failed' || report.status === 'cancelled' ? String(report.terminationReason ?? '엔진 실행이 완료되지 않았습니다.') : undefined };
                }
                catch { }
            }
        }
        catch { }
        return undefined;
    }
    get executionStatus() {
        const attempts = [
            ...this.state.tasks.flatMap(task => task.revisions.flatMap(revision => revision.targets.map(target => target.attempts.at(-1)!))),
            ...(this.state.focusedReviews ?? []).map(review => review.attempts.at(-1)!),
        ];
        return {
            maxConcurrentReviews: this.maxConcurrentReviews,
            runningCount: attempts.filter(attempt => attempt.status === 'running').length,
            queuedCount: attempts.filter(attempt => attempt.status === 'queued').length,
        };
    }
    private isWorkspaceBusy(requestId?:string){if(!requestId)return false;const request=this.requireRequest(requestId);const predecessorId=request.queuePredecessorRequestId??request.executionBaseRequestId;const predecessor=predecessorId?this.workspaceState.requests.find(r=>r.requestId===predecessorId):undefined;if(predecessor){const attempt=this.findTask(predecessor.taskId).revisions.find(r=>r.revisionId===predecessor.revisionId)?.targets.find(t=>t.targetId===predecessor.targetId)?.attempts.at(-1);if(attempt?.status==='awaiting-start'||attempt?.status==='queued'||attempt?.status==='running')return true;}return this.workspaceState.requests.some(r=>r.workspaceId===request.workspaceId&&r.requestId!==requestId&&this.findTask(r.taskId).revisions.find(v=>v.revisionId===r.revisionId)?.targets.some(t=>t.attempts.some(a=>this.runningControllers.has(a.attemptId))));}
    private hasRunnableQueued(){return (this.state.focusedReviews??[]).some(r=>r.attempts.at(-1)?.status==='queued')||this.state.tasks.some(t=>t.revisions.some(r=>r.targets.some(target=>target.attempts.at(-1)?.status==='queued')&&!this.isWorkspaceBusy(r.workspaceRequestId)));}
    private kick() {
        if (this.isClosing || !this.hasStarted || !this.isStorageHealthy || !this.hasRunnableQueued())
            return;
        while (this.workers.size < this.maxConcurrentReviews) {
            const worker = this.drain().catch(error => {
                this.isStorageHealthy = false;
                console.error('Review worker stopped:', error instanceof Error ? error.message : 'unknown error');
            }).finally(() => {
                this.workers.delete(worker);
                this.kick();
            });
            this.workers.add(worker);
        }
    }
    private async drain() {
        while (!this.isClosing) {
            if (await this.runNextFocused())
                continue;
            const next = await this.serial(async () => {
                if (this.isClosing || !this.isStorageHealthy) return undefined;
                for (const task of [...this.state.tasks].reverse())
                    for (const revision of task.revisions)
                        for (const target of revision.targets) {
                            const attempt = target.attempts.at(-1)!;
                            if (attempt.status === 'queued' && !this.isWorkspaceBusy(revision.workspaceRequestId)) {
                                const pending = this.pendingCredentials.get(attempt.attemptId);
                                const credentials = pending && pending.expiresAt > Date.now() ? pending.credentials : undefined;
                                if (attempt.credentialMethod && !credentials) {
                                    this.forgetCredentials(attempt.attemptId);
                                    this.reopenCredentialAttempt(revision, target, attempt, expiredCredentialMessage);
                                    task.updatedAt = now();
                                    await this.save();
                                    continue;
                                }
                                if (credentials?.method === 'password' && revision.workspaceRequestId &&
                                    this.workspaceState.supabaseAuthGrants?.[revision.workspaceRequestId]?.isRevoked) {
                                    this.forgetCredentials(attempt.attemptId);
                                    this.reopenCredentialAttempt(revision, target, attempt, revokedSupabaseAuthMessage);
                                    task.updatedAt = now();
                                    await this.save();
                                    continue;
                                }
                                attempt.status = 'running';
                                if(revision.workspaceRequestId || credentials)this.runningControllers.set(attempt.attemptId,new AbortController());
                                attempt.startedAt = now();
                                await this.save();
                                this.forgetCredentials(attempt.attemptId);
                                return { taskId: task.taskId, revision: copy(revision), target: copy(target), attempt: copy(attempt), credentials };
                            }
                        }
                return undefined;
            });
            if (!next)
                return;
            const shouldDetectRedirectedLogin = next.target.kind === 'url' && !next.target.comparisonUrl && !next.target.shouldWaitForStart &&
                !next.attempt.shouldReviewLoginPage && !next.credentials;
            let result: Partial<ReviewAttempt>;
            let authFailure: string | undefined;
            let loginRedirect: ReviewLoginRedirect | undefined;
            let followupResult:FollowupResult|undefined;let needsImageHandoff=false;
            try {
                const { target, revision, attempt } = next;
                const request=revision.workspaceRequestId?this.requireRequest(revision.workspaceRequestId):undefined;
                let imagePath: string | undefined=target.kind==='image'?this.workspaceState.sourceImages?.[request?.requestId??'']:undefined;
                if (!imagePath&&target.kind === 'image') {
                    const asset = this.state.assets.find(a => a.assetId === target.assetId)!;
                    imagePath = resolve(this.stateRoot, 'assets', target.assetId);
                    if (!asset || hash(await readFile(imagePath)) !== asset.sha256)
                        throw new Error('이미지 해시 검증 실패');
                }
                const autoStyleComparison = target.kind === 'url' && target.comparisonUrl ? { comparisonUrl: target.comparisonUrl } : undefined;
                const stateDiscovery = target.kind === 'url' && !autoStyleComparison ? copy(revision.options.stateDiscovery??{}) : undefined;
                const spec: RunSpec = { targetUrl: target.kind === 'url' ? target.url : undefined, imagePath, stateDiscovery, autoStyleComparison, mode: 'quick', purpose: revision.purpose, viewport: { ...(target.kind === 'url' ? target.viewport : undefined) ?? { width: 1440, height: 900 }, deviceScaleFactor: 1 }, allowedActions: [], allowedOrigins: target.kind === 'url' ? [new URL(target.url).origin] : [], hasMutationPermission: false, isHeaded: false, shouldWaitForLogin: false, limits: { maxDurationMs: revision.options.timeoutSeconds * 1000, maxObservations: target.kind === 'url' ? 24 : 3, maxActions: 0, maxToolCalls: target.kind === 'url' ? 40 : 20, maxFindings: 10 }, evaluator: revision.options.evaluator, model: revision.options.model, reasoningEffort: revision.options.reasoningEffort, strategy: 'A', reviewPipeline: revision.options.reviewPipeline, evaluationBudget: revision.options.evaluationBudget };
                const expectedRedirectedLoginUrl = attempt.shouldReviewLoginPage ? attempt.loginRedirect?.loginUrl : undefined;
                const {previous, baseAttempt} = this.followupExecutionBase(target.kind === 'url' && !expectedRedirectedLoginUrl ? request : undefined);
                const isResumingProtectedPage = Boolean(request && next.credentials && this.hasLoginOnlyBaseline(request, baseAttempt));
                if (request && hasRestrictedFollowupScope(request) && (expectedRedirectedLoginUrl || isResumingProtectedPage)) {
                    throw new ReviewServiceError(409, changedReviewScopeMessage);
                }
                if (expectedRedirectedLoginUrl) {
                    spec.purpose = '사용자가 현재 로그인 화면 검토를 선택했습니다. 실제로 열린 로그인 화면만 검토하고, 처음 요청한 보호 화면은 확인 범위에서 제외하세요. 원래 요청: ' + revision.purpose;
                } else if (isResumingProtectedPage) {
                    spec.purpose = '사용자가 로그인을 선택했습니다. 로그인 후 처음 요청한 화면의 새 관찰을 기준으로 검토하세요. 원래 요청: ' + revision.purpose;
                }
                const isFollowup = request?.kind === 'followup' && !expectedRedirectedLoginUrl && !isResumingProtectedPage;
                if (target.kind === 'url' && !isFollowup) {
                    if (target.themeReview) spec.themeReview = copy(target.themeReview);
                    if (target.alignmentContracts) spec.alignmentContracts = copy(target.alignmentContracts);
                }
                if(request){spec.workspaceId=request.workspaceId;if(isFollowup){
                  let executionBase:FollowupExecutionBase|undefined;
                  if(previous&&target.kind==='url'){if(baseAttempt?.status!=='completed'||!baseAttempt.runId||!baseAttempt.reportId){needsImageHandoff=true;throw new ReviewServiceError(409,'선행 검증이 완료되지 않아 상태를 이어갈 수 없습니다. 준비된 이미지를 첨부하거나 새 검토를 시작하세요.');}const file=resolve(this.outputRoot(baseAttempt),baseAttempt.runId,'report.json'),bytes=await readFile(file);executionBase={...request.source!,requestId:previous.requestId,reportId:baseAttempt.reportId,runId:baseAttempt.runId,reportSha256:hash(bytes),replay:previous.result?.replay,state:previous.result?.state};}
                  if(executionBase?.replay&&target.kind==='url'){
                    const {evidence,conflictingIndices}=await this.verifiedReplayDismissals(request,executionBase,previous,executionBase.replay,target.url);
                    if(evidence.length)executionBase.dismissalEvidence=evidence;
                    if(conflictingIndices.length)executionBase.dismissalConflicts=conflictingIndices;
                  }
                  spec.followup={requestId:request.requestId,workspaceId:request.workspaceId,instruction:request.instruction,source:request.source!,region:request.region,scopeMode:request.scopeMode,maxOptions:request.maxOptions,executionBaseRequestId:target.kind==='url'?previous?.requestId:request.executionBaseRequestId,executionBase,sourceImagePath:this.workspaceState.sourceImages?.[request.requestId]};
                }}
                const controller=this.runningControllers.get(attempt.attemptId);
                if(target.kind==='url'&&request&&!autoStyleComparison&&!expectedRedirectedLoginUrl)spec.projectPostPolicy=this.currentWorkspacePostPolicy(request.requestId);
                const canSendProjectPost=spec.projectPostPolicy&&request&&controller?(projectId:string,host:string)=>{
                    if(controller.signal.aborted||this.runningControllers.get(attempt.attemptId)!==controller)return false;
                    const policy=this.currentWorkspacePostPolicy(request.requestId);
                    return policy?.projectId===projectId&&policy.hosts.includes(host);
                }:undefined;
                const supabaseGrant = request && next.credentials?.method === 'password' && this.workspaceState.supabaseAuthGrants?.[request.requestId];
                const targetOrigin = target.kind === 'url' ? new URL(target.url).origin : undefined;
                const projectSupabaseAuth = supabaseGrant && request && controller && targetOrigin ? {
                    targetOrigin,
                    origin: supabaseGrant.origin,
                    canSend: () => this.isReady && !controller.signal.aborted && this.runningControllers.get(attempt.attemptId) === controller &&
                        this.canUseWorkspaceSupabaseAuth(request.requestId, attempt.attemptId, supabaseGrant, targetOrigin),
                } : undefined;
                const execute = () => (this.dependencies.inspect ?? inspect)(spec, this.outputRoot(attempt),{canSendProjectPost,projectSupabaseAuth,shouldDetectRedirectedLogin,expectedRedirectedLoginUrl,...(next.credentials?{credentials:next.credentials}:{}),...(controller?{signal:controller.signal}:{}),...(request?{onProgress:(progress:{phase:string;reason?:string})=>{void this.serial(async()=>{const current=this.requireRequest(request.requestId);current.phase=progress.phase;current.reason=progress.reason;await this.save();}).catch(()=>{});}}:{})});
                const execution = await (revision.options.evaluator === 'rules-only' ? execute() :
                    this.runEvaluation(revision.revisionId, revision.options.evaluator, execute));
                if(request&&execution.result.followup){followupResult=execution.result.followup;needsImageHandoff=execution.result.followup.needsImageHandoff;}

                const recovered = await this.recoverReport(attempt);
                if (!recovered)
                    throw new Error('읽을 수 있는 보고서가 저장되지 않았습니다.');
                result = recovered;
            }
            catch (error) {
                if (next.credentials && error instanceof ReviewAuthenticationError) authFailure = error.message;
                if (error instanceof ReviewLoginRequired && shouldDetectRedirectedLogin && next.target.kind === 'url') {
                    const destination = URL.parse(error.loginUrl);
                    const source = new URL(next.target.url);
                    if (destination?.origin === source.origin && !destination.username && !destination.password && destination.pathname !== source.pathname) {
                        loginRedirect = { loginUrl: destination.origin + destination.pathname, methods: error.methods };
                    }
                }
                const errorMessage = authFailure ?? (error instanceof ReviewServiceError && error.message === changedReviewScopeMessage ? changedReviewScopeMessage : next.credentials ? '로그인 정보를 사용한 검토 실행에 실패했습니다.' : error instanceof ReviewLoginRequired ? '로그인 화면 이동을 확인하지 못했습니다.' : error instanceof Error ? error.message.slice(0, 500) : '리뷰 실행 실패');
                result = authFailure || loginRedirect ? {} : await this.recoverReport(next.attempt) ?? { status: 'failed', endedAt: now(), error: errorMessage };
            }
            await this.serial(async () => {
                const task = this.findTask(next.taskId), revision = task.revisions.find(r => r.revisionId === next.revision.revisionId)!;
                const target = revision.targets.find(t => t.targetId === next.target.targetId)!;
                const attempt = target.attempts.find(a => a.attemptId === next.attempt.attemptId)!;
                let latestAttempt = attempt;
                if (attempt.status !== 'cancelled') {
                    if (loginRedirect) {
                        Object.assign(attempt, { status: 'awaiting-start', loginRedirect });
                        delete attempt.startedAt;
                    } else if (authFailure) latestAttempt = this.requireNewCredentials(target, attempt, authFailure);
                    else Object.assign(attempt, result);
                } else if (result.reportId) {
                    Object.assign(attempt, { reportId: result.reportId, runId: result.runId, runStatus: result.runStatus });
                }
                this.runningControllers.delete(attempt.attemptId);
                if (revision.workspaceRequestId) {
                    const request = this.requireRequest(revision.workspaceRequestId);
                    request.attempts = target.attempts;
                    if (latestAttempt.reportId && followupResult?.requestId === request.requestId) request.result = followupResult;
                    else delete request.result;
                    request.needsImageHandoff = needsImageHandoff;
                    this.synchronizeWorkspaceResult(request, latestAttempt);
                } else migrateWorkspaces(this.workspaceState, this.state.tasks);
                task.updatedAt = now();
                await this.save();
            });
        }
    }
}
