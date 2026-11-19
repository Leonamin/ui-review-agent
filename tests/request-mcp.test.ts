import test from 'node:test';
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {mkdtemp,writeFile,rm,readFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {execFileSync} from 'node:child_process';
import sharp from 'sharp';
import {Client} from '@modelcontextprotocol/sdk/client/index.js';
import {StdioClientTransport} from '@modelcontextprotocol/sdk/client/stdio.js';
import {ReviewServiceClient,reviewServiceOrigin} from '../src/request-mcp.js';

test('external stdio MCP uses HTTP service for workspace reviews, uploads, retries and reports without an owned worker',async()=>{
 const requests:{path:string;body:any;origin?:string}[]=[];const assetId='10000000-0000-4000-8000-000000000001';
 const imageWorkspaceId='10000000-0000-4000-8000-000000000003';
 const urlWorkspaceId='10000000-0000-4000-8000-000000000004';
 const project = {
  projectId: assetId,
  name: 'Sample project',
  version: 2,
  postAllowedHosts: ['api.example.com'],
  supabaseAuthBindings: [{targetOrigin: 'https://app.example.com', origin: 'https://project-ref.supabase.co'}],
 };
 const uncategorized = {
  projectId: '10000000-0000-4000-8000-000000000002', name: '미분류', isUncategorized: true,
  version: 1, postAllowedHosts: [], supabaseAuthBindings: [],
 };
 const server=createServer(async(req,res)=>{
  let body='';for await(const chunk of req)body+=chunk;
  requests.push({path:req.url!,body:body?JSON.parse(body):undefined,origin:req.headers.origin});
  res.setHeader('content-type','application/json');
  if (req.url === '/api/review-projects') {
   res.end(JSON.stringify({projects: [project, uncategorized]}));
   return;
  }
  const submittedWorkspace=req.url?.match(/^\/api\/review-workspaces\/([^/]+)\/(?:reviews|requests)$/);
  if(submittedWorkspace){
   res.end(JSON.stringify({workspace:{workspaceId:submittedWorkspace[1]},request:{requestId:assetId},dashboardUrl:`${req.headers.origin}/?workspace=${submittedWorkspace[1]}`}));
   return;
  }
  res.end(JSON.stringify(req.url==='/api/review-assets'?{asset:{assetId}}:{status:'ready'}));
 });
 await new Promise<void>(r=>server.listen(0,'127.0.0.1',r));const address=server.address()!;assert.notEqual(typeof address,'string');const origin=`http://127.0.0.1:${(address as any).port}`;
 const dir=await mkdtemp(join(tmpdir(),'ui-mcp-'));const imagePath=join(dir,'example.png');await sharp({create:{width:100,height:100,channels:3,background:'white'}}).png().toFile(imagePath);
 const transport=new StdioClientTransport({command:process.execPath,args:['--import','tsx','src/request-mcp-cli.ts','--service',origin],stderr:'pipe'});const client=new Client({name:'mcp-test',version:'1'});
 try{
 await client.connect(transport);
 const toolNames=(await client.listTools()).tools.map(tool=>tool.name);
 for(const name of ['review_list_tasks','review_get_task','review_create_task','review_add_revision','review_retry_target']){
  assert.ok(!toolNames.includes(name));
 }
 const call=async(name:string,args:Record<string,unknown>)=>{
  const result=await client.callTool({name,arguments:args});
  assert.notEqual(result.isError,true,JSON.stringify(result));
  assert.ok(Array.isArray(result.content));
  const [content]=result.content;
  assert.equal(content.type,'text');
  return JSON.parse(content.text);
 };
 await call('review_upload_image',{imagePath});
 assert.equal(Buffer.from(requests.at(-1)!.body.base64,'base64').compare(await readFile(imagePath)),0);

 const imageReview={submissionId:'image-1',target:{kind:'image',name:'Examples',assetId}};
 const imageResult=await call('review_create_workspace_review',{workspaceId:imageWorkspaceId,...imageReview});
 assert.equal(imageResult.dashboardUrl,`${origin}/?workspace=${imageWorkspaceId}`);
 assert.deepEqual(requests.at(-1),{path:`/api/review-workspaces/${imageWorkspaceId}/reviews`,body:imageReview,origin});

 const urlReview={
  submissionId:'url-1',target:{kind:'url',url:'https://app.example.test/orders',shouldWaitForStart:true},
  options:{evaluator:'openai-compatible',model:'vision'},
 };
 const urlResult=await call('review_create_workspace_review',{workspaceId:urlWorkspaceId,...urlReview});
 assert.equal(urlResult.dashboardUrl,`${origin}/?workspace=${urlWorkspaceId}`);
 assert.deepEqual(requests.at(-1),{
  path:`/api/review-workspaces/${urlWorkspaceId}/reviews`,
  body:{...urlReview,options:{...urlReview.options,reviewPipeline:'standard',timeoutSeconds:1200}},
  origin,
 });

 const retry={attemptId:assetId,submissionId:'retry-1'};
 await call('review_retry_workspace_request',{requestId:assetId,...retry});
 assert.deepEqual(requests.at(-1),{path:`/api/workspace-requests/${assetId}/retry`,body:retry,origin});

 const reportId='a'.repeat(64),imageId='b'.repeat(64);
 await call('review_get_report',{reportId});
 assert.equal(requests.at(-1)?.path,`/api/reports/${reportId}`);
 await call('review_get_image_context',{reportId,imageId});
 assert.equal(requests.at(-1)?.path,`/api/reports/${reportId}/images/${imageId}/context`);
 const focused={submissionId:'focus-1',reportId,imageId,sourceSha256:'c'.repeat(64),region:{x:10,y:20,width:30,height:40},comment:'이 영역이 읽기 쉬운가요?'};
 await call('review_create_focused',{submission:focused});
 assert.deepEqual(requests.at(-1)?.body,{...focused,options:{timeoutSeconds:1200}});
 await call('review_get_focused',{focusedReviewId:assetId});
 assert.equal(requests.at(-1)?.path,`/api/focused-reviews/${assetId}`);
 await call('review_retry_focused',{focusedReviewId:assetId,attemptId:assetId,submissionId:'focus-retry-1'});
 assert.equal(requests.at(-1)?.path,`/api/focused-reviews/${assetId}/retry`);
 assert.deepEqual(await call('review_list_projects',{}), {projects: [
  {...project, managementLinks: {
    login: `${origin}/?project=${assetId}&manage=login`, post: `${origin}/?project=${assetId}&manage=post`,
   }},
  uncategorized,
 ]});
 const forwardedOrigin = 'http://localhost:4317';
 const forwardedProjects = await new ReviewServiceClient(origin, forwardedOrigin).listProjects();
 assert.deepEqual(forwardedProjects.projects[0].managementLinks, {
  login: `${forwardedOrigin}/?project=${assetId}&manage=login`, post: `${forwardedOrigin}/?project=${assetId}&manage=post`,
 });
 await call('review_get_workspace',{workspaceId:assetId});await call('review_followup',{workspaceId:assetId,submission:{submissionId:'followup-1',parentReportId:'a'.repeat(64),instruction:'Choose a category'}});await call('review_cancel_workspace_request',{requestId:assetId,attemptId:assetId});assert.equal(requests.at(-2)!.path,`/api/review-workspaces/${assetId}/requests`);assert.equal(requests.at(-2)!.body.parentReportId,'a'.repeat(64));assert.equal(requests.at(-1)!.path,`/api/workspace-requests/${assetId}/cancel`);

 const pair={workspaceId:urlWorkspaceId,submissionId:'compare-1',referenceUrl:'https://app.example.test/?view=projects',comparisonUrl:'https://app.example.test/?view=report-search'};
 const comparison=await call('review_compare_styles',pair);
 assert.equal(comparison.dashboardUrl,`${origin}/?workspace=${urlWorkspaceId}`);
 assert.equal(requests.at(-1)?.path,`/api/review-workspaces/${urlWorkspaceId}/reviews`);
 assert.deepEqual(requests.at(-1)?.body,{
  submissionId:'compare-1',target:{kind:'url',url:pair.referenceUrl,comparisonUrl:pair.comparisonUrl},
 });
 const beforeInvalidPair=requests.length;
 const invalidPair=await client.callTool({name:'review_compare_styles',arguments:{...pair,comparisonUrl:'https://other.example.test/reports'}});
 assert.equal(invalidPair.isError,true);
 assert.equal(requests.length,beforeInvalidPair);

 }finally{await client.close();server.closeAllConnections();await new Promise<void>(r=>server.close(()=>r()));await rm(dir,{recursive:true,force:true});}
});

test('request MCP rejects remote services/non-images and gives actionable disconnected-service errors',async()=>{
 assert.throws(()=>reviewServiceOrigin('https://example.com'));assert.throws(()=>reviewServiceOrigin('http://[::1]:4317'));assert.throws(()=>reviewServiceOrigin('http://127.0.0.1:4317/path'));
 const dir=await mkdtemp(join(tmpdir(),'ui-mcp-image-'));try{const path=join(dir,'not-image.png');await writeFile(path,'not image');const client=new ReviewServiceClient('http://127.0.0.1:1');await assert.rejects(client.uploadImage('relative.png'),/absolute/);await assert.rejects(client.uploadImage(path));const fifo=join(dir,'image-pipe');execFileSync('mkfifo',[fifo]);await assert.rejects(client.uploadImage(fifo),/regular file/);await assert.rejects(client.request('/api/review-service'),/pnpm run viewer/);}finally{await rm(dir,{recursive:true,force:true});}
});

test('skill installer copies a standalone skill and refuses to overwrite existing user files',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'ui-skill-'));try{execFileSync(process.execPath,['scripts/skills/install.mjs','--target',dir]);assert.match(await readFile(join(dir,'ui-review/SKILL.md'),'utf8'),/name: ui-review/);await writeFile(join(dir,'ui-review/custom.txt'),'user data');assert.throws(()=>execFileSync(process.execPath,['scripts/skills/install.mjs','--target',dir],{stdio:'pipe'}));assert.equal(await readFile(join(dir,'ui-review/custom.txt'),'utf8'),'user data');}finally{await rm(dir,{recursive:true,force:true});}
});
