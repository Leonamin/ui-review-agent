import { AsyncLocalStorage } from 'node:async_hooks';

interface OpenAiCompatibleConfig {
    baseUrl: string;
    apiFormat: 'chat' | 'responses';
    apiKey?: string;
}

const configs = new AsyncLocalStorage<OpenAiCompatibleConfig>();

export function runWithOpenAiCompatible<T>(config: OpenAiCompatibleConfig, run: () => T): T {
    return configs.run(config, run);
}

export function openAiCompatibleConfig(): OpenAiCompatibleConfig | undefined {
    return configs.getStore();
}
