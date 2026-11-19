import {spawn} from 'node:child_process';
import {StringDecoder} from 'node:string_decoder';
import {mkdtemp,rm,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {buildProviderContent} from './provider-input.js';
import type {EvaluationInput} from './types.js';

type Schema = Record<string, any>;
export function codexOutputSchema(schema:Schema):Schema {
 const result:Schema={...schema};delete result.$schema;
 if(schema.properties){const required=new Set(schema.required??[]);result.properties=Object.fromEntries(Object.entries(schema.properties).map(([key,value])=>{const child=codexOutputSchema(value as Schema);return[key,required.has(key)?child:{anyOf:[child,{type:'null'}]}];}));result.required=Object.keys(schema.properties);}
 if(schema.items)result.items=codexOutputSchema(schema.items);
 if(schema.anyOf)result.anyOf=schema.anyOf.map(codexOutputSchema);
 return result;
}
export function normalizeCodexOutput(value:unknown,schema:Schema):unknown {
 if(Array.isArray(value))return value.map(item=>normalizeCodexOutput(item,schema.items??{}));
 if(!value||typeof value!=='object')return value;
 const required=new Set(schema.required??[]);
 return Object.fromEntries(Object.entries(value).filter(([key,item])=>!(item===null&&schema.properties?.[key]&&!required.has(key))).map(([key,item])=>[key,normalizeCodexOutput(item,schema.properties?.[key]??{})]));
}
export function codexChildEnvironment(source:NodeJS.ProcessEnv):NodeJS.ProcessEnv {
 // Preserve the user's existing auth location; never redirect HOME or CODEX_HOME.
 const permitted=['PATH','HOME','CODEX_HOME','USER','LOGNAME','TMPDIR','TEMP','TMP','LANG','LC_ALL','LC_CTYPE','TERM','SSL_CERT_FILE','SSL_CERT_DIR','HTTPS_PROXY','HTTP_PROXY','ALL_PROXY','NO_PROXY','https_proxy','http_proxy','all_proxy','no_proxy','SYSTEMROOT','WINDIR','APPDATA','LOCALAPPDATA'];
 return Object.fromEntries(permitted.filter(key=>source[key]!==undefined).map(key=>[key,source[key]]));
}
export const CODEX_DISABLED_FEATURES=['shell_tool','view_image','apps','plugins','memories','multi_agent','multi_agent_v2','browser_use','browser_use_external','browser_use_full_cdp_access','computer_use','in_app_browser','image_generation','code_mode_host','hooks','workspace_dependencies','skill_search','shell_snapshot','goals','sleep_tool'];
export interface CodexEvent {type?:string;item?:{type?:string;text?:string};usage?:{input_tokens?:number;cached_input_tokens?:number;cache_write_input_tokens?:number;output_tokens?:number};}
export interface CodexProcessResult {events:CodexEvent[];exitCode:number|null;hasTimedOut:boolean;hasUnexpectedToolCall:boolean;structuredOutput?:unknown;rawStructuredOutput?:unknown;}
export async function runCodex(input:EvaluationInput,options:{prompt:string;instructions:string;schema:Schema}):Promise<CodexProcessResult>{
 const workingDir=await mkdtemp(join(tmpdir(),'usability-codex-'));
 try{
  const schemaPath=join(workingDir,'schema.json'),instructionPath=join(workingDir,'instructions.md');
  await writeFile(schemaPath,JSON.stringify(codexOutputSchema(options.schema)),{mode:0o600});
  await writeFile(instructionPath,options.instructions,{mode:0o600});
  const args=['--no-daemon','-a','never','exec','--ignore-user-config','--ignore-rules','--ephemeral','--strict-config','--sandbox','read-only','--skip-git-repo-check','--json','--color','never','--output-schema',schemaPath];
  for(const feature of CODEX_DISABLED_FEATURES)args.push('--disable',feature);
  for(const setting of ['project_doc_max_bytes=1','web_search="disabled"','developer_instructions=""','skills.include_instructions=false','skills.max_context_tokens=1','skills.bundled.enabled=false','features.code_mode.enabled=false','memories.use_memories=false','memories.generate_memories=false','agents.max_threads=1','agents.max_depth=0',`model_instructions_file=${JSON.stringify(instructionPath)}`])args.push('-c',setting);
  if(input.spec.model)args.push('--model',input.spec.model);
  if(input.spec.reasoningEffort)args.push('-c',`model_reasoning_effort=${JSON.stringify(input.spec.reasoningEffort)}`);
  const {content,images}=await buildProviderContent(input,options.prompt);
  const promptLines:string[]=[];
  let imageNumber=0;
  for(const [index,part] of content.entries()){
   if(part.type==='text'){
    promptLines.push(content[index+1]?.type==='image'?`Image ${imageNumber+1}: ${part.text}`:part.text);
    continue;
   }
   const extension=part.mimeType==='image/png'?'png':part.mimeType==='image/jpeg'?'jpg':'webp';
   const imagePath=join(workingDir,`image-${++imageNumber}.${extension}`);
   await writeFile(imagePath,Buffer.from(part.data,'base64'),{mode:0o600});
   args.push('--image',imagePath);
  }
  args.push('-');
  return await new Promise<CodexProcessResult>((resolve,reject)=>{
   const child=spawn('codex',args,{cwd:workingDir,env:codexChildEnvironment(process.env),stdio:['pipe','pipe','pipe'],detached:process.platform!=='win32'});
   const events:CodexEvent[]=[];const decoder=new StringDecoder('utf8');let pending='',outputSize=0;let hasTimedOut=false,hasUnexpectedToolCall=false,hasOverflowed=false;let killTimer:ReturnType<typeof setTimeout>|undefined;
   const terminate=()=>{try{if(process.platform!=='win32'&&child.pid)process.kill(-child.pid,'SIGTERM');else child.kill('SIGTERM');}catch{}killTimer??=setTimeout(()=>{try{if(process.platform!=='win32'&&child.pid)process.kill(-child.pid,'SIGKILL');else child.kill('SIGKILL');}catch{}},1000);};
   const consume=(line:string)=>{try{const event=JSON.parse(line) as CodexEvent;events.push(event);if(event.type?.startsWith('item.')&&event.item?.type&&!['agent_message','reasoning','error'].includes(event.item.type)){hasUnexpectedToolCall=true;terminate();}}catch{}};
   const onAbort=()=>terminate();input.signal?.addEventListener('abort',onAbort,{once:true});if(input.signal?.aborted)terminate();
   const timer=setTimeout(()=>{hasTimedOut=true;terminate();},Math.max(1,input.timeoutMs));
   child.stdout.on('data',(chunk:Buffer)=>{outputSize+=chunk.length;if(outputSize>8*1024*1024){hasOverflowed=true;terminate();return;}pending+=decoder.write(chunk);let newline:number;while((newline=pending.indexOf('\n'))>=0){consume(pending.slice(0,newline));pending=pending.slice(newline+1);}});
   child.stderr.on('data',()=>{});child.stdin.on('error',()=>{});
   child.on('error',error=>{clearTimeout(timer);input.signal?.removeEventListener('abort',onAbort);reject(error);});
   child.on('close',exitCode=>{clearTimeout(timer);clearTimeout(killTimer);input.signal?.removeEventListener('abort',onAbort);pending+=decoder.end();if(pending.trim())consume(pending);if(hasOverflowed){reject(new Error('Codex output exceeded limit.'));return;}const message=events.findLast(event=>event.type==='item.completed'&&event.item?.type==='agent_message')?.item?.text;let structuredOutput:unknown,rawStructuredOutput:unknown;try{rawStructuredOutput=message?JSON.parse(message):undefined;structuredOutput=normalizeCodexOutput(rawStructuredOutput,options.schema);}catch{}resolve({events,exitCode,hasTimedOut,hasUnexpectedToolCall,structuredOutput,rawStructuredOutput});});
   input.recordProviderImages?.(images);
   child.stdin.end(promptLines.join('\n'));
  });
 }finally{await rm(workingDir,{recursive:true,force:true});}
}
