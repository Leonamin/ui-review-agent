import {createHash} from 'node:crypto';
import type {FollowupReplayStep,ReplayDismissalEvidence} from './followup-types.js';

export function normalizeModalTitle(title:string){return title.normalize('NFC').replace(/\s+/gu,' ').trim();}
const modalRoleLine=/^\s*- (?:alertdialog|dialog)(?:\s|:|$)/;
export function hasReplayModal(snapshot:string){return snapshot.split('\n').some(line=>modalRoleLine.test(line));}

export function activeReplayModal(snapshot:string){
 const dialogs=snapshot.split('\n').filter(line=>modalRoleLine.test(line));
 if(dialogs.length!==1)return;
 const match=/^\s*- (alertdialog|dialog) ("(?:[^"\\]|\\.)*")(?:\s|:|$)/.exec(dialogs[0]);
 if(!match)return;
 try{
  const title=normalizeModalTitle(JSON.parse(match[2]));
  if(title&&title.length<=240)return {title,fingerprint:createHash('sha256').update(JSON.stringify([match[1],title])).digest('hex')};
 }catch{/* An ambiguous snapshot cannot authorize a dismissal. */}
}

export function isReversibleReplayDismissal(step:FollowupReplayStep){
 if(step.optionLabel!==undefined)return false;
 if(step.dismissMethod==='escape')return step.type==='press-escape'&&step.role==='dialog'&&step.label==='Close modal (Escape)';
 return step.dismissMethod==='close-button'&&step.type==='click'&&step.role==='button'&&/^(?:(?:팝업\s*|모달\s*)?닫기|close|dismiss|[x×✕✖])$/i.test(step.label);
}

function asRecord(value:unknown){return value!==null&&typeof value==='object'&&!Array.isArray(value)?value as Record<string,unknown>:undefined;}

/** The caller verifies the immutable report bytes before deriving replay authorization. */
export function deriveReplayDismissalEvidence(report:unknown,replay:FollowupReplayStep[]):ReplayDismissalEvidence[]{
 const raw=asRecord(report),followup=asRecord(raw?.followup);
 const saved=followup?.replay,history=followup?.history,observations=raw?.observations;
 if(!Array.isArray(saved)||!Array.isArray(history)||!Array.isArray(observations))return [];
 return replay.flatMap((step,replayIndex)=>{
  if(!isReversibleReplayDismissal(step))return [];
  const previous=asRecord(saved[replayIndex]);
  if(!previous||!(['type','role','label','optionLabel','scopeLabel','dismissMethod'] as const).every(key=>previous[key]===step[key]))return [];
  const actions=history.map(asRecord).filter(action=>action?.outcome==='success'&&action.label===step.label&&(action.type===step.type||action.type===`restore-${step.type}`));
  if(actions.length!==1||typeof actions[0]?.beforeObservationId!=='string')return [];
  const matching=observations.map(asRecord).filter(observation=>observation?.observationId===actions[0]!.beforeObservationId);
  if(matching.length!==1||typeof matching[0]?.accessibilitySnapshot!=='string')return [];
  const modal=activeReplayModal(matching[0].accessibilitySnapshot);
  return modal?[{replayIndex,modalFingerprint:modal.fingerprint}]:[];
 });
}
