import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { codexOutputSchema, normalizeCodexOutput } from './codex.js';
import { buildProviderContent, parseProviderJson, schemaDirective, type ProviderContent, type ProviderPrompt, type StructuredProviderResult, type ProviderTransport } from './provider-input.js';
import { openAiCompatibleConfig } from './review-settings-runtime.js';
import type { EvaluationInput } from './types.js';

type ApiFormat = 'chat' | 'responses';
const MAX_RESPONSE_BYTES = 8 * 1024 * 1024;
const MAX_ERROR_BYTES = 16 * 1024;
const optionalFields: Record<ApiFormat, Record<string, RegExp>> = {
    chat: { response_format: /response_format|json_schema|json_object|json mode/i, temperature: /temperature/i, reasoning_effort: /reasoning_effort/i },
    responses: { text: /text\.format|json_schema|json_object|json mode/i, temperature: /temperature/i, reasoning: /reasoning(?:\.effort)?/i },
};

const tokenCount = z.number().int().nonnegative().optional();
const responseSchema = z.object({
    model: z.string().max(256).optional(),
    status: z.string().optional(),
    error: z.unknown().optional(),
    incomplete_details: z.object({reason:z.string().optional()}).nullable().optional(),
    output_text: z.string().optional(),
    output: z.array(z.object({
        type: z.string().optional(),
        role: z.string().optional(),
        content: z.array(z.object({ type: z.string(), text: z.string().optional() })).optional(),
    })).optional(),
    choices: z.array(z.object({
        finish_reason: z.string().nullable().optional(),
        message: z.object({ content: z.string().nullable().optional(), refusal: z.string().nullable().optional(), tool_calls: z.array(z.unknown()).optional(), function_call:z.unknown().optional() }),
    })).optional(),
    usage: z.object({
        input_tokens: tokenCount,
        output_tokens: tokenCount,
        prompt_tokens: tokenCount,
        completion_tokens: tokenCount,
        input_tokens_details: z.object({ cached_tokens: tokenCount }).optional(),
        prompt_tokens_details: z.object({ cached_tokens: tokenCount }).optional(),
    }).nullable().optional(),
});

function requestBody(format: ApiFormat, input: EvaluationInput, options: ProviderPrompt, content: ProviderContent[]): Record<string, unknown> {
    const instructions = `${options.instructions}\n\n${schemaDirective(options.schema)}`;
    const schema = codexOutputSchema(options.schema);
    const effort = input.spec.reasoningEffort;
    if (format === 'responses') {
        return {
            model: input.spec.model, instructions, store: false, temperature: 0.2,
            input: [{ role: 'user', content: content.map(part => part.type === 'text'
                ? { type: 'input_text', text: part.text }
                : { type: 'input_image', detail: 'auto', image_url: `data:${part.mimeType};base64,${part.data}` }) }],
            text: { format: { type: 'json_schema', name: 'ui_review', strict: true, schema } },
            ...(effort ? { reasoning: { effort } } : {}),
        };
    }
    return {
        model: input.spec.model, temperature: 0.2,
        messages: [{ role: 'system', content: instructions }, { role: 'user', content: content.map(part => part.type === 'text'
            ? part
            : { type: 'image_url', image_url: { url: `data:${part.mimeType};base64,${part.data}` } }) }],
        response_format: { type: 'json_schema', json_schema: { name: 'ui_review', strict: true, schema } },
        ...(effort ? { reasoning_effort: effort } : {}),
    };
}

async function readResponse(response: Response, limit: number): Promise<string> {
    if (!response.body) return '';
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let bytes = 0;
    let result = '';
    try {
        while (true) {
            const chunk = await reader.read();
            if (chunk.done) return result + decoder.decode();
            bytes += chunk.value.byteLength;
            if (bytes > limit) throw new Error('OpenAI-compatible API response exceeded its size limit.');
            result += decoder.decode(chunk.value, { stream: true });
        }
    } finally {
        await reader.cancel().catch(() => undefined);
    }
}

function completionUrl(baseUrl: string, format: ApiFormat): URL {
    const url = URL.parse(baseUrl);
    const isLoopback = url && ['127.0.0.1', '[::1]'].includes(url.hostname);
    if (!url || (url.protocol !== 'https:' && !(url.protocol === 'http:' && isLoopback))
        || url.username || url.password || url.search || url.hash || /[?#\s]/.test(baseUrl))
        throw new Error('OpenAI-compatible API URL must use HTTPS or local loopback HTTP.');
    url.pathname = `${url.pathname.replace(/\/+$/, '')}/${format === 'responses' ? 'responses' : 'chat/completions'}`;
    return url;
}

function resultFromResponse(format: ApiFormat, raw: unknown, schema: ProviderPrompt['schema'], usedSchema: boolean, transport: ProviderTransport): StructuredProviderResult {
    const parsed = responseSchema.safeParse(raw);
    if (!parsed.success) {
        transport.responseOutcome='invalid-envelope';
        return {error:'OpenAI-compatible API returned an invalid response.'};
    }
    const response = parsed.data;
    const usage = response.usage;
    const metadata = {model:response.model,usage:usage?{
        inputTokens:usage.input_tokens??usage.prompt_tokens,
        outputTokens:usage.output_tokens??usage.completion_tokens,
        cacheReadInputTokens:usage.input_tokens_details?.cached_tokens??usage.prompt_tokens_details?.cached_tokens,
    }:undefined};
    if(metadata.usage)transport.usage=metadata.usage;
    const reject=(outcome:NonNullable<ProviderTransport['responseOutcome']>,error:string)=>{
        transport.responseOutcome=outcome;
        return {...metadata,error};
    };
    if(response.error!=null)return reject('provider-error','OpenAI-compatible API returned an error instead of model output.');
    let text: string | undefined;
    if (format === 'responses') {
        const reason=response.incomplete_details?.reason;
        if(response.status)transport.finishReason=response.status==='incomplete'&&(reason==='max_output_tokens'||reason==='content_filter')?reason:
            response.status==='completed'||response.status==='incomplete'||response.status==='failed'?response.status:'other';
        const messages = response.output?.filter(item => item.type === 'message' && (!item.role || item.role === 'assistant'));
        if (messages?.some(message => message.content?.some(part => part.type === 'refusal')))
            return reject('refusal','OpenAI-compatible API declined the review.');
        if(response.output?.some(item=>item.type?.endsWith('_call')))
            return reject('unexpected-tool-call','OpenAI-compatible API returned an unexpected tool call.');
        if(response.status==='incomplete'&&reason==='max_output_tokens')return reject('output-length','OpenAI-compatible API ended at the output token limit.');
        if(response.status==='incomplete'&&reason==='content_filter')return reject('content-filter','OpenAI-compatible API filtered the model output.');
        if(response.status&&response.status!=='completed')return reject('incomplete','OpenAI-compatible API did not complete the review.');
        if(!response.status&&response.output_text===undefined&&!response.output)
            return reject('invalid-envelope','OpenAI-compatible API returned an invalid response.');
        text = response.output_text?.trim() || messages?.flatMap(message => message.content ?? []).filter(part => part.type === 'output_text').map(part => part.text ?? '').join('');
    } else {
        const choice = response.choices?.[0];
        if(!response.choices)return reject('invalid-envelope','OpenAI-compatible API returned an invalid response.');
        const reason=choice?.finish_reason;
        if(reason)transport.finishReason=reason==='stop'||reason==='length'||reason==='content_filter'||reason==='tool_calls'?reason:'other';
        if(choice?.message.refusal)return reject('refusal','OpenAI-compatible API declined the review.');
        if(reason==='content_filter')return reject('content-filter','OpenAI-compatible API filtered the model output.');
        if(reason==='tool_calls'||reason==='function_call'||choice?.message.tool_calls?.length||choice?.message.function_call!=null)return reject('unexpected-tool-call','OpenAI-compatible API returned an unexpected tool call.');
        if(reason==='length')return reject('output-length','OpenAI-compatible API ended at the output token limit.');
        if(reason&&reason!=='stop')return reject('incomplete','OpenAI-compatible API did not complete the review.');
        text=choice?.message.content??undefined;
    }
    if(!text?.trim())return reject('missing-output','OpenAI-compatible API returned no structured review.');
    const output=parseProviderJson(text);
    if(output===undefined)return reject('invalid-output-json','OpenAI-compatible API returned invalid structured JSON.');
    transport.responseOutcome='output-available';
    return {...metadata,output:usedSchema?normalizeCodexOutput(output,schema):output};
}

// Adapted from the OpenAI-compatible API client in Bakje item 19915.
export async function runOpenAiCompatible(input: EvaluationInput, options: ProviderPrompt): Promise<StructuredProviderResult> {
    const config = openAiCompatibleConfig();
    if (!config || !input.spec.model) return { error: 'Configure the OpenAI-compatible API URL and model in Settings.' };
    const timeout = AbortSignal.timeout(Math.max(1, Math.ceil(input.timeoutMs)));
    const signal = input.signal ? AbortSignal.any([input.signal, timeout]) : timeout;
    const format = config.apiFormat;
    const started = performance.now();
    const transport: ProviderTransport = {apiFormat:format,allocatedTimeoutMs:input.timeoutMs,...(input.callBudgetMetadata?{budget:input.callBudgetMetadata}:{}),startedAt:new Date().toISOString(),elapsedMs:0,outcome:'error',phase:'prepare',compatibilityRetries:0,attempts:[]};
    let attemptStarted = started;
    const finish = (result: StructuredProviderResult, outcome: ProviderTransport['outcome']): StructuredProviderResult => {
        transport.elapsedMs = Math.round(performance.now() - started);
        transport.outcome = outcome;
        const attempt = transport.attempts.at(-1);
        if (attempt) attempt.elapsedMs = Math.round(performance.now() - attemptStarted);
        return {...result, transport};
    };
    try {
        const url = completionUrl(config.baseUrl, format);
        const {content, images} = await buildProviderContent({ ...input, signal }, options.prompt);
        const body = requestBody(format, input, options, content);
        const headers: Record<string, string> = { 'content-type': 'application/json' };
        if (config.apiKey) headers.authorization = `Bearer ${config.apiKey}`;
        if (url.hostname === 'opencode.ai' || url.hostname.endsWith('.opencode.ai'))
            headers['x-opencode-session'] = randomUUID();
        const request = async () => {
            input.recordProviderImages?.(images);
            const previous = transport.attempts.at(-1);
            if (previous) previous.elapsedMs = Math.round(performance.now() - attemptStarted);
            attemptStarted = performance.now();
            transport.phase = 'request';
            const attempt: ProviderTransport['attempts'][number] = {startedAt:new Date().toISOString(),elapsedMs:0};
            transport.attempts.push(attempt);
            const response = await fetch(url, { method: 'POST', headers, body: JSON.stringify(body), signal, redirect: 'error' });
            attempt.headersReceivedAt = new Date().toISOString();
            attempt.headersElapsedMs = Math.round(performance.now() - attemptStarted);
            attempt.httpStatus = response.status;
            for (const name of ['x-request-id', 'request-id'] as const) {
                const value = response.headers.get(name);
                if (value && /^[A-Za-z0-9._:-]{1,128}$/.test(value)) {attempt.requestIdHeader=name;attempt.requestId=value;break;}
            }
            return response;
        };
        let response = await request();
        // Some endpoints reject supported-looking options one at a time.
        // Each retry removes at least one known optional field.
        while (response.status === 400) {
            transport.phase = 'read-error';
            const problem = await readResponse(response, MAX_ERROR_BYTES);
            const rejected = Object.entries(optionalFields[format]).filter(([field, mentions]) => field in body && mentions.test(problem));
            if (!rejected.length) break;
            for (const [field] of rejected) delete body[field];
            transport.compatibilityRetries++;
            response = await request();
        }
        if (!response.ok) {
            await response.body?.cancel().catch(() => undefined);
            return finish({ error: `OpenAI-compatible API request failed (HTTP ${response.status}).` }, 'http-error');
        }
        transport.phase = 'read-response';
        const text = await readResponse(response, MAX_RESPONSE_BYTES);
        transport.phase = 'parse';
        const raw: unknown = JSON.parse(text);
        const result = resultFromResponse(format, raw, options.schema, format === 'chat' ? 'response_format' in body : 'text' in body, transport);
        transport.phase = 'complete';
        return finish(result, 'completed');
    } catch {
        if (timeout.aborted) return finish({ hasTimedOut: true }, 'timeout');
        if (input.signal?.aborted) return finish({ error: 'OpenAI-compatible API request cancelled.' }, 'cancelled');
        return finish({ error: 'OpenAI-compatible API request failed. Check the endpoint, response format, and connection.' }, 'error');
    }
}
