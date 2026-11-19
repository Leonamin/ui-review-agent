import {readStoredReviewTasks} from './helpers/review-state.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, readFile, rm, mkdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { createHash, randomUUID } from 'node:crypto';
import sharp from 'sharp';
import { inspectFocused, focusViewportRegion, focusMaskRegions, validateFocusImage } from '../src/focused-review.js';
import { ReviewService } from '../src/review-service.js';
import { focusedSubmissionSchema, type FocusedReview, type FocusSource } from '../src/focused-review-contract.js';
import type { evaluateStage } from '../src/evaluator.js';
import { ReportRepository } from '../viewer/server/repository.js';
const digest = (bytes: Buffer | string) => createHash('sha256').update(bytes).digest('hex');
async function fixture(root: string) { const bytes = await sharp({ create: { width: 200, height: 100, channels: 3, background: '#c8d5e1' } }).composite([{ input: Buffer.from('<svg width="200" height="100"><rect x="40" y="20" width="80" height="40" fill="#285296"/></svg>') }]).png().toBuffer(); const path = resolve(root, 'source.png'); await writeFile(path, bytes); const source: FocusSource = { reportId: 'a'.repeat(64), imageId: 'b'.repeat(64), runId: 'original', observationId: 'obs-001', evidenceId: 'obs-001-screenshot', sha256: digest(bytes), width: 200, height: 100, screenshot: { coordinateSpace: 'viewport-css-pixels', clip: { x: 30, y: 40, width: 100, height: 50 }, deviceScaleFactor: 2, maskColor: '#6B7280', redactionRegions: [{ regionId: 'm1', reason: 'input-value', boundingBox: { x: 50, y: 50, width: 40, height: 20 } }] }, isStable: true }; const review: FocusedReview = { focusedReviewId: randomUUID(), createdAt: new Date().toISOString(), source, region: { x: 40, y: 20, width: 80, height: 40 }, comment: '이 영역이 실제로 문제가 있는지 확인해줘.', options: { evaluator: 'codex', timeoutSeconds: 30, model: 'fixed-model', reasoningEffort: 'medium' }, attempts: [{ attemptId: randomUUID(), createdAt: new Date().toISOString(), status: 'queued' }] }; return { bytes, path, source, review }; }
function draft(input: any, status = 'not-supported', evidenceIds?: string[]) { return { findings: [], suggestions: [], screenMap: [{ observationId: 'obs-001', sections: [{ sectionId: 'selected', label: '선택 영역', elementRefs: [], evidenceIds: [input.evidence[0].evidenceId], visibleSummary: '화면' }] }], interpretations: [], limitations: [], feedbackAnswer: { status, answer: '현재 캡처에서는 주장한 결함 근거를 찾기 어렵습니다.', evidenceIds: evidenceIds ?? [input.evidence[0].evidenceId] } }; }
async function waitFor(fn: () => Promise<boolean>) { for (let n = 0; n < 200; n++) {
    if (await fn())
        return;
    await new Promise(r => setTimeout(r, 10));
} throw new Error('timeout'); }
test('focused engine supplies full and exact crop, preserves source pixels, masks, coordinate transform and answer provenance', async () => { const root = await mkdtemp(resolve(tmpdir(), 'focus-')); try {
    const f = await fixture(root);
    assert.deepEqual(focusViewportRegion(f.review), { x: 50, y: 50, width: 40, height: 20 });
    assert.deepEqual(focusMaskRegions(f.source)[0].boundingBox, { x: 40, y: 20, width: 80, height: 40 });
    const engine = (async (input: any, _deps: any, stage: any) => { assert.equal(input.observations.length, 1); assert.equal(input.evidence.length, 2); assert.equal(input.spec.targetUrl, undefined); assert.equal(input.canRequestObservation, false); assert.equal(input.spec.model, 'fixed-model'); assert.match(stage.instructions, /NOT evidence/); const payload = JSON.parse(stage.prompt); assert.equal(payload.focusedQuestion.comment, f.review.comment); assert.deepEqual(payload.focusedQuestion.region, f.review.region); const actual = await sharp(await readFile(input.evidence[1].absolutePath)).raw().toBuffer(); const expected = await sharp(f.bytes).extract({ left: 40, top: 20, width: 80, height: 40 }).raw().toBuffer(); assert.deepEqual(actual, expected); assert.deepEqual(input.observations[0].redactionRegions[0].boundingBox, { x: 40, y: 20, width: 80, height: 40 }); return stage.validate(draft(input), {}); }) as typeof evaluateStage;
    const result = await inspectFocused(f.review, f.path, resolve(root, 'runs'), { evaluateStage: engine });
    assert.equal(result.result.status, 'completed');
    assert.equal(result.result.focusedReview?.answer?.status, 'not-supported');
    assert.equal(result.result.focusedReview?.source.sha256, f.source.sha256);
    assert.equal(digest(await readFile(f.path)), f.source.sha256);
    assert.match(await readFile(resolve(result.runDir, 'report.md'), 'utf8'), /선택 영역 집중 재검토/);
    assert.equal((await validateFocusImage(f.bytes)).width, 200);
}
finally {
    await rm(root, { recursive: true, force: true });
} });
test('focused engine rejects wrong answer references, ungrounded confirmed verdict, changed pixels and out-of-range crop', async () => { const root = await mkdtemp(resolve(tmpdir(), 'focus-')); try {
    const f = await fixture(root);
    for (const [status, ids] of [['not-supported', ['invented-evidence']], ['confirmed', undefined]] as const) {
        const evaluator = (async (input: any, _: any, stage: any) => stage.validate(draft(input, status, ids as string[] | undefined), {})) as typeof evaluateStage;
        const result = await inspectFocused(f.review, f.path, resolve(root, 'runs'), { evaluateStage: evaluator });
        assert.equal(result.result.status, 'failed');
        assert.equal(result.result.focusedReview?.answer, undefined);
    }
    await assert.rejects(inspectFocused({ ...f.review, region: { x: 190, y: 0, width: 20, height: 10 } }, f.path, root), /벗어났/);
    await assert.rejects(inspectFocused({ ...f.review, source: { ...f.source, sha256: 'f'.repeat(64) } }, f.path, root), /변경/);
}
finally {
    await rm(root, { recursive: true, force: true });
} });
test('focused queue accepts legacy no-task report, deduplicates and pins snapshot despite source changes', async () => { const root = await mkdtemp(resolve(tmpdir(), 'focus-service-')); let calls = 0; const f = await fixture(root); const service = new ReviewService(resolve(root, 'runs'), { inspectFocused: async (review, path, output) => { calls++; assert.equal(digest(await readFile(path)), f.source.sha256); await new Promise(r => setTimeout(r, 20)); return inspectFocused(review, path, output, { evaluateStage: (async (input: any, _: any, stage: any) => stage.validate(draft(input), {})) as typeof evaluateStage }); } }); try {
    await service.start();
    const body = { submissionId: 'same', reportId: f.source.reportId, imageId: f.source.imageId, sourceSha256: f.source.sha256, region: f.review.region, comment: f.review.comment };
    const loader = async () => ({ source: f.source, bytes: f.bytes });
    const [a, b] = await Promise.all([service.submitFocused(body, loader), service.submitFocused(body, loader)]);
    assert.equal(a.focusedReviewId, b.focusedReviewId);
    await assert.rejects(service.submitFocused({ ...body, comment: '다른 질문' }, loader), /다른 집중/);
    await writeFile(f.path, 'changed original after accepted');
    await waitFor(async () => (await service.focusedGet(a.focusedReviewId)).attempts[0].status === 'completed');
    const completed = await service.focusedGet(a.focusedReviewId);
    assert.equal(completed.answer?.status, 'not-supported');
    assert.equal(calls, 1);
    assert.equal((await readStoredReviewTasks(service)).length, 0);
    const report = await new ReportRepository(resolve(root, 'runs')).detail(completed.attempts[0].reportId!);
    assert.equal((report as any).focusedReview.source.runId, 'original');
    await assert.rejects(service.submitFocused({ ...body, submissionId: 'stale', sourceSha256: 'f'.repeat(64) }, loader), /변경/);
    await assert.rejects(service.submitFocused({ ...body, submissionId: 'bounds', region: { x: 0, y: 0, width: 201, height: 1 } }, loader), /벗어났/);
}
finally {
    await service.close();
    await rm(root, { recursive: true, force: true });
} });
test('focus source uses actual PNG size and rejects mismatched CSS metadata or corrupted evidence', async () => { const root = await mkdtemp(resolve(tmpdir(), 'focus-source-')); try {
    const f = await fixture(root);
    const run = resolve(root, 'run');
    await mkdir(run);
    await writeFile(resolve(run, 'screen.png'), f.bytes);
    const evidence = { kind: 'screenshot', evidenceId: 'screen', observationId: 'obs-001', relativePath: 'screen.png', sha256: f.source.sha256, screenshot: f.source.screenshot };
    const path = resolve(run, 'report.json');
    await writeFile(path, JSON.stringify({ runId: 'old-cli-run', observations: [{ observationId: 'obs-001', isStable: false }], evidence: [evidence] }));
    const repository = new ReportRepository(root), report = (await repository.list()).reports[0];
    const result = await repository.focusSource(report.id, digest('screen'));
    assert.equal(result.source.width, 200);
    assert.equal(result.source.isStable, false);
    await writeFile(path, JSON.stringify({ runId: 'old-cli-run', evidence: [{ ...evidence, screenshot: { ...evidence.screenshot, deviceScaleFactor: 1 } }] }));
    await assert.rejects(repository.focusSource(report.id, digest('screen')), /크기가 일치/);
    await writeFile(resolve(run, 'screen.png'), 'tampered');
    await assert.rejects(repository.focusSource(report.id, digest('screen')));
}
finally {
    await rm(root, { recursive: true, force: true });
} });
test('focused failure retry is CAS guarded and survives legacy-state restart without changing capture',async()=>{const root=await mkdtemp(resolve(tmpdir(),'focus-retry-'));let calls=0;const f=await fixture(root);const runs=resolve(root,'runs');await mkdir(resolve(runs,'.review-service'),{recursive:true});await writeFile(resolve(runs,'.review-service/state.json'),JSON.stringify({version:1,tasks:[],assets:[],submissions:{}}));const service=new ReviewService(runs,{inspectFocused:async(review,path,output)=>{calls++;if(calls===1)throw new Error('Provider unavailable');return inspectFocused(review,path,output,{evaluateStage:(async(input:any,_:any,stage:any)=>stage.validate(draft(input),{})) as typeof evaluateStage});}});try{await service.start();const body={submissionId:'initial',reportId:f.source.reportId,imageId:f.source.imageId,sourceSha256:f.source.sha256,region:f.review.region,comment:f.review.comment};const review=await service.submitFocused(body,async()=>({source:f.source,bytes:f.bytes}));await waitFor(async()=> (await service.focusedGet(review.focusedReviewId)).attempts[0].status==='failed');await assert.rejects(service.retryFocused(review.focusedReviewId,'stale',randomUUID()),/최신 실패/);const first=(await service.focusedGet(review.focusedReviewId)).attempts[0];await Promise.all([service.retryFocused(review.focusedReviewId,'retry',first.attemptId),service.retryFocused(review.focusedReviewId,'retry',first.attemptId)]);await waitFor(async()=> (await service.focusedGet(review.focusedReviewId)).attempts.at(-1)?.status==='completed');assert.equal(calls,2);assert.equal((await service.focusedGet(review.focusedReviewId)).attempts.length,2);await service.close();const restarted=new ReviewService(runs);try{await restarted.start();const stored=await restarted.focusedGet(review.focusedReviewId);assert.equal(stored.answer?.status,'not-supported');assert.equal(stored.source.sha256,f.source.sha256);assert.equal(stored.attempts[0].error,'Provider unavailable');}finally{await restarted.close();}}finally{await service.close();await rm(root,{recursive:true,force:true});}});


test('focused legacy omitted-timeout submissions stay idempotent and retain their accepted three-minute budget',async()=>{
 for(const format of ['request','legacy']) {
  const root=await mkdtemp(resolve(tmpdir(),'focus-legacy-timeout-'));const f=await fixture(root);
  const service=new ReviewService(root,{inspectFocused:async()=>{throw new Error('fixture provider failure');}});
  try {
   await service.start();
   const body={submissionId:'legacy-timeout',reportId:f.source.reportId,imageId:f.source.imageId,sourceSha256:f.source.sha256,region:f.review.region,comment:f.review.comment};
   const accepted=await service.submitFocused(body,async()=>({source:f.source,bytes:f.bytes}));
   await waitFor(async()=> (await service.focusedGet(accepted.focusedReviewId)).attempts[0].status==='failed');
   await service.close();
   const path=resolve(root,'.review-service/state.json');const state=JSON.parse(await readFile(path,'utf8'));
   state.focusedReviews[0].options.timeoutSeconds=180;
   const parsed=focusedSubmissionSchema.parse(body);const previous={...parsed,options:{timeoutSeconds:180}};
   state.focusedSubmissions['submit:legacy-timeout'].hash=format==='request'?'request:'+digest(JSON.stringify(previous)):digest(JSON.stringify({...previous,options:{evaluator:'codex',timeoutSeconds:180}}));
   await writeFile(path,JSON.stringify(state));
   const restarted=new ReviewService(root,{inspectFocused:async()=>{assert.fail('duplicate must not execute again');}});
   try {
    await restarted.start();
    const repeated=await restarted.submitFocused(body,async()=>{assert.fail('duplicate must not reload source');});
    assert.equal(repeated.focusedReviewId,accepted.focusedReviewId);assert.equal(repeated.options.timeoutSeconds,180);assert.equal(repeated.attempts.length,1);
    await assert.rejects(restarted.submitFocused({...body,options:{timeoutSeconds:1200}},async()=>({source:f.source,bytes:f.bytes})),/다른 집중 검토/);
   } finally {await restarted.close();}
  } finally {await service.close();await rm(root,{recursive:true,force:true});}
 }
});
