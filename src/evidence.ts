import { mkdir,writeFile,readFile } from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {resolve,sep} from 'node:path';
import type {EvidenceRef} from './types.js';
export class EvidenceStore {
 readonly evidence:EvidenceRef[]=[];
 constructor(readonly runId:string,readonly runDir:string){}
 async save(observationId:string,kind:EvidenceRef['kind'],data:Buffer|string,mimeType:string,variant=''):Promise<EvidenceRef>{
  const extension=kind==='screenshot'?'png':kind==='structure'?'txt':'json';
  if(!/^[a-z0-9-]*$/.test(variant))throw new Error('Invalid evidence variant');
  const suffix=variant?`-${variant}`:'';const evidenceId=`${observationId}-${kind}${suffix}`;const relativePath=`observations/${observationId}/${kind}${suffix}.${extension}`;
  const absolutePath=resolve(this.runDir,relativePath);await mkdir(resolve(absolutePath,'..'),{recursive:true});
  await writeFile(absolutePath,data,{mode:0o600});const sha256=createHash('sha256').update(data).digest('hex');
  const ref={evidenceId,runId:this.runId,observationId,kind,relativePath,absolutePath,mimeType,sha256,isRedacted:true};this.evidence.push(ref);return ref;
 }
 async read(evidenceId:string):Promise<{ref:EvidenceRef;data:Buffer}>{
  const ref=this.evidence.find(e=>e.evidenceId===evidenceId);if(!ref)throw new Error('Unknown evidence ID');
  if(!resolve(ref.absolutePath).startsWith(resolve(this.runDir)+sep))throw new Error('Evidence path escapes run');
  const data=await readFile(ref.absolutePath);if(createHash('sha256').update(data).digest('hex')!==ref.sha256)throw new Error('Evidence integrity mismatch');return{ref,data};
 }
}
