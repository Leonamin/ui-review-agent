import { z } from 'zod';
import { openAiCompatibleConfig } from './review-settings-runtime.js';
import type { EvaluatorProvider } from './types.js';

const side = z.number().int().min(128).max(20_000);
export const MAX_TRANSPORT_IMAGE_BYTES = 20 * 1024 * 1024;
export const MAX_EVIDENCE_IMAGE_PIXELS = 20_000_000;
const limit = z.object({
    evaluator: z.enum(['codex', 'claude', 'antigravity', 'openai-compatible']),
    model: z.string().min(1).max(200),
    baseUrl: z.string().url().max(2048).optional(),
    maxWidthPx: side.optional(),
    maxHeightPx: side.optional(),
    maxPixels: z.number().int().min(128 * 128).max(MAX_EVIDENCE_IMAGE_PIXELS).optional(),
    maxImageBytes: z.number().int().min(1024).max(MAX_TRANSPORT_IMAGE_BYTES).optional(),
}).strict().refine(({ evaluator, baseUrl, maxWidthPx, maxHeightPx, maxPixels, maxImageBytes }) =>
    (evaluator === 'openai-compatible') === (baseUrl !== undefined) &&
    [maxWidthPx,maxHeightPx,maxPixels,maxImageBytes].some(value => value !== undefined));
const limits = z.array(limit).max(32);
type ImageLimit = z.infer<typeof limit>;

export function providerImageLimit(evaluator: EvaluatorProvider, model?: string): ImageLimit | undefined {
    const config = process.env.UI_REVIEW_PROVIDER_IMAGE_LIMITS;
    if (!config || !model) return;
    let profiles: ImageLimit[];
    try {
        profiles = limits.parse(JSON.parse(config));
    } catch {
        throw new Error('Invalid UI_REVIEW_PROVIDER_IMAGE_LIMITS configuration.');
    }
    const endpoint = evaluator === 'openai-compatible' ? openAiCompatibleConfig()?.baseUrl : undefined;
    const matches = profiles.filter(profile => profile.evaluator === evaluator && profile.model === model && profile.baseUrl === endpoint);
    if (matches.length > 1) throw new Error('Duplicate UI_REVIEW_PROVIDER_IMAGE_LIMITS profile for this evaluator and model.');
    return matches[0];
}
