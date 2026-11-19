import type {ReviewEvaluator} from '../../../src/review-settings';

export const evaluatorLabels: Record<ReviewEvaluator, string> = {
  codex: 'Codex CLI',
  claude: 'Claude Code CLI',
  antigravity: 'Antigravity CLI',
  'openai-compatible': 'OpenAI Compatible API',
};

export const cliEvaluators = ['codex', 'claude', 'antigravity'] as const;
export const evaluatorChoices = ([...cliEvaluators, 'openai-compatible'] as const).map(value => ({
  value, label: evaluatorLabels[value],
}));

export const effortChoices = [
  {value: 'default', label: '기본값'},
  {value: 'low', label: '낮음'},
  {value: 'medium', label: '보통'},
  {value: 'high', label: '높음'},
];
