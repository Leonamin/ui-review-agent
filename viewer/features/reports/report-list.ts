import {reportName} from './presentation';
import type {ReportSummary} from './types';

export const reportStatuses = {
 completed: '분석 완료',
 partial: '일부 완료',
 'evaluation-partial': 'AI 평가 일부 완료',
 'evaluation-failed': 'AI 평가 실패',
 failed: '실행 실패',
 cancelled: '취소',
 unknown: '상태 미기록',
 'read-error': '파일 오류',
} as const;

export const reportSources = {
 url: '웹 URL',
 image: '이미지',
 unknown: '대상 미기록',
} as const;

function reportStatus(report: ReportSummary): keyof typeof reportStatuses {
 if (report.hasReadError) return 'read-error';
 if (report.evaluation?.status === 'failed') return 'evaluation-failed';
 if (report.evaluation?.status === 'partial') return 'evaluation-partial';
 if (Object.hasOwn(reportStatuses, report.status)) return report.status as keyof typeof reportStatuses;
 return 'unknown';
}

function reportSource(report: ReportSummary): keyof typeof reportSources {
 if (report.target.startsWith('이미지: ')) return 'image';
 if (/^https?:\/\//i.test(report.target)) return 'url';
 return 'unknown';
}

export function reportListStatusLabel(report: ReportSummary) {
 return reportStatuses[reportStatus(report)];
}

export const emptyReportFilters = {query: '', status: '', source: ''};

const normalize = (text: string) => text.normalize('NFKC').toLowerCase();

export function filterReports(reports: ReportSummary[], {query, status, source}: typeof emptyReportFilters) {
 const terms = normalize(query).trim().split(/\s+/).filter(Boolean);
 return reports.filter(report => {
  if (status && status !== reportStatus(report)) return false;
  if (source && source !== reportSource(report)) return false;
  if (!terms.length) return true;
  const searchable = normalize([
   reportName(report), report.taskContext?.targetName, report.taskContext?.taskTitle,
   report.workspaceContext?.projectName, report.workspaceContext?.workspaceName,
   report.recommendation?.screenName, ...(report.recommendation?.featureCategories ?? []),
   report.screenTitle, report.serviceName, report.pageTitle, report.urlPath,
   report.target, report.runId, report.label,
  ].join(' '));
  return terms.every(term => searchable.includes(term));
 });
}
