import type {FindingView, ReportDetail, ReportSummary} from './types';

export const readinessWaitLabel='화면 준비 대기 한도';
const evaluationTimeoutLabel='AI 평가 시간 초과';

export function reportPartialCauseLabels(report:Pick<ReportSummary,'status'|'evaluation'|'stateDiscoveryWait'>):string[] {
 if(report.status!=='partial')return [];
 const labels:string[]=[];
 if(report.stateDiscoveryWait)labels.push(readinessWaitLabel);
 if(report.evaluation?.failureCode==='timeout')labels.push(evaluationTimeoutLabel);
 return labels;
}

export function evaluationLabel(report: Pick<ReportSummary, 'evaluation'>): string | undefined {
 if(report.evaluation?.failureCode==='timeout')return evaluationTimeoutLabel;
 return report.evaluation?.status === 'failed' ? 'AI 평가 실패' : report.evaluation?.status === 'partial' ? 'AI 평가 일부 완료' : undefined;
}
export function findingCountLabel(report: Pick<ReportSummary, 'evaluation' | 'initialCount'>): string {
 return report.evaluation?.status === 'failed' ? '집계 불가' : report.initialCount === null ? '미기록' : `${report.initialCount}건`;
}

export function reportName(report: ReportSummary, fallback = '화면명 미확인'): string {
 const recommendation = report.recommendation;
 const hasEditedName = recommendation && ['edited', 'confirmed'].includes(recommendation.status) && recommendation.screenName;
 return (hasEditedName ? recommendation.screenName : '') || report.taskContext?.targetName || recommendation?.screenName || report.screenTitle || report.pageTitle || fallback;
}

/** Only link evidence actually referenced by the result. */
export function findingImageIndex(report: Pick<ReportDetail, 'images'>, result?: Pick<FindingView, 'evidenceIds' | 'observationIds'>): number {
 if (!result) return -1;
 const exactIndex=report.images.findIndex(image=>
  result.evidenceIds.includes(image.id)||(image.evidenceId!==undefined&&result.evidenceIds.includes(image.evidenceId)));
 if(exactIndex>=0)return exactIndex;
 const legacyIndex=report.images.findIndex(image=>result.evidenceIds.includes(image.label));
 if(legacyIndex>=0)return legacyIndex;
 return report.images.findIndex(image => Boolean(image.observationId) && result.observationIds.includes(image.observationId));
}

export function verificationSummary(report: Pick<ReportDetail, 'hasVerificationData' | 'measurements'>): string {
 if (!report.hasVerificationData) return '기록 없음';
 if (!report.measurements.length) return '실행된 검사 없음';
 return `${report.measurements.length}건 기록`;
}
export const severityLabels: Record<string, string> = {critical:'치명적', major:'높음', minor:'경미', info:'참고'};
export const categoryLabels: Record<string, string> = {layout:'레이아웃', navigation:'내비게이션', content:'콘텐츠', accessibility:'접근성', interaction:'상호작용', visual:'시각 표현'};
