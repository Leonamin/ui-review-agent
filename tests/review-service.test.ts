import {readStoredReviewTask, readStoredReviewTasks} from './helpers/review-state.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, mkdir, writeFile, readFile, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import sharp from 'sharp';
import { ReviewService } from '../src/review-service.js';
import type { inspect } from '../src/core.js';
import type { RunSpec } from '../src/types.js';
import { openAiCompatibleConfig } from '../src/review-settings-runtime.js';
import { reviewSubmissionSchema } from '../src/review-contract.js';
const input = (id = randomUUID()) => ({ submissionId: id, title: '상품 화면', purpose: '가독성 확인', targets: [{ kind: 'url', name: '목록', url: 'http://localhost:3000' }] });
async function waitFor(fn: () => Promise<boolean>) {
    const end = Date.now() + 5000;
    while (Date.now() < end) {
        if (await fn())
            return;
        await new Promise(r => setTimeout(r, 10));
    }
    throw new Error('timeout');
}
const engine = (handler?: (url: string | undefined) => void) => async (spec: any, root: string) => { handler?.(spec.targetUrl); const runId = randomUUID(), runDir = resolve(root, runId); await mkdir(runDir, { recursive: true }); await writeFile(resolve(runDir, 'report.json'), JSON.stringify({ runId, status: 'partial', endedAt: new Date().toISOString() })); return { result: { runId, status: 'partial' }, runDir }; };
test('submission idempotency, immutable revisions, mixed targets, partial reports and serialized calls', async () => {
    const root = await mkdtemp(resolve(tmpdir(), 'reviews-'));
    let count = 0;
    const service = new ReviewService(root, { inspect: engine(() => { count++; }) as typeof inspect });
    try {
        await service.start();
        const bytes = await sharp({ create: { width: 32, height: 32, channels: 3, background: 'white' } }).png().toBuffer();
        const asset = await service.upload({ fileName: 'example.png', base64: bytes.toString('base64') });
        const request = { ...input(), targets: [...input().targets, { kind: 'image', name: '수정', assetId: asset.assetId }] };
        const [a, b] = await Promise.all([service.submit(request), service.submit(request)]);
        assert.equal(a.task.taskId, b.task.taskId);
        assert.equal((await readStoredReviewTasks(service)).length, 1);
        await assert.rejects(service.submit({ ...request, title: '다른 제목' }), /다른 입력/);
        await waitFor(async () => { const t = await readStoredReviewTask(service, a.task.taskId); return t.revisions[0].targets.every(x => x.attempts[0].status === 'completed'); });
        assert.equal(count, 2);
        const done = await readStoredReviewTask(service, a.task.taskId);
        assert.equal(done.revisions[0].targets[0].attempts[0].runStatus, 'partial');
        assert.match(done.revisions[0].targets[0].attempts[0].reportId!, /^[a-f0-9]{64}$/);
        const next = await service.submit({ ...request, submissionId: randomUUID(), title: '수정 후', targets: done.revisions[0].targets.map(({ attempts, ...target }) => target) }, a.task.taskId);
        assert.equal(next.revision.number, 2);
        assert.equal(next.task.revisions[0].title, '상품 화면');
        assert.equal(next.revision.targets[0].targetId, done.revisions[0].targets[0].targetId);
        await assert.rejects(service.submit({ ...input(), targets: [{ kind: 'image', name: '없음', assetId: randomUUID() }] }), /이미지/);
    }
    finally {
        await service.close();
        await rm(root, { recursive: true, force: true });
    }
});
test('failed target retry requires current attempt and preserves attempts', async () => {
    const root = await mkdtemp(resolve(tmpdir(), 'reviews-'));
    let hasFailed = false;
    const service = new ReviewService(root, { inspect: engine(() => {
            if (!hasFailed) {
                hasFailed = true;
                throw new Error('connection failed');
            }
        }) as typeof inspect });
    try {
        await service.start();
        const created = await service.submit(input());
        const tid = created.task.taskId;
        await waitFor(async () => (await readStoredReviewTask(service, tid)).revisions[0].targets[0].attempts[0].status === 'failed');
        const revision = (await readStoredReviewTask(service, tid)).revisions[0], target = revision.targets[0], attempt = target.attempts[0];
        await assert.rejects(service.retry(tid, revision.revisionId, target.targetId, randomUUID(), randomUUID()), /오래된/);
        const key = randomUUID();
        await Promise.all([service.retry(tid, revision.revisionId, target.targetId, key, attempt.attemptId), service.retry(tid, revision.revisionId, target.targetId, key, attempt.attemptId)]);
        await waitFor(async () => (await readStoredReviewTask(service, tid)).revisions[0].targets[0].attempts.at(-1)?.status === 'completed');
        const attempts = (await readStoredReviewTask(service, tid)).revisions[0].targets[0].attempts;
        assert.equal(attempts.length, 2);
        assert.equal(attempts[0].error, 'connection failed');
        await assert.rejects(service.retry(tid, revision.revisionId, target.targetId, randomUUID(), attempts[1].attemptId), /실패한/);
    }
    finally {
        await service.close();
        await rm(root, { recursive: true, force: true });
    }
});
test('URL theme and group settings are validated and retained across retry and revision', async () => {
    const root = await mkdtemp(resolve(tmpdir(), 'review-theme-'));
    const specs: Pick<RunSpec, 'themeReview' | 'alignmentContracts'>[] = [];
    const service = new ReviewService(root, { inspect: (async (spec, output) => {
        const { themeReview, alignmentContracts } = spec;
        specs.push({ themeReview, alignmentContracts });
        if (specs.length === 1) throw new Error('first attempt fails');
        return engine()(spec, output);
    }) as typeof inspect });
    const themeReview = { mode: 'both', selectors: { light: 'html[data-mode=light]', dark: 'html[data-mode=dark]' } } as const;
    const alignmentContracts = [{ groupSelector: '[role=toolbar]', crossSize: 'mixed', alignment: 'center' }] as const;
    const settings = { themeReview, alignmentContracts };
    const request = input();
    const target = { ...request.targets[0], ...settings };
    try {
        await service.start();
        assert.equal(reviewSubmissionSchema.safeParse({ ...request, targets: [{ kind: 'image', name: '사진', assetId: randomUUID(), themeReview }] }).success, false);
        assert.equal(reviewSubmissionSchema.safeParse({ ...request, targets: [{ ...target, alignmentContracts: [{ groupSelector: '[role=toolbar]' }] }] }).success, false);
        const created = await service.submit({ ...request, targets: [target] });
        const { taskId } = created.task;
        const { revisionId, targets: [stored] } = created.revision;
        assert.equal(stored.kind, 'url');
        assert.deepEqual(stored.themeReview, themeReview);
        assert.deepEqual(stored.alignmentContracts, alignmentContracts);
        await waitFor(async () => (await readStoredReviewTask(service, taskId)).revisions[0].targets[0].attempts[0].status === 'failed');
        await service.retry(taskId, revisionId, stored.targetId, randomUUID(), stored.attempts[0].attemptId);
        const revised = await service.submit({ ...input(), targets: [{ ...target, targetId: stored.targetId }] }, taskId);
        await waitFor(async () => (await readStoredReviewTask(service, taskId)).revisions[1].targets[0].attempts[0].status === 'completed');
        assert.deepEqual(specs, [settings, settings, settings]);
        assert.equal(revised.revision.targets[0].targetId, stored.targetId);
    } finally {
        await service.close();
        await rm(root, { recursive: true, force: true });
    }
});

test('saved evaluator defaults reach jobs, explicit options win and retries keep the accepted settings', async () => {
    const root = await mkdtemp(resolve(tmpdir(), 'review-defaults-'));
    const received: { evaluator: string; model?: string; reasoningEffort?: string }[] = [];
    const service = new ReviewService(root, { inspect: (async (spec: RunSpec, output: string) => {
        const { evaluator, model, reasoningEffort } = spec;
        received.push({ evaluator, model, reasoningEffort });
        if (received.length === 1)
            throw new Error('first attempt fails');
        return engine()(spec, output);
    }) as typeof inspect });
    try {
        await service.start();
        await service.updateSettings({
            revision: 0,
            defaultEvaluator: 'claude',
            providers: { claude: { model: 'sonnet', reasoningEffort: 'low' } },
        });
        const request = input();
        const created = await service.submit(request);
        assert.equal(created.revision.options.evaluator, 'claude');
        await waitFor(async () => (await readStoredReviewTask(service, created.task.taskId)).revisions[0].targets[0].attempts[0].status === 'failed');
        await service.updateSettings({
            revision: 1,
            defaultEvaluator: 'antigravity',
            providers: { claude: { model: 'changed' }, antigravity: { model: 'gemini' }, codex: { model: 'saved-codex', reasoningEffort: 'medium' } },
        });
        const repeated = await service.submit({ ...request, options: {} });
        assert.equal(repeated.revision.revisionId, created.revision.revisionId);
        const { revisionId, targets: [target] } = created.revision;
        await service.retry(created.task.taskId, revisionId, target.targetId, randomUUID(), target.attempts[0].attemptId);
        const next = await service.submit({ ...input(), options: { evaluator: 'codex', model: 'custom-codex' } });
        const newDefault = await service.submit(input());
        await waitFor(async () => (await readStoredReviewTask(service, newDefault.task.taskId)).revisions[0].targets[0].attempts[0].status === 'completed');
        assert.equal(next.revision.options.reasoningEffort, 'medium');
        assert.deepEqual(received, [
            { evaluator: 'claude', model: 'sonnet', reasoningEffort: 'low' },
            { evaluator: 'claude', model: 'sonnet', reasoningEffort: 'low' },
            { evaluator: 'codex', model: 'custom-codex', reasoningEffort: 'medium' },
            { evaluator: 'antigravity', model: 'gemini', reasoningEffort: undefined },
        ]);
    }
    finally {
        await service.close();
        await rm(root, { recursive: true, force: true });
    }
});
test('compatible connection credentials are private and rejected after the accepted endpoint changes', async () => {
    const root = await mkdtemp(resolve(tmpdir(), 'review-compatible-'));
    const received: unknown[] = [];
    const service = new ReviewService(root, { inspect: (async () => {
        received.push(openAiCompatibleConfig());
        throw new Error('connection failed');
    }) as unknown as typeof inspect });
    const save = (baseUrl: string, apiKey?: string) => service.updateSettings({
        defaultEvaluator: 'openai-compatible',
        providers: { 'openai-compatible': { model: 'vision', baseUrl, apiKey, apiFormat: 'responses' } },
    });
    try {
        await service.start();
        await assert.rejects(save('http://api.example/v1'));
        const saved = await save('https://api.example/v1/', 'test-secret');
        assert.equal(saved.providers['openai-compatible']?.hasApiKey, true);
        assert.doesNotMatch(JSON.stringify(saved), /test-secret/);
        const created = await service.submit(input());
        const { revisionId, targets: [target] } = created.revision;
        await waitFor(async () => (await readStoredReviewTask(service, created.task.taskId)).revisions[0].targets[0].attempts[0].status === 'failed');
        assert.deepEqual(received, [{ baseUrl: 'https://api.example/v1', apiFormat: 'responses', apiKey: 'test-secret' }]);
        assert.doesNotMatch(await readFile(resolve(root, '.review-service/state.json'), 'utf8'), /test-secret/);
        assert.equal((await save('https://api.example/v2')).providers['openai-compatible']?.hasApiKey, false);
        await service.retry(created.task.taskId, revisionId, target.targetId, randomUUID(), target.attempts[0].attemptId);
        await waitFor(async () => (await readStoredReviewTask(service, created.task.taskId)).revisions[0].targets[0].attempts[1]?.status === 'failed');
        assert.match((await readStoredReviewTask(service, created.task.taskId)).revisions[0].targets[0].attempts[1].error!, /주소 또는 형식이 변경/);
        assert.equal(received.length, 1);
        assert.equal((await stat(resolve(root, '.review-service/settings.json'))).mode & 0o777, 0o600);
        await service.close();
        const restarted = new ReviewService(root);
        try {
            await restarted.start();
            assert.deepEqual(await restarted.getSettings(), {
                revision: 2,
                defaultEvaluator: 'openai-compatible',
                providers: { 'openai-compatible': { model: 'vision', baseUrl: 'https://api.example/v2', apiFormat: 'responses', standardEvaluationTimeouts: { initialTimeoutSeconds: 960, repairTimeoutSeconds: 180 }, hasApiKey: false } },
            });
        }
        finally {
            await restarted.close();
        }
    }
    finally {
        await service.close();
        await rm(root, { recursive: true, force: true });
    }
});
test('restart recovers running artifacts, fails interrupted runs and resumes queued targets; lock prevents second worker', async () => {
    const root = await mkdtemp(resolve(tmpdir(), 'reviews-'));
    const service = new ReviewService(root, { inspect: engine() as typeof inspect });
    try {
        await service.start();
        const other = new ReviewService(root);
        await assert.rejects(other.start(), /이미 실행/);
        const created = await service.submit({ ...input(), targets: [...input().targets, ...input().targets, ...input().targets] });
        await waitFor(async () => (await readStoredReviewTask(service, created.task.taskId)).revisions[0].targets[0].attempts[0].status === 'completed');
        await service.close();
        const path = resolve(root, '.review-service/state.json'), state = JSON.parse(await readFile(path, 'utf8'));
        const targets = state.tasks[0].revisions[0].targets;
        targets[0].attempts[0].status = 'running';
        targets[1].attempts[0].status = 'running';
        await rm(resolve(root, 'review-attempts', targets[1].attempts[0].attemptId), { recursive: true, force: true });
        targets[2].attempts[0].status = 'queued';
        await writeFile(path, JSON.stringify(state));
        const restarted = new ReviewService(root, { inspect: engine() as typeof inspect });
        try {
            await restarted.start();
            await waitFor(async () => (await readStoredReviewTask(restarted, created.task.taskId)).revisions[0].targets[2].attempts[0].status === 'completed');
            const result = (await readStoredReviewTask(restarted, created.task.taskId)).revisions[0].targets;
            assert.equal(result[0].attempts[0].status, 'completed');
            assert.equal(result[1].attempts[0].status, 'failed');
            assert.match(result[1].attempts[0].error!, /중단/);
        }
        finally {
            await restarted.close();
        }
    }
    finally {
        await service.close();
        await rm(root, { recursive: true, force: true });
    }
});
test('strict inputs reject unsafe URL, ledger URLs, invalid images and duplicate target IDs', async () => {
    const root = await mkdtemp(resolve(tmpdir(), 'reviews-'));
    const service = new ReviewService(root, { inspect: engine() as typeof inspect });
    try {
        await service.start();
        await assert.rejects(service.submit({ ...input(), targets: [{ kind: 'url', name: 'bad', url: 'file:///etc/passwd' }] }));
        await assert.rejects(service.submit({ ...input(), targets: [{ kind: 'url', name: 'bad', url: 'http://user:pass@localhost/' }] }));
        await assert.rejects(service.submit({ ...input(), options: { reviewPipeline: 'observation-ledger' } }));
        await assert.rejects(service.submit({ ...input(), hasMutationPermission: true }));
        await assert.rejects(service.upload({ fileName: 'x.png', base64: Buffer.from('not image').toString('base64') }));
        await assert.rejects(service.upload({ fileName: 'x.png', base64: 'data:image/png;base64,AA==' }));
    }
    finally {
        await service.close();
        await rm(root, { recursive: true, force: true });
    }
});
test('storage failure rolls back unacknowledged submission and cannot schedule a phantom review', async () => {
    const root = await mkdtemp(resolve(tmpdir(), 'reviews-'));
    let count = 0;
    const service = new ReviewService(root, { inspect: engine(() => { count++; }) as typeof inspect });
    try {
        await service.start();
        const statePath = resolve(root, '.review-service/state.json'), original = await readFile(statePath);
        await rm(statePath);
        await mkdir(statePath);
        const request = input();
        await assert.rejects(service.submit(request));
        assert.equal(service.executionStatus.queuedCount, 0);
        assert.equal(count, 0);
        await rm(statePath, { recursive: true });
        await writeFile(statePath, original);
        const result = await service.submit(request);
        await waitFor(async () => (await readStoredReviewTask(service, result.task.taskId)).revisions[0].targets[0].attempts[0].status === 'completed');
        assert.equal(count, 1);
    }
    finally {
        await service.close();
        await rm(root, { recursive: true, force: true });
    }
});
test('engine exception after report persistence preserves report; failed reports remain retryable', async () => {
    const root = await mkdtemp(resolve(tmpdir(), 'reviews-'));
    let shouldFail = true;
    const service = new ReviewService(root, { inspect: (async (_spec, output) => { const runId = randomUUID(), runDir = resolve(output, runId); await mkdir(runDir, { recursive: true }); await writeFile(resolve(runDir, 'report.json'), JSON.stringify({ runId, status: shouldFail ? 'failed' : 'partial', terminationReason: 'Provider unavailable' })); shouldFail = false; throw new Error('post-report failure'); }) as typeof inspect });
    try {
        await service.start();
        const created = await service.submit(input());
        await waitFor(async () => (await readStoredReviewTask(service, created.task.taskId)).revisions[0].targets[0].attempts[0].status === 'failed');
        const revision = (await readStoredReviewTask(service, created.task.taskId)).revisions[0], target = revision.targets[0], attempt = target.attempts[0];
        assert.ok(attempt.reportId);
        assert.equal(attempt.runStatus, 'failed');
        await service.retry(created.task.taskId, revision.revisionId, target.targetId, randomUUID(), attempt.attemptId);
        await waitFor(async () => (await readStoredReviewTask(service, created.task.taskId)).revisions[0].targets[0].attempts.at(-1)?.status === 'completed');
        assert.equal((await readStoredReviewTask(service, created.task.taskId)).revisions[0].targets[0].attempts.at(-1)?.runStatus, 'partial');
    }
    finally {
        await service.close();
        await rm(root, { recursive: true, force: true });
    }
});
test('concurrent stale-lock recovery admits only one worker', async () => { const root = await mkdtemp(resolve(tmpdir(), 'reviews-lock-')); await mkdir(resolve(root, '.review-service')); await writeFile(resolve(root, '.review-service/service.lock'), '2147483647'); const services = [new ReviewService(root), new ReviewService(root)]; try {
    const attempts = await Promise.allSettled(services.map(s => s.start()));
    assert.equal(attempts.filter(x => x.status === 'fulfilled').length, 1);
    assert.equal(attempts.filter(x => x.status === 'rejected').length, 1);
    assert.equal(await readFile(resolve(root, '.review-service/service.lock'), 'utf8'), String(process.pid));
}
finally {
    await Promise.all(services.map(s => s.close()));
    await rm(root, { recursive: true, force: true });
} });


test('explicit compatible budgets take precedence and default split applies to standard compatible URL and image reviews',async()=>{
 const root=await mkdtemp(resolve(tmpdir(),'review-budget-'));const specs:RunSpec[]=[];
 const service=new ReviewService(root,{inspect:async(spec,path)=>{specs.push(spec);return engine()(spec,path) as any;}});
 try{await service.start();await service.updateSettings({defaultEvaluator:'openai-compatible',providers:{'openai-compatible':{baseUrl:'https://example.com/v1',apiFormat:'chat',model:'fixture'}}});
 const asset=await service.upload({fileName:'budget.png',base64:(await sharp({create:{width:4,height:4,channels:3,background:'white'}}).png().toBuffer()).toString('base64')});
 const evaluationBudget={stageTimeoutSeconds:330,initialTimeoutSeconds:240,repairTimeoutSeconds:90};
 const submitted=await service.submit({...input(),options:{timeoutSeconds:360,evaluationBudget},targets:[...input().targets,{kind:'image',name:'image',assetId:asset.assetId}]});
 await waitFor(async()=> (await readStoredReviewTask(service, submitted.task.taskId)).revisions[0].targets.every(t=>t.attempts[0].status==='completed'));
 assert.deepEqual(submitted.revision.options.evaluationBudget,evaluationBudget);assert.equal(specs.length,2);for(const spec of specs){assert.deepEqual(spec.evaluationBudget,evaluationBudget);assert.equal(spec.limits.maxDurationMs,360000);}
 const stateDiscovery={readySelector:'[data-ready]',loadingSelector:'[aria-busy=true]',maxWaitMs:20000,modalExploration:{maxAttempts:2,preferenceHint:'본문 확인을 위한 최소 선택',canChoosePreferences:false}};
 const standardRequest={...input(),options:{stateDiscovery},targets:[...input().targets,{kind:'image',name:'image',assetId:asset.assetId}]};
 const standard=await service.submit(standardRequest);
 assert.deepEqual((await service.submit(standardRequest)).revision.options.stateDiscovery,stateDiscovery);
 await assert.rejects(service.submit({...standardRequest,options:{stateDiscovery:{...stateDiscovery,maxWaitMs:21000}}}),/같은 제출 ID/);
 await assert.rejects(service.submit({...input(),options:{stateDiscovery},targets:[{kind:'image',name:'image',assetId:asset.assetId}]}),/URL target/);
 await assert.rejects(service.submit({...input(),options:{stateDiscovery:{maxWaitMs:120001}}}),/120000/);
 assert.deepEqual((await readStoredReviewTask(service, standard.task.taskId)).revisions[0].options.stateDiscovery,stateDiscovery);
 const defaults={stageTimeoutSeconds:1170,initialTimeoutSeconds:960,repairTimeoutSeconds:180};
 assert.equal(standard.revision.options.timeoutSeconds,1200);assert.deepEqual(standard.revision.options.evaluationBudget,defaults);
 await waitFor(async()=> (await readStoredReviewTask(service, standard.task.taskId)).revisions[0].targets.every(t=>t.attempts[0].status==='completed'));
 assert.equal(specs.length,4);
 assert.deepEqual(specs.find(spec=>spec.targetUrl&&spec.stateDiscovery?.readySelector)?.stateDiscovery,stateDiscovery);
 assert.equal(specs.filter(spec=>spec.imagePath).every(spec=>spec.stateDiscovery===undefined),true);
 for(const spec of specs.slice(2)){assert.equal(spec.limits.maxDurationMs,1200000);assert.deepEqual(spec.evaluationBudget,defaults);}
 for(const request of [
  {...input(),options:{timeoutSeconds:180}},
  {...input(),options:{evaluator:'claude'}},
  {...input(),options:{reviewPipeline:'observation-ledger'},targets:[{kind:'image',name:'image',assetId:asset.assetId}]},
 ]){
  const excluded=await service.submit(request);
  assert.equal(excluded.revision.options.timeoutSeconds,request.options.timeoutSeconds??1200);assert.equal(excluded.revision.options.evaluationBudget,undefined);
 }
 await assert.rejects(service.submit({...standardRequest,options:{timeoutSeconds:180}}),/같은 제출 ID/);
 await assert.rejects(service.submit({...input(),options:{timeoutSeconds:180,evaluationBudget}}),/stage|budget/);
 await assert.rejects(service.submit({...input(),options:{timeoutSeconds:360,evaluationBudget:{...evaluationBudget,repairTimeoutSeconds:100}}}),/budget/);
 }finally{await service.close();await rm(root,{recursive:true,force:true});}
});

test('split settings are persisted, legacy requests remain idempotent and new revisions adopt current defaults',async()=>{
 const root=await mkdtemp(resolve(tmpdir(),'review-default-budget-'));
 const legacy=[input(),input()];
 let service=new ReviewService(root,{inspect:engine() as typeof inspect});
 const compatible={baseUrl:'https://example.com/v1',apiFormat:'chat',model:'fixture'};
 const standardEvaluationTimeouts={initialTimeoutSeconds:260,repairTimeoutSeconds:200};
 const save=(config:unknown=compatible)=>service.updateSettings({defaultEvaluator:'openai-compatible',providers:{'openai-compatible':config}});
 try{
  await service.start();
  await save({...compatible,standardEvaluationTimeouts});
  await assert.rejects(save({...compatible,standardEvaluationTimeouts:{initialTimeoutSeconds:960,repairTimeoutSeconds:181}}),/1140초/);
  const preserved=await save({...compatible,model:'legacy-client-update'});
  assert.deepEqual(preserved.providers['openai-compatible']?.standardEvaluationTimeouts,standardEvaluationTimeouts);
  const created=await service.submit(legacy[0]);const historical=await service.submit(legacy[1]);
  await service.close();
  const path=resolve(root,'.review-service/state.json');
  const state=JSON.parse(await readFile(path,'utf8'));
  for(const [index,request] of legacy.entries()){
   const parsed=reviewSubmissionSchema.parse(request);
   const options={...(index===1&&{evaluator:'codex'}),timeoutSeconds:180,reviewPipeline:'standard'};
   const previousHash=(index===0?'request:':'')+createHash('sha256').update(JSON.stringify({taskId:null,input:{...parsed,options}})).digest('hex');
   state.submissions['submit:'+request.submissionId].hash=previousHash;
   const savedTask=state.tasks.find((task:{taskId:string})=>task.taskId===[created.task.taskId,historical.task.taskId][index]);
   savedTask.revisions[0].options.timeoutSeconds=180;
   delete savedTask.revisions[0].options.evaluationBudget;
  }
  await writeFile(path,JSON.stringify(state));
  service=new ReviewService(root,{inspect:engine() as typeof inspect});
  await service.start();
  assert.deepEqual((await service.getSettings()).providers['openai-compatible']?.standardEvaluationTimeouts,standardEvaluationTimeouts);
  for(const [index,request] of legacy.entries()){
   const replay=await service.submit(request);
   assert.equal(replay.task.taskId,[created.task.taskId,historical.task.taskId][index]);
   assert.equal(replay.revision.options.timeoutSeconds,180);
   assert.equal(replay.revision.options.evaluationBudget,undefined);
  }
  const revised=await service.submit(input(),created.task.taskId);
  assert.equal(revised.revision.options.timeoutSeconds,520);
  assert.deepEqual(revised.revision.options.evaluationBudget,{stageTimeoutSeconds:490,...standardEvaluationTimeouts});
 }finally{await service.close();await rm(root,{recursive:true,force:true});}
});

test('saved AI failure retry preserves history, options and idempotency while rejecting stale or foreign attempts',async()=>{
 const root=await mkdtemp(resolve(tmpdir(),'evaluation-retry-'));const specs:RunSpec[]=[];let release=()=>{};const gate=new Promise<void>(r=>{release=r;});let originalPath='';
 const service=new ReviewService(root,{inspect:(async(spec,output)=>{
  specs.push(structuredClone(spec));if(specs.length===2)await gate;
  const runId=randomUUID(),runDir=resolve(output,runId);await mkdir(runDir,{recursive:true});
  const report={runId,status:specs.length===1?'partial':'completed',evaluation:{status:specs.length===1?'failed':'completed'},findings:[],endedAt:new Date().toISOString()};
  const path=resolve(runDir,'report.json');await writeFile(path,JSON.stringify(report));if(specs.length===1)originalPath=path;return {result:report,runDir};
 }) as typeof inspect});
 const baseProvider={baseUrl:'https://example.com/v1',apiFormat:'chat',model:'fixture',reasoningEffort:'high'};
 const save=(standardEvaluationTimeouts:{initialTimeoutSeconds:number;repairTimeoutSeconds:number})=>service.updateSettings({defaultEvaluator:'openai-compatible',providers:{'openai-compatible':{...baseProvider,standardEvaluationTimeouts}}});
 try{await service.start();await save({initialTimeoutSeconds:240,repairTimeoutSeconds:180});
 const created=await service.submit(input());
 await waitFor(async()=> (await readStoredReviewTask(service, created.task.taskId)).revisions[0].targets[0].attempts[0].status==='completed');
 assert.deepEqual(specs[0].evaluationBudget,{stageTimeoutSeconds:450,initialTimeoutSeconds:240,repairTimeoutSeconds:180});
 await save({initialTimeoutSeconds:280,repairTimeoutSeconds:190});
 const before=await readStoredReviewTask(service, created.task.taskId),revision=before.revisions[0],target=revision.targets[0],attempt=target.attempts[0],bytes=await readFile(originalPath);
 await assert.rejects(service.retry(before.taskId,revision.revisionId,randomUUID(),randomUUID(),attempt.attemptId),/대상/);
 const submissionId=randomUUID();await Promise.all([service.retry(before.taskId,revision.revisionId,target.targetId,submissionId,attempt.attemptId),service.retry(before.taskId,revision.revisionId,target.targetId,submissionId,attempt.attemptId)]);
 await waitFor(async()=> (await readStoredReviewTask(service, before.taskId)).revisions[0].targets[0].attempts.at(-1)?.status==='running');
 const running=(await readStoredReviewTask(service, before.taskId)).revisions[0].targets[0].attempts.at(-1)!;
 await assert.rejects(service.retry(before.taskId,revision.revisionId,target.targetId,randomUUID(),attempt.attemptId),/오래된/);
 await assert.rejects(service.retry(before.taskId,revision.revisionId,target.targetId,randomUUID(),running.attemptId),/실패한/);
 release();await waitFor(async()=> (await readStoredReviewTask(service, before.taskId)).revisions[0].targets[0].attempts.at(-1)?.status==='completed');
 const after=await readStoredReviewTask(service, before.taskId);assert.equal(after.revisions.length,1);assert.equal(after.revisions[0].targets[0].attempts.length,2);assert.deepEqual(after.revisions[0].targets[0].attempts[0],attempt);assert.deepEqual(await readFile(originalPath),bytes);assert.deepEqual(specs[1],specs[0]);
 }finally{release();await service.close();await rm(root,{recursive:true,force:true});}
});

test('partial status, zero findings, missing evaluation and unreadable or mismatched reports do not authorize AI retry',async()=>{
 for(const scenario of ['normal-zero','validation-partial','legacy','missing-report','mismatched-run','changed-evaluation'] as const){
  const root=await mkdtemp(resolve(tmpdir(),'retry-ineligible-'));let reportPath='';
  const service=new ReviewService(root,{inspect:(async(_spec,output)=>{
   const runId=randomUUID(),runDir=resolve(output,runId);await mkdir(runDir,{recursive:true});reportPath=resolve(runDir,'report.json');
   const report={runId,status:scenario==='normal-zero'?'completed':'partial',...(scenario==='legacy'?{}:{evaluation:{status:scenario==='normal-zero'?'completed':scenario==='validation-partial'?'partial':'failed'}}),findings:[]};
   await writeFile(reportPath,JSON.stringify(report));return {result:report,runDir};
  }) as typeof inspect});
  try{await service.start();const created=await service.submit(input());await waitFor(async()=> (await readStoredReviewTask(service, created.task.taskId)).revisions[0].targets[0].attempts[0].status==='completed');
   if(scenario==='missing-report')await rm(reportPath);
   if(scenario==='mismatched-run'||scenario==='changed-evaluation'){const d=JSON.parse(await readFile(reportPath,'utf8'));if(scenario==='mismatched-run')d.runId=randomUUID();else d.evaluation.status='partial';await writeFile(reportPath,JSON.stringify(d));}
   const t=await readStoredReviewTask(service, created.task.taskId),r=t.revisions[0],target=r.targets[0];await assert.rejects(service.retry(t.taskId,r.revisionId,target.targetId,randomUUID(),target.attempts[0].attemptId),/실패한/,scenario);assert.equal((await readStoredReviewTask(service, t.taskId)).revisions[0].targets[0].attempts.length,1);
  }finally{await service.close();await rm(root,{recursive:true,force:true});}
 }
});


test('modal exploration options bound autonomous retries and keep hints optional',()=>{
 const request=input();assert(reviewSubmissionSchema.safeParse(request).success);
 assert.equal(reviewSubmissionSchema.parse(request).options.stateDiscovery,undefined);
 assert.deepEqual(reviewSubmissionSchema.parse({...request,options:{stateDiscovery:{modalExploration:{}}}}).options.stateDiscovery?.modalExploration,{});
 assert.equal(reviewSubmissionSchema.parse({...request,options:{stateDiscovery:{modalExploration:{canChoosePreferences:false}}}}).options.stateDiscovery?.modalExploration?.canChoosePreferences,false);
 assert.equal(reviewSubmissionSchema.parse({...request,options:{stateDiscovery:{modalExploration:{canChoosePreferences:true}}}}).options.stateDiscovery?.modalExploration?.canChoosePreferences,true);
 for(const modalExploration of [{},{maxAttempts:1},{maxAttempts:3,canChoosePreferences:false},{preferenceHint:'선택 목표'}])assert(reviewSubmissionSchema.safeParse({...request,options:{stateDiscovery:{modalExploration}}}).success);
 for(const modalExploration of [{maxAttempts:0},{maxAttempts:4},{maxAttempts:1.5},{canChoosePreferences:'true'},{preferenceHint:''},{preferenceHint:'x'.repeat(501)},{selector:'button'},{steps:[{kind:'preference',buttonName:'Both'}]}])assert.equal(reviewSubmissionSchema.safeParse({...request,options:{stateDiscovery:{modalExploration}}}).success,false);
});
