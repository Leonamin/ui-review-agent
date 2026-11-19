import {Alert} from '../../shared/goodcase/components/basic/alert';
import {evaluationLabel} from './presentation';
import type {ReportSummary} from './types';

export function EvaluationNotice({report}:{report:Pick<ReportSummary,'evaluation'>}) {
 const title=evaluationLabel(report);
 if(!title)return null;
 return <div className="evaluation-notice"><Alert title={title} tone={report.evaluation?.status==='failed'?'danger':'warning'}>{report.evaluation?.reason}</Alert></div>;
}
