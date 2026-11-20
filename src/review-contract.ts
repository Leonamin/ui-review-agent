import { z } from 'zod';
import { DEFAULT_REVIEW_TIMEOUT_SECONDS, MAX_REVIEW_TIMEOUT_SECONDS, evaluationBudgetSchema } from './evaluation-budget.js';
export { evaluationBudgetSchema } from './evaluation-budget.js';
import { reviewEvaluatorSchema, reviewModelSchema, reviewReasoningEffortSchema } from './review-settings.js';
import { themeReviewSchema } from './theme-review.js';
import { alignmentContractsSchema } from './group-alignment.js';
import { canUseReviewCredentials } from './review-credentials.js';
import { styleComparisonUrlSchema } from './style-comparison.js';
import { hasDistinctStyleUrls, styleComparisonTargetsSchema } from './automatic-style-comparison.js';
export { reviewEvaluatorSchema, type ReviewEvaluator } from './review-settings.js';
export const reviewIdSchema = z.string().uuid();
const httpUrl = z.string().max(4096).refine(value => { try {
    const u = new URL(value);
    return ['http:', 'https:'].includes(u.protocol) && !u.username && !u.password;
}
catch {
    return false;
} }, 'HTTP(S) URL without credentials required');
export const styleComparisonUrlsSchema = z.object({referenceUrl:styleComparisonUrlSchema,comparisonUrl:styleComparisonUrlSchema}).superRefine((urls,context)=>{
    const reference=URL.parse(urls.referenceUrl),comparison=URL.parse(urls.comparisonUrl);
    if(reference&&comparison&&(reference.origin!==comparison.origin||reference.href===comparison.href))
        context.addIssue({code:'custom',path:['comparisonUrl'],message:'같은 사이트의 서로 다른 화면 URL 두 개를 입력하세요.'});
});
const reviewTimeoutSchema = z.number().int().min(10).max(MAX_REVIEW_TIMEOUT_SECONDS);
export const modalExplorationOptionsSchema=z.object({maxAttempts:z.number().int().min(1).max(3).optional(),preferenceHint:z.string().trim().min(1).max(500).optional(),canChoosePreferences:z.boolean().optional()}).strict();
export const stateDiscoveryOptionsSchema = z.object({ readySelector: z.string().trim().min(1).max(500).optional(), loadingSelector: z.string().trim().min(1).max(500).optional(), maxWaitMs: z.number().int().min(1000).max(120000).optional(),modalExploration:modalExplorationOptionsSchema.optional() }).strict();
export const reviewOptionsSchema = z.object({ stateDiscovery: stateDiscoveryOptionsSchema.optional(), evaluator: reviewEvaluatorSchema, model: reviewModelSchema.optional(), reasoningEffort: reviewReasoningEffortSchema.optional(), evaluationBudget: evaluationBudgetSchema.optional(), timeoutSeconds: reviewTimeoutSchema.default(DEFAULT_REVIEW_TIMEOUT_SECONDS), reviewPipeline: z.enum(['standard', 'observation-ledger']).default('standard') }).strict();
const reviewRequestOptionsSchema = reviewOptionsSchema.extend({ evaluator: reviewEvaluatorSchema.optional(), timeoutSeconds: reviewTimeoutSchema.optional() });
export const REVIEW_TARGET_NAME_MAX_LENGTH = 120;
const common = { targetId: reviewIdSchema.optional(), name: z.string().trim().min(1).max(REVIEW_TARGET_NAME_MAX_LENGTH) };
export const reviewTargetSchema = z.discriminatedUnion('kind', [
    z.object({
        ...common,
        kind: z.literal('url'),
        url: httpUrl,
        comparisonUrl: styleComparisonUrlSchema.optional(),
        comparisonUrls: styleComparisonTargetsSchema.optional(),
        viewport: z.object({ width: z.number().int().min(320).max(3840), height: z.number().int().min(240).max(2160) }).strict().optional(),
        themeReview: themeReviewSchema.optional(),
        alignmentContracts: alignmentContractsSchema.optional(),
        shouldWaitForStart: z.boolean().optional(),
        shouldWaitForLogin: z.boolean().optional(),
    }).strict(),
    z.object({ ...common, kind: z.literal('image'), assetId: reviewIdSchema }).strict()
]);
export const reviewSubmissionSchema = z.object({ submissionId: z.string().trim().min(1).max(200), title: z.string().trim().min(1).max(160), purpose: z.string().trim().min(1).max(4000), project: z.string().trim().max(160).optional(), externalLinks: z.array(httpUrl).max(10).default([]), targets: z.array(reviewTargetSchema).min(1).max(10), options: reviewRequestOptionsSchema.prefault({}) }).strict().superRefine((input, context) => {
    const {options,targets}=input;
    if (options.stateDiscovery && !targets.some(target=>target.kind==='url'))
        context.addIssue({code:'custom',message:'State discovery hints require a URL target'});
    if (options.evaluationBudget && (options.evaluationBudget.stageTimeoutSeconds > (options.timeoutSeconds ?? DEFAULT_REVIEW_TIMEOUT_SECONDS) ||
        options.reviewPipeline !== 'standard' || (options.evaluator && options.evaluator !== 'openai-compatible')))
        context.addIssue({code:'custom',message:'Explicit evaluation budget requires the standard compatible API pipeline and must fit within the run timeout'});
    const ids = targets.flatMap(target=>target.targetId?[target.targetId]:[]);
    if (new Set(ids).size !== ids.length)
        context.addIssue({code:'custom',message:'Duplicate target IDs'});
    if (options.reviewPipeline === 'observation-ledger' && targets.some(target=>target.kind!=='image'))
        context.addIssue({code:'custom',message:'Observation ledger requires image targets'});
    for (const [index,target] of targets.entries()) {
        if(target.kind!=='url')continue;
        if(!(target.comparisonUrl||target.comparisonUrls)){
            if(target.shouldWaitForLogin)
                context.addIssue({code:'custom',path:['targets',index,'shouldWaitForLogin'],message:'브라우저에서 직접 로그인은 화면 스타일 비교에서 사용할 수 있습니다.'});
            continue;
        }
        if(target.comparisonUrl&&target.comparisonUrls)
            context.addIssue({code:'custom',path:['targets',index,'comparisonUrls'],message:'비교 URL 입력 형식을 하나만 사용하세요.'});
        else if(target.comparisonUrls){
            if(!styleComparisonUrlSchema.safeParse(target.url).success||!hasDistinctStyleUrls(target.url,target.comparisonUrls))
                context.addIssue({code:'custom',path:['targets',index,'comparisonUrls'],message:'기준과 비교 화면은 같은 사이트의 서로 다른 URL이어야 합니다.'});
        }else{
            const pair=styleComparisonUrlsSchema.safeParse({referenceUrl:target.url,comparisonUrl:target.comparisonUrl});
            if(!pair.success)for(const issue of pair.error.issues)
                context.addIssue({code:'custom',path:['targets',index,'comparisonUrl'],message:issue.message});
        }
        if(target.shouldWaitForLogin&&!canUseReviewCredentials(target.url))
            context.addIssue({code:'custom',path:['targets',index,'shouldWaitForLogin'],message:'HTTPS 또는 로컬 테스트 URL에서 직접 로그인할 수 있습니다.'});
        if(targets.length!==1||target.shouldWaitForStart||target.themeReview||target.alignmentContracts||
            options.evaluator||options.model||options.reasoningEffort||options.stateDiscovery||options.evaluationBudget)
            context.addIssue({code:'custom',path:['targets',index],message:'스타일 비교에 로그인 정보 입력, 다른 검사 설정, AI 평가자를 함께 지정할 수 없습니다.'});
    }
});
export type ReviewSubmission = z.infer<typeof reviewSubmissionSchema>;
export const reviewStartSchema = z.object({
    attemptId: reviewIdSchema,
    credentials: z.discriminatedUnion('method', [
        z.object({ method: z.literal('password'), username: z.string().min(1).max(512), password: z.string().min(1).max(4096) }).strict(),
        z.object({ method: z.literal('code'), code: z.string().min(1).max(512) }).strict(),
    ]).optional(),
}).strict();
export type ReviewOptions = z.infer<typeof reviewOptionsSchema>;
export type ReviewRevisionOptions = ReviewOptions | (Pick<ReviewOptions,'timeoutSeconds'> & {
    evaluator:'rules-only';
    reviewPipeline:'standard';
    model?:undefined;
    reasoningEffort?:undefined;
    stateDiscovery?:undefined;
    evaluationBudget?:undefined;
});
export interface ReviewAsset {
    assetId: string;
    fileName: string;
    mimeType: string;
    width: number;
    height: number;
    sha256: string;
}
export interface ReviewLoginRedirect {
    loginUrl: string;
    methods: Array<'password' | 'code'>;
}
export interface ReviewAttempt {
    attemptId: string;
    status: 'awaiting-start' | 'queued' | 'running' | 'completed' | 'failed' | 'cancelled';
    credentialMethod?: 'password' | 'code';
    loginRedirect?: ReviewLoginRedirect;
    shouldReviewLoginPage?: boolean;
    createdAt: string;
    startedAt?: string;
    endedAt?: string;
    runId?: string;
    runStatus?: string;
    reportId?: string;
    error?: string;
}
export type ReviewTarget = (Omit<Extract<z.infer<typeof reviewTargetSchema>, {
    kind: 'url';
}>, 'targetId'> | Omit<Extract<z.infer<typeof reviewTargetSchema>, {
    kind: 'image';
}>, 'targetId'>) & {
    targetId: string;
    attempts: ReviewAttempt[];
};
export interface ReviewRevision {
    workspaceRequestId?: string;
    revisionId: string;
    number: number;
    submittedAt: string;
    title: string;
    purpose: string;
    project?: string;
    externalLinks: string[];
    options: ReviewRevisionOptions;
    targets: ReviewTarget[];
}
export interface ReviewTask {
    taskId: string;
    title: string;
    purpose: string;
    project?: string;
    externalLinks: string[];
    createdAt: string;
    updatedAt: string;
    revisions: ReviewRevision[];
}

/** A recorded report's owning submission, independent of URL query parameters. */
export interface ReviewReportContext {
  taskId: string;
  taskTitle: string;
  revisionId: string;
  revisionNumber: number;
  targetId: string;
  targetName: string;
  attemptNumber: number;
  loginRedirect?: ReviewLoginRedirect;
}
