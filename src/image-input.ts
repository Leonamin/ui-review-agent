import {constants} from 'node:fs';
import {open,mkdir,writeFile} from 'node:fs/promises';
import {basename,join} from 'node:path';
import {createHash} from 'node:crypto';
import sharp from 'sharp';
import {EvidenceStore} from './evidence.js';
import type {Observation,ImageSource} from './types.js';

const MAX_BYTES=5*1024*1024;
const MAX_PIXELS=20_000_000;
export const MAX_NORMALIZED_IMAGE_BYTES=82*1024*1024;
export const IMAGE_UNAVAILABLE_CHECKS=[
 {checkId:'dom-layout',reason:'Image input has no DOM geometry or computed styles; visual estimates are not measured layout.'},
 {checkId:'accessibility-tree',reason:'Image input has no accessibility tree, semantics, focus or keyboard evidence.'},
 {checkId:'interaction',reason:'Clicking, scrolling, navigation, saving and content outside the image were not checked.'},
 {checkId:'source-capture',reason:'Original URL, CSS viewport, device scale, scroll position and capture time are unknown.'},
 {checkId:'privacy-redaction',reason:'Imported images are not automatically redacted. Visible text and values are sent to the evaluator.'},
];

/** Decode a bounded local raster, preserve the source, and expose only normalized pixels. */
export async function importImage(path:string,store:EvidenceStore,sourceKind:'upload'|'stored-png'='upload'):Promise<Observation>{
 const maxBytes=sourceKind==='stored-png'?MAX_NORMALIZED_IMAGE_BYTES:MAX_BYTES;
 const handle=await open(path,constants.O_RDONLY|constants.O_NONBLOCK);
 let bytes:Buffer;
 try{
  const info=await handle.stat();
  if(!info.isFile()||info.size===0||info.size>maxBytes)throw new Error(`Image must be a regular, non-empty file of at most ${maxBytes / (1024*1024)} MiB.`);
  bytes=Buffer.alloc(info.size+1);let size=0;
  while(size<bytes.length){const read=await handle.read(bytes,size,bytes.length-size,null);if(!read.bytesRead)break;size+=read.bytesRead;}
  if(size!==info.size)throw new Error('Image size changed while it was read.');bytes=bytes.subarray(0,size);
 }finally{await handle.close();}
 const decoder=sharp(bytes,{failOn:'warning',limitInputPixels:MAX_PIXELS,animated:true});
 const metadata=await decoder.metadata();
 if((sourceKind==='stored-png'?metadata.format!=='png':!['png','jpeg','webp'].includes(metadata.format??''))||(metadata.pages??1)!==1)throw new Error('Only single-frame PNG, JPEG and WebP images are supported.');
 const {data,info}=await decoder.rotate().png().toBuffer({resolveWithObject:true});
 if(data.length>MAX_NORMALIZED_IMAGE_BYTES)throw new Error('Decoded PNG exceeds the normalized image storage limit.');
 const mimeType=`image/${metadata.format}` as ImageSource['mimeType'];
 const originalRelativePath=`input/original.${metadata.format==='jpeg'?'jpg':metadata.format}`;
 await mkdir(join(store.runDir,'input'),{recursive:true,mode:0o700});
 await writeFile(join(store.runDir,originalRelativePath),bytes,{mode:0o600});
 const importedAt=new Date().toISOString();
 const source:ImageSource={kind:'image',fileName:basename(path),mimeType,sourceSha256:createHash('sha256').update(bytes).digest('hex'),originalRelativePath,importedAt,width:info.width,height:info.height,hasAutomaticRedaction:false,normalization:'decoded-oriented-png'};
 const observationId='obs-001';
 const screenshot=await store.save(observationId,'screenshot',data,'image/png');
 screenshot.isRedacted=false;
 screenshot.screenshot={coordinateSpace:'image-pixels',clip:{x:0,y:0,width:info.width,height:info.height},deviceScaleFactor:1,maskColor:'',redactionRegions:[]};
 return {source,observationId,runId:store.runId,url:'',pageTitle:'',captureStartedAt:importedAt,captureEndedAt:importedAt,
  viewport:{width:info.width,height:info.height,deviceScaleFactor:1},scrollOffset:{x:0,y:0},isStable:false,
  consistencyWarnings:[],screenshotRefs:[screenshot.evidenceId],evidenceRefs:[screenshot],elements:[],accessibilitySnapshot:'',
  documentWidth:info.width,viewportWidth:info.width,unsupportedFrames:0,imageFailures:0};
}
