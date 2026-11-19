import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { createServer, type Server } from 'node:http';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { test } from 'node:test';
import { setTimeout as wait } from 'node:timers/promises';
import { chromium } from 'playwright';
import { createServer as createViteServer } from 'vite';
import { ReviewService } from '../src/review-service.js';
import type { ReviewResult } from '../src/types.js';
import type { WorkspaceRequest } from '../src/workspace-contract.js';
import { createViewerServer } from '../viewer/server/http.js';
import { ReportRepository } from '../viewer/server/repository.js';
import type { ReportDetail } from '../viewer/features/reports/types.js';

async function listen(server: Server): Promise<string> {
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    const address = server.address();
    assert(address && typeof address !== 'string');
    return `http://127.0.0.1:${address.port}`;
}

async function close(server: Server): Promise<void> {
    server.closeAllConnections();
    await new Promise<void>(done => server.close(() => done()));
}

test('managed partial reports distinguish readiness wait limit from AI evaluation timeout', async t => {
    const root = await mkdtemp(join(tmpdir(), 'partial-report-causes-'));
    const html = await readFile(new URL('./fixtures/workspace-spacing.html', import.meta.url));
    let stalledEvaluations = 0;
    const fixture = createServer(async (request, response) => {
        if (request.method === 'GET') {
            response.writeHead(200, {'Content-Type':'text/html; charset=utf-8'}).end(html);
            return;
        }
        if (request.method !== 'POST' || request.url !== '/v1/chat/completions') {
            response.writeHead(404).end();
            return;
        }
        const chunks: Buffer[] = [];
        for await (const chunk of request) chunks.push(chunk);
        const payload = JSON.parse(Buffer.concat(chunks).toString('utf8'));
        const isStateDecision = Boolean(payload.response_format.json_schema.schema.properties.readiness);
        const prompt = JSON.parse(payload.messages[1].content[0].text.split('\n')[0]) as {
            observations: Array<{observationId:string; screenshotRefs:string[]; url:string}>;
        };
        if (!stalledEvaluations && !isStateDecision && prompt.observations.some(observation => observation.url.endsWith('/ai-timeout'))) {
            // Keep the provider connection open so the actual transport times out.
            stalledEvaluations++;
            return;
        }
        const output = isStateDecision ? {
            screenState:'content', readiness:'ready', reason:'The fixture content is visible.', dismissElementRef:null,
        } : {
            findings:[],
            screenMap:prompt.observations.map(observation => ({
                observationId:observation.observationId,
                sections:[{
                    sectionId:'workspace', label:'Workspace', elementRefs:[],
                    evidenceIds:observation.screenshotRefs, visibleSummary:'The workspace content is visible.',
                }],
            })),
            interpretations:[], limitations:[],
        };
        response.writeHead(200, {'Content-Type':'application/json'}).end(JSON.stringify({
            choices:[{finish_reason:'stop',message:{content:JSON.stringify(output)}}],
        }));
    });
    const fixtureOrigin = await listen(fixture);
    const service = new ReviewService(root);
    await service.start();
    t.after(async () => {
        await service.close();
        await close(fixture);
        await rm(root,{recursive:true,force:true});
    });
    await service.updateSettings({
        defaultEvaluator:'openai-compatible',
        providers:{'openai-compatible':{model:'fixture-vision',baseUrl:fixtureOrigin+'/v1',apiFormat:'chat'}},
    });
    const vite = await createViteServer({
        configFile:resolve('viewer/vite.config.ts'),
        server:{middlewareMode:true,hmr:false,ws:false},
    });
    const repository = new ReportRepository(root);
    const server = createViewerServer(repository, resolve('viewer'), service, vite.middlewares);
    const origin = await listen(server);
    const archive = createViewerServer(repository, resolve('viewer'), undefined, vite.middlewares);
    const archiveOrigin = await listen(archive);
    t.after(async () => {
        await close(server);
        await close(archive);
        await vite.close();
    });
    const browser = await chromium.launch();
    t.after(() => browser.close());
    const page = await browser.newPage({viewport:{width:1440,height:900}});
    const errors: string[] = [];
    page.on('pageerror',error=>errors.push(error.message));
    const project = await service.addProject({name:'Partial outcome fixture'});

    for (const item of [
        {path:'/wait-limit',waitMs:1500,label:'화면 준비 대기 한도'},
        {path:'/ai-timeout',waitMs:2500,label:'AI 평가 시간 초과'},
    ]) {
        const {workspaceId} = await service.addWorkspace({projectId:project.projectId,name:'Workspace'+item.path,goal:'Review readiness and visible layout.'});
        const response = await fetch(`${origin}/api/review-workspaces/${workspaceId}/reviews`,{
            method:'POST',headers:{origin,'content-type':'application/json'},
            body:JSON.stringify({
                submissionId:item.path,target:{kind:'url',url:fixtureOrigin+item.path},
                options:{
                    timeoutSeconds:30,
                    stateDiscovery:{maxWaitMs:item.waitMs,readySelector:'main.workspace'},
                    evaluationBudget:{initialTimeoutSeconds:4,repairTimeoutSeconds:1,stageTimeoutSeconds:5},
                },
            }),
        });
        assert.equal(response.status,202);
        const {request} = await response.json() as {request:WorkspaceRequest};
        const readRequest = async () => (await service.workspace(workspaceId)).requests.find(entry=>entry.requestId===request.requestId)!;
        const deadline = Date.now()+35_000;
        let attempt = (await readRequest()).attempts[0];
        while (attempt.status==='queued'||attempt.status==='running') {
            assert(Date.now()<deadline,'managed report did not finish in time');
            await wait(30);
            attempt = (await readRequest()).attempts[0];
        }
        assert(attempt.reportId && attempt.runId);
        assert.equal(attempt.runStatus,'partial');
        const stored = JSON.parse(await readFile(join(root,'review-attempts',attempt.attemptId,attempt.runId,'report.json'),'utf8')) as ReviewResult;
        const detail = await (await fetch(origin+'/api/reports/'+attempt.reportId)).json() as ReportDetail;
        if (item.waitMs===1500) {
            assert.equal(stored.stateDiscovery?.reasonCode,'wait-limit');
            assert.equal(stored.stateDiscovery.maxWaitMs,1500);
            assert.equal(stored.evaluation.status,'completed');
            assert.equal(detail.stateDiscoveryWait?.maxWaitMs,1500);
            assert.equal(detail.evaluation?.failureCode,undefined);
        } else {
            assert.equal(stored.stateDiscovery?.status,'completed');
            assert.equal(stored.evaluation.failureCode,'timeout');
            assert.equal(detail.evaluation?.failureCode,'timeout');
            assert.equal(detail.stateDiscoveryWait,undefined);
        }

        const workspaceResponse = await fetch(origin+'/api/workspace-context?reportId='+attempt.reportId);
        assert(workspaceResponse.ok);
        const {workspace} = await workspaceResponse.json() as {workspace?:{workspaceId:string}};
        assert(workspace?.workspaceId);
        await page.goto(`${origin}/?report=${attempt.reportId}&tab=summary`);
        await page.waitForURL(url=>url.searchParams.get('workspace')===workspaceId&&url.searchParams.get('report')===attempt.reportId);
        const currentResult = page.locator('.workspace-current-result');
        const alerts = page.locator('main .gc-alert');
        const notice = alerts.getByText(item.label,{exact:true});
        const oppositeLabel = item.waitMs===1500 ? 'AI 평가 시간 초과' : '화면 준비 대기 한도';
        const workspaceTab = (name: string | RegExp) => page.getByRole('tab',{name});
        await workspaceTab('요약').click();
        await currentResult.getByText('일부 완료',{exact:true}).waitFor();
        await notice.waitFor();

        const history = page.getByRole('button',{name:'요청과 검증 내역',exact:true});
        await history.click();
        const retryButton = page.getByRole('button',{name:'같은 조건으로 재시도',exact:true});
        if (item.waitMs===1500) {
            assert.equal(await retryButton.count(),0);
        } else {
            await retryButton.click();
            await page.getByRole('button',{name:'실행 이력 2회',exact:true}).waitFor();
            const attempts=(await readRequest()).attempts;
            assert.equal(attempts[0].reportId,attempt.reportId);
            assert.equal(attempts.length,2);
            assert.equal(new URL(page.url()).searchParams.get('report'),attempt.reportId);
        }
        assert.equal(await alerts.getByText(oppositeLabel,{exact:true}).count(),0);

        await page.setViewportSize({width:390,height:844});
        await notice.waitFor();
        assert(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth));
        await page.setViewportSize({width:1440,height:900});

        for (const name of ['결과', '범위와 한계']) {
            const tab = workspaceTab(name);
            await tab.click();
            assert.equal(await tab.getAttribute('aria-selected'),'true');
            await currentResult.waitFor({state:'hidden'});
            await notice.waitFor({state:'hidden'});
        }
        await workspaceTab('요약').click();
        await currentResult.getByText('일부 완료',{exact:true}).waitFor();
        await notice.waitFor();

        for (const tab of ['summary','findings']) {
            await page.goto(`${archiveOrigin}/?report=${attempt.reportId}&tab=${tab}`);
            await notice.waitFor();
            assert.equal(new URL(page.url()).searchParams.has('workspace'),false);
            assert.equal(await alerts.getByText(oppositeLabel,{exact:true}).count(),0);
            assert.equal(await page.getByRole('link',{name:'작업으로 돌아가기',exact:true}).count(),0);
            assert.equal(await page.getByRole('link',{name:'미연결 보고서',exact:true}).getAttribute('href'),'/?view=unlinked-reports');
        }
    }
    assert.equal(stalledEvaluations,1);
    assert.deepEqual(errors,[]);
});
