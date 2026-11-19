import {readStoredReviewTask} from './helpers/review-state.js';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { runAntigravity } from '../src/antigravity.js';
import { evaluateStage } from '../src/evaluator.js';
import { runOpenAiCompatible } from '../src/openai-compatible.js';
import { ReviewService } from '../src/review-service.js';
import { runWithOpenAiCompatible } from '../src/review-settings-runtime.js';
import type { EvaluationInput, EvaluatorProvider, ReviewResult } from '../src/types.js';

const prompt = {
    instructions: 'Analyze the supplied screenshot.',
    prompt: 'What is the main color?',
    schema: { type: 'object', properties: { color: { type: 'string' }, note: { type: 'string' } }, required: ['color'], additionalProperties: false },
};

function input(runDir: string, evaluator: EvaluatorProvider, model = 'fixture-model'): EvaluationInput {
    return {
        runId: 'run',
        runDir,
        spec: { evaluator, model, reasoningEffort: 'high' },
        timeoutMs: 3000,
        observations: [],
        evidence: [],
        rules: [],
        actions: [],
    } as unknown as EvaluationInput;
}

async function screenshot(runDir: string, evaluator: EvaluatorProvider): Promise<EvaluationInput> {
    const absolutePath = join(runDir, 'fixture.png');
    const bytes = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a/vQAAAAASUVORK5CYII=', 'base64');
    await writeFile(absolutePath, bytes);
    return {
        ...input(runDir, evaluator),
        observations: [{ observationId: 'screen', screenshotRefs: ['screenshot'] }],
        evidence: [{ evidenceId: 'screenshot', kind: 'screenshot', absolutePath, mimeType: 'image/png', sha256: createHash('sha256').update(bytes).digest('hex') }],
    } as unknown as EvaluationInput;
}

async function listen(handle: (req: IncomingMessage, res: ServerResponse) => void) {
    const server = createServer(handle);
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    assert(address && typeof address !== 'string');
    return { url: `http://127.0.0.1:${address.port}/v1`, close: () => new Promise<void>(resolve => server.close(() => resolve())) };
}

async function requestJson(req: IncomingMessage): Promise<Record<string, any>> {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(chunk);
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}

test('compatible API supports multimodal Chat, credential headers, schema fallback, and returned usage', async t => {
    const dir = await mkdtemp(join(tmpdir(), 'provider-chat-'));
    t.after(() => rm(dir, { recursive: true, force: true }));
    const calls: Array<{ url?: string; credential?: string; body: Record<string, any> }> = [];
    const server = await listen(async (req, res) => {
        calls.push({ url: req.url, credential: req.headers.authorization, body: await requestJson(req) });
        const rejectedField = ['response_format', 'reasoning_effort'][calls.length - 1];
        if (rejectedField) {
            res.writeHead(400).end(`Unsupported parameter: ${rejectedField}`);
            return;
        }
        res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({
            model: 'resolved-model',
            choices: [{ finish_reason: 'stop', message: { content: 'Result: \`\`\`json\n{"color":"red"}\n\`\`\`' } }],
            usage: { prompt_tokens: 51, completion_tokens: 11, prompt_tokens_details: { cached_tokens: 20 } },
        }));
    });
    t.after(server.close);
    const runInput = await screenshot(dir, 'openai-compatible');
    const result = await runWithOpenAiCompatible({ baseUrl: `${server.url}/`, apiKey: 'fixture-secret', apiFormat: 'chat' }, () => runOpenAiCompatible(runInput, prompt));
    const {transport,...contentResult}=result;
    assert.deepEqual(contentResult, { output: { color: 'red' }, model: 'resolved-model', usage: { inputTokens: 51, outputTokens: 11, cacheReadInputTokens: 20 } });
    assert.equal(transport?.allocatedTimeoutMs,runInput.timeoutMs);
    assert.equal(transport?.compatibilityRetries,2);
    assert.deepEqual(transport?.attempts.map(item=>item.httpStatus),[400,400,200]);
    assert.equal(transport?.outcome,'completed');
    assert.equal(transport?.phase,'complete');
    assert(transport!.attempts.every(item=>item.headersReceivedAt&&item.headersElapsedMs!==undefined));
    assert(!JSON.stringify(transport).includes('fixture-secret'));
    assert(!JSON.stringify(transport).includes('Unsupported parameter'));
    assert.equal(calls.length, 3);
    assert.equal(calls[0].url, '/v1/chat/completions');
    assert.equal(calls[0].credential, 'Bearer fixture-secret');
    assert.match(calls[0].body.messages[1].content[2].image_url.url, /^data:image\/png;base64,/);
    assert.equal(calls[0].body.response_format.type, 'json_schema');
    assert.equal(calls[0].body.reasoning_effort, 'high');
    assert.equal(calls[1].body.response_format, undefined);
    assert.equal(calls[1].body.reasoning_effort, 'high');
    assert.equal(calls[2].body.response_format, undefined);
    assert.equal(calls[2].body.reasoning_effort, undefined);
});

test('URL review uses the saved compatible evaluator with live browser evidence', async t => {
    const dir = await mkdtemp(join(tmpdir(), 'provider-url-review-'));
    const requests: Array<{ url?: string; authorization?: string; body: Record<string, any> }> = [];
    const server = await listen(async (req, res) => {
        if (req.method === 'GET') {
            res.writeHead(200, { 'content-type': 'text/html' }).end(
                '<!doctype html><html lang="en"><meta charset="utf-8"><title>Orders</title><main><h1>Orders</h1><p>Review incoming orders.</p></main></html>',
            );
            return;
        }
        const body = await requestJson(req);
        requests.push({ url: req.url, authorization: req.headers.authorization, body });
        const hasStateSchema = Boolean(body.response_format?.json_schema?.schema?.properties?.readiness);
        const review = hasStateSchema ? {
            readiness: 'ready', screenState: 'content', reason: 'The orders heading and content are visible.', dismissElementRef: null,
        } : {
            findings: [],
            screenMap: JSON.parse(body.messages[1].content[0].text.split('\n')[0]).observations.map((observation: {observationId: string; screenshotRefs: string[]}) => ({
                observationId: observation.observationId,
                sections: [{
                    sectionId: 'orders', label: 'Orders', elementRefs: [],
                    evidenceIds: observation.screenshotRefs, visibleSummary: 'The orders screen heading is visible.',
                }],
            })),
            interpretations: [],
            limitations: [],
        };
        res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({
            model: 'resolved-vision-model',
            choices: [{ finish_reason: 'stop', message: { content: JSON.stringify(review) } }],
        }));
    });
    const service = new ReviewService(dir);
    t.after(async () => {
        await service.close();
        await server.close();
        await rm(dir, { recursive: true, force: true });
    });
    await service.start();
    await service.updateSettings({
        defaultEvaluator: 'openai-compatible',
        providers: { 'openai-compatible': { model: 'fixture-vision', baseUrl: server.url, apiKey: 'fixture-secret', apiFormat: 'chat' } },
    });
    const targetUrl = new URL('/orders', server.url).href;
    const { task } = await service.submit({
        submissionId: 'compatible-url-review',
        title: 'Orders review',
        purpose: 'Review orders screen readability.',
        targets: [{ kind: 'url', name: 'Orders', url: targetUrl }],
        options: { timeoutSeconds: 15 },
    });
    const attempt = async () => (await readStoredReviewTask(service, task.taskId)).revisions[0].targets[0].attempts[0];
    const deadline = Date.now() + 20_000;
    let latest = await attempt();
    while (latest.status === 'queued' || latest.status === 'running') {
        assert(Date.now() < deadline, 'URL review did not finish');
        await new Promise(resolve => setTimeout(resolve, 25));
        latest = await attempt();
    }
    assert.equal(latest.status, 'completed', latest.error);
    assert.equal(latest.runStatus, 'completed');
    assert(latest.runId && latest.reportId);
    const report: ReviewResult = JSON.parse(await readFile(join(dir, 'review-attempts', latest.attemptId, latest.runId, 'report.json'), 'utf8'));
    assert.equal(report.provider, 'openai-compatible');
    const runDir=join(dir,'review-attempts',latest.attemptId,latest.runId);
    const diagnosticFiles=(await readdir(runDir)).filter(name=>name.startsWith('provider-transport-'));
    assert.equal(diagnosticFiles.length,2);
    const transport=JSON.parse(await readFile(join(runDir,diagnosticFiles[0]),'utf8'));
    assert.equal(transport.attempts[0].httpStatus,200);
    assert.equal(transport.outcome,'completed');
    assert(!JSON.stringify(transport).includes('fixture-secret'));
    assert(!JSON.stringify(transport).includes(targetUrl));
    assert.equal(report.evaluation.model, 'resolved-vision-model');
    assert.equal(report.observations[0].url, targetUrl);
    assert.equal(report.evaluation.screenMap[0].sections[0].label, 'Orders');
    assert.equal(report.stateDiscovery?.status, 'completed');
    assert.equal(report.observations.length, 2);
    assert.equal(report.evaluation.screenMap.length, 2);
    assert.equal(requests.length, 2);
    for (const request of requests) {
        assert.equal(request.url, '/v1/chat/completions');
        assert.equal(request.authorization, 'Bearer fixture-secret');
        assert.equal(request.body.model, 'fixture-vision');
    }
    assert(requests[0].body.response_format.json_schema.schema.properties.readiness);
    assert.equal(requests[1].body.response_format.json_schema.schema.properties.readiness, undefined);
    const content = requests[1].body.messages[1].content;
    assert.match(content[0].text, /"pageTitle":"Orders"/);
    assert.match(content[2].image_url.url, /^data:image\/png;base64,/);
    assert.match(content[4].image_url.url, /^data:image\/png;base64,/);
    assert.match(content[5].text, /^Untrusted rule evidence obs-002-rule:/);
    const submittedImages=report.evaluation.calls?.at(-1)?.imageInputs;
    assert.deepEqual(submittedImages?.map(image=>image.evidenceId),report.observations.flatMap(observation=>observation.screenshotRefs));
    assert.deepEqual(submittedImages?.map(image=>image.sha256),[content[2],content[4]].map(part=>
        createHash('sha256').update(Buffer.from(part.image_url.url.split(',')[1], 'base64')).digest('hex')));
});

test('compatible API parses multimodal Responses and normalizes optional structured fields', async t => {
    const dir = await mkdtemp(join(tmpdir(), 'provider-responses-'));
    t.after(() => rm(dir, { recursive: true, force: true }));
    let actualPath: string | undefined;
    let payload: Record<string, any> | undefined;
    const server = await listen(async (req, res) => {
        actualPath = req.url;
        payload = await requestJson(req);
        res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({
            status: 'completed', model: 'resolved-model',
            output: [{ type: 'reasoning' }, { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: '{"color":"red","note":null}' }] }],
            usage: { input_tokens: 64, output_tokens: 14 },
        }));
    });
    t.after(server.close);
    const runInput = await screenshot(dir, 'openai-compatible');
    const result = await runWithOpenAiCompatible({ baseUrl: server.url, apiFormat: 'responses' }, () => runOpenAiCompatible(runInput, prompt));
    assert.equal(actualPath, '/v1/responses');
    assert.match(payload?.input[0].content[2].image_url, /^data:image\/png;base64,/);
    assert.equal(payload?.text.format.type, 'json_schema');
    assert.equal(payload?.store, false);
    assert.equal(payload?.reasoning.effort, 'high');
    assert.deepEqual(result.output, { color: 'red' });
    assert.equal(result.usage?.inputTokens, 64);
});

test('compatible API rejects redirects and redacts provider errors', async t => {
    let redirectedRequests = 0;
    const external = await listen((_req, res) => { redirectedRequests++; res.writeHead(200).end('{}'); });
    const source = await listen((req, res) => {
        req.resume();
        res.writeHead(302, { location: external.url }).end();
    });
    const bad = await listen((req, res) => { req.resume(); res.writeHead(401).end('fixture-secret should stay out of reports'); });
    t.after(external.close);
    t.after(source.close);
    t.after(bad.close);
    const runInput = input(tmpdir(), 'openai-compatible');
    const call = (baseUrl: string) => runWithOpenAiCompatible({ baseUrl, apiFormat: 'chat', apiKey: 'fixture-secret' }, () => runOpenAiCompatible(runInput, prompt));
    assert.match((await call(source.url)).error ?? '', /request failed/);
    assert.equal(redirectedRequests, 0);
    assert.equal((await call(bad.url)).error, 'OpenAI-compatible API request failed (HTTP 401).');
});

test('successful HTTP transport distinguishes unusable output from refusal or tool policy without retaining raw response', async t => {
    const dir = await mkdtemp(join(tmpdir(), 'provider-output-codes-'));
    t.after(() => rm(dir,{recursive:true,force:true}));
    const responses = [
        {choices:[{finish_reason:'stop',message:{content:null}}],usage:{completion_tokens:7}},
        {choices:[{finish_reason:'length',message:{content:'{not-valid-fixture-secret'}}],usage:{completion_tokens:8}},
        {choices:[{finish_reason:'stop',message:{content:'{"color":"pink"}',refusal:'fixture-secret refusal'}}]},
        {choices:[{finish_reason:'tool_calls',message:{tool_calls:[{id:'fixture-secret tool'}]}}]},
        {error:{message:'fixture-secret gateway error'}},
        {unexpected:'fixture-secret bad envelope'},
        {status:'incomplete',incomplete_details:{reason:'content_filter'},output:[]},
    ];
    const server = await listen((req,res) => {
        req.resume();
        res.setHeader('content-type','application/json').end(JSON.stringify(responses.shift()));
    });
    t.after(server.close);
    const runInput=await screenshot(dir,'openai-compatible');
    const codes=['missing-output','output-length','refusal','unexpected-tool-call','provider-error','invalid-envelope','content-filter'];
    for(const [index,code] of codes.entries()){
        const apiFormat=index===6?'responses':'chat';
        const result=await runWithOpenAiCompatible({baseUrl:server.url,apiFormat},()=>runOpenAiCompatible(runInput,prompt));
        assert.equal(result.transport?.outcome,'completed');
        assert.equal(result.transport?.responseOutcome,code);
        assert.equal(result.transport?.attempts.length,1);
        assert.equal(result.transport?.attempts[0].httpStatus,200);
        assert.equal(result.output,undefined);
        assert.doesNotMatch(JSON.stringify(result),/fixture-secret/);
        if(index<2){
            assert.equal(result.usage?.outputTokens,7+index);
            assert.equal(result.transport?.usage?.outputTokens,7+index);
        }
    }
});

test('follow-up output repair does not retry refusal after successful HTTP transport', async t => {
    const dir=await mkdtemp(join(tmpdir(),'provider-output-refusal-'));
    t.after(()=>rm(dir,{recursive:true,force:true}));
    let requestCount=0;
    const server=await listen((req,res)=>{
        req.resume();requestCount++;
        res.setHeader('content-type','application/json').end(JSON.stringify({choices:[{finish_reason:'stop',message:{refusal:'private refusal'}}]}));
    });
    t.after(server.close);
    const runInput=await screenshot(dir,'openai-compatible');
    const result=await runWithOpenAiCompatible({baseUrl:server.url,apiFormat:'chat'},()=>evaluateStage(runInput,{},{
        name:'followup-action',basePrompt:'Fixture prompt',schema:prompt.schema,
        shouldRepairUnreadableOutput:true,shouldStoreCandidateDraft:false,
        validate:async()=>assert.fail('A refusal must not reach stage validation'),
    }));
    assert.equal(result.status,'failed');
    assert.equal(requestCount,1);
    assert.deepEqual(result.calls?.map(call=>[call.failureCode,call.isRepair]),[['refusal',false]]);
    assert.doesNotMatch(JSON.stringify(result),/private refusal/);
});

const fakeAgy = String.raw`#!/usr/bin/env node
const { createInterface } = require('node:readline');
const { existsSync, readFileSync, writeFileSync } = require('node:fs');
const { join } = require('node:path');
const args = process.argv.slice(2);
const agent = args[args.indexOf('--agent') + 1];
const log = args[args.indexOf('--log-file') + 1];
const profile = join(process.cwd(), '.agents', 'agents', agent, 'agent.md');
const mode = readFileSync(join(__dirname, 'mode'), 'utf8');
const send = (object) => process.stdout.write(JSON.stringify({jsonrpc:'2.0', ...object}) + '\n');
const configs = [{id:'model',currentValue:'default-model'},{id:'thought_level',currentValue:'medium'}];
const update = (sessionId, message) => send({method:'session/update',params:{sessionId,update:message}});
createInterface({input:process.stdin}).on('line', (line) => {
    const message = JSON.parse(line);
    const reply = (result) => send({id:message.id, result});
    if (message.method === 'initialize') {
        reply({protocolVersion:1, agentCapabilities:{promptCapabilities:{image:true}}});
    } else if (message.method === 'session/new') {
        if (!existsSync(profile) || !readFileSync(profile,'utf8').includes('tools: []\ncommandExecutionPolicy: "off"\ninheritMcp: false\ninheritCustomizations: false')
            || !args.includes('--include-default-customizations=false') || message.params.mcpServers.length !== 0) process.exit(10);
        writeFileSync(log, mode === 'fallback' ? 'Agent "' + agent + '" not found, falling back to default' : 'Creating new cascade trajectory (agentScript=true)');
        reply({sessionId:'fixture-session', configOptions:configs});
    } else if (message.method === 'session/set_config_option') {
        configs.find(config => config.id === message.params.configId).currentValue = message.params.value;
        reply({configOptions:configs});
    } else if (message.method === 'session/prompt') {
        if (message.params.sessionId !== 'fixture-session' || !message.params.prompt.some(part => part.type === 'image' && part.mimeType === 'image/png')) process.exit(11);
        if (mode === 'tool') update('fixture-session', {sessionUpdate:'tool_call'});
        update('unrelated-session', {sessionUpdate:'agent_message_chunk',content:{type:'text',text:'{"ignore":true}'}});
        update('fixture-session', {sessionUpdate:'agent_message_chunk',content:{type:'text',text:'{"color":"red"}'}});
        reply({stopReason:'end_turn'});
    }
});
`;

test('Antigravity uses an isolated ACP profile and native images, and fails closed for fallback and tool calls', { skip: process.platform === 'win32' }, async t => {
    const dir = await mkdtemp(join(tmpdir(), 'provider-acp-'));
    t.after(() => rm(dir, { recursive: true, force: true }));
    await writeFile(join(dir, 'agy'), fakeAgy, { mode: 0o700 });
    const originalPath = process.env.PATH;
    process.env.PATH = `${dir}:${originalPath ?? ''}`;
    t.after(() => { if (originalPath === undefined) delete process.env.PATH; else process.env.PATH = originalPath; });
    const review = await screenshot(dir, 'antigravity');
    const call = async (mode: string) => {
        await writeFile(join(dir, 'mode'), mode);
        return runAntigravity(review, prompt);
    };
    assert.deepEqual(await call('success'), { output: { color: 'red' }, model: 'fixture-model', reasoningEffort: 'high' });
    assert.match((await call('fallback')).error ?? '', /could not confirm the isolated review agent/);
    assert.match((await call('tool')).error ?? '', /tool call/);
});

test('evaluation dispatch validates new provider output and records the actual model and effort', async t => {
    const dir = await mkdtemp(join(tmpdir(), 'provider-evaluation-'));
    t.after(() => rm(dir, { recursive: true, force: true }));
    const runInput = await screenshot(dir, 'antigravity');
    const result = await evaluateStage(runInput, {
        runAntigravity: async () => ({ output: { color: 'red' }, model: 'actual-model', reasoningEffort: 'high', usage: { inputTokens: 50, cacheReadInputTokens: 10 } }),
    }, {
        name: 'fixture', basePrompt: 'Classify the screenshot', schema: prompt.schema,
        async validate(output) {
            assert.deepEqual(output, { color: 'red' });
            return { status: 'completed', findings: [], screenMap: [], interpretations: [], limitations: [] };
        },
    });
    assert.equal(result.provider, 'antigravity');
    assert.equal(result.model, 'actual-model');
    assert.equal(result.usage?.inputTokens, 50);
    assert.equal(result.calls?.[0].actualReasoningEffort, 'high');
});

test('compatible transport diagnostics distinguish header waits from body waits without recording secrets',async t=>{
 const slowHeaders=await listen((req,_res)=>{req.resume();});
 const slowBody=await listen((req,res)=>{req.resume();res.writeHead(200,{'content-type':'application/json','x-request-id':'request_fixture-123','x-private':'do-not-record'});res.flushHeaders();res.write('{');});
 t.after(slowHeaders.close);t.after(slowBody.close);
 for(const [server,phase] of [[slowHeaders,'request'],[slowBody,'read-response']] as const){
  const result=await runWithOpenAiCompatible({baseUrl:server.url,apiKey:'fixture-secret',apiFormat:'chat'},()=>runOpenAiCompatible({...input(tmpdir(),'openai-compatible'),timeoutMs:100},prompt));
  assert.equal(result.hasTimedOut,true);assert.equal(result.transport?.outcome,'timeout');assert.equal(result.transport?.phase,phase);assert.equal(result.transport?.compatibilityRetries,0);
  assert(result.transport!.elapsedMs>=75);assert.equal(result.transport?.attempts.length,1);
  const attempt=result.transport!.attempts[0];
  if(phase==='request'){assert.equal(attempt.httpStatus,undefined);assert.equal(attempt.headersReceivedAt,undefined);}
  else {assert.equal(attempt.httpStatus,200);assert.equal(attempt.requestId,'request_fixture-123');assert.equal(attempt.requestIdHeader,'x-request-id');assert(attempt.headersReceivedAt);}
  const text=JSON.stringify(result.transport);for(const secret of ['fixture-secret','do-not-record','Authorization','content-type',server.url,prompt.prompt])assert(!text.includes(secret));
 }
});
