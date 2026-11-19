import type {ReviewEvaluator} from '../../../src/review-settings';
import {TextField} from '../../shared/goodcase/components/basic/text-field';
import {Select} from '../../shared/goodcase/components/overlays/select';
import {effortChoices, evaluatorChoices} from './options';

type Effort = 'low' | 'medium' | 'high';
export type EvaluatorDraft = {evaluator: ReviewEvaluator; model: string; reasoningEffort?: Effort};
export type EvaluatorMode = 'server' | 'custom';

export function ReviewEvaluatorFields({mode, draft, isDisabled, onModeChange, onChange}: {
  mode: EvaluatorMode;
  draft: EvaluatorDraft;
  isDisabled: boolean;
  onModeChange: (mode: EvaluatorMode) => void;
  onChange: (patch: Partial<EvaluatorDraft>) => void;
}) {
  const settingsChoices = [
    {value: 'server', label: '서버 기본값 사용'},
    {value: 'custom', label: '이번 작업에서 지정'},
  ];
  return <div className="task-evaluator-options">
    <Select label="평가자 설정 방식" value={mode} options={settingsChoices} isDisabled={isDisabled}
      onValueChange={value => onModeChange(value as EvaluatorMode)}/>
    {mode === 'server' && <p className="muted"><a href="/?view=settings">서버 설정</a>에 저장된 평가자와 모델을 사용합니다.</p>}
    {mode === 'custom' && <>
      <div className="settings-fields">
        <Select label="평가자" value={draft.evaluator} options={evaluatorChoices} isDisabled={isDisabled}
          onValueChange={value => onChange({evaluator: value as ReviewEvaluator, model: '', reasoningEffort: undefined})}/>
        <TextField label="모델" disabled={isDisabled} value={draft.model} maxLength={200}
          placeholder="평가자 기본 모델" onChange={event => onChange({model: event.target.value})}/>
      </div>
      <Select label="추론 강도" value={draft.reasoningEffort ?? 'default'} options={effortChoices} isDisabled={isDisabled}
        onValueChange={value => onChange({reasoningEffort: value === 'default' ? undefined : value as Effort})}/>
      <p className="muted">모델과 추론 강도를 지정하지 않으면 선택한 평가자의 서버 설정을 따릅니다.</p>
    </>}
  </div>;
}

export function evaluatorOverrides(draft: EvaluatorDraft) {
  return {...draft, model: draft.model.trim() || undefined};
}
