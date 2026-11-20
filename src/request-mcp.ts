import {projectInputSchema,workspaceInputSchema,workspaceInitialSchema,workspaceFollowupSchema} from './workspace-contract.js';
import {open} from 'node:fs/promises';
import {request as httpRequest} from 'node:http';
import {constants} from 'node:fs';
import {basename,isAbsolute} from 'node:path';
import sharp from 'sharp';
import {McpServer} from '@modelcontextprotocol/sdk/server/mcp.js';
import {z} from 'zod';
import {hasDistinctStyleUrls,styleComparisonTargetsSchema} from './automatic-style-comparison.js';
import {reviewIdSchema,styleComparisonUrlsSchema} from './review-contract.js';
import {focusedSubmissionSchema} from './focused-review-contract.js';

const MAX_IMAGE_BYTES=5*1024*1024;
const projectListSchema = z.looseObject({
 projects: z.array(z.looseObject({projectId: reviewIdSchema, isUncategorized: z.literal(true).optional()})),
});

export function reviewServiceOrigin(value:string):string{
 const url=new URL(value);
 if(url.protocol!=='http:'||!['127.0.0.1','localhost'].includes(url.hostname)||url.username||url.password||url.pathname!=='/'||url.search||url.hash)throw new Error('Review service must be a loopback HTTP origin, e.g. http://127.0.0.1:4317');
 return url.origin;
}
export class ReviewServiceClient{
 readonly origin:string;
 constructor(origin='http://127.0.0.1:4317', private forwardedOrigin?:string){this.origin=reviewServiceOrigin(origin);if(forwardedOrigin)this.forwardedOrigin=reviewServiceOrigin(forwardedOrigin);}
 async request(path:string,body?:unknown):Promise<unknown>{
  let response:Response;
  try{if(this.forwardedOrigin){
   const forwardedOrigin=this.forwardedOrigin;
   response=await new Promise<Response>((resolve,reject)=>{
    const request=httpRequest(this.origin+path,{method:body===undefined?'GET':'POST',headers:{host:new URL(forwardedOrigin).host,...(body===undefined?{}:{'content-type':'application/json',origin:forwardedOrigin})},signal:AbortSignal.timeout(15000)},incoming=>{
     const chunks:Buffer[]=[];incoming.on('data',chunk=>chunks.push(Buffer.from(chunk)));incoming.on('error',reject);incoming.on('end',()=>resolve(new Response(Buffer.concat(chunks),{status:incoming.statusCode??500})));
    });request.on('error',reject);if(body!==undefined)request.write(JSON.stringify(body));request.end();
   });
  }else response=await fetch(this.origin+path,{method:body===undefined?'GET':'POST',headers:body===undefined?{}:{'content-type':'application/json',origin:this.origin},body:body===undefined?undefined:JSON.stringify(body),redirect:'error',signal:AbortSignal.timeout(15000)});}
  catch{throw new Error(`UI Review service unavailable at ${this.origin}. Start pnpm run viewer in the UI Review Agent repository, then retry this request. MCP does not start a worker. If a submission timed out, reuse its submissionId to avoid duplicate reviews.`);}
  const result:unknown=await response.json();
  if(!response.ok)throw new Error(`Review service HTTP ${response.status}: ${typeof result==='object'&&result&&'error' in result?String(result.error):response.statusText}`);
  return result;
 }
 async listProjects(){
  const result = projectListSchema.parse(await this.request('/api/review-projects'));
  const dashboardOrigin = this.forwardedOrigin ?? this.origin;
  return {...result, projects: result.projects.map(project => {
   if (project.isUncategorized) return project;
   const settingsLink = (section: 'login' | 'post') => {
    const url = new URL('/', dashboardOrigin);
    url.search = new URLSearchParams({project: project.projectId, manage: section}).toString();
    return url.href;
   };
   return {...project, managementLinks: {login: settingsLink('login'), post: settingsLink('post')}};
  })};
 }
 async uploadImage(path:string):Promise<unknown>{
  if(!isAbsolute(path))throw new Error('imagePath must be an absolute path to an explicitly requested PNG/JPEG/WebP image.');
  const handle=await open(path,constants.O_RDONLY|constants.O_NONBLOCK);let bytes:Buffer;
  try{const info=await handle.stat();if(!info.isFile()||info.size>MAX_IMAGE_BYTES)throw new Error('Image must be a regular file of at most 5 MiB.');const buffer=Buffer.alloc(MAX_IMAGE_BYTES+1);let offset=0;while(offset<buffer.length){const {bytesRead}=await handle.read(buffer,offset,buffer.length-offset,offset);if(bytesRead===0)break;offset+=bytesRead;}if(offset>MAX_IMAGE_BYTES)throw new Error('Image exceeds 5 MiB.');bytes=buffer.subarray(0,offset);}finally{await handle.close();}
  const metadata=await sharp(bytes,{limitInputPixels:20_000_000,failOn:'error'}).metadata();
  if(!['png','jpeg','webp'].includes(metadata.format??'')||(metadata.pages??1)>1||!metadata.width||!metadata.height||metadata.width*metadata.height>20_000_000)throw new Error('Only single-frame PNG/JPEG/WebP images up to 20 megapixels are accepted.');
  return this.request('/api/review-assets',{fileName:basename(path),base64:bytes.toString('base64')});
 }
}
export function createRequestMcp(client=new ReviewServiceClient()):McpServer{
 const server=new McpServer({name:'ui-review',version:'0.1.0'});
 const wrap=(fn:()=>Promise<unknown>)=>async()=>{try{return{content:[{type:'text' as const,text:JSON.stringify(await fn())}]};}catch(error){return{isError:true,content:[{type:'text' as const,text:error instanceof Error?error.message:'UI Review request failed'}]};}};
 server.registerTool('review_service_status',{description:'Check the local review service. Does not start workers or call a model.',inputSchema:{}},wrap(()=>client.request('/api/review-service')));
 server.registerTool('review_get_report',{description:'Read a completed report by reportId from an attempt. Does not generate screen-name recommendations.',inputSchema:{reportId:z.string().regex(/^[a-f0-9]{64}$/)}},args=>wrap(()=>client.request(`/api/reports/${args.reportId}`))());
 server.registerTool('review_upload_image',{description:'Upload one explicitly requested local image to the local service. Image content is sent to the configured AI provider when reviewed; no automatic masking.',inputSchema:{imagePath:z.string().min(1)}},args=>wrap(()=>client.uploadImage(args.imagePath))());
 server.registerTool('review_get_image_context',{description:'Read immutable screenshot dimensions, sourceSha256 and existing focused reviews before selecting a region. Coordinates refer to native image pixels, not displayed CSS pixels.',inputSchema:{reportId:z.string().regex(/^[a-f0-9]{64}$/),imageId:z.string().regex(/^[a-f0-9]{64}$/)}},args=>wrap(()=>client.request(`/api/reports/${args.reportId}/images/${args.imageId}/context`))());
 server.registerTool('review_create_focused',{description:'Queue AI review of a manually selected rectangle in a saved screenshot plus a user question. Include sourceSha256 from context and use native image-pixel bounds. Uses server settings unless submission.options overrides them. Uses the existing captured image without live navigation.',inputSchema:{submission:focusedSubmissionSchema}},args=>wrap(()=>client.request('/api/focused-reviews',args.submission))());
 server.registerTool('review_get_focused',{description:'Read status and answer for an already submitted focused screenshot review. Pending or failed states are not completed answers.',inputSchema:{focusedReviewId:reviewIdSchema}},args=>wrap(()=>client.request(`/api/focused-reviews/${args.focusedReviewId}`))());
 server.registerTool('review_retry_focused',{description:'Retry only the latest failed focused-review attempt against the same immutable screenshot and question. Reuse submissionId after uncertain delivery. A completed answer is not eligible merely because its verdict is unwanted.',inputSchema:{focusedReviewId:reviewIdSchema,attemptId:reviewIdSchema,submissionId:z.string().min(1).max(200)}},args=>wrap(()=>client.request(`/api/focused-reviews/${args.focusedReviewId}/retry`,{attemptId:args.attemptId,submissionId:args.submissionId}))());
 server.registerTool('review_list_projects',{description:'List persistent review projects with Supabase login origin bindings, allowed POST hosts, and managementLinks to open each setting in the dashboard when supported. Does not call a model.',inputSchema:{}},wrap(()=>client.listProjects()));
 server.registerTool('review_create_project',{description:'Create a review project. Does not start a review.',inputSchema:{project:projectInputSchema}},args=>wrap(()=>client.request('/api/review-projects',args.project))());
 server.registerTool('review_list_workspaces',{description:'List screen review workspaces, optionally within one project.',inputSchema:{projectId:reviewIdSchema.optional()}},args=>wrap(()=>client.request('/api/review-workspaces'+(args.projectId?'?projectId='+args.projectId:'')))());
 server.registerTool('review_create_workspace',{description:'Create a screen review workspace with a goal. No browser or AI is started.',inputSchema:{workspace:workspaceInputSchema}},args=>wrap(()=>client.request('/api/review-workspaces',args.workspace))());
 server.registerTool('review_get_workspace',{description:'Read current reports, immutable requests and running or queued attempt history.',inputSchema:{workspaceId:reviewIdSchema}},args=>wrap(()=>client.request(`/api/review-workspaces/${args.workspaceId}`))());
 server.registerTool('review_create_workspace_review',{
  description:'Submit an independent URL or image review in a screen workspace, including a fresh review of changed input. For multiple screens, select or create one workspace per screen, submit each separately, and share each returned dashboardUrl. Set shouldWaitForStart on a URL target if optional login is needed, and enter credentials only in the workspace dashboard. Set themeReview.mode to both for light and dark checks. Use alignmentContracts only for known design expectations. Omit options to use server settings. Reuse submissionId after uncertain delivery.',
  inputSchema:{workspaceId:reviewIdSchema,...workspaceInitialSchema.shape},
 },({workspaceId,...submission})=>wrap(()=>client.request(`/api/review-workspaces/${workspaceId}/reviews`,submission))());
 server.registerTool('review_compare_styles',{
  description:'Compare rendered styles against up to four distinct same-origin URLs in one workspace report. Use comparisonUrl for one target, or comparisonUrls for two to four. Share the returned workspace dashboardUrl. Reuse submissionId after uncertain delivery.',
  inputSchema:{workspaceId:reviewIdSchema,submissionId:workspaceInitialSchema.shape.submissionId,
   referenceUrl:styleComparisonUrlsSchema.shape.referenceUrl,comparisonUrl:styleComparisonUrlsSchema.shape.comparisonUrl.optional(),
   comparisonUrls:styleComparisonTargetsSchema.optional()},
 },({workspaceId,submissionId,referenceUrl,comparisonUrl,comparisonUrls})=>wrap(()=>{
  if(Boolean(comparisonUrl)===Boolean(comparisonUrls))throw new Error('Provide comparisonUrl or comparisonUrls.');
  if(comparisonUrls&&!hasDistinctStyleUrls(referenceUrl,comparisonUrls))
   throw new Error('기준과 비교 화면은 같은 사이트의 서로 다른 URL이어야 합니다.');
  if(comparisonUrl)styleComparisonUrlsSchema.parse({referenceUrl,comparisonUrl});
  return client.request(`/api/review-workspaces/${workspaceId}/reviews`,{
   submissionId,target:{kind:'url',url:referenceUrl,...(comparisonUrls?{comparisonUrls}:{comparisonUrl})},
  });
 })());
 server.registerTool('review_followup',{description:'Submit a new live browser review from a fixed parent report and optional saved-image region. Set shouldWaitForStart to true to let the user choose optional login information in the dashboard. This calls the model and can perform bounded read-only display interactions; it is not a saved-image answer. Omit model options for current server settings. Reuse submissionId after uncertain delivery.',inputSchema:{workspaceId:reviewIdSchema,submission:workspaceFollowupSchema}},args=>wrap(()=>client.request(`/api/review-workspaces/${args.workspaceId}/requests`,args.submission))());
 server.registerTool('review_cancel_workspace_request',{description:'Cancel a queued or running workspace attempt. Does not change completed reports.',inputSchema:{requestId:reviewIdSchema,attemptId:reviewIdSchema}},args=>wrap(()=>client.request(`/api/workspace-requests/${args.requestId}/cancel`,{attemptId:args.attemptId}))());
 server.registerTool('review_retry_workspace_request',{description:'Retry the latest failed workspace attempt or a partially completed attempt whose saved AI evaluation failed. Keep the accepted instruction and budget, and use the latest attemptId and a new submissionId. Changing the goal requires a new request.',inputSchema:{requestId:reviewIdSchema,attemptId:reviewIdSchema,submissionId:z.string().min(1).max(200)}},args=>wrap(()=>client.request(`/api/workspace-requests/${args.requestId}/retry`,{attemptId:args.attemptId,submissionId:args.submissionId}))());
 return server;
}
