import {createServer,type Server} from 'node:http';
import {randomBytes,timingSafeEqual} from 'node:crypto';
import {McpServer} from '@modelcontextprotocol/sdk/server/mcp.js';
import {StreamableHTTPServerTransport} from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import {Client} from '@modelcontextprotocol/sdk/client/index.js';
import {StreamableHTTPClientTransport} from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import {z} from 'zod';
import {executeVerification,verificationRequestSchema} from './verification.js';
import type {BrowserSession} from './browser.js';
export async function startMcp(session:BrowserSession):Promise<{url:string;token:string;close:()=>Promise<void>}>{
 const token=randomBytes(32).toString('hex');
 const server:Server=createServer(async(req,res)=>{
  const actual=Buffer.from(req.headers.authorization??'');const expected=Buffer.from(`Bearer ${token}`);
  if(req.url!=='/mcp'||actual.length!==expected.length||!timingSafeEqual(actual,expected)){res.writeHead(403);res.end();return;}
  if(req.method!=='POST'){res.writeHead(405);res.end();return;}
  const rpc=new McpServer({name:'usability-observer',version:'0.1.0'});
  const wrap=(fn:()=>Promise<unknown>)=>async()=>{try{session.budget.takeTool();const result=await fn();return{content:[{type:'text' as const,text:JSON.stringify(result)}]};}catch(e){return{isError:true,content:[{type:'text' as const,text:e instanceof Error?e.message:'Tool failed'}]};}};
  rpc.registerTool('captureObservation',{description:'Capture the current page without clicking or navigation',inputSchema:{}},wrap(()=>session.capture()));
  rpc.registerTool('runRuleChecks',{description:'Run deterministic rules on current observation',inputSchema:{observationId:z.string()}},args=>wrap(()=>session.runRules(args.observationId))());
  rpc.registerTool('inspectElement',{description:'Capture current page and a detail image of an observed element; no scripts or navigation',inputSchema:{observationId:z.string(),elementRef:z.string()}},args=>wrap(()=>session.inspectElement(args.observationId,args.elementRef))());
  rpc.registerTool('performAction',{description:'Execute only a preconfigured action ID; disabled in quick mode',inputSchema:{actionId:z.string(),expectedObservationId:z.string()}},args=>wrap(()=>session.performAction(args.actionId,args.expectedObservationId))());
  rpc.registerTool('verifyCandidate',{description:'Run one registered bounded verification recipe; no arbitrary scripts or selectors',inputSchema:{request:verificationRequestSchema}},args=>wrap(()=>executeVerification(session,args.request))());
  rpc.registerTool('getEvidence',{description:'Read a generated evidence ID, no arbitrary file access',inputSchema:{evidenceId:z.string()}},async args=>{
   try{session.budget.takeTool();const {ref,data}=await session.store.read(args.evidenceId);return{content:ref.kind==='screenshot'?[{type:'image' as const,data:data.toString('base64'),mimeType:'image/png'}]:[{type:'text' as const,text:data.toString()}]};}catch(e){return{isError:true,content:[{type:'text' as const,text:e instanceof Error?e.message:'Unknown evidence'}]};}
  });
  const transport=new StreamableHTTPServerTransport({sessionIdGenerator:undefined,enableJsonResponse:true});
  res.on('close',()=>{void transport.close();void rpc.close();});
  try{let body='';for await(const chunk of req){body+=chunk;if(body.length>1000000)throw new Error('Request too large');}await rpc.connect(transport);await transport.handleRequest(req,res,JSON.parse(body));}
  catch{if(!res.headersSent)res.writeHead(400);res.end();}
 });
 await new Promise<void>((resolve,reject)=>{server.once('error',reject);server.listen(0,'127.0.0.1',resolve);});
 const address=server.address();if(!address||typeof address==='string')throw new Error('MCP bind failed');
 return{url:`http://127.0.0.1:${address.port}/mcp`,token,close:()=>new Promise<void>((resolve,reject)=>{server.close(error=>error?reject(error):resolve());server.closeAllConnections();})};
}
export async function connectMcp(url:string,token:string):Promise<Client>{const client=new Client({name:'inspector-orchestrator',version:'0.1.0'});await client.connect(new StreamableHTTPClientTransport(new URL(url),{requestInit:{headers:{Authorization:`Bearer ${token}`}}}));return client;}
export async function callTool<T>(client:Client,name:string,args:Record<string,unknown>={}):Promise<T>{const response=await client.callTool({name,arguments:args});const content=response.content as {type:string;text?:string}[];const text=content.filter(c=>c.type==='text').map(c=>c.text).join('\n');if(response.isError)throw new Error(text);return JSON.parse(text) as T;}
