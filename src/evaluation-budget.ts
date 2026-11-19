import { z } from 'zod';

export const DEFAULT_REVIEW_TIMEOUT_SECONDS = 1200;
export const MAX_REVIEW_TIMEOUT_SECONDS = 1200;
const STAGE_HEADROOM_SECONDS = 30;
const RUN_HEADROOM_SECONDS = 30;
export const MAX_STANDARD_EVALUATION_SECONDS = MAX_REVIEW_TIMEOUT_SECONDS - STAGE_HEADROOM_SECONDS - RUN_HEADROOM_SECONDS;

const timeoutSeconds = z.number().int().min(1).max(MAX_REVIEW_TIMEOUT_SECONDS);
export const evaluationBudgetSchema = z.object({
    stageTimeoutSeconds: timeoutSeconds,
    initialTimeoutSeconds: timeoutSeconds,
    repairTimeoutSeconds: timeoutSeconds,
}).strict().refine(value => value.initialTimeoutSeconds + value.repairTimeoutSeconds <= value.stageTimeoutSeconds,
    'Initial and repair budgets must fit within the stage budget');

export const standardEvaluationTimeoutsSchema = z.object({
    initialTimeoutSeconds: timeoutSeconds,
    repairTimeoutSeconds: timeoutSeconds,
}).strict().refine(value => value.initialTimeoutSeconds + value.repairTimeoutSeconds <= MAX_STANDARD_EVALUATION_SECONDS,
    `최초 평가와 자동 보정 시간의 합은 ${MAX_STANDARD_EVALUATION_SECONDS}초 이하여야 합니다.`);

export const defaultStandardEvaluationTimeouts = { initialTimeoutSeconds: 960, repairTimeoutSeconds: 180 } as const;

export function deriveStandardReviewTimeouts(timeouts: z.infer<typeof standardEvaluationTimeoutsSchema>) {
    const stageTimeoutSeconds = timeouts.initialTimeoutSeconds + timeouts.repairTimeoutSeconds + STAGE_HEADROOM_SECONDS;
    return {
        timeoutSeconds: stageTimeoutSeconds + RUN_HEADROOM_SECONDS,
        evaluationBudget: { ...timeouts, stageTimeoutSeconds },
    };
}
