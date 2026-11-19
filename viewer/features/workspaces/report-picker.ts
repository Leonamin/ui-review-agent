import type {PublicWorkspaceDetail} from '../../../src/workspace-contract';

export interface WorkspaceReportMetadata {
 title?: string;
 startedAt?: string;
}

export function workspaceReportAttempts(requests: PublicWorkspaceDetail['requests']) {
 return new Map(requests.flatMap(request=>request.attempts.flatMap((attempt,index)=>
  attempt.reportId ? [[attempt.reportId,{
   title:request.instruction.trim(),
   startedAt:attempt.startedAt,
   attemptNumber:request.attempts.length>1 ? index+1 : undefined,
  }] as const] : []
 )));
}

export function hasExecutionDate(startedAt?: string): startedAt is string {
 return Boolean(startedAt && Number.isFinite(Date.parse(startedAt)));
}

export function reportIdsNeedingMetadata(reportIds: string[],attempts: ReturnType<typeof workspaceReportAttempts>) {
 return reportIds.filter(id=>{
  const attempt=attempts.get(id);
  return !attempt?.title || !hasExecutionDate(attempt.startedAt);
 });
}
