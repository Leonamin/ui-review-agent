import type {EvaluationView} from '../features/reports/types.js';

const providerTimeout = /^(?:Codex|Claude|Antigravity|OpenAI-compatible API) evaluation timed out\. No AI review was completed\.$/;

function hasRecordedLegacyDeadline(document: Record<string, any>, limitations: string[]): boolean {
 if(document.status!=='partial'||document.terminationReason!=='Automatic inspection time limit reached'||
  !limitations.includes('OpenAI-compatible API evaluation cancelled.')) return false;
 const calls=document.evaluation?.calls;
 const last=Array.isArray(calls)?calls.at(-1):undefined;
 const endedAt=typeof document.endedAt==='string'?Date.parse(document.endedAt):NaN;
 const callEndedAt=typeof last?.endedAt==='string'?Date.parse(last.endedAt):NaN;
 // The old provider reported outer deadline cancellation as a cancelled model call.
 return last?.status==='failed'&&last.stage==='A-discovery'&&endedAt>=callEndedAt&&endedAt-callEndedAt<1000;
}

/** Use the stored evaluator outcome, never infer AI failure from overall partial status. */
export function recordedEvaluation(document: Record<string, any>): EvaluationView | undefined {
 const evaluation = document.evaluation;
 if (!evaluation || !['completed', 'partial', 'failed'].includes(evaluation.status)) return;
 const status = evaluation.status as EvaluationView['status'];
 if (status === 'completed') return {status};
 const limitations: string[] = Array.isArray(evaluation.limitations) ? evaluation.limitations.filter((item: unknown) => typeof item === 'string') : [];
 const reason = limitations.join('\n');
 if(evaluation.failureCode==='timeout'||(status==='failed'&&hasRecordedLegacyDeadline(document,limitations))) {
  return {status,failureCode:'timeout',reason:'정해진 시간 안에 AI 평가를 마치지 못했습니다.'};
 }
 if (status === 'failed') {
  if(limitations.some(message=>providerTimeout.test(message)))return {status,failureCode:'timeout',reason:'평가 API 응답 시간이 초과되어 AI 검토를 완료하지 못했습니다.'};
  if (/evaluation did not run/i.test(reason)) return {status, reason: 'AI 평가가 실행되지 않았습니다. 실행 오류와 수집 한계를 확인하세요.'};
  return {status, reason: '평가 요청 오류로 AI 검토를 완료하지 못했습니다. 수집·평가 한계에서 오류 기록을 확인하세요.'};
 }
 return {status, reason: /Rejected finding|validation|repair/i.test(reason)
  ? '지적의 근거 검증이 완료되지 않아 평가 결과가 불완전합니다. 채택된 결과만 표시합니다.'
  : 'AI 평가가 일부만 완료되었습니다. 채택된 결과와 확인하지 못한 범위를 함께 확인하세요.'};
}
