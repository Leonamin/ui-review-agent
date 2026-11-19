import type {FollowupResult} from '../../../src/followup-types';
import type {Observation,Rect} from '../../../src/types';
import type {ReviewReportContext} from '../../../src/review-contract';
import type {FocusedReviewReport} from '../../../src/focused-review-contract';
import type {ReportWorkspaceContext} from '../../../src/workspace-contract';
export interface EvaluationView {status:'completed'|'partial'|'failed';reason?:string;failureCode?:'timeout';}
export interface ReportSummary {evaluation?:EvaluationView;stateDiscoveryWait?:{maxWaitMs?:number};taskContext?:ReviewReportContext;workspaceContext?:ReportWorkspaceContext;recommendation?:ReportRecommendation;serviceName?:string;screenTitle?:string;pageTitle?:string;urlPath?:string;thumbnailUrl?:string;isLocalTarget?:boolean;metadataProvenance?:{serviceName?:'explicit-recorded-service-name';screenTitle?:'visible-heading';pageTitle?:'observation-page-title';urlPath?:'target-url'};id:string;runId:string;label:string;target:string;status:string;startedAt:string;endedAt?:string;provider:string;initialCount:number|null;automaticCandidateCount?:number;measurementCount:number|null;isLegacy:boolean;hasReadError:boolean}
export interface FindingView {id:string;source?:'automatic-rule';title:string;disposition:string;severity:string;category:string;facts:string[];expectations:string[];impact:string;recommendation:string;evidenceIds:string[];observationIds:string[]}
export interface MeasurementView {id:string;candidateId:string;recipe:string;outcome:string;condition:string;summary:string;hasMeasured:boolean|null;recordedValues?:{label:string;value:string}[];measurementJson?:string;beforeObservationId?:string;afterObservationId?:string;targets:{targetRef:string;claimIds:string[];outcome:string;hasMeasured:boolean|null;summary:string}[];limitations:string[];evidenceIds:string[]}
export interface CaptureContext {
 image?:{fileName:string;width:number;height:number;importedAt?:string};
 state?:{label:string;readiness:'loading'|'ready'|'unknown'|'blocked';reason:string};
 theme?:Observation['theme'];
 deterministicChecks?:Observation['deterministicChecks'];
 observationId?:string;
 observedUrl?:string;
 capturedAt?:string;
 viewport?:{width:number;height:number;deviceScaleFactor?:number};
 scrollOffset?:{x:number;y:number};
 verticalScroll?:Observation['verticalScroll'];
 isStable?:boolean;
}
export interface SuggestionView {id:string;title:string;observation:string;rationale:string;possibleImpact:string;uncertainty:string;recommendation:string;evidenceIds:string[];observationIds:string[]}
export interface ReportImageLayout {
 imageSize:{width:number;height:number;deviceScaleFactor:number};
 isEstimated?:true;
 regions:{label:string;bounds:Rect}[];
 focusAreas:{findingId:string;bounds:Rect}[];
}
export interface ReportImage {id:string;evidenceId?:string;observationId:string;label:string;url:string;layout?:ReportImageLayout;}
export interface ModalExplorationView {status:'not-needed'|'completed'|'gave-up';attempts:number;actionCount:number;reason:string;history:{actionId:string;attempt:number;method:string;buttonLabel?:string;outcome:string;hasModalDismissed:boolean|null;hasRedirected:boolean;beforeObservationId:string;afterObservationId?:string}[];}
export interface ReportDetail extends ReportSummary {followup?:FollowupResult;baselineImages?:ReportImage[];stateDiscovery?:{status:'completed'|'partial';reason:string;dismissalCount:number;modalExploration?:ModalExplorationView;};focusedReview?:FocusedReviewReport;observationLedger?:{collectionStatus:string;isObservationCoverageComplete:boolean;accountedCount:number;adjudicatedCount:number;notes:{id:string;fact:string;location:string;status:string;reason:string;references:string[];errors:string[]}[];rejectedCount:number;overflow:{id:string;title:string;kind:string}[];};suggestions?:SuggestionView[];requestedUrl?:string;requestedThemeReview?:'both';captures?:CaptureContext[];purpose:string;requestedModel:string;actualModel:string;findings:FindingView[];measurements:MeasurementView[];selections:{candidateId:string;origin:string;status:string;recipe:string;reason:string}[];images:ReportImage[];limitations:string[];hasVerificationData:boolean;coverage:{canFinish:boolean|null;unmet:string[]};}
export interface ReportList {reports:ReportSummary[];hasMore:boolean;warnings:string[]}
export type ReportScope = 'linked' | 'unlinked';
export interface ReportsApi {list(signal?:AbortSignal,scope?:ReportScope):Promise<ReportList>;detail(id:string,signal?:AbortSignal):Promise<ReportDetail>}

export interface ReportRecommendation {
 hasSourceChanged?:boolean;schemaVersion:1;reportId:string;sourceHash:string;inputHash:string;promptVersion:string;
 status:'pending'|'suggested'|'edited'|'confirmed'|'error';revision:number;
 screenName:string;featureCategories:string[];evidenceRefs:string[];confidence:'low'|'medium'|'high'|null;rationale:string;
 provider:'codex'|'claude';requestedModel:string|null;actualModel:string|null;
 createdAt:string;updatedAt:string;generatedAt:string|null;attemptId:string;attemptCount:number;
 error:{code:string;message:string}|null;
 usage:{inputTokenAccounting?:'including-cache'|'uncached-only';cacheCreationInputTokens?:number|null;inputTokens:number|null;outputTokens:number|null;cachedInputTokens:number|null;costUsd:number|null}|null;
}
