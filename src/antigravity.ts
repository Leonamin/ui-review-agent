import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { mkdir, mkdtemp, open, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { StringDecoder } from 'node:string_decoder';
import { z } from 'zod';
import { buildProviderContent, parseProviderJson, schemaDirective, type ProviderPrompt, type StructuredProviderResult } from './provider-input.js';
import type { EvaluationInput, ReasoningEffort } from './types.js';

const outputLimit = 8 * 1024 * 1024;
const logLimit = 2 * 1024 * 1024;
const settingsSchema = z.object({
    configOptions: z.array(z.object({
        id: z.string(),
        currentValue: z.unknown(),
    })).optional(),
});
const sessionSchema = settingsSchema.extend({ sessionId: z.string().min(1).max(200) });
const initializeSchema = z.object({
    protocolVersion: z.literal(1),
    agentCapabilities: z.object({ promptCapabilities: z.object({ image: z.boolean().optional() }).optional() }).optional(),
});
const rpcSchema = z.object({
    jsonrpc: z.literal('2.0'),
    id: z.union([z.number(), z.string(), z.null()]).optional(),
    method: z.string().optional(),
    params: z.unknown().optional(),
    result: z.unknown().optional(),
    error: z.object({ code: z.number(), message: z.string() }).optional(),
});
const updateSchema = z.object({
    sessionId: z.string(),
    update: z.object({
        sessionUpdate: z.string(),
        content: z.object({ type: z.string(), text: z.string().optional() }).optional(),
    }),
});
const toolUpdates = new Set(['tool_call', 'tool_call_update']);

function environment(): NodeJS.ProcessEnv {
    // Keep the existing CLI login location and omit application/API credentials.
    const variables = ['HOME', 'PATH', 'USER', 'LOGNAME', 'USERPROFILE', 'SYSTEMROOT', 'WINDIR', 'APPDATA', 'LOCALAPPDATA',
        'TMP', 'TEMP', 'TMPDIR', 'LANG', 'LC_ALL', 'LC_CTYPE', 'SSL_CERT_FILE', 'SSL_CERT_DIR', 'HTTPS_PROXY', 'HTTP_PROXY', 'NO_PROXY',
        'https_proxy', 'http_proxy', 'no_proxy'];
    return Object.fromEntries(variables.map(key => [key, process.env[key]]).filter(([, value]) => value !== undefined));
}

async function verifyProfile(logPath: string, agent: string): Promise<void> {
    try {
        const log = await open(logPath, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
        try {
            const stat = await log.stat();
            if (!stat.isFile() || !stat.size || stat.size > logLimit) throw new Error();
            const bytes = Buffer.alloc(logLimit + 1);
            const { bytesRead } = await log.read(bytes, 0, bytes.length, 0);
            const text = bytes.subarray(0, bytesRead).toString('utf8');
            // Current agy ACP logs successful custom-agent selection and logs the exact agent on fallback.
            if (bytesRead > logLimit || !text.includes('Creating new cascade trajectory (agentScript=true)')
                || text.includes(`Agent "${agent}" not found`) || /agent.*falling back to default/i.test(text)) throw new Error();
        } finally {
            await log.close();
        }
    } catch {
        throw new Error('Antigravity CLI could not confirm the isolated review agent.');
    }
}

async function reviewSession(input: EvaluationInput, options: ProviderPrompt, cwd: string, agent: string, signal: AbortSignal): Promise<StructuredProviderResult> {
    const logPath = join(cwd, 'cli.log');
    const {content, images} = await buildProviderContent({ ...input, signal }, `${schemaDirective(options.schema)}\n\n${options.prompt}`);
    signal.throwIfAborted();
    const child = spawn('agy', ['acp', '--agent', agent, '--add-dir', cwd, '--sandbox', '--disable_telemetry',
        '--include-default-customizations=false', '--log-file', logPath], {
        cwd, env: environment(), stdio: ['pipe', 'pipe', 'pipe'], detached: process.platform !== 'win32', windowsHide: true,
    });
    const decoder = new StringDecoder('utf8');
    let pending = '';
    let receivedBytes = 0;
    let nextId = 0;
    let sessionId: string | undefined;
    let responseText = '';
    let failure: Error | undefined;
    let hasStartedPrompt = false;
    let request: { id: number; resolve: (result: unknown) => void; reject: (error: Error) => void } | undefined;
    const kill = (processSignal: NodeJS.Signals) => {
        try {
            if (child.pid && process.platform !== 'win32') process.kill(-child.pid, processSignal);
            else child.kill(processSignal);
        } catch { /* Already exited. */ }
    };
    const stop = (error: Error) => {
        failure ??= error;
        request?.reject(failure);
        request = undefined;
        kill('SIGTERM');
    };
    const onAbort = () => stop(new Error('Antigravity CLI review was interrupted.'));
    signal.addEventListener('abort', onAbort, { once: true });
    if (signal.aborted) onAbort();
    const send = (value: object) => child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', ...value })}\n`);
    const call = (method: string, params: object): Promise<unknown> => new Promise((resolve, reject) => {
        if (failure) { reject(failure); return; }
        const id = ++nextId;
        request = { id, resolve, reject };
        send({ id, method, params });
    });
    const consume = (line: string) => {
        if (!line.trim() || failure) return;
        try {
            const message = rpcSchema.parse(JSON.parse(line));
            if (message.method && message.id !== undefined) {
                if (message.method === 'session/request_permission') {
                    send({ id: message.id, result: { outcome: { outcome: 'cancelled' } } });
                } else {
                    send({ id: message.id, error: { code: -32601, message: 'Method not available' } });
                }
                stop(new Error('Antigravity attempted a tool call; review output was rejected.'));
                return;
            }
            if (message.method === 'session/update') {
                const { sessionId: updateId, update } = updateSchema.parse(message.params);
                if (toolUpdates.has(update.sessionUpdate)) {
                    stop(new Error('Antigravity attempted a tool call; review output was rejected.'));
                } else if (hasStartedPrompt && updateId === sessionId && update.sessionUpdate === 'agent_message_chunk' && update.content?.type === 'text') {
                    responseText += update.content.text ?? '';
                }
                return;
            }
            if (!request || request.id !== message.id) return;
            const current = request;
            request = undefined;
            if (!message.error) current.resolve(message.result);
            else if (message.error.code === -32000 || /authenticat|not signed in|login required/i.test(message.error.message)) {
                current.reject(new Error('Antigravity authentication is required. Sign in with agy on the server.'));
            } else {
                current.reject(new Error('Antigravity CLI rejected the review request.'));
            }
        } catch {
            stop(new Error('Antigravity CLI returned an invalid protocol response.'));
        }
    };
    child.stdout.on('data', (chunk: Buffer) => {
        receivedBytes += chunk.length;
        if (receivedBytes > outputLimit) {
            stop(new Error('Antigravity CLI output exceeded its size limit.'));
            return;
        }
        pending += decoder.write(chunk);
        let newline: number;
        while ((newline = pending.indexOf('\n')) !== -1) {
            consume(pending.slice(0, newline));
            pending = pending.slice(newline + 1);
        }
    });
    child.stderr.resume();
    child.stdin.on('error', () => stop(new Error('Antigravity CLI stopped accepting requests.')));
    child.once('error', () => stop(new Error('Antigravity CLI could not be started. Check that agy is installed on the server.')));
    const closed = new Promise<void>(resolve => child.once('close', () => {
        pending += decoder.end();
        if (pending.trim()) consume(pending);
        if (request) stop(new Error('Antigravity CLI exited before completing the review.'));
        resolve();
    }));
    try {
        const agentInfo = initializeSchema.parse(await call('initialize', { protocolVersion: 1, clientCapabilities: {}, clientInfo: { name: 'ui-review-agent', version: '1.0.0' } }));
        if (content.some(part => part.type === 'image') && agentInfo.agentCapabilities?.promptCapabilities?.image !== true)
            throw new Error('Antigravity CLI does not support native image input in this version.');
        const session = sessionSchema.parse(await call('session/new', { cwd, mcpServers: [] }));
        sessionId = session.sessionId;
        await verifyProfile(logPath, agent);
        let config = session.configOptions;
        const select = async (configId: 'model' | 'thought_level', value: string) => {
            const option = config?.find(option => option.id === configId);
            if (!option) throw new Error(`Antigravity CLI does not expose the requested ${configId === 'model' ? 'model' : 'reasoning effort'} option.`);
            if (option.currentValue === value) return;
            const result = settingsSchema.parse(await call('session/set_config_option', { sessionId, configId, value }));
            if (result.configOptions?.find(option => option.id === configId)?.currentValue !== value)
                throw new Error(`Antigravity CLI did not apply the requested ${configId === 'model' ? 'model' : 'reasoning effort'}.`);
            config = result.configOptions;
        };
        if (input.spec.model) await select('model', input.spec.model);
        if (input.spec.reasoningEffort) await select('thought_level', input.spec.reasoningEffort);
        const model = config?.find(option => option.id === 'model')?.currentValue;
        const effort = config?.find(option => option.id === 'thought_level')?.currentValue;
        hasStartedPrompt = true;
        input.recordProviderImages?.(images);
        const result = z.object({ stopReason: z.string() }).parse(await call('session/prompt', { sessionId, prompt: content }));
        if (failure) throw failure;
        if (result.stopReason !== 'end_turn') return { error: 'Antigravity CLI did not complete the review.' };
        return {
            output: parseProviderJson(responseText),
            model: typeof model === 'string' && model.length <= 256 ? model : undefined,
            reasoningEffort: typeof effort === 'string' && ['low', 'medium', 'high'].includes(effort) ? effort as ReasoningEffort : undefined,
        };
    } finally {
        signal.removeEventListener('abort', onAbort);
        child.stdin.end();
        kill('SIGTERM');
        const force = setTimeout(() => kill('SIGKILL'), 700);
        force.unref();
        await closed;
        clearTimeout(force);
        // Kill any remaining subprocesses owned by this invocation before removing the workspace.
        kill('SIGKILL');
    }
}

export async function runAntigravity(input: EvaluationInput, options: ProviderPrompt): Promise<StructuredProviderResult> {
    const timeout = AbortSignal.timeout(Math.max(1, Math.ceil(input.timeoutMs)));
    const signal = input.signal ? AbortSignal.any([input.signal, timeout]) : timeout;
    const cwd = await mkdtemp(join(tmpdir(), 'usability-antigravity-'));
    try {
        if (input.spec.model && !/^[a-zA-Z0-9][a-zA-Z0-9._/-]{0,127}$/.test(input.spec.model))
            return { error: 'Antigravity model must be a valid model identifier.' };
        const agent = `ui-review-${randomUUID()}`;
        const dir = join(cwd, '.agents', 'agents', agent);
        await mkdir(dir, { recursive: true, mode: 0o700 });
        await writeFile(join(dir, 'agent.md'), [
            '---', `name: ${agent}`, 'description: Isolated UI screenshot evaluation',
            'mainAgent: true', 'subagent: false', 'tools: []', 'commandExecutionPolicy: "off"',
            'inheritMcp: false', 'inheritCustomizations: false', '---', options.instructions,
            'Use only the evidence inside the request. Never use tools.', '',
        ].join('\n'), { mode: 0o600 });
        return await reviewSession(input, options, cwd, agent, signal);
    } catch (error) {
        if (timeout.aborted) return { hasTimedOut: true };
        if (input.signal?.aborted) return { error: 'Antigravity CLI review was cancelled.' };
        return { error: error instanceof Error && error.message.startsWith('Antigravity ') ? error.message : 'Antigravity CLI could not complete the isolated review.' };
    } finally {
        await rm(cwd, { recursive: true, force: true });
    }
}
