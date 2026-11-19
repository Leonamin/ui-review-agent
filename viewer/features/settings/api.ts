import type {ReviewSettings, ReviewSettingsUpdate} from '../../../src/review-settings';

export class ReviewSettingsError extends Error {
  constructor(message: string, readonly status: number) {
    super(message);
  }
}

async function settingsRequest(signal?: AbortSignal, value?: ReviewSettingsUpdate): Promise<ReviewSettings> {
  const response = await fetch('/api/review-settings', {
    credentials: 'same-origin',
    signal,
    ...(value && {
      method: 'PUT',
      headers: {'content-type': 'application/json'},
      body: JSON.stringify(value),
    }),
  });
  const result = await response.json();
  if (!response.ok) throw new ReviewSettingsError(result.error ?? '평가자 설정을 처리하지 못했습니다.', response.status);
  return result.settings;
}

export const reviewSettingsApi = {
  load: (signal?: AbortSignal) => settingsRequest(signal),
  save: (settings: ReviewSettingsUpdate) => settingsRequest(undefined, settings),
};
