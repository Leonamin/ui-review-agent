import type {Expectation,FailureAttribution} from './types.js';
export type VerificationOutcome='reproduced'|'refuted'|'not-reproduced'|'inconclusive';
interface VerificationBase {requestId:string;candidateId:string;claimIds:string[];observationId:string;expectation:Expectation;evidenceIds:string[];preconditions:string[]}
export type VerificationRequest=VerificationBase & (
 | {recipe:'occlusion';targetRef:string;issue:'clipping'|'occlusion';targetScopes?:{targetRef:string;scope:'text'|'control-surface'}[];additionalTargets?:{targetRef:string;claimIds:string[]}[];occluderRefs?:string[]}
 | {recipe:'focus';scopeRef:string;allowedActionIds:string[]}
 | {recipe:'money';totalRef:string;itemRefs:string[]}
);
export interface VerificationResult {
 targetMeasurements?:{targetRef:string;claimIds:string[];hasMeasured:boolean;outcome:VerificationOutcome;summary:string;before?:Record<string,unknown>;after?:Record<string,unknown>}[];
 verificationId:string;request:VerificationRequest;recipeVersion:'1';outcome:VerificationOutcome;
 hypothesisKind:'text-clipped'|'text-occluded'|'element-occluded'|'modal-focus-escape'|'visible-total-mismatch';
 hasObservedViolation:boolean|null;expectedInvariant:string;
 condition:string;summary:string;measurements:Record<string,unknown>;limitations:string[];
 beforeObservationId?:string;afterObservationId?:string;evidenceIds:string[];actionIds:string[];
 failureAttribution:FailureAttribution|null;startedAt:string;endedAt:string;
 replay:{recipe:VerificationRequest['recipe'];version:'1';targetRefs:string[];allowedActionIds:string[];requiresFreshReferences:true};
}
