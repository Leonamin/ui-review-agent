import type {ActionNetworkDiagnostic} from './action-network.js';
import type {FocusSource,FocusRegion} from './focused-review-contract.js';
import type {RunSpec,VerticalScrollPosition} from './types.js';
import type {SavedScrollPosition} from './vertical-scroll.js';

export type FollowupScopeMode='selected-only'|'related-screen';
export interface FollowupReplayStep {type:'click'|'select-option'|'press-escape';role:string;label:string;optionLabel?:string;scopeLabel?:string;dismissMethod?:'close-button'|'escape'}
export interface FollowupState {url:string;anchors:string[];scroll?:SavedScrollPosition}
export interface FollowupSource {reportId:string;reportSha256:string;runId:string;targetUrl?:string;viewport?:RunSpec['viewport'];image?:FocusSource}
export interface ReplayDismissalEvidence {replayIndex:number;modalFingerprint:string}
export interface ReplayDismissalTrace {replayIndex:number;outcome:'dismissed'|'obsolete'|'blocked';observationId:string;method?:'close-button'|'escape'}
export interface FollowupExecutionBase extends FollowupSource {requestId?:string;replay?:FollowupReplayStep[];state?:FollowupState;dismissalEvidence?:ReplayDismissalEvidence[];dismissalConflicts?:number[]}
export interface FollowupSpec {requestId:string;workspaceId:string;instruction:string;source:FollowupSource;sourceImagePath?:string;region?:FocusRegion;maxOptions:number;executionBaseRequestId?:string;executionBase?:FollowupExecutionBase;scopeMode?:FollowupScopeMode}
export interface FollowupProgress {phase:string;reason?:string}
export interface FollowupStep {step:number;actionId?:string;type:string;label?:string;optionLabel?:string;outcome:'success'|'rejected'|'error';beforeObservationId:string;afterObservationId?:string;scroll?:{direction:'up'|'down';from:VerticalScrollPosition;to:VerticalScrollPosition};network?:ActionNetworkDiagnostic}
export type ReplayScrollOutcome='found'|'ambiguous'|'not-found'|'limit'|'no-progress'|'unsafe'|'cancelled'|'navigation'|'unobserved';
export interface ReplayScrollSearch {replayIndex:number;label:string;distancePx:number;steps:number;outcome:ReplayScrollOutcome;beforeObservationId:string;afterObservationId?:string}
export interface ReplayScrollSummary {maxDistancePx:number;usedDistancePx:number;searches:ReplayScrollSearch[]}
export interface FollowupResult {requestId:string;workspaceId:string;status:'completed'|'partial'|'cancelled';reason:string;restoration:{status:'reused'|'replayed'|'failed'|'not-required';reason:string;hasReplayedSavedSteps?:boolean;scroll?:ReplayScrollSummary;dismissals?:ReplayDismissalTrace[]};history:FollowupStep[];beforeObservationId?:string;afterObservationId?:string;answer?:string;replay:FollowupReplayStep[];state?:FollowupState;scopeMode?:FollowupScopeMode;scopeDescription?:string;scopeSuggestion?:{kind:'same-workspace'|'new-workspace';name:string;goal:string;reason:string};needsImageHandoff:boolean}
