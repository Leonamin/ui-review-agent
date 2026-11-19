import type {Page} from 'playwright';
import {z} from 'zod';

export const stylePropertySchema = z.enum([
 'height','min-height','font-size','font-weight','line-height','padding-left','padding-right',
 'border-top-left-radius','border-top-color','border-top-width','background-color','color',
]);
export const styleValueSchema = z.string().trim().min(1).max(100);
const label = z.string().trim().min(1).max(120);
const selector = z.string().trim().min(1).max(500);
export const styleBoundsSchema = z.object({x:z.number(),y:z.number(),width:z.number().positive(),height:z.number().positive()});
const property=stylePropertySchema,value=styleValueSchema,box=styleBoundsSchema;
const expected = z.partialRecord(property,value);
const side = z.object({label,selector,expected:expected.optional()}).strict();

export const styleComparisonUrlSchema = z.string().max(2048).url().refine(raw=>{
  if(!URL.canParse(raw))return false;
  const url=new URL(raw);
  return ['http:','https:'].includes(url.protocol)&&!url.username&&!url.password;
 }, 'Use an HTTP(S) URL without credentials.');
export const styleComparisonSchema = z.object({
 label,
 comparisonUrl:styleComparisonUrlSchema,
 reference:side,
 comparison:side,
 properties:z.array(property).min(1).max(property.options.length),
}).strict().superRefine((config,ctx)=>{
 const properties=new Set(config.properties);
 if(properties.size!==config.properties.length)
  ctx.addIssue({code:'custom',path:['properties'],message:'Specify each property once.'});
 for(const key of ['reference','comparison'] as const){
  if(Object.keys(config[key].expected??{}).some(name=>!properties.has(name as StyleProperty)))
   ctx.addIssue({code:'custom',path:[key,'expected'],message:'Expected values must use the selected properties.'});
 }
});
export type StyleComparison = z.infer<typeof styleComparisonSchema>;
type StyleProperty = z.infer<typeof property>;
export type StyleSide = z.infer<typeof side>;
const values = z.partialRecord(property,value);
const sample = z.discriminatedUnion('status',[
 z.object({status:z.literal('measured'),bounds:box,values}),
 z.object({status:z.literal('unverified'),reason:z.enum(['missing','ambiguous','not-visible','invalid-selector','different-url','http-error','unstable','unavailable'])}),
]);
export type StyleSample = z.infer<typeof sample>;
type StyleObservation = {observationId:string;screenshotEvidenceId?:string;url:string;sample:StyleSample};
const recordedSide = z.object({
 label,selector,url:z.string().max(2048),observationId:z.string().max(300).optional(),
 screenshotEvidenceId:z.string().max(300).optional(),sample,
});
export const styleComparisonReportSchema = z.object({
 label,
 evidenceId:z.string().max(300),
 reference:recordedSide,
 comparison:recordedSide,
 checks:z.array(z.object({
  property,
  status:z.enum(['passed','violation','candidate','unverified']),
  reference:value.optional(),
  comparison:value.optional(),
  expectedReference:value.optional(),
  expectedComparison:value.optional(),
 })).max(property.options.length),
});
export type StyleComparisonReport = z.infer<typeof styleComparisonReportSchema>;

export async function sampleComputedStyle(page:Page,url:string,selector:string,properties:StyleProperty[]):Promise<StyleSample> {
 return page.evaluate(({url,selector,properties})=>{
  if(location.href!==url)return {status:'unverified',reason:'different-url'};
  let nodes:NodeListOf<Element>;
  try{nodes=document.querySelectorAll(selector);}
  catch{return {status:'unverified',reason:'invalid-selector'};}
  if(!nodes.length)return {status:'unverified',reason:'missing'};
  if(nodes.length!==1)return {status:'unverified',reason:'ambiguous'};
  const element=nodes[0];
  const bounds=element.getBoundingClientRect();
  if(!element.checkVisibility({opacityProperty:true,visibilityProperty:true,contentVisibilityAuto:true})||
     bounds.width<=0||bounds.height<=0||bounds.right<=0||bounds.bottom<=0||bounds.left>=innerWidth||bounds.top>=innerHeight)
   return {status:'unverified',reason:'not-visible'};
  const x=Math.max(0,bounds.left),y=Math.max(0,bounds.top);
  const width=Math.min(innerWidth,bounds.right)-x,height=Math.min(innerHeight,bounds.bottom)-y;
  const points=[0.5,0.15,0.85];
  const hasVisiblePoint=points.some(dx=>points.some(dy=>{
   const hit=document.elementFromPoint(x+dx*width,y+dy*height);
   return hit!==null&&element.contains(hit);
  }));
  if(!hasVisiblePoint)return {status:'unverified',reason:'not-visible'};
  const css=getComputedStyle(element);
  return {status:'measured',bounds:{x:bounds.x,y:bounds.y,width:bounds.width,height:bounds.height},
   values:Object.fromEntries(properties.map(name=>[name,css.getPropertyValue(name).trim()]))};
 },{url:new URL(url).href,selector,properties});
}

export function makeStyleComparison(config:StyleComparison,reference:StyleObservation,comparison:Omit<StyleObservation,'observationId'> & {observationId?:string}):Omit<StyleComparisonReport,'evidenceId'> {
 const checks=config.properties.map((property):StyleComparisonReport['checks'][number]=>{
  const a=reference.sample.status==='measured'?reference.sample.values[property]:undefined;
  const b=comparison.sample.status==='measured'?comparison.sample.values[property]:undefined;
  const expectedReference=config.reference.expected?.[property];
  const expectedComparison=config.comparison.expected?.[property];
  const status=a===undefined||b===undefined?'unverified':
   (expectedReference!==undefined&&a!==expectedReference)||(expectedComparison!==undefined&&b!==expectedComparison)?'violation':
   a===b||expectedReference!==undefined&&expectedComparison!==undefined?'passed':'candidate';
  return {property,status,reference:a,comparison:b,expectedReference,expectedComparison};
 });
 return {label:config.label,checks,
  reference:{label:config.reference.label,selector:config.reference.selector,...reference},
  comparison:{label:config.comparison.label,selector:config.comparison.selector,...comparison},
 };
}
