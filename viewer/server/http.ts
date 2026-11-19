import {handleReviewHttp} from './review-http.js';
import type {ReviewService} from '../../src/review-service.js';
import {z} from 'zod';
import {RecommendationError} from './recommendation-store.js';
import {createServer, type IncomingMessage, type ServerResponse} from 'node:http';
export type DevelopmentMiddleware = (req: IncomingMessage, res: ServerResponse, next: () => void) => void;
import {readFile,realpath} from 'node:fs/promises';
import {resolve,sep} from 'node:path';
import {ReportRepository,ViewerError} from './repository.js';
export function parsePublicOrigin(value: string): URL {
 const origin=URL.parse(value);
 if(!origin || !/^https:\/\/[^/?#@\\\s]+\/?$/i.test(value)) {
  throw new Error('public-origin must be an HTTPS origin without credentials, a path, query, or fragment');
 }
 return origin;
}
export function trustedViewerOrigin(req: IncomingMessage, publicOrigin?: URL): string | undefined {
 const host=req.headers.host;
 if(!host || req.headers['sec-fetch-site']==='cross-site')return;
 const port=req.socket.localPort;
 // Direct HTTP requests may use loopback names or the receiving interface address.
 const localAddress=req.socket.localAddress?.replace(/^::ffff:/,'');
 const localHost=localAddress?.includes(':')?`[${localAddress}]`:localAddress;
 const allowedHosts=new Set([`127.0.0.1:${port}`,`localhost:${port}`,`${localHost}:${port}`]);
 const peer=req.socket.remoteAddress?.replace(/^::ffff:/,'');
 // The HTTPS proxy connects over loopback and preserves the original Host header.
 let origin: string | undefined;
 if(allowedHosts.has(host))origin=`http://${host}`;
 else if(publicOrigin?.host===host && (peer==='127.0.0.1' || peer==='::1'))origin=publicOrigin.origin;
 if(origin && (!req.headers.origin || req.headers.origin===origin))return origin;
}
export function createViewerServer(repository:ReportRepository,publicDir:string,reviewService?:ReviewService,developmentMiddleware?:DevelopmentMiddleware,publicOrigin?:URL){
 if(reviewService)repository.setTrashedReportIdsLookup(()=>reviewService.trashedReportIds());
 return createServer(async(req,res)=>{
 res.setHeader('X-Content-Type-Options','nosniff');res.setHeader('Cache-Control','no-store');res.setHeader('Referrer-Policy','no-referrer');res.setHeader('Cross-Origin-Resource-Policy','same-origin');res.setHeader('Content-Security-Policy',"default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self'; connect-src 'self'; font-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'");
 const json=(status:number,data:unknown)=>{res.writeHead(status,{'Content-Type':'application/json; charset=utf-8'});res.end(JSON.stringify(data));};
 const origin=trustedViewerOrigin(req,publicOrigin);
 if(!origin){json(403,{error:'서버 주소와 같은 출처에서만 접근할 수 있습니다.'});return;}
 try{const url=new URL(req.url??'/',origin),path=url.pathname;
  if(reviewService&&await handleReviewHttp(req,res,path,origin,reviewService,repository))return;
  const recommendationMatch=path.match(/^\/api\/reports\/([a-f0-9]{64})\/recommendation(\/ensure)?$/);
  if(recommendationMatch){const id=recommendationMatch[1];
   if(req.method==='GET'&&!recommendationMatch[2]){json(200,{recommendation:await repository.recommendation(id)});return;}
   if((req.method==='POST'&&recommendationMatch[2])||(req.method==='PATCH'&&!recommendationMatch[2])){
    if(req.headers.origin!==origin)throw new ViewerError(403,'변경 요청에는 같은 출처 확인이 필요합니다.');
    if(req.headers['content-type']?.split(';')[0].trim().toLowerCase()!=='application/json')throw new ViewerError(415,'JSON 요청만 지원합니다.');
    let size=0;const chunks:Buffer[]=[];for await(const chunk of req){size+=chunk.length;if(size>8192)throw new ViewerError(413,'요청 크기가 너무 큽니다.');chunks.push(Buffer.from(chunk));}let body:unknown;try{body=JSON.parse(Buffer.concat(chunks).toString('utf8'));}catch{throw new ViewerError(400,'JSON 요청을 확인해 주세요.');}
    if(req.method==='POST'){const parsed=z.object({provider:z.enum(['codex','claude']).optional(),shouldRetry:z.boolean().optional()}).strict().safeParse(body);if(!parsed.success)throw new ViewerError(400,'추천 생성 옵션이 올바르지 않습니다.');const input=await repository.recommendationInput(id);json(200,{recommendation:await repository.recommendations.ensure(id,input,parsed.data.provider??'codex',parsed.data.shouldRetry??false)});return;}
    const parsed=z.object({revision:z.number().int().min(1),screenName:z.string().trim().min(1).max(80),featureCategories:z.array(z.string().trim().min(1).max(40)).max(3),shouldConfirm:z.boolean()}).strict().safeParse(body);if(!parsed.success)throw new ViewerError(400,'화면명(최대80자)과 기능 분류(최대3개)를 확인해 주세요.');await repository.recommendation(id);await repository.recommendations.edit(id,parsed.data);json(200,{recommendation:await repository.recommendation(id)});return;
   }
   throw new ViewerError(405,'지원하지 않는 요청 방식입니다.');
  }
  if(req.method!=='GET'&&req.method!=='HEAD'){json(405,{error:'이 경로는 읽기 요청만 지원합니다.'});return;}
  if(path==='/api/reports'){
   const scope=url.searchParams.get('scope');
   if(scope!==null&&scope!=='linked'&&scope!=='unlinked')throw new ViewerError(400,'보고서 목록 범위를 확인해 주세요.');
   const catalog=await reviewService?.projectCatalog();
   const workspaceContexts=catalog?.reportWorkspaceContexts;
   const includesReport=(id:string)=>{
    if(scope==='linked')return workspaceContexts?.has(id)??false;
    if(scope==='unlinked')return !workspaceContexts?.has(id);
    return true;
   };
   const [list,taskContexts]=await Promise.all([repository.list(includesReport),reviewService?.reportContexts()]);
   json(200,{...list,reports:list.reports.map(report=>{
    const taskContext=taskContexts?.[report.id];
    const workspaceContext=workspaceContexts?.get(report.id);
    return {...report,...(taskContext?{taskContext}:{}),...(workspaceContext?{workspaceContext}:{})};
   })});
   return;
  }
  const match=path.match(/^\/api\/reports\/([a-f0-9]{64})(?:\/images\/([a-f0-9]{64}))?$/);
  if(match){if(match[2]){const image=await repository.image(match[1],match[2]);res.writeHead(200,{'Content-Type':'image/png'});res.end(req.method==='HEAD'?undefined:image);}else {const report=await repository.detail(match[1]),context=(await reviewService?.reportContexts())?.[match[1]];json(200,{...report,...(context?{taskContext:context}:{})});}return;}
  if(path.startsWith('/api/'))throw new ViewerError(404,'지원하지 않는 요청입니다.');
  if(developmentMiddleware){developmentMiddleware(req,res,()=>json(404,{error:'페이지를 찾을 수 없습니다.'}));return;}
  if(path!=='/'&&path!=='/ui-review-agent-icon.svg'&&!/^\/assets\/[a-zA-Z0-9._-]+\.(?:js|css|woff2)$/.test(path))throw new ViewerError(404,'페이지를 찾을 수 없습니다.');
  const base=await realpath(publicDir),file=await realpath(resolve(base,path==='/'?'index.html':path.slice(1)));if(!file.startsWith(base+sep))throw new ViewerError(403,'허용되지 않은 파일입니다.');
  const data=await readFile(file);res.writeHead(200,{'Content-Type':file.endsWith('.js')?'text/javascript':file.endsWith('.css')?'text/css':file.endsWith('.woff2')?'font/woff2':file.endsWith('.svg')?'image/svg+xml':'text/html; charset=utf-8'});res.end(req.method==='HEAD'?undefined:data);
 }catch(error){json(error instanceof ViewerError||error instanceof RecommendationError?error.status:500,{error:error instanceof ViewerError||error instanceof RecommendationError?error.message:'파일을 불러오지 못했습니다. 잠시 후 다시 시도하세요.'});}
});}
