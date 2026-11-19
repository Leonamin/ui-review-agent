import {evaluatorLabels} from '../features/settings/options';
export function EvaluatorChips({provider,model}:{provider:string;model:string}) {
 const providerLabel=provider==='openai-compatible'?'OpenAI 호환 API':evaluatorLabels[provider as keyof typeof evaluatorLabels]??provider;
 return <div className="evaluator-chips"><span><b>평가 방식</b> {providerLabel}</span><span><b>모델</b> {model}</span></div>;
}
