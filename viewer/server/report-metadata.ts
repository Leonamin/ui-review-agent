import {safeUrl} from '../../src/policy.js';
import {themeStatusLabel} from '../../src/check-presentation.js';
import {autoStyleComparisonReportSchema} from '../../src/automatic-style-comparison.js';
import {styleComparisonReportSchema} from '../../src/style-comparison.js';
import {z} from 'zod';
import type {CaptureContext,ReportSummary} from '../features/reports/types.js';
type Metadata=Pick<ReportSummary,'serviceName'|'screenTitle'|'pageTitle'|'urlPath'|'isLocalTarget'|'metadataProvenance'>;
const object=(value:unknown):Record<string,unknown>|undefined=>value!==null&&typeof value==='object'&&!Array.isArray(value)?value as Record<string,unknown>:undefined;
const text=(value:unknown):string|undefined=>{if(typeof value!=='string')return;const result=value.replace(/\s+/g,' ').trim();return result&&result.length<=200?result:undefined;};

export function recordedStateDiscoveryWait(value:unknown):ReportSummary['stateDiscoveryWait'] {
 const discovery=object(value);
 if(discovery?.status!=='partial'||discovery.reasonCode!=='wait-limit')return;
 const maxWaitMs=discovery.maxWaitMs;
 return typeof maxWaitMs==='number'&&Number.isSafeInteger(maxWaitMs)&&maxWaitMs>=0?{maxWaitMs}:{};
}

export function recordedLegacyStateDiscoveryWait(document:Record<string,unknown>,manifest:Record<string,unknown>):ReportSummary['stateDiscoveryWait'] {
 const discovery=object(document.stateDiscovery);
 if(document.status!=='partial'||discovery?.status!=='partial'||discovery.reasonCode!==undefined||
  discovery.reason!=='준비 완료를 확인하지 못했습니다. 로딩, 준비 조건 및 관찰 범위를 확인해야 합니다.'||
  object(discovery.modalExploration)?.status!=='not-needed'||
  !Array.isArray(discovery.blockedRequests)||discovery.blockedRequests.length>0)return;
 const maxWaitMs=object(object(manifest.spec)?.stateDiscovery)?.maxWaitMs;
 // The previous wait loop only settled after 1,600 ms. The complete probe ran between the two captures.
 if(typeof maxWaitMs!=='number'||!Number.isSafeInteger(maxWaitMs)||maxWaitMs<0||maxWaitMs>=1600)return;
 if(!Array.isArray(document.observations)||document.observations.length!==2)return;
 const [first,second]=document.observations.map(object);
 if(typeof first?.captureEndedAt!=='string'||typeof second?.captureStartedAt!=='string')return;
 const elapsedMs=Date.parse(second.captureStartedAt)-Date.parse(first.captureEndedAt);
 if(elapsedMs>=maxWaitMs&&elapsedMs<1600)return {maxWaitMs};
}

export function recordedWebUrl(value:unknown):string|undefined {
 if(typeof value!=='string')return;
 try {
  const url=new URL(value);
  if(url.protocol==='http:'||url.protocol==='https:')return safeUrl(value);
 }catch{}
}

const finite=(value:unknown):number|undefined=>typeof value==='number'&&Number.isFinite(value)?value:undefined;
const rect=z.object({x:z.number(),y:z.number(),width:z.number().nonnegative(),height:z.number().nonnegative()});
const count=z.number().int().nonnegative();
const spacingMeasurement={
 bounds:rect,
 targetBounds:z.array(rect).min(1).max(2),
 observed:z.number().nonnegative(),
 threshold:z.number().positive(),
};
const spacingChecks=z.object({
 inspectedPairs:count,
 inspectedCards:count,
 isLimited:z.boolean().optional(),
 checks:z.array(z.discriminatedUnion('kind',[
  z.object({...spacingMeasurement,kind:z.literal('control-gap'),axis:z.enum(['row','column'])}),
  z.object({...spacingMeasurement,kind:z.literal('card-inset'),edge:z.enum(['top','right','bottom','left'])}),
 ])).max(24),
});
const themeObservation=z.object({
 requested:z.enum(['light','dark']),status:z.enum(['verified','unverified']),reason:z.string().max(1000),
 scope:z.enum(['page','region']).optional(),
 regions:z.array(z.object({role:z.string().max(80),bounds:rect,background:z.string().max(100)})).max(50).optional(),
});
export function recordedCaptureLabel(value:unknown,fallback:string):string {
 const observation=object(value);
 const state=text(object(observation?.state)?.label);
 const theme=themeObservation.safeParse(observation?.theme);
 if(!theme.success)return state??fallback;
 const label=theme.data.requested==='light'?'라이트 모드':'다크 모드';
 const {status,scope}=theme.data;
 return [label,status==='unverified'||scope==='region'?themeStatusLabel(status,scope):undefined,state].filter(Boolean).join(' · ');
}
const deterministicChecks=z.object({
 evidenceId:z.string().max(300),
 contrast:z.object({
  status:z.enum(['passed','violation','incomplete','inapplicable']),
  passed:count,violations:count,incomplete:count,
  source:z.literal('visible-text').optional(),
  hasReachedLimit:z.boolean().optional(),
  examples:z.array(z.object({
   status:z.enum(['violation','incomplete']),observedRatio:z.number().optional(),expectedRatio:z.number().optional(),
   foreground:z.string().max(100).optional(),background:z.string().max(100).optional(),
   target:z.object({tag:z.string().max(80),bounds:rect}).optional(),
  })).max(100).optional(),
 }).optional(),
 alignment:z.object({tolerance:z.number().nonnegative(),checks:z.array(z.object({
  status:z.enum(['passed','violation','candidate','unverified']),
  groupIndex:count.nullable(),contractIndex:count.optional(),axis:z.enum(['row','column']).optional(),line:count.optional(),groupBox:rect.optional(),
  formPair:z.enum(['field-select','field-action']).optional(),evidenceId:z.string().max(200).optional(),materialityThreshold:z.number().nonnegative().optional(),
  members:z.array(z.object({hitBox:rect,visualBox:rect,visualSource:z.enum(['element','before','after']),elementRef:z.string().regex(/^e\d+$/).optional(),formRole:z.enum(['text-field','select','action-button']).optional()})).max(500),
  differences:z.array(z.object({kind:z.enum(['cross-size','alignment']),spread:z.number().nonnegative(),signedTopOffset:z.number().optional()})).max(2),
  reason:z.string().max(1000).optional(),
 })).max(10000)}).optional(),
});
const verticalScrollPosition=z.object({
 owner:z.enum(['document','container']),offset:z.number(),maxOffset:z.number().nonnegative(),extent:z.number().positive(),
 visibleStart:z.number().nonnegative(),visibleEnd:z.number().nonnegative(),clip:rect,
});
export function recordedCapture(value:unknown):CaptureContext|undefined {
 const observation=object(value);
 if(!observation)return;
 const source=object(observation.source);
 if(source?.kind==='image'){
  const width=finite(source.width),height=finite(source.height);
  if(width===undefined||height===undefined||width<=0||height<=0)return;
  return {observationId:text(observation.observationId),image:{fileName:text(source.fileName)??'이미지',width,height,importedAt:typeof source.importedAt==='string'?source.importedAt:undefined}};
 }
 const viewport=object(observation.viewport), scroll=object(observation.scrollOffset);
 const width=finite(viewport?.width), height=finite(viewport?.height), scale=finite(viewport?.deviceScaleFactor);
 const x=finite(scroll?.x), y=finite(scroll?.y);
 const capture:CaptureContext={};
 if(typeof observation.observationId==='string'&&observation.observationId)capture.observationId=observation.observationId;
 const observedUrl=recordedWebUrl(observation.url);
 if(observedUrl)capture.observedUrl=observedUrl;
 if(typeof observation.captureStartedAt==='string'&&Number.isFinite(Date.parse(observation.captureStartedAt)))capture.capturedAt=observation.captureStartedAt;
 if(width!==undefined&&height!==undefined&&width>0&&height>0)capture.viewport={width,height,deviceScaleFactor:scale!==undefined&&scale>0?scale:undefined};
 if(x!==undefined&&y!==undefined)capture.scrollOffset={x,y};
 const verticalScroll=verticalScrollPosition.safeParse(observation.verticalScroll);
 if(verticalScroll.success)capture.verticalScroll=verticalScroll.data;
 if(typeof observation.isStable==='boolean')capture.isStable=observation.isStable;
 const theme=themeObservation.safeParse(observation.theme);
 if(theme.success)capture.theme=theme.data;
 const checks=deterministicChecks.safeParse(observation.deterministicChecks);
 if(checks.success){
  const source=object(observation.deterministicChecks);
  const spacing=spacingChecks.safeParse(source?.spacing);
  const styleComparison=styleComparisonReportSchema.safeParse(source?.styleComparison);
  const autoStyleComparison=autoStyleComparisonReportSchema.safeParse(source?.autoStyleComparison);
  capture.deterministicChecks={...checks.data,
   ...(spacing.success?{spacing:spacing.data}:{}),
   ...(styleComparison.success?{styleComparison:styleComparison.data}:{}),
   ...(autoStyleComparison.success?{autoStyleComparison:autoStyleComparison.data}:{})};
 }
 return Object.keys(capture).length?capture:undefined;
}
/** Read only recorded initial observation labels. Never infer brands/categories from hosts. */
export function observedReportMetadata(report:Record<string,unknown>,target:string):Metadata{
 const output:Metadata={metadataProvenance:{}};
 try{const url=new URL(target);if(['http:','https:'].includes(url.protocol)){output.urlPath=url.pathname;output.isLocalTarget=['localhost','127.0.0.1','[::1]'].includes(url.hostname);output.metadataProvenance!.urlPath='target-url';}}catch{}
 const observation=Array.isArray(report.observations)?object(report.observations[0]):undefined;if(!observation)return output;
 const title=text(observation.pageTitle);if(title){output.pageTitle=title;output.metadataProvenance!.pageTitle='observation-page-title';}
 const elements=Array.isArray(observation.elements)?observation.elements.slice(0,1000).map(object).filter((e):e is Record<string,unknown>=>Boolean(e)):[];
 const visible=elements.filter(element=>element.isVisible===true);
 const headings=[...new Set(visible.filter(element=>element.tag==='h1').map(element=>text(element.text)).filter((value):value is string=>Boolean(value)))];
 if(headings.length===1){output.screenTitle=headings[0];output.metadataProvenance!.screenTitle='visible-heading';}
 // A matching strong label is not proof of a service identity. Existing reports
 // have no explicit service-name contract, so serviceName remains unknown.
 return output;
}
