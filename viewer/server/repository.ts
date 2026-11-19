import type {WorkspaceSource} from '../../src/workspace-contract.js';
import {projectReportImageLayout} from './report-layout.js';
import {recordedEvaluation} from './evaluation-status.js';
import {validateFocusImage} from '../../src/focused-review.js';
import {MAX_NORMALIZED_IMAGE_BYTES} from '../../src/image-input.js';
import type {FocusSource} from '../../src/focused-review-contract.js';
import {RecommendationStore} from './recommendation-store.js';
import {metadataHash,type RecommendationInput} from './recommendation-provider.js';
import {observedReportMetadata,recordedCapture,recordedCaptureLabel,recordedLegacyStateDiscoveryWait,recordedStateDiscoveryWait,recordedWebUrl} from './report-metadata.js';
import {readdir,realpath,stat,open} from 'node:fs/promises';
import {constants} from 'node:fs';
import {resolve,relative,dirname,sep,isAbsolute} from 'node:path';
import {createHash} from 'node:crypto';
import type {ReportSummary,ReportDetail,ReportList} from '../features/reports/types.js';
import {reportName} from '../features/reports/presentation.js';
import type {WorkspaceReportMetadata} from '../features/workspaces/report-picker.js';
import type {ReviewReportContext} from '../../src/review-contract.js';
const arr=(v:unknown):any[]=>Array.isArray(v)?v:[];
const str=(v:unknown,fallback=''):string=>typeof v==='string'?v.slice(0,20000):fallback;
const strings=(v:unknown)=>arr(v).filter(x=>typeof x==='string').map(x=>str(x));
const key=(v:string)=>createHash('sha256').update(v).digest('hex');
function automaticCandidates(d:Record<string,any>){
 const seen=new Set(arr(d.evaluation?.findings).map(f=>f?.issueId));
 return arr(d.verificationCandidates).filter(f=>{
  if(f?.source!=='automatic-rule'||f.disposition!=='needs-verification'||typeof f.issueId!=='string'||seen.has(f.issueId))return false;
  seen.add(f.issueId);
  return true;
 });
}
function displayedFindings(d:Record<string,any>){
 const evaluationFindings=d.evaluation?.findings;
 if(!Array.isArray(evaluationFindings))return [...arr(d.findings),...arr(d.verificationCandidates)];
 return [...evaluationFindings,...automaticCandidates(d)];
}
export class ViewerError extends Error {constructor(public status:number,message:string){super(message);}}
export class ReportRepository {
 private entries=new Map<string,string>(); private root='';
 private lookupTrashedReportIds?:()=>ReadonlySet<string>;
 readonly recommendations:RecommendationStore;
 constructor(private configuredRoot:string,recommendations?:RecommendationStore){this.recommendations=recommendations??new RecommendationStore(configuredRoot);}
 setTrashedReportIdsLookup(lookup:()=>ReadonlySet<string>){this.lookupTrashedReportIds=lookup;}
 private async rootPath(){if(!this.root){try{this.root=await realpath(this.configuredRoot);}catch{throw new ViewerError(404,'보고서 폴더를 찾을 수 없습니다. --runs 경로를 확인하세요.');}}return this.root;}
 private async safeFile(path:string,maxBytes=32*1024*1024){
  const root=await this.rootPath();
  try{
   const canonical=await realpath(path);
   if(canonical!==root&&!canonical.startsWith(root+sep))throw new ViewerError(403,'보고서 폴더 밖의 파일은 열 수 없습니다.');
   const handle=await open(canonical,constants.O_RDONLY|constants.O_NOFOLLOW);
   try{
    const info=await handle.stat();
    if(!info.isFile()||info.size>maxBytes)throw new ViewerError(413,'파일 형식 또는 크기가 지원 범위를 벗어났습니다.');
    return await handle.readFile();
   }finally{await handle.close();}
  }catch(error){
   if((error as NodeJS.ErrnoException).code==='ENOENT')throw new ViewerError(404,'보고서 파일을 찾을 수 없습니다.');
   throw error;
  }
 }
 private async read(path:string){try{const parsed=JSON.parse((await this.safeFile(path)).toString('utf8'));if(!parsed||typeof parsed!=='object'||Array.isArray(parsed))throw new Error('shape');return parsed;}catch(error){if(error instanceof ViewerError)throw error;throw new ViewerError(422,'보고서 JSON을 읽을 수 없습니다. 파일이 완성되었는지 확인한 뒤 다시 시도하세요.');}}
 private summary(id:string,path:string,d:Record<string,any>):ReportSummary {
  const evaluation=recordedEvaluation(d);
  const stateDiscoveryWait=recordedStateDiscoveryWait(d.stateDiscovery);
  const findings=Array.isArray(d.evaluation?.findings)?d.evaluation.findings:Array.isArray(d.findings)?[...d.findings,...arr(d.verificationCandidates)]:null;
  const automaticCandidateCount=automaticCandidates(d).length;
  const target=d.imageSource?.kind==='image'?`이미지: ${str(d.imageSource.fileName,'이름 미기록')}`:recordedWebUrl(d.spec?.targetUrl)||recordedWebUrl(d.targetUrl)||recordedWebUrl(d.observations?.[0]?.url)||'대상 URL 미기록';
  const screenshots=this.evidence(d).filter(e=>e.observationId!=='source-baseline');
  const initialScreenshotId=d.observations?.[0]?.screenshotRefs?.[0];
  const thumbnail=screenshots.find(item=>item.evidenceId===initialScreenshotId)??screenshots[0];
  return {
   ...observedReportMetadata(d,target),id,runId:str(d.runId,'이름 없는 실행'),label:relative(this.root,dirname(path)),target,
   thumbnailUrl:thumbnail?this.imageUrl(id,thumbnail.evidenceId):undefined,
   status:str(d.status,'unknown'),startedAt:str(d.startedAt),...(d.endedAt?{endedAt:str(d.endedAt)}:{}),provider:str(d.provider||d.evaluation?.provider,'미기록'),
   evaluation,...(stateDiscoveryWait?{stateDiscoveryWait}:{}),initialCount:evaluation?.status==='failed'?null:findings?findings.length:null,measurementCount:Array.isArray(d.verifications)?d.verifications.length:null,
   ...(automaticCandidateCount>0?{automaticCandidateCount}:{}),isLegacy:!Array.isArray(d.verifications),hasReadError:false,
  };
 }
 private imageUrl(reportId:string,evidenceId:string){return `/api/reports/${reportId}/images/${key(evidenceId)}`;}
 async list(includesReport: (id: string) => boolean = () => true):Promise<ReportList>{
  const root=await this.rootPath();
  const trashedIds=this.lookupTrashedReportIds?.();
  const paths:{id:string;path:string;time:number}[]=[];
  const entries=new Map<string,string>();
  let scanned=0,hasMore=false;
  const walk=async(dir:string,depth:number)=>{
   if(depth>9||scanned>=30000){hasMore=true;return;}
   let children;
   try{children=await readdir(dir,{withFileTypes:true});}
   catch(error){
    if(depth>0&&(error as NodeJS.ErrnoException).code==='ENOENT')return;
    throw error;
   }
   for(const entry of children){
    if(++scanned>30000){hasMore=true;break;}
    const path=resolve(dir,entry.name);
    if(entry.isDirectory())await walk(path,depth+1);
    else if(entry.isFile()&&entry.name==='report.json'){
     const id=key(relative(root,path));
     if(trashedIds?.has(id))continue;
     // Keep detail and image lookups independent of the active list scope.
     entries.set(id,path);
     if(!includesReport(id))continue;
     try{paths.push({id,path,time:(await stat(path)).mtimeMs});}
     catch(error){if((error as NodeJS.ErrnoException).code!=='ENOENT')throw error;}
    }
   }
  };
  await walk(root,0);
  paths.sort((a,b)=>b.time-a.time);
  hasMore ||= paths.length>1000;
  const reports:ReportSummary[]=[];
  for(const {id,path} of paths.slice(0,1000)){
   try{
    const document=await this.read(path);
    const summary=this.summary(id,path,document);
    const recommendation=await this.recommendations.get(id).catch(()=>null);
    reports.push({...summary,...(recommendation?{recommendation:{...recommendation,hasSourceChanged:recommendation.sourceHash!==metadataHash(document)}}:{})});
   }catch(error){
    if(error instanceof ViewerError&&error.status===404)continue;
    reports.push({id,runId:'읽을 수 없는 보고서',label:relative(root,dirname(path)),target:'보고서 오류',status:'unknown',startedAt:'',provider:'미기록',initialCount:null,measurementCount:null,isLegacy:true,hasReadError:true});
   }
  }
  this.entries=entries;
  return{reports,hasMore,warnings:hasMore?['탐색 한도에 도달했습니다. --runs로 더 작은 폴더를 선택하세요.']:[]};
 }
 private async entry(id:string){
  if(!/^[a-f0-9]{64}$/.test(id))throw new ViewerError(400,'잘못된 보고서 ID입니다.');
  if(!this.lookupTrashedReportIds?.().has(id)&&!this.entries.has(id))await this.list();
  const path=this.entries.get(id);
  if(!path||this.lookupTrashedReportIds?.().has(id))throw new ViewerError(404,'보고서를 찾을 수 없습니다. 목록을 새로고침하세요.');
  return path;
 }
 async workspaceReportMetadata(ids: string[],taskContexts: Record<string,ReviewReportContext>): Promise<Record<string,WorkspaceReportMetadata>> {
  if(ids.some(id=>!this.entries.has(id)))await this.list(()=>false);
  const metadata: [string,WorkspaceReportMetadata][]=[];
  for(const id of ids){
   const path=this.entries.get(id);
   if(!path||this.lookupTrashedReportIds?.().has(id))continue;
   try{
    const summary=this.summary(id,path,await this.read(path));
    const recommendation=await this.recommendations.get(id).catch(()=>null);
    const taskContext=taskContexts[id];
    const title=taskContext?.taskTitle.trim() || reportName({...summary,taskContext,recommendation:recommendation??undefined},'').trim();
    metadata.push([id,{title,startedAt:summary.startedAt}]);
   }catch(error){
    if(!(error instanceof ViewerError))throw error;
   }
  }
  return Object.fromEntries(metadata);
 }
 private evidence(d:Record<string,any>){const all=[...arr(d.evidence),...arr(d.observations).flatMap(o=>arr(o?.evidenceRefs))];return [...new Map(all.filter(e=>e&&e.kind==='screenshot'&&typeof e.evidenceId==='string').map(e=>[e.evidenceId,e])).values()];}
 async detail(id:string):Promise<ReportDetail>{const path=await this.entry(id),d=await this.read(path),summary=this.summary(id,path,d);let manifest:Record<string,any>={};try{manifest=await this.read(resolve(dirname(path),'manifest.json'));}catch{}const findings=displayedFindings(d);const recommendation=await this.recommendations.get(id).catch(()=>null);const ledger=d.observationLedger??d.evaluation?.observationLedger;const stateDiscoveryWait=summary.stateDiscoveryWait??recordedLegacyStateDiscoveryWait(d,manifest);return{...summary,...(stateDiscoveryWait?{stateDiscoveryWait}:{}),...(d.followup?{followup:d.followup}:{}),...(d.focusedReview?{focusedReview:d.focusedReview}:{}),...(ledger?.schemaVersion==='observation-ledger-0.1'?{observationLedger:{collectionStatus:str(ledger.collectionStatus),isObservationCoverageComplete:ledger.isObservationCoverageComplete===true,accountedCount:Number(ledger.accountedCount)||0,adjudicatedCount:Number(ledger.adjudicatedCount)||0,rejectedCount:arr(ledger.rejectedObservations).length,notes:arr(ledger.observations).map(note=>{const decision=arr(ledger.resolutions).find(item=>item.noteId===note.noteId);return{id:str(note.noteId),fact:str(note.visibleFact),location:str(note.location),status:str(decision?.resolution,'unreviewed'),reason:str(decision?.reason,'미판정'),references:[...strings(note.evidenceIds),...arr(decision?.outputRefs).map(ref=>str(ref.kind)+': '+str(ref.id)),...(decision?.mergedInto?['병합: '+str(decision.mergedInto)]:[])],errors:strings(decision?.errors)};}),overflow:[...arr(ledger.overflowFindings).map(f=>({id:str(f.issueId),title:str(f.title),kind:str(f.disposition)})),...arr(ledger.overflowSuggestions).map(s=>({id:str(s.suggestionId),title:str(s.title),kind:'suggestion'}))]}}:{}),requestedUrl:recordedWebUrl(manifest.spec?.targetUrl)||recordedWebUrl(d.spec?.targetUrl)||recordedWebUrl(d.targetUrl),...(manifest.spec?.themeReview?.mode==='both'?{requestedThemeReview:'both' as const}:{}),captures:arr(d.observations).flatMap(observation=>{const capture=recordedCapture(observation);return capture?[{...capture,...(observation.state&&['loading','ready','unknown','blocked'].includes(observation.state.readiness)?{state:{label:str(observation.state.label),readiness:observation.state.readiness,reason:str(observation.state.reason)}}:{})}]:[];}),...(recommendation?{recommendation:{...recommendation,hasSourceChanged:recommendation.sourceHash!==metadataHash(d)}}:{}),...(d.stateDiscovery&&['completed','partial'].includes(d.stateDiscovery.status)?{stateDiscovery:{status:d.stateDiscovery.status,reason:str(d.stateDiscovery.reason),dismissalCount:Number(d.stateDiscovery.dismissalCount)||0,...(d.stateDiscovery.modalExploration&&['not-needed','completed','gave-up'].includes(d.stateDiscovery.modalExploration.status)?{modalExploration:{status:d.stateDiscovery.modalExploration.status,attempts:Number(d.stateDiscovery.modalExploration.attempts)||0,actionCount:Number(d.stateDiscovery.modalExploration.actionCount)||0,reason:str(d.stateDiscovery.modalExploration.reason),history:arr(d.stateDiscovery.modalExploration.history).map(action=>({actionId:str(action.actionId),attempt:Number(action.attempt)||0,method:str(action.method),buttonLabel:str(action.buttonLabel)||undefined,outcome:str(action.outcome),hasModalDismissed:typeof action.hasModalDismissed==='boolean'?action.hasModalDismissed:null,hasRedirected:action.hasRedirected===true,beforeObservationId:str(action.beforeObservationId),afterObservationId:str(action.afterObservationId)||undefined}))}}:{})}}:{}),purpose:str(manifest.spec?.purpose||d.spec?.purpose||d.purpose),requestedModel:str(manifest.requestedModel||manifest.spec?.model||d.spec?.model,'미기록'),actualModel:str(d.evaluation?.model,'미확인'),suggestions:arr(d.suggestions??d.evaluation?.suggestions).map((s:any,i:number)=>({id:str(s.suggestionId,`suggestion-${i}`),title:str(s.title),observation:str(s.observation),rationale:str(s.rationale),possibleImpact:str(s.possibleImpact),uncertainty:str(s.uncertainty),recommendation:str(s.recommendation),evidenceIds:strings(s.evidenceIds),observationIds:strings(s.observationIds)})),findings:findings.map((f:any,i:number)=>({id:str(f.issueId,`legacy-${i}`),...(f.source==='automatic-rule'?{source:'automatic-rule' as const}:{}),title:str(f.title,'제목 없음'),disposition:str(f.disposition,'미기록'),severity:str(f.severity,'미기록'),category:str(f.category),facts:arr(f.observedFacts).map(x=>str(x?.text)).filter(Boolean),expectations:arr(f.expectations).map(x=>str(x?.statement)).filter(Boolean),impact:str(f.userImpact),recommendation:str(f.recommendation),evidenceIds:strings(f.evidenceIds),observationIds:strings(f.observationIds)})),measurements:arr(d.verifications).map(v=>({id:str(v.verificationId),candidateId:str(v.request?.candidateId),recipe:str(v.request?.recipe),outcome:str(v.outcome,'inconclusive'),condition:str(v.condition),summary:str(v.summary),recordedValues:[['표시 합계',v.measurements?.displayedTotalMinor],['항목 계산 합계',v.measurements?.computedTotalMinor],['차이',v.measurements?.differenceMinor]].filter(([,value])=>typeof value==='string'||typeof value==='number').map(([label,value])=>({label:String(label),value:v.measurements?.currency==='KRW'&&/^-?\d+$/.test(String(value))?BigInt(String(value)).toLocaleString('ko-KR')+'원':String(value)+' '+str(v.measurements?.currency)+' (최소 통화 단위)'})),measurementJson:v.measurements&&typeof v.measurements==='object'?JSON.stringify(v.measurements,null,2):'',beforeObservationId:str(v.beforeObservationId),afterObservationId:str(v.afterObservationId),hasMeasured:typeof v.hasMeasured==='boolean'?v.hasMeasured:null,targets:arr(v.targetMeasurements).map(t=>({targetRef:str(t.targetRef),claimIds:strings(t.claimIds),outcome:str(t.outcome,'inconclusive'),hasMeasured:typeof t.hasMeasured==='boolean'?t.hasMeasured:null,summary:str(t.summary)})),limitations:strings(v.limitations),evidenceIds:strings(v.evidenceIds)})),selections:arr(d.evaluation?.verificationSelections).map(s=>({candidateId:str(s.candidateId),origin:str(s.origin),status:str(s.status),recipe:str(s.recipe),reason:str(s.reason)})),baselineImages:this.evidence(d).filter(e=>e.observationId==='source-baseline').map(e=>({id:key(e.evidenceId),observationId:str(e.observationId),label:'이전 보고서 기준 화면',url:this.imageUrl(id,e.evidenceId)})),images:this.evidence(d).filter(e=>e.observationId!=='source-baseline').map(e=>{const layout=projectReportImageLayout(d,e);return{id:key(e.evidenceId),evidenceId:e.evidenceId,observationId:str(e.observationId),label:recordedCaptureLabel(arr(d.observations).find(observation=>observation?.observationId===e.observationId),e.evidenceId),url:this.imageUrl(id,e.evidenceId),...(layout?{layout}:{})};}),limitations:[...strings(d.limitations),...strings(d.evaluation?.limitations)],hasVerificationData:Array.isArray(d.verifications),coverage:{canFinish:typeof d.coverage?.canFinish==='boolean'?d.coverage.canFinish:null,unmet:arr(d.coverage?.unmetChecks).map(c=>str(c?.reason||c?.checkId))}};}
 async followupSource(id:string,imageId?:string):Promise<WorkspaceSource&{imageBytes?:Buffer}>{const path=await this.entry(id),bytes=await this.safeFile(path),report=JSON.parse(bytes.toString('utf8'));const selectedImageId=imageId??(report.imageSource?.kind==='image'?this.evidence(report).find(e=>e.observationId!=='source-baseline')?.evidenceId:undefined);const focus=selectedImageId?await this.focusSource(id,imageId??key(selectedImageId)):undefined;return{reportId:id,reportSha256:createHash('sha256').update(bytes).digest('hex'),runId:str(report.runId),...(focus?{image:focus.source,imageBytes:focus.bytes}:{})};}
 async focusSource(id:string,imageId:string):Promise<{source:FocusSource;bytes:Buffer}>{
  const path=await this.entry(id),report=await this.read(path),evidence=this.evidence(report).find(e=>key(e.evidenceId)===imageId);if(!evidence)throw new ViewerError(404,'캡처 증거를 찾을 수 없습니다.');
  const bytes=await this.image(id,imageId);let decoded;try{decoded=await validateFocusImage(bytes);}catch(error){throw new ViewerError(422,error instanceof Error?error.message:'유효한 캡처가 필요합니다.');}
  const observation=arr(report.observations).find(o=>o.observationId===evidence.observationId);const screenshot=evidence.screenshot;
  if(screenshot){const clip=screenshot.clip,dpr=screenshot.deviceScaleFactor;if(!['image-pixels','viewport-css-pixels'].includes(screenshot.coordinateSpace)||!clip||![clip.x,clip.y,clip.width,clip.height,dpr].every(Number.isFinite)||clip.width<=0||clip.height<=0||dpr<=0||Math.abs(decoded.width-clip.width*dpr)>1||Math.abs(decoded.height-clip.height*dpr)>1)throw new ViewerError(422,'캡처 좌표 메타데이터와 이미지 크기가 일치하지 않습니다.');}
  return{source:{reportId:id,imageId,runId:str(report.runId),observationId:str(evidence.observationId),evidenceId:str(evidence.evidenceId),...decoded,...(screenshot?{screenshot}:{}),...(typeof observation?.isStable==='boolean'?{isStable:observation.isStable}:{})},bytes};
 }
 async recommendationInput(id:string):Promise<RecommendationInput>{const path=await this.entry(id),report=await this.read(path);let manifest:Record<string,any>={};try{manifest=await this.read(resolve(dirname(path),'manifest.json'));}catch{}const observation=arr(report.observations)[0];const items:{id:string;text:string}[]=[];const add=(id:string,value:unknown,max=200)=>{if(typeof value==='string'&&value.trim()&&!/\[.*(?:omitted|redacted).*\]/i.test(value))items.push({id,text:value.trim().slice(0,max)});};add('page-title',observation?.pageTitle);add('purpose',manifest.spec?.purpose||report.spec?.purpose||report.purpose,1000);try{add('url-path',new URL(report.targetUrl||report.spec?.targetUrl||observation?.url).pathname);}catch{}for(const [index,element] of arr(observation?.elements).slice(0,200).entries()){if(element&&element.isVisible===true&&['h1','h2','h3','button','a','label','legend'].includes(element.tag))add(`element-${index}`,element.text);if(items.length>=45)break;}return{sourceHash:metadataHash(report),inputHash:metadataHash(items),items};}
 async recommendation(id:string){const path=await this.entry(id),report=await this.read(path),recommendation=await this.recommendations.get(id);return recommendation?{...recommendation,hasSourceChanged:recommendation.sourceHash!==metadataHash(report)}:null;}
 async image(id:string,imageId:string):Promise<Buffer>{if(!/^[a-f0-9]{64}$/.test(imageId))throw new ViewerError(400,'잘못된 이미지 ID입니다.');const path=await this.entry(id),d=await this.read(path),e=this.evidence(d).find(e=>key(e.evidenceId)===imageId);if(!e)throw new ViewerError(404,'이미지 기록을 찾을 수 없습니다.');const rel=str(e.relativePath);let imagePath:string;if(rel&&!isAbsolute(rel)&&!rel.split(/[\\/]/).includes('..')){imagePath=resolve(dirname(path),rel);try{await stat(imagePath);}catch{imagePath=str(e.absolutePath);}}else throw new ViewerError(403,'허용되지 않은 이미지 경로입니다.');if(!isAbsolute(imagePath))throw new ViewerError(404,'이미지 파일을 찾을 수 없습니다.');let bytes:Buffer;try{bytes=await this.safeFile(imagePath,MAX_NORMALIZED_IMAGE_BYTES);}catch(error){if(error instanceof ViewerError)throw error;throw new ViewerError(404,'이미지 파일이 없거나 접근할 수 없습니다.');}if(!bytes.subarray(0,8).equals(Buffer.from([137,80,78,71,13,10,26,10])))throw new ViewerError(415,'PNG 캡처만 지원합니다.');if(typeof e.sha256==='string'&&createHash('sha256').update(bytes).digest('hex')!==e.sha256)throw new ViewerError(409,'이미지 해시가 보고서와 다릅니다.');return bytes;}
}
