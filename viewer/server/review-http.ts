import {handleWorkspaceHttp} from './workspace-http.js';
import type { ReportRepository } from './repository.js';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { z } from 'zod';
import { ReviewService, ReviewServiceError } from '../../src/review-service.js';
import { reviewIdSchema } from '../../src/review-contract.js';
async function body(req: IncomingMessage, origin: string, maxBytes: number) {
    if (req.headers.origin !== origin)
        throw new ReviewServiceError(403, '변경 요청에는 같은 출처 확인이 필요합니다.');
    if (req.headers['content-type']?.split(';')[0].trim().toLowerCase() !== 'application/json')
        throw new ReviewServiceError(415, 'JSON 요청만 지원합니다.');
    const chunks: Buffer[] = [];
    let size = 0;
    for await (const chunk of req) {
        size += chunk.length;
        if (size > maxBytes)
            throw new ReviewServiceError(413, '요청 크기가 너무 큽니다.');
        chunks.push(Buffer.from(chunk));
    }
    try {
        return JSON.parse(Buffer.concat(chunks).toString('utf8'));
    }
    catch {
        throw new ReviewServiceError(400, '올바른 JSON 요청이 필요합니다.');
    }
}
export async function handleReviewHttp(req: IncomingMessage, res: ServerResponse, path: string, origin: string, service: ReviewService, repository?: ReportRepository): Promise<boolean> {
    if (!/^\/api\/(review-assets|review-service|review-settings|focused-reviews|review-projects|review-project-trash|review-workspaces|review-workspace-trash|workspace-requests|workspace-context)(\/|$)/.test(path) && !/^\/api\/reports\/[^/]+\/images\/[^/]+\/context$/.test(path))
        return false;
    const json = (status: number, value: unknown) => { res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' }); res.end(JSON.stringify(value)); };
    try {
        if(repository&&await handleWorkspaceHttp(req,res,path,origin,service,repository,(maxBytes=32768)=>body(req,origin,maxBytes)))return true;
        const context = path.match(/^\/api\/reports\/([a-f0-9]{64})\/images\/([a-f0-9]{64})\/context$/);
        if (context && req.method === 'GET' && repository) {
            const { source } = await repository.focusSource(context[1], context[2]);
            json(200, { source, reviews: await service.focusedList(context[1], context[2]) });
            return true;
        }
        if (path === '/api/focused-reviews' && req.method === 'POST' && repository) {
            json(202, { review: await service.submitFocused(await body(req, origin, 32768), (reportId, imageId) => repository.focusSource(reportId, imageId)) });
            return true;
        }
        const focusedRetry = path.match(/^\/api\/focused-reviews\/([^/]+)\/retry$/);
        if (focusedRetry && req.method === 'POST') {
            const parsed = z.object({ submissionId: z.string().trim().min(1).max(200), attemptId: reviewIdSchema }).strict().safeParse(await body(req, origin, 32768));
            if (!parsed.success)
                throw new ReviewServiceError(400, '최신 attemptId와 제출 ID가 필요합니다.');
            json(202, { review: await service.retryFocused(focusedRetry[1], parsed.data.submissionId, parsed.data.attemptId) });
            return true;
        }
        const focused = path.match(/^\/api\/focused-reviews\/([^/]+)$/);
        if (focused && req.method === 'GET') {
            json(200, { review: await service.focusedGet(focused[1]) });
            return true;
        }
        if (path === '/api/review-service' && req.method === 'GET') {
            json(service.isReady ? 200 : 503, { status: service.isReady ? 'ready' : 'unavailable', version: 1, execution: service.executionStatus });
            return true;
        }
        if (path === '/api/review-settings') {
            if (req.method === 'GET') {
                json(200, { settings: await service.getSettings() });
                return true;
            }
            if (req.method === 'PUT') {
                const peer = req.socket.remoteAddress?.replace(/^::ffff:/, '');
                if (peer !== '127.0.0.1' && peer !== '::1')
                    throw new ReviewServiceError(403, '서버 PC 또는 등록한 HTTPS 주소에서만 설정을 변경할 수 있습니다.');
                json(200, { settings: await service.updateSettings(await body(req, origin, 16384)) });
                return true;
            }
        }
        if (path === '/api/review-assets' && req.method === 'POST') {
            const parsed = z.object({ fileName: z.string(), base64: z.string() }).strict().safeParse(await body(req, origin, 7 * 1024 * 1024));
            if (!parsed.success)
                throw new ReviewServiceError(400, 'fileName과 base64가 필요합니다.');
            json(201, { asset: await service.upload(parsed.data) });
            return true;
        }
        throw new ReviewServiceError(405, '지원하지 않는 리뷰 요청입니다.');
    }
    catch (error) {
        if(error instanceof z.ZodError){json(400,{error:error.issues.map(i=>i.message).join('; ')});return true;}
        json(error instanceof ReviewServiceError || error instanceof Error && 'status' in error ? Number((error as {
            status: number;
        }).status) : 500, { error: error instanceof ReviewServiceError || error instanceof Error && 'status' in error ? error.message : '리뷰 요청을 처리하지 못했습니다.' });
        return true;
    }
}
