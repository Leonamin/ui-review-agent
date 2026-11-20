import type {Page} from 'playwright';
import {z} from 'zod';
import {styleBoundsSchema,styleComparisonUrlSchema,stylePropertySchema,styleValueSchema} from './style-comparison.js';

export const MAX_STYLE_COMPARISON_TARGETS=4;
export const styleComparisonTargetsSchema=z.array(styleComparisonUrlSchema).min(2).max(MAX_STYLE_COMPARISON_TARGETS);
export const autoStyleComparisonConfigSchema=z.union([
 z.object({comparisonUrl:styleComparisonUrlSchema}).strict(),
 z.object({comparisonUrls:styleComparisonTargetsSchema}).strict(),
]);
export function automaticStyleUrls(config:AutoStyleComparisonConfig):string[]{
 return 'comparisonUrls' in config?config.comparisonUrls:[config.comparisonUrl];
}
export function hasDistinctStyleUrls(referenceUrl:string,comparisonUrls:string[]):boolean{
 const reference=URL.parse(referenceUrl);
 if(!reference)return false;
 const seen=new Set([reference.href]);
 return comparisonUrls.every(value=>{
  const comparison=URL.parse(value);
  if(!comparison||comparison.origin!==reference.origin||seen.has(comparison.href))return false;
  seen.add(comparison.href);
  return true;
 });
}
export type AutoStyleComparisonConfig=z.infer<typeof autoStyleComparisonConfigSchema>;
const role=z.enum(['searchbox','textbox','combobox','button','checkbox','radio','switch','tab','link','navigation','complementary']);
const maxElements=48;
const sideName=z.enum(['reference','comparison']);
const pageReason=z.enum(['different-url','http-error','unstable','unavailable']);
const unmeasuredReason=z.enum(['unstable','unavailable']);
const element=z.object({label:z.string().max(120),selector:z.string().min(1).max(500),bounds:styleBoundsSchema});
const locatedElement=element.extend({side:sideName,role});
const screen=z.object({
 url:z.string().max(2048),observationId:z.string().max(300).optional(),screenshotEvidenceId:z.string().max(300).optional(),
 reason:pageReason.optional(),hasReachedLimit:z.boolean(),inspected:z.number().int().nonnegative().max(maxElements),
});
const count=z.number().int().nonnegative();
export const autoStyleComparisonReportSchema=z.object({
 evidenceId:z.string().max(300),
 reference:screen,comparison:screen,
 matches:z.array(z.object({
  role,method:z.enum(['label','unique-role']),reference:element,comparison:element,
  differences:z.array(z.object({property:stylePropertySchema,reference:styleValueSchema,comparison:styleValueSchema})).max(stylePropertySchema.options.length),
 })).max(maxElements),
 unmatched:z.array(locatedElement).max(2*maxElements),
 ambiguous:z.array(locatedElement).max(2*maxElements),
 unmeasured:z.array(locatedElement.extend({reason:unmeasuredReason})).max(2*maxElements),
 coverage:z.object({matched:count,changed:count,unmatched:count,ambiguous:count,unmeasured:count}),
});
export type AutoStyleComparisonReport=z.infer<typeof autoStyleComparisonReportSchema>;
export const autoStyleComparisonsSchema=z.array(autoStyleComparisonReportSchema).min(2).max(MAX_STYLE_COMPARISON_TARGETS);
export function recordedAutomaticStyles(checks:{autoStyleComparison?:AutoStyleComparisonReport;autoStyleComparisons?:AutoStyleComparisonReport[]}|undefined){
 return checks?.autoStyleComparisons??(checks?.autoStyleComparison?[checks.autoStyleComparison]:[]);
}
type StyleProperty=z.infer<typeof stylePropertySchema>;
type AutoStyleRole=z.infer<typeof role>;
type Screen=z.infer<typeof screen>;
type Candidate=z.infer<typeof element> & {
 role:AutoStyleRole;
 scope:string;
 interactionState:string;
 values:Partial<Record<StyleProperty,string>>;
};
export type AutoStyleProbe={entries:Candidate[];hasReachedLimit:boolean;reason?:Screen['reason'];incompleteRoles?:AutoStyleRole[]};
type SampledCandidate=Candidate & {reason?:z.infer<typeof unmeasuredReason>};
export type AutoStyleSample=Omit<AutoStyleProbe,'entries'> & {entries:SampledCandidate[]};
export type AutoStyleInput=Omit<Screen,'reason'|'hasReachedLimit'|'inspected'> & {sample:AutoStyleSample};

const controlProperties:StyleProperty[]=[
 'height','font-size','font-weight','line-height','padding-left','padding-right',
 'border-top-left-radius','border-top-color','border-top-width','background-color','color',
];
const landmarkProperties:StyleProperty[]=['padding-left','padding-right','border-top-left-radius','border-top-color','border-top-width','background-color','color'];

export function probeAutomaticStyles(page:Page,url:string):Promise<AutoStyleProbe>{
 return page.evaluate(({url,roles,controlProperties,landmarkProperties,maxElements})=>{
  const expected=new URL(url);
  const actual=new URL(location.href);
  if(expected.origin!==actual.origin||expected.pathname!==actual.pathname||expected.hash!==actual.hash||
     [...new Set(expected.searchParams.keys())].some(key=>JSON.stringify(expected.searchParams.getAll(key))!==JSON.stringify(actual.searchParams.getAll(key))))
   return {entries:[],hasReachedLimit:false,reason:'different-url'};
  const entries:Candidate[]=[];
  const roleSelector=roles.map(role=>`[role~="${role}"]`).join(',');
  const nodes=document.querySelectorAll(`input,select,textarea,button,a[href],nav,aside,${roleSelector}`);
  const maxScanned=600;
  const candidates=Array.from({length:Math.min(nodes.length,maxScanned)},(_,index)=>nodes[index]).flatMap(node=>{
   const explicit=node.getAttribute('role')?.split(/\s+/).find(value=>roles.some(role=>role===value)) as AutoStyleRole|undefined;
   let role=explicit;
   if(!role&&!node.hasAttribute('role')){
    if(node instanceof HTMLInputElement){
     if(node.type==='search')role='searchbox';
     else if(['text','email','password','url','tel'].includes(node.type))role='textbox';
     else if(node.type==='checkbox'||node.type==='radio')role=node.type;
     else if(['button','submit','reset'].includes(node.type))role='button';
    }else if(node instanceof HTMLTextAreaElement)role='textbox';
    else if(node instanceof HTMLSelectElement&&!node.multiple&&node.size<=1)role='combobox';
    else if(node.matches('button'))role='button';
    else if(node.matches('a[href]'))role='link';
    else if(node.matches('nav'))role='navigation';
    else if(node.matches('aside'))role='complementary';
   }
   return role?[{node,role}]:[];
  });
  candidates.sort((a,b)=>roles.indexOf(a.role)-roles.indexOf(b.role));
  // Methods keep this serialized callback independent from tsx function-name helpers.
  const ops={
   clean(value:string|null|undefined){return value?.replace(/\s+/g,' ').trim().slice(0,120)??'';},
   accessibleLabel(node:Element,role:AutoStyleRole){
    const ids=node.getAttribute('aria-labelledby')?.trim().split(/\s+/).slice(0,10);
    const referenced=ids?.map(id=>document.getElementById(id)?.textContent?.trim()).filter(Boolean).join(' ');
    const explicit=ops.clean(referenced)||ops.clean(node.getAttribute('aria-label'));
    if(explicit)return explicit;
    if(node instanceof HTMLInputElement||node instanceof HTMLTextAreaElement||node instanceof HTMLSelectElement){
     const native=ops.clean(Array.from(node.labels??[]).slice(0,10).map(label=>label.innerText).join(' '));
     if(native)return native;
     return ops.clean(node.getAttribute('placeholder'));
    }
    if(role==='navigation'||role==='complementary')return '';
    if(node instanceof HTMLElement)return ops.clean(node.innerText)||ops.clean(node.querySelector('img[alt]')?.getAttribute('alt'));
    return '';
   },
   locator(node:Element){
    const path:string[]=[];
    let current:Element|null=node;
    while(current){
     let index=1;
     for(let sibling=current.previousElementSibling;sibling;sibling=sibling.previousElementSibling){
      if(sibling.localName===current.localName)index++;
     }
     path.unshift(`${CSS.escape(current.localName)}:nth-of-type(${index})`);
     current=current.parentElement;
    }
    return path.join(' > ');
   },
  };
  const incompleteRoles=new Set<AutoStyleRole>(nodes.length>maxScanned?roles:[]);
  for(const {node,role} of candidates){
   if(node.closest('[aria-hidden="true"],[inert]')||!node.checkVisibility({opacityProperty:true,visibilityProperty:true,contentVisibilityAuto:true}))continue;
   const {x,y,width,height,left,top,right,bottom}=node.getBoundingClientRect();
   const visibleLeft=Math.max(0,left),visibleTop=Math.max(0,top);
   const visibleWidth=Math.min(innerWidth,right)-visibleLeft,visibleHeight=Math.min(innerHeight,bottom)-visibleTop;
   if(visibleWidth<=0||visibleHeight<=0)continue;
   const points=[0.5,0.15,0.85];
   if(!points.some(dx=>points.some(dy=>{
    const hit=document.elementFromPoint(visibleLeft+dx*visibleWidth,visibleTop+dy*visibleHeight);
    return hit!==null&&node.contains(hit);
   })))continue;
   if(entries.length>=maxElements){
    for(const truncated of roles.slice(roles.indexOf(role)))incompleteRoles.add(truncated);
    break;
   }
   const selector=ops.locator(node);
   if(selector.length>500){incompleteRoles.add(role);continue;}
   const scope=node.parentElement?.closest('main,nav,aside,header,footer,dialog,[role="dialog"],[role="navigation"],[role="complementary"]');
   const properties=role==='navigation'||role==='complementary'?landmarkProperties:controlProperties;
   const css=getComputedStyle(node);
   const interactionState=[
    node.matches(':disabled,[aria-disabled="true"]')?'disabled':'',
    node.matches('[aria-current]:not([aria-current="false"]):not([aria-current=""]),[aria-selected="true"],[data-state="active"]')?'active':'',
    node.matches(':checked,[aria-checked="true"],[data-state="checked"]')?'checked':node.matches('[aria-checked="mixed"]')?'mixed':'',
    node.matches('[aria-pressed="true"]')?'pressed':node.matches('[aria-pressed="mixed"]')?'mixed':'',
    node.matches('[aria-expanded="true"],[data-state="open"]')?'expanded':'',
   ].filter(Boolean).join(' ');
   entries.push({
    role,label:ops.accessibleLabel(node,role),selector,scope:scope?`${scope.getAttribute('role')??scope.localName} ${ops.clean(scope.getAttribute('aria-label'))}`:'',
    interactionState,bounds:{x,y,width,height},
    values:Object.fromEntries(properties.map(property=>[property,css.getPropertyValue(property).trim()])),
   });
  }
  return {entries,hasReachedLimit:incompleteRoles.size>0,incompleteRoles:[...incompleteRoles]};
 },{url:new URL(url).href,roles:role.options,controlProperties,landmarkProperties,maxElements});
}

export function settleAutomaticStyles(before:AutoStyleProbe,after:AutoStyleProbe,hasStableObservation:boolean,redact:(value:string)=>string):AutoStyleSample{
 const newer=new Map(after.entries.map(entry=>[entry.selector,entry]));
 const older=new Set(before.entries.map(entry=>entry.selector));
 const discovered=[...before.entries,...after.entries.filter(entry=>!older.has(entry.selector))];
 const entries=discovered.slice(0,maxElements).map(entry=>{
  const hasMatchingMeasurement=hasStableObservation&&JSON.stringify(entry)===JSON.stringify(newer.get(entry.selector))&&older.has(entry.selector);
  const reason=!hasMatchingMeasurement?'unstable':Object.values(entry.values).every(value=>styleValueSchema.safeParse(value).success)?undefined:'unavailable';
  return {...entry,label:redact(entry.label).slice(0,120),scope:redact(entry.scope),reason} satisfies SampledCandidate;
 });
 const reason=before.reason===after.reason?after.reason:'unstable';
 const incompleteRoles=[...new Set([
  ...(before.incompleteRoles??(before.hasReachedLimit?role.options:[])),
  ...(after.incompleteRoles??(after.hasReachedLimit?role.options:[])),
  ...discovered.slice(maxElements).map(entry=>entry.role),
 ])];
 return {entries,reason:!hasStableObservation&&reason!=='http-error'?'unstable':reason,hasReachedLimit:incompleteRoles.length>0,incompleteRoles};
}

const normalize=(value:string)=>value.includes('[input value omitted]')||value.length>=120?'':value.normalize('NFKC').trim().toLowerCase();
function hasCompatibleScope(a:Candidate,b:Candidate):boolean{
 const [leftKind,...leftName]=normalize(a.scope).split(' ');
 const [rightKind,...rightName]=normalize(b.scope).split(' ');
 if(!leftKind||!rightKind)return true;
 return leftKind===rightKind&&(!leftName.length||!rightName.length||leftName.join(' ')===rightName.join(' '));
}
const recordedElement=({label,selector,bounds}:Candidate)=>({label,selector,bounds});
const recordedScreen=({sample,...rest}:AutoStyleInput):Screen=>({...rest,reason:sample.reason,hasReachedLimit:sample.hasReachedLimit,inspected:sample.entries.length});
const groupBy=(entries:SampledCandidate[],key:(value:SampledCandidate)=>string)=>{
 const groups=new Map<string,SampledCandidate[]>();
 for(const entry of entries){
  const name=key(entry);
  if(!name)continue;
  const group=groups.get(name);
  if(group)group.push(entry);
  else groups.set(name,[entry]);
 }
 return groups;
};

export function makeAutomaticStyleComparison(reference:AutoStyleInput,comparison:AutoStyleInput):Omit<AutoStyleComparisonReport,'evidenceId'>{
 const matches:AutoStyleComparisonReport['matches']=[];
 const consumed=new Set<Candidate>();
 const hasLimitedSample=reference.sample.hasReachedLimit||comparison.sample.hasReachedLimit;
 const incompleteRoles=new Set([reference.sample,comparison.sample].flatMap(sample=>sample.incompleteRoles??(sample.hasReachedLimit?role.options:[])));
 const byLabel=(candidate:Candidate)=>{
  const label=normalize(candidate.label);
  return label?JSON.stringify([candidate.role,label]):'';
 };
 const pair=(left:SampledCandidate,right:SampledCandidate,method:'label'|'unique-role')=>{
  if(incompleteRoles.has(left.role)||reference.sample.reason||comparison.sample.reason||left.reason||right.reason||left.interactionState!==right.interactionState)return;
  consumed.add(left);consumed.add(right);
  const differences=stylePropertySchema.options.flatMap(property=>{
   const reference=left.values[property],comparison=right.values[property];
   return reference!==undefined&&comparison!==undefined&&reference!==comparison?[{property,reference,comparison}]:[];
  });
  matches.push({role:left.role,method,reference:recordedElement(left),comparison:recordedElement(right),differences});
 };
 const namedReference=groupBy(reference.sample.entries,byLabel),namedComparison=groupBy(comparison.sample.entries,byLabel);
 for(const [key,left] of namedReference){
  const right=namedComparison.get(key)??[];
  if(left.length===1&&right.length===1){
   if(hasCompatibleScope(left[0],right[0]))pair(left[0],right[0],'label');
   continue;
  }
  const rightContexts=groupBy(right,entry=>normalize(entry.scope));
  for(const [scope,group] of groupBy(left,entry=>normalize(entry.scope))){
   const other=rightContexts.get(scope);
   if(group.length===1&&other?.length===1)pair(group[0],other[0],'label');
  }
 }
 const roleReference=groupBy(reference.sample.entries,entry=>entry.role),roleComparison=groupBy(comparison.sample.entries,entry=>entry.role);
 for(const role of ['searchbox','complementary'] as const){
  const left=roleReference.get(role),right=roleComparison.get(role);
  if(hasLimitedSample||left?.length!==1||right?.length!==1||consumed.has(left[0])||consumed.has(right[0]))continue;
  if(role==='complementary'&&Math.abs(left[0].bounds.x-right[0].bounds.x)>8)continue;
  pair(left[0],right[0],'unique-role');
 }
 const unmatched:AutoStyleComparisonReport['unmatched']=[];
 const ambiguous:AutoStyleComparisonReport['ambiguous']=[];
 const unmeasured:AutoStyleComparisonReport['unmeasured']=[];
 for(const side of ['reference','comparison'] as const){
  const own=side==='reference'?reference:comparison,other=side==='reference'?comparison:reference;
  const otherNames=side==='reference'?namedComparison:namedReference;
  const otherRoles=side==='reference'?roleComparison:roleReference;
  for(const entry of own.sample.entries){
   if(consumed.has(entry))continue;
   const located={side,role:entry.role,...recordedElement(entry)};
   if(entry.reason||own.sample.reason||other.sample.reason){
    unmeasured.push({...located,reason:entry.reason??(own.sample.reason==='unstable'||other.sample.reason==='unstable'?'unstable':'unavailable')});
    continue;
   }
   const exact=otherNames.get(byLabel(entry))?.filter(candidate=>!consumed.has(candidate));
   const alternatives=otherRoles.get(entry.role)?.filter(candidate=>!consumed.has(candidate));
   if(exact?.length===1&&hasCompatibleScope(entry,exact[0])&&exact[0].reason){
    unmeasured.push({...located,reason:exact[0].reason});
    continue;
   }
   if(incompleteRoles.has(entry.role)||exact?.length||((entry.role==='searchbox'||entry.role==='complementary')&&alternatives?.length))ambiguous.push(located);
   else unmatched.push(located);
  }
 }
 return {reference:recordedScreen(reference),comparison:recordedScreen(comparison),matches,unmatched,ambiguous,unmeasured,
  coverage:{matched:matches.length,changed:matches.filter(match=>match.differences.length>0).length,unmatched:unmatched.length,ambiguous:ambiguous.length,unmeasured:unmeasured.length}};
}
