import { z } from 'zod';
import { defaultStandardEvaluationTimeouts, standardEvaluationTimeoutsSchema } from './evaluation-budget.js';

export const reviewEvaluatorSchema = z.enum(['codex', 'claude', 'antigravity', 'openai-compatible']);
export const reviewModelSchema = z.string().trim().min(1).max(200);
export const reviewReasoningEffortSchema = z.enum(['low', 'medium', 'high']);
export type ReviewEvaluator = z.infer<typeof reviewEvaluatorSchema>;

const providerSchema = z.object({
    model: reviewModelSchema.optional(),
    reasoningEffort: reviewReasoningEffortSchema.optional(),
}).strict();

const baseUrlSchema = z.string().trim().max(2048).transform((value, ctx) => {
    const url = URL.parse(value);
    const isLoopback = /^http:\/\/(?:127\.0\.0\.1|\[::1\])(?::\d+)?(?:\/|$)/i.test(value);
    if (!url || !/^https?:\/\/[^@/?#]+(?:\/[^?#]*)?$/i.test(value) ||
        /[?#\\\s]/.test(value) || url.username || url.password ||
        (url.protocol !== 'https:' && !(url.protocol === 'http:' && isLoopback))) {
        ctx.addIssue({ code: 'custom', message: 'API 주소는 HTTPS 또는 루프백 HTTP여야 하며 사용자 정보, 쿼리, 프래그먼트를 포함할 수 없습니다.' });
        return z.NEVER;
    }
    return url.origin + url.pathname.replace(/\/+$/, '');
});

const compatibleSchema = providerSchema.extend({
    baseUrl: baseUrlSchema.optional(),
    apiFormat: z.enum(['chat', 'responses']).default('chat'),
    standardEvaluationTimeouts: standardEvaluationTimeoutsSchema.optional(),
});
const keySchema = z.string().trim().min(1).max(2048).regex(/^[!-~]+$/);
const providersSchema = z.object({
    codex: providerSchema.optional(),
    claude: providerSchema.optional(),
    antigravity: providerSchema.optional(),
}).strict();

export const reviewSettingsSchema = z.object({
    revision: z.number().int().nonnegative(),
    defaultEvaluator: reviewEvaluatorSchema,
    providers: providersSchema.extend({
        'openai-compatible': compatibleSchema.extend({ apiKey: keySchema.optional() }).optional(),
    }),
}).strict();

export const reviewSettingsUpdateSchema = reviewSettingsSchema.extend({
    revision: reviewSettingsSchema.shape.revision.optional(),
    providers: providersSchema.extend({
        'openai-compatible': compatibleSchema.extend({ apiKey: keySchema.nullable().optional() }).optional(),
    }),
});

export type StoredReviewSettings = z.output<typeof reviewSettingsSchema>;
export type ReviewSettingsUpdate = z.input<typeof reviewSettingsUpdateSchema>;
export type ReviewSettings = {
    revision: number;
    defaultEvaluator: ReviewEvaluator;
    providers: z.output<typeof providersSchema> & {
        'openai-compatible'?: z.output<typeof compatibleSchema> & { hasApiKey: boolean };
    };
};

export const initialReviewSettings: StoredReviewSettings = { revision: 0, defaultEvaluator: 'codex', providers: {} };

export function publicReviewSettings(settings: StoredReviewSettings): ReviewSettings {
    const { 'openai-compatible': compatible, ...providers } = settings.providers;
    if (!compatible)
        return { revision: settings.revision, defaultEvaluator: settings.defaultEvaluator, providers };
    const { apiKey, ...options } = compatible;
    return { revision: settings.revision, defaultEvaluator: settings.defaultEvaluator, providers: { ...providers, 'openai-compatible': { ...options, standardEvaluationTimeouts: options.standardEvaluationTimeouts ?? defaultStandardEvaluationTimeouts, hasApiKey: Boolean(apiKey) } } };
}
