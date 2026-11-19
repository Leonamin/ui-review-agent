import type {BlockedTelemetryKind} from './blocked-telemetry.js';
import type {ProjectPostPolicy} from './post-host-policy.js';
import type {FocusedReviewReport} from './focused-review-contract.js';
import type {FollowupSpec,FollowupResult} from './followup-types.js';
import type {VerificationRequest,VerificationResult} from './verification-types.js';
import type {AlignmentContract,GroupAlignmentReport} from './group-alignment.js';
import type {LayoutSpacingReport} from './layout-spacing.js';
import type {StyleComparison,StyleComparisonReport} from './style-comparison.js';
import type {AutoStyleComparisonConfig,AutoStyleComparisonReport} from './automatic-style-comparison.js';
import type {ThemeContrastSummary,ThemeObservation,ThemeReviewOptions} from './theme-review.js';
export type RunStatus = 'completed' | 'partial' | 'failed' | 'cancelled';
export type FailureAttribution = 'product' | 'automation' | 'environment' | 'unknown';
export type EvaluatorProvider = 'codex' | 'claude' | 'antigravity' | 'openai-compatible' | 'rules-only';
export type EvaluationStrategy = 'A'|'B'|'C';
export type ReasoningEffort = 'low'|'medium'|'high';
export interface EvaluationUsage {inputTokens?:number;cacheCreationInputTokens?:number;cacheReadInputTokens?:number;outputTokens?:number;estimatedCost?:number}
export type ProviderOutputOutcome='output-available'|'invalid-envelope'|'provider-error'|'output-length'|'content-filter'|'incomplete'|'refusal'|'unexpected-tool-call'|'missing-output'|'invalid-output-json';
export interface EvaluationCall {promptHash?:string;instructionsHash?:string;schemaHash?:string;imageInputs?:ProviderImageInput[];callId:string;stage:string;provider:EvaluatorProvider;requestedModel?:string;requestedReasoningEffort?:ReasoningEffort;actualModel?:string;actualReasoningEffort?:ReasoningEffort;startedAt:string;endedAt:string;durationMs:number;status:'completed'|'partial'|'failed';failureCode?:Exclude<ProviderOutputOutcome,'output-available'>|'stage-validation'|'timeout';usage?:EvaluationUsage;isRepair:boolean}
export type Mode = 'quick' | 'interaction';
export interface AllowedAction { id: string; type: 'click' | 'fill' | 'press'; selector: string; value?: string; description: string; }
export interface EvaluationBudget {stageTimeoutSeconds:number;initialTimeoutSeconds:number;repairTimeoutSeconds:number}
export type ModalActionMethod='close-button'|'escape'|'backdrop'|'preference'|'continue';
export interface ModalInteraction {method:ModalActionMethod;modalObservationRef:string;hasModalDismissed:boolean|null;hasRedirected:boolean;attempt:number;buttonLabel?:string}
export interface ModalHistoryEntry extends Omit<ModalInteraction,'modalObservationRef'> {actionId:string;modalKey?:string;outcome:ActionRecord['outcome'];beforeObservationId:string;afterObservationId?:string}
export interface ModalExplorationResult {status:'not-needed'|'completed'|'gave-up';attempts:number;actionCount:number;reason:string;history:ModalHistoryEntry[]}
export interface BlockedBrowserRequest {method:string;origin:string;resourceType:string;telemetry?:BlockedTelemetryKind}
export interface StateDiscoveryResult {status:'completed'|'partial';reason:string;reasonCode?:'wait-limit';maxWaitMs?:number;observationIds:string[];dismissalCount:number;modalExploration?:ModalExplorationResult;blockedRequests:BlockedBrowserRequest[]}
export interface PageState {label:string;readiness:'loading'|'ready'|'unknown'|'blocked';reason:string}
export interface RunSpec {
  workspaceId?:string;
  projectPostPolicy?:ProjectPostPolicy;
  followup?:FollowupSpec;
  stateDiscovery?:{maxWaitMs?:number;maxDismissals?:number;readySelector?:string;loadingSelector?:string;modalExploration?:{maxAttempts?:number;preferenceHint?:string;canChoosePreferences?:boolean}};
  evaluationBudget?:EvaluationBudget;
  reviewPipeline?:'standard'|'observation-ledger';
  themeReview?:ThemeReviewOptions;
  alignmentContracts?:AlignmentContract[];
  styleComparison?:StyleComparison;
  autoStyleComparison?:AutoStyleComparisonConfig;
  targetUrl?: string; imagePath?: string; mode: Mode; purpose?: string; shouldVerify?:boolean;
  viewport: { width: number; height: number; deviceScaleFactor: number };
  allowedActions: AllowedAction[]; allowedOrigins: string[];
  hasMutationPermission: boolean; isHeaded: boolean; shouldWaitForLogin: boolean;
  limits: { maxDurationMs: number; maxObservations: number; maxActions: number; maxToolCalls: number; maxFindings: number };
  evaluator: EvaluatorProvider; model?: string; reasoningEffort?:ReasoningEffort;strategy?:EvaluationStrategy;
}
export interface Rect {x:number;y:number;width:number;height:number}
/** Native image coordinates and digests for the images handed to the evaluator adapter. */
export interface ProviderImageInput {
  observationId:string; evidenceId:string; sourceSha256:string; sourceWidth:number; sourceHeight:number;
  evidenceGeometry?:Pick<ScreenshotMetadata,'coordinateSpace'|'clip'|'deviceScaleFactor'> & {canvasWidth?:number;canvasHeight?:number};
  configuredLimits?:{maxWidthPx?:number;maxHeightPx?:number;maxPixels?:number;maxImageBytes?:number};
  transformReasons?:('model-dimensions'|'image-byte-limit'|'aggregate-byte-limit')[];
  crop:Rect; mode:'original'|'tile'|'lossless-reencode'; mimeType:string; sha256:string; byteLength:number;
}
export interface RedactionRegion {regionId:string;elementRef?:string;reason:'input-value'|'select-options'|'editable-content';boundingBox:Rect}
export interface ScreenshotMetadata {coordinateSpace:'viewport-css-pixels'|'image-pixels';clip:Rect;deviceScaleFactor:number;maskColor:string;redactionRegions:RedactionRegion[]}
export interface ImageSource {
  kind:'image'; fileName:string; mimeType:'image/png'|'image/jpeg'|'image/webp';
  sourceSha256:string; originalRelativePath:string; importedAt:string;
  width:number; height:number; hasAutomaticRedaction:false;
  normalization:'decoded-oriented-png';
}
export interface EvidenceRef { screenshot?:ScreenshotMetadata; evidenceId: string; runId: string; observationId: string; kind: 'screenshot' | 'structure' | 'layout' | 'rule'; relativePath: string; absolutePath: string; mimeType: string; sha256: string; isRedacted: boolean; }
export interface MoneyLabelRelation {status:'resolved'|'unsupported';source?:'aria-labelledby'|'html-label'|'definition-list'|'table-row-header'|'table-headers'|'two-cell-row';labelRefs:string[];labelText?:string;reason?:string}
export interface OcclusionEvidence {textRects:Rect[];coveringElementRefs:string[];hasUncertainCover:boolean}
export interface ElementObservation { ancestorRefs?:string[]; isModal?:boolean;isPaintContainer?:boolean; occlusionEvidence?:OcclusionEvidence; moneyLabelRelation?:MoneyLabelRelation; imageState?:{naturalWidth:number;naturalHeight:number;isComplete:boolean}; parentGroup?:{groupRef:string;tag:string;boundingBox:Rect;display:string;flexDirection:string;alignItems:string;gap:string}; typography?:{fontSize:string;lineHeight:string;fontWeight:string}; elementRef: string; tag: string; role: string; text: string; accessibleName: string; boundingBox: {x:number;y:number;width:number;height:number}; isVisible: boolean; isEnabled: boolean; }
export interface VerticalScrollPosition {
  owner:'document'|'container'; offset:number; maxOffset:number; extent:number; visibleStart:number; visibleEnd:number; clip:Rect;
}
export interface Observation {
  verticalScroll?:VerticalScrollPosition;
  state?:PageState;
  theme?:ThemeObservation;
  deterministicChecks?:{evidenceId:string;contrast?:ThemeContrastSummary;alignment?:GroupAlignmentReport;spacing?:LayoutSpacingReport;styleComparison?:StyleComparisonReport;autoStyleComparison?:AutoStyleComparisonReport};
  source?:ImageSource;
  observationId: string; runId: string; url: string; pageTitle: string;
  captureStartedAt: string; captureEndedAt: string;
  viewport: RunSpec['viewport']; scrollOffset: {x:number;y:number};
  isStable: boolean; consistencyWarnings: string[];
  screenshotRefs: string[]; evidenceRefs: EvidenceRef[]; elements: ElementObservation[];
  redactionRegions?:RedactionRegion[];
  focus?: {capturedAt:string;hasDocumentFocus:boolean;activeElement:{elementRef?:string;tag:string;role?:string}|null};
  accessibilitySnapshot: string; documentWidth: number; viewportWidth: number;
  unsupportedFrames: number; imageFailures: number;
}
export interface RuleFinding { ruleFindingId: string; observationId: string; ruleId: string; ruleVersion: string; result: 'violation' | 'potential' | 'incomplete' | 'pass'; title: string; description: string; evidenceIds: string[]; elementRefs: string[]; impact: string | null; }
export interface ActionRecord { modalInteraction?:ModalInteraction; actionId: string; allowedActionId: string; type: string; beforeObservationId: string; afterObservationId?: string; outcome: 'success' | 'rejected' | 'error'; failureAttribution: FailureAttribution | null; message?: string; }
export interface Check { checkId: string; description: string; isRequired: boolean; }
export interface CoverageState {
  unavailableChecks?:{checkId:string;reason:string}[];
  requiredChecks: string[]; observedChecks: {checkId:string; evidenceIds:string[]}[];
  unmetChecks: {checkId:string; reason:string; state:'pending'|'failed'|'skipped'}[];
  canFinish: boolean; completionBlockers: string[];
}
export interface Expectation { expectationId: string; expectationSource: 'user-goal'|'visible-promise'|'rule'|'heuristic'; sourceRef: string; statement: string; applicability: string; }
export interface ReviewFinding {
  source?:'automatic-rule';
  noteIds?:string[];
  visualEvidence?:{observationId:string;elementRefs:string[];hasMaskedContentDependency:boolean}[];
  issueId: string; layer:'L1'|'L2'; category:'layout'|'content'|'navigation'|'feedback'|'forms'|'accessibility'; title:string;
  disposition:'confirmed'|'needs-verification'|'dismissed';
  observedFacts:{factId:string;text:string}[]; expectations:Expectation[];
  reasoning:string; userImpact:string; severity:'critical'|'major'|'minor'; confidence:'high'|'medium'|'low'; confidenceRationale:string;
  evidenceIds:string[]; observationIds:string[]; reproductionSteps:string[]; recommendation:string;
  hasFailureObservation:boolean; failureAttribution:FailureAttribution|null;
  attributionEvidenceIds:string[]; attributionRationale?:string;
  needsFurtherVerification:boolean; verificationNeeded?:string;
  claimEvidenceLinks:{claimId:string;evidenceIds:string[];sourceRefs:string[];supportStatus:'supported'|'partial'|'unsupported'|'unassessed';assessedBy:'model'|'human'|'rule';rationale:string;hasMaskedContentDependency?:boolean}[];
}
export interface ScreenMap { observationId:string; sections:{sectionId:string;label:string;elementRefs:string[];evidenceIds:string[];visibleSummary:string}[]; }
export interface ImageLayout {
  observationId:string; evidenceId:string;
  regions:{label:string;bounds:Rect}[];
  focusAreas:{findingId:string;bounds:Rect}[];
}
export interface Interpretation { interpretationId:string;observationId:string;apparentRole:string;taskRelevance:string;evidenceIds:string[];uncertainty:string; }
export interface EvaluationInput {
  runId:string; runDir:string; spec:RunSpec; observations:Observation[]; rules:RuleFinding[];
  actions:ActionRecord[]; evidence:EvidenceRef[]; coverage:CoverageState;
  timeoutMs:number;stageTimeoutMs?:number; callBudgetMetadata?:{stageTimeoutMs:number;initialTimeoutMs:number;repairTimeoutMs:number;isRepair:boolean;allocatedTimeoutMs:number}; canRequestObservation?:boolean; signal?:AbortSignal; mcpUrl?:string; mcpToken?:string;
  recordProviderImages?:(images:ProviderImageInput[])=>void;
}
export interface ReviewSuggestion {
  noteIds?:string[];
  suggestionId:string; category:ReviewFinding["category"]; title:string; observation:string; rationale:string; possibleImpact:string; uncertainty:string; recommendation:string; evidenceIds:string[]; observationIds:string[];
}
export interface EvaluationResult {
  imageLayouts?:ImageLayout[];
  observationLedger?:ObservationLedger;
  suggestions?:ReviewSuggestion[];
  verificationSelections?:{candidateId:string;origin:'model'|'automatic';status:'selected'|'skipped'|'rejected';recipe?:VerificationRequest['recipe'];requestId?:string;reason:string}[];
  verificationRequests?:VerificationRequest[];
  calls?:EvaluationCall[];
  skippedStages?:{stage:string;reason:string}[];
  verificationDecisions?:{candidateId:string;decision:'keep'|'downgrade'|'dismiss';reason:string}[];
  provider?:EvaluatorProvider;
  failureCode?:'timeout';
  omittedFindings?:ReviewFinding[];
  observationRequests?:{type:'capture'|'inspect';observationId:string;elementRef?:string;reason:string}[];
  status:'completed'|'partial'|'failed'; findings:ReviewFinding[]; screenMap:ScreenMap[]; interpretations:Interpretation[];
  limitations:string[]; model?:string; usage?:EvaluationUsage;
}
export interface FindingAssessment {candidateId:string;initialDisposition:ReviewFinding['disposition'];hasWholeFindingVerification:false;measurements:{verificationId:string;claimIds:string[];outcome:VerificationResult['outcome'];condition:string}[]}
export interface ReviewResult {
  followup?:FollowupResult;
  stateDiscovery?:StateDiscoveryResult;
  focusedReview?:FocusedReviewReport;
  observationLedger?:ObservationLedger;
  suggestions?:ReviewSuggestion[];
  findingsBasis?:'initial-ai-review';
  findingAssessments?:FindingAssessment[];
  verifications?:VerificationResult[];
  provider?:EvaluatorProvider;
  schemaVersion:'0.1'; runId:string; status:RunStatus; targetUrl?:string; imageSource?:ImageSource; startedAt:string; endedAt:string;
  findings:ReviewFinding[]; verificationCandidates:ReviewFinding[]; coverage:CoverageState;
  observations:Observation[]; actions:ActionRecord[]; rules:RuleFinding[]; evidence:EvidenceRef[];
  limitations:string[]; evaluation:EvaluationResult; terminationReason?:string;
}

export interface ReviewObservation {
  noteId:string;visibleFact:string;location:string;taskRelevance:string;unknowns:string[];
  observationIds:string[];evidenceIds:string[];sourceIndex:number;sourceCallId:string;sourceDraftSha256:string;
}
export interface LedgerOutputRef {kind:'finding'|'suggestion';id:string}
export interface ObservationResolution {
  noteId:string;resolution:'routed'|'excluded'|'merged'|'unreviewed';reason:string;
  outputRefs:LedgerOutputRef[];mergedInto:string|null;errors:string[];
}
export interface ObservationLedger {
  schemaVersion:'observation-ledger-0.1';collectionStatus:'completed'|'partial'|'failed';
  observations:ReviewObservation[];
  regions:{label:string;status:'inspected'|'unavailable'|'not-inspected';reason:string}[];
  rejectedObservations:{sourceIndex:number;sourceCallId:string;sourceDraftSha256:string;reason:string}[];
  resolutions:ObservationResolution[];additionalObservationRequests:{noteIds:string[];reason:string}[];
  isObservationCoverageComplete:boolean;accountedCount:number;adjudicatedCount:number;
  collectionArtifact?:string;adjudicationArtifact?:string;
  overflowFindings:ReviewFinding[];overflowSuggestions:ReviewSuggestion[];
  limitations:string[];
}
