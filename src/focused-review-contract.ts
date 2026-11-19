import { z } from 'zod';
import { reviewOptionsSchema, type ReviewAttempt } from './review-contract.js';
import { reviewEvaluatorSchema } from './review-settings.js';
import type { ScreenshotMetadata } from './types.js';
const hashId = z.string().regex(/^[a-f0-9]{64}$/);
export const focusRegionSchema = z.object({ x: z.number().int().min(0), y: z.number().int().min(0), width: z.number().int().min(1), height: z.number().int().min(1) }).strict();
export const focusOptionsSchema = reviewOptionsSchema.omit({ reviewPipeline: true, evaluationBudget: true });
const focusedRequestOptionsSchema = focusOptionsSchema.extend({ evaluator: reviewEvaluatorSchema.optional() });
export const focusedSubmissionSchema = z.object({ submissionId: z.string().trim().min(1).max(200), reportId: hashId, imageId: hashId, sourceSha256: hashId, region: focusRegionSchema, comment: z.string().trim().min(1).max(4000), options: focusedRequestOptionsSchema.prefault({}) }).strict();
export const feedbackAnswerSchema = z.object({ status: z.enum(['confirmed', 'suggestion', 'not-supported', 'needs-verification']), answer: z.string().trim().min(1).max(6000), evidenceIds: z.array(z.string().min(1).max(200)).min(1).max(10) }).strict();
export type FeedbackAnswer = z.infer<typeof feedbackAnswerSchema>;
export type FocusRegion = z.infer<typeof focusRegionSchema>;
export type FocusOptions = z.infer<typeof focusOptionsSchema>;
export interface FocusSource {
    reportId: string;
    imageId: string;
    runId: string;
    observationId: string;
    evidenceId: string;
    sha256: string;
    width: number;
    height: number;
    screenshot?: ScreenshotMetadata;
    isStable?: boolean;
}
export interface FocusedReview {
    focusedReviewId: string;
    createdAt: string;
    source: FocusSource;
    region: FocusRegion;
    comment: string;
    options: FocusOptions;
    attempts: ReviewAttempt[];
    answer?: FeedbackAnswer;
}
export interface FocusedReviewReport {
    focusedReviewId: string;
    source: FocusSource;
    region: FocusRegion;
    sourceViewportRegion?: FocusRegion;
    comment: string;
    answer?: FeedbackAnswer;
}
