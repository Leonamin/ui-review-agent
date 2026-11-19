import {useEffect, useState, type FormEvent} from 'react';
import type {ReviewEvaluator, ReviewSettings, ReviewSettingsUpdate} from '../../../src/review-settings';
import {defaultStandardEvaluationTimeouts, deriveStandardReviewTimeouts, MAX_STANDARD_EVALUATION_SECONDS, MAX_REVIEW_TIMEOUT_SECONDS} from '../../../src/evaluation-budget';
import {Alert} from '../../shared/goodcase/components/basic/alert';
import {Button} from '../../shared/goodcase/components/basic/button';
import {TextField} from '../../shared/goodcase/components/basic/text-field';
import {Select} from '../../shared/goodcase/components/overlays/select';
import {ReviewSettingsError, reviewSettingsApi} from './api';
import {cliEvaluators, effortChoices, evaluatorChoices, evaluatorLabels} from './options';
import './settings.css';

type ProviderOptions = NonNullable<ReviewSettings['providers']['codex']>;
const compatible = 'openai-compatible' as const;
const apiFormats = [
  {value: 'chat', label: 'Chat Completions'},
  {value: 'responses', label: 'Responses'},
];

function cleanOptions(options: ProviderOptions | undefined): ProviderOptions {
  return {model: options?.model?.trim() || undefined, reasoningEffort: options?.reasoningEffort};
}

function evaluationTimeInputs(settings: ReviewSettings) {
  const timeouts = settings.providers[compatible]?.standardEvaluationTimeouts ?? defaultStandardEvaluationTimeouts;
  return {
    initial: String(timeouts.initialTimeoutSeconds),
    repair: String(timeouts.repairTimeoutSeconds),
  };
}

function parseEvaluationSeconds(value: string): number | undefined {
  const seconds = Number(value);
  return Number.isInteger(seconds) && seconds >= 1 && seconds < MAX_STANDARD_EVALUATION_SECONDS ? seconds : undefined;
}

function ProviderOptionsFields({provider, options, onChange, isSaving, needsModel = false}: {
  provider: ReviewEvaluator;
  options?: ProviderOptions;
  onChange: (patch: Partial<ProviderOptions>) => void;
  isSaving: boolean;
  needsModel?: boolean;
}) {
  const label = evaluatorLabels[provider];
  return <div className={provider === compatible ? 'settings-fields settings-api-model-row' : 'settings-fields'}>
    <TextField label={`${label} 모델`} value={options?.model ?? ''} maxLength={200}
      placeholder={provider === compatible ? 'API에서 사용할 모델 ID' : 'CLI 기본 모델'}
      onChange={event => onChange({model: event.target.value})} required={needsModel}/>
    <Select label={`${label} 추론 강도`} value={options?.reasoningEffort ?? 'default'}
      options={effortChoices} isDisabled={isSaving}
      onValueChange={value => onChange({reasoningEffort: value === 'default' ? undefined : value as ProviderOptions['reasoningEffort']})}/>
  </div>;
}

function SettingsForm({initial, onReload}: {initial: ReviewSettings; onReload: () => void}) {
  const [saved, setSaved] = useState(initial);
  const [draft, setDraft] = useState(initial);
  const [timeInputs, setTimeInputs] = useState(() => evaluationTimeInputs(initial));
  const [apiKey, setApiKey] = useState('');
  const [shouldRemoveApiKey, setShouldRemoveApiKey] = useState(false);
  const [isSaving, setIsSaving] = useState(false);
  const [status, setStatus] = useState<{type: 'success' | 'danger'; message: string; hasConflict?: boolean}>();
  const config = draft.providers[compatible];
  const hasSavedKey = saved.providers[compatible]?.hasApiKey ?? false;
  const hasChangedUrl = (config?.baseUrl ?? '').trim().replace(/\/+$/, '') !== (saved.providers[compatible]?.baseUrl ?? '');
  const needsCompatible = draft.defaultEvaluator === compatible;
  const savedTimeInputs = evaluationTimeInputs(saved);
  const hasTimeChanges = timeInputs.initial !== savedTimeInputs.initial || timeInputs.repair !== savedTimeInputs.repair;
  const hasChanges = JSON.stringify(saved) !== JSON.stringify(draft) || hasTimeChanges || apiKey.length > 0 || shouldRemoveApiKey;
  const initialTimeoutSeconds = parseEvaluationSeconds(timeInputs.initial);
  const repairTimeoutSeconds = parseEvaluationSeconds(timeInputs.repair);
  const evaluationTimeError = `1~${MAX_STANDARD_EVALUATION_SECONDS - 1}초 사이의 정수를 입력하세요.`;
  const initialTimeError = initialTimeoutSeconds === undefined ? evaluationTimeError : undefined;
  const hasExceededCombinedLimit = initialTimeoutSeconds !== undefined && repairTimeoutSeconds !== undefined
    && initialTimeoutSeconds + repairTimeoutSeconds > MAX_STANDARD_EVALUATION_SECONDS;
  const repairTimeError = repairTimeoutSeconds === undefined ? evaluationTimeError
    : hasExceededCombinedLimit ? `두 시간의 합계를 ${MAX_STANDARD_EVALUATION_SECONDS}초 이하로 설정하세요.` : undefined;
  const standardEvaluationTimeouts = initialTimeoutSeconds !== undefined && repairTimeoutSeconds !== undefined && !hasExceededCombinedLimit
    ? {initialTimeoutSeconds, repairTimeoutSeconds} : undefined;
  const reviewTimeouts = standardEvaluationTimeouts && deriveStandardReviewTimeouts(standardEvaluationTimeouts);

  function setProvider<K extends ReviewEvaluator>(provider: K, patch: Partial<NonNullable<ReviewSettings['providers'][K]>>) {
    setDraft(previous => ({...previous, providers: {
      ...previous.providers,
      [provider]: {...(provider === compatible && !previous.providers[compatible] ? {hasApiKey: false} : {}), ...previous.providers[provider], ...patch},
    }}));
    setStatus(undefined);
  }

  async function save(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!hasChanges || !standardEvaluationTimeouts) return;
    setIsSaving(true);
    setStatus(undefined);
    try {
      const payload: ReviewSettingsUpdate = {
        revision: saved.revision,
        defaultEvaluator: draft.defaultEvaluator,
        providers: {
          codex: cleanOptions(draft.providers.codex),
          claude: cleanOptions(draft.providers.claude),
          antigravity: cleanOptions(draft.providers.antigravity),
          [compatible]: {
            ...cleanOptions(config),
            baseUrl: config?.baseUrl?.trim() || undefined,
            apiFormat: config?.apiFormat ?? 'chat',
            apiKey: shouldRemoveApiKey ? null : apiKey.trim() || undefined,
            standardEvaluationTimeouts: hasTimeChanges ? standardEvaluationTimeouts : undefined,
          },
        },
      };
      const next = await reviewSettingsApi.save(payload);
      setSaved(next);
      setDraft(next);
      setTimeInputs(evaluationTimeInputs(next));
      setApiKey('');
      setShouldRemoveApiKey(false);
      setStatus({type: 'success', message: '평가자 설정을 저장했습니다.'});
    } catch (cause) {
      setStatus({type: 'danger', message: cause instanceof Error ? cause.message : '설정을 저장하지 못했습니다.',
        hasConflict: cause instanceof ReviewSettingsError && cause.status === 409});
    } finally {
      setIsSaving(false);
    }
  }

  function reset() {
    setDraft(saved);
    setTimeInputs(evaluationTimeInputs(saved));
    setApiKey('');
    setShouldRemoveApiKey(false);
    setStatus(undefined);
  }

  const keyDescription = shouldRemoveApiKey
    ? '변경 사항을 저장하면 API 키가 삭제됩니다.'
    : hasSavedKey && hasChangedUrl ? 'API 주소를 변경하면 저장된 키가 삭제됩니다. 새 주소에 사용할 키를 입력하세요.'
    : hasSavedKey ? 'API 키가 저장되어 있습니다. 새 키를 입력하면 교체됩니다.' : '인증이 필요한 API에 사용하는 키입니다.';

  return <form className="settings-form" onSubmit={save}>
    <fieldset disabled={isSaving}>
      <section className="settings-default" aria-labelledby="settings-default-heading">
        <div>
          <h2 id="settings-default-heading">서버 기본값</h2>
          <p>대시보드와 MCP에서 평가자를 따로 지정하지 않은 새 작업에 적용됩니다.</p>
        </div>
        <Select label="기본 평가자" value={draft.defaultEvaluator} options={evaluatorChoices} isDisabled={isSaving}
          onValueChange={value => {setDraft(previous => ({...previous, defaultEvaluator: value as ReviewEvaluator}));setStatus(undefined);}}/>
      </section>

      <section className="settings-providers" aria-labelledby="settings-cli-heading">
        <div className="settings-section-heading">
          <h2 id="settings-cli-heading">CLI 평가자</h2>
          <p className="muted">서버 PC에 설치된 CLI와 해당 계정의 로그인을 사용합니다.</p>
        </div>
        {cliEvaluators.map(provider => <section className="settings-provider" key={provider} aria-label={evaluatorLabels[provider]}>
          <h3>{evaluatorLabels[provider]}</h3>
          <ProviderOptionsFields provider={provider} options={draft.providers[provider]} isSaving={isSaving}
            onChange={patch => setProvider(provider, patch)}/>
        </section>)}
      </section>

      <section className="settings-providers" aria-labelledby="settings-api-heading">
        <div className="settings-section-heading">
          <h2 id="settings-api-heading">OpenAI Compatible API</h2>
          <p className="muted">리뷰 이미지와 검토 목적을 지정한 API로 전송합니다. 추론 강도 지원은 API와 모델에 따라 다릅니다.</p>
        </div>
        <div className="settings-provider settings-api">
          <div className="settings-fields">
            <TextField label="API 기본 URL" type="url" value={config?.baseUrl ?? ''} maxLength={2048} required={needsCompatible}
              placeholder="https://api.openai.com/v1" description="API 루트 주소를 입력하세요. 예를 들어 https://openrouter.ai/api/v1 또는 https://opencode.ai/inference/go/openai/v1"
              onChange={event => setProvider(compatible, {baseUrl: event.target.value})}/>
            <Select label="API 형식" value={config?.apiFormat ?? 'chat'} options={apiFormats} isDisabled={isSaving}
              onValueChange={value => setProvider(compatible, {apiFormat: value as 'chat' | 'responses'})}/>
          </div>
          <ProviderOptionsFields provider={compatible} options={config} isSaving={isSaving} needsModel={needsCompatible}
            onChange={patch => setProvider(compatible, patch)}/>
          <div className="settings-credential">
            <TextField label="API 키" name="review-api-key" type="password" autoComplete="new-password" spellCheck={false}
              value={apiKey} maxLength={2048} placeholder="새 API 키 입력" description={keyDescription}
              onChange={event => {setApiKey(event.target.value);setShouldRemoveApiKey(false);setStatus(undefined);}}/>
            {hasSavedKey && <Button variant="secondary" onClick={() => {
              setShouldRemoveApiKey(previous => !previous);
              setApiKey('');
              setStatus(undefined);
            }}>{shouldRemoveApiKey ? '키 삭제 취소' : '저장된 키 삭제'}</Button>}
          </div>
          <section className="settings-evaluation-times" aria-labelledby="settings-evaluation-times-heading">
            <div>
              <h3 id="settings-evaluation-times-heading">기본 평가 시간</h3>
              <p className="muted">새 표준 리뷰에 적용됩니다. 전체 실행 상한은 {MAX_REVIEW_TIMEOUT_SECONDS / 60}분이며, 검증 보정 시간은 첫 응답을 검증한 뒤 보정이 필요한 경우에 사용됩니다.</p>
            </div>
            <div className="settings-fields">
              <TextField label="최초 평가 시간 (초)" type="number" inputMode="numeric" step={1} min={1} max={MAX_STANDARD_EVALUATION_SECONDS - 1}
                value={timeInputs.initial} error={initialTimeError}
                onChange={event => {setTimeInputs({...timeInputs, initial: event.target.value});setStatus(undefined);}}/>
              <TextField label="검증 보정 시간 (초)" type="number" inputMode="numeric" step={1} min={1} max={MAX_STANDARD_EVALUATION_SECONDS - 1}
                value={timeInputs.repair} error={repairTimeError}
                onChange={event => {setTimeInputs({...timeInputs, repair: event.target.value});setStatus(undefined);}}/>
            </div>
            {reviewTimeouts && <p className="muted" role="status">평가 단계 최대 {reviewTimeouts.evaluationBudget.stageTimeoutSeconds}초 · 전체 실행 최대 {reviewTimeouts.timeoutSeconds}초</p>}
          </section>
        </div>
      </section>
    </fieldset>
    {status && <Alert title={status.message} tone={status.type}
      action={status.hasConflict && <Button variant="secondary" onClick={onReload}>최신 설정 불러오기</Button>}/>}
    <div className="settings-actions">
      <Button type="submit" isLoading={isSaving} disabled={!hasChanges || !standardEvaluationTimeouts}>변경 사항 저장</Button>
      <Button variant="secondary" disabled={isSaving || !hasChanges} onClick={reset}>변경 취소</Button>
    </div>
  </form>;
}

export function SettingsPage() {
  const [settings, setSettings] = useState<ReviewSettings>();
  const [error, setError] = useState('');
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    const controller = new AbortController();
    reviewSettingsApi.load(controller.signal).then(setSettings).catch(cause => {
      if (!controller.signal.aborted) setError(cause instanceof Error ? cause.message : '설정을 불러오지 못했습니다.');
    });
    return () => controller.abort();
  }, [attempt]);

  function retry() {
    setSettings(undefined);
    setError('');
    setAttempt(previous => previous + 1);
  }

  return <main className="settings-page">
    <h1>평가자 설정</h1>
    {settings ? <SettingsForm initial={settings} onReload={retry}/> : error
      ? <Alert title="설정을 불러오지 못했습니다" tone="danger" action={<Button variant="secondary" onClick={retry}>다시 불러오기</Button>}>{error}</Alert>
      : <p role="status" className="muted">평가자 설정을 불러오는 중…</p>}
  </main>;
}
