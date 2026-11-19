import {randomUUID} from 'node:crypto';
import type {BrowserSession} from './browser.js';
import type {Observation,Rect} from './types.js';
import type {VerificationRequest,VerificationResult} from './verification-types.js';
import {PolicyError} from './policy.js';
import {verificationRequestSchema} from './evaluation-verification.js';
export {verificationRequestSchema} from './evaluation-verification.js';
export function verificationTargets(request:VerificationRequest):string[]{return request.recipe==='occlusion'?[request.targetRef,...(request.additionalTargets??[]).map(target=>target.targetRef),...(request.occluderRefs??[])]:request.recipe==='focus'?[request.scopeRef]:[request.totalRef,...request.itemRefs];}
export function isVerificationTab(action:{type:string;value?:string;selector:string}):boolean{return action.type==='press'&&action.value==='Tab'&&action.selector==='body';}
interface MoneyPart {minor:string;currency:'KRW'|'USD'|'EUR';label:string;isDiscount:boolean}
function parseMoney(text:string,isTotal:boolean):MoneyPart|undefined {
 if(/\+|\[input value omitted\]|포함|별도|예상|부터|최대|최소|단가|수량|unit\s*price|quantity|\beach\b|included|exclusive|estimated|from|up to|%/i.test(text))return;
 const matches=[...text.matchAll(/(?:₩|\$|€|KRW|USD|EUR)?\s*[-−]?\d[\d,.]*\s*(?:원|KRW|USD|EUR|달러|유로)?/g)].filter(m=>m[0].trim());
 if(matches.length!==1)return;const token=matches[0][0].trim();const currencies=[/₩|KRW|원/.test(token)?'KRW':null,/\$|USD|달러/.test(token)?'USD':null,/€|EUR|유로/.test(token)?'EUR':null].filter(Boolean);
 if(currencies.length!==1)return;const currency=currencies[0] as MoneyPart['currency'];
 const label=text.replace(matches[0][0],'').trim();if(/[-−]/.test(label))return;
 if(isTotal?!/합계|총액|총\s*결제|결제\s*금액|total/i.test(label):!/소계|상품|서비스|배송|세금|부가세|할인|쿠폰|수수료|subtotal|shipping|tax|discount|fee|coupon|items?/i.test(label))return;
 if(!isTotal&&/합계|총액|total/i.test(label)&&!/소계|상품\s*합계|subtotal/i.test(label))return;
 const isDiscount=/할인|쿠폰|discount|coupon/i.test(label);
 if(/[-−]/.test(token)&&!isDiscount)return; // negative fees/refunds require semantics not supplied by this recipe
const number=token.replace(/[^\d,.−-]/g,'').replace('−','-');
 const regex=/^-?(?:\d+|\d{1,3}(?:,\d{3})+)(?:\.\d{1,2})?$/;
 if(!(currency==='KRW'?/^-?(?:\d+|\d{1,3}(?:,\d{3})+)$/:regex).test(number))return;
 const [whole,fraction='']=number.replaceAll(',','').replace('-','').split('.');if(whole.length>14)return;
 let amount=BigInt(whole)*(currency==='KRW'?1n:100n)+BigInt(currency==='KRW'?'0':fraction.padEnd(2,'0'));
 if(number.startsWith('-')||isDiscount)amount=-amount;
 if(isTotal&&amount<0n)return;
 return{minor:amount.toString(),currency,label:label.slice(0,200),isDiscount};
}
export function measureMoney(totalText:string,itemTexts:string[]):{outcome:VerificationResult['outcome'];measurements:Record<string,unknown>;summary:string} {
 const total=parseMoney(totalText,true);const items=itemTexts.map(text=>parseMoney(text,false));
 if(!total||items.some(item=>!item)||!items.length||items.some(item=>item!.currency!==total.currency))return{outcome:'inconclusive',measurements:{hasUnambiguousAmounts:false},summary:'Visible labels, currency or amount format do not establish an unambiguous additive calculation.'};
 const sum=items.reduce((value,item)=>value+BigInt(item!.minor),0n);const difference=BigInt(total.minor)-sum;
 return{outcome:difference===0n?'refuted':'reproduced',measurements:{hasUnambiguousAmounts:true,currency:total.currency,displayedTotalMinor:total.minor,computedTotalMinor:sum.toString(),differenceMinor:difference.toString(),items,total},summary:difference===0n?'The selected visible additive amounts exactly equal the displayed total.':'The selected visible additive amounts differ from the displayed total.'};
}
export function measureOcclusion(measurement:Record<string,unknown>,issue:'clipping'|'occlusion'):{outcome:VerificationResult['outcome'];summary:string} {
 if(measurement.hasSensitiveContent||measurement.hasComplexPainting||(measurement.style as Record<string,string>)?.pointerEvents==='none'||Number((measurement.style as Record<string,string>)?.opacity)===0)return{outcome:'inconclusive',summary:'Masked content or complex painting prevents this geometric check.'};
 const rects=measurement.textRects as Rect[];const clip=measurement.clip as {left:number;right:number;top:number;bottom:number};
 if(!rects?.length)return{outcome:'inconclusive',summary:'No eligible rendered text ranges were available.'};
 if(issue==='clipping'){
  const hasClipping=rects.some(r=>r.x<clip.left-1||r.y<clip.top-1||r.x+r.width>clip.right+1||r.y+r.height>clip.bottom+1);
  return{outcome:hasClipping?'reproduced':'not-reproduced',summary:hasClipping?'Text range geometry extends outside the effective viewport or CSS clipping bounds.':'No text range exceeded the measured clipping bounds in this observation.'};
 }
 const samples=measurement.samples as {hasTargetOnTop:boolean;hasOpaqueCover:boolean}[];
 if(!samples?.length)return{outcome:'inconclusive',summary:'No eligible viewport hit-test samples were available.'};
 const hasOcclusion=samples.some(sample=>!sample.hasTargetOnTop&&sample.hasOpaqueCover);
 if(!hasOcclusion&&samples.some(sample=>!sample.hasTargetOnTop))return{outcome:'inconclusive',summary:'Hit-test interception did not establish an opaque covering surface.'};
 return{outcome:hasOcclusion?'reproduced':'not-reproduced',summary:hasOcclusion?'Another element receives hit tests at one or more sampled text or interactive-control surface positions.':'The target received all sampled text/control-surface hit tests in this observation.'};
}
function measureScopedOcclusion(measurement:Record<string,unknown>,issue:'clipping'|'occlusion',occluderRefs:string[],scope:'text'|'control-surface'='text'):{outcome:VerificationResult['outcome'];summary:string}{
 if(issue==='occlusion'&&scope==='text')measurement={...measurement,samples:(measurement.samples as {sampleScope?:string}[]??[]).filter(sample=>sample.sampleScope!=='control-surface')};
 if(issue==='occlusion'&&occluderRefs.length){
  const samples=measurement.samples as {hasTargetOnTop:boolean;hasOpaqueCover:boolean;coveringElementRef?:string}[];
  if(samples?.some(sample=>!sample.hasTargetOnTop&&sample.hasOpaqueCover&&(!sample.coveringElementRef||!occluderRefs.includes(sample.coveringElementRef))))return{outcome:'inconclusive',summary:'A covering surface did not match the candidate-bound occluder references.'};
 }
 return measureOcclusion(measurement,issue);
}
function aggregateOcclusionTargets(targets:NonNullable<VerificationResult['targetMeasurements']>):{outcome:VerificationResult['outcome'];summary:string}{
 const hasReproduced=targets.some(target=>target.outcome==='reproduced');
 if(hasReproduced)return{outcome:'reproduced',summary:'At least one recorded target reproduced the measured condition; inspect each target outcome separately.'};
 if(targets.some(target=>target.outcome==='inconclusive'))return{outcome:'inconclusive',summary:'One or more target measurements were inconclusive; this does not refute the candidate.'};
 return{outcome:'not-reproduced',summary:'The condition was not reproduced at the selected targets in this run; unselected targets and other claims remain untested.'};
}
function hasOverlappingRefs(observation:Observation,refs:string[]):boolean {
 const boxes=refs.map(ref=>observation.elements.find(e=>e.elementRef===ref)!.boundingBox);
 return boxes.some((a,i)=>boxes.some((b,j)=>i!==j&&Math.min(a.x+a.width,b.x+b.width)-Math.max(a.x,b.x)>1&&Math.min(a.y+a.height,b.y+b.height)-Math.max(a.y,b.y)>1));
}
async function assertOcclusionRoleContinuity(session:BrowserSession,original:Observation,fresh:Observation,oldRefs:string[],freshRefs:string[]):Promise<void>{
 for(let index=0;index<oldRefs.length;index++){
  const old=original.elements.find(element=>element.elementRef===oldRefs[index])?.occlusionEvidence,current=fresh.elements.find(element=>element.elementRef===freshRefs[index])?.occlusionEvidence;
  if(!old||!current||old.hasUncertainCover!==current.hasUncertainCover||old.textRects.length!==current.textRects.length)throw new PolicyError('stale-observation','Occlusion role evidence changed before or across verification');
  for(let r=0;r<old.textRects.length;r++)if((['x','y','width','height'] as const).some(key=>Math.abs(old.textRects[r][key]-current.textRects[r][key])>1))throw new PolicyError('stale-observation','Rendered text geometry changed across role observations');
  const rebound=await session.resolveVerificationRefs(original.observationId,old.coveringElementRefs);
  if(JSON.stringify(rebound.slice().sort())!==JSON.stringify(current.coveringElementRefs.slice().sort()))throw new PolicyError('stale-observation','Opaque covering identity changed across role observations');
 }
}
async function assertAncestorContinuity(session:BrowserSession,original:Observation,fresh:Observation,oldRefs:string[],freshRefs:string[]):Promise<void>{
 for(let index=0;index<oldRefs.length;index++){
  const previous=original.elements.find(element=>element.elementRef===oldRefs[index])?.ancestorRefs;
  if(!previous)continue;
  const rebound=await session.resolveVerificationRefs(original.observationId,previous);
  const current=fresh.elements.find(element=>element.elementRef===freshRefs[index])?.ancestorRefs??[];
  if(JSON.stringify(rebound)!==JSON.stringify(current))throw new PolicyError('stale-observation','Candidate DOM ancestor provenance changed across verification');
 }
}
async function assertMoneyRelationContinuity(session:BrowserSession,original:Observation,fresh:Observation,oldRefs:string[],freshRefs:string[]):Promise<void>{
 for(let index=0;index<oldRefs.length;index++){
  const old=original.elements.find(e=>e.elementRef===oldRefs[index])!.moneyLabelRelation,current=fresh.elements.find(e=>e.elementRef===freshRefs[index])!.moneyLabelRelation;
  if(old?.status!==current?.status||old?.source!==current?.source||old?.labelText!==current?.labelText)throw new PolicyError('stale-observation','Money label relation changed between observations');
  if(old?.status==='resolved'){
   const rebound=await session.resolveVerificationRefs(original.observationId,old.labelRefs);
   if(JSON.stringify(rebound)!==JSON.stringify(current?.labelRefs))throw new PolicyError('stale-observation','Money label identity changed between observations');
  }
 }
}
export async function executeVerification(session:BrowserSession,raw:VerificationRequest):Promise<VerificationResult>{
 const request=verificationRequestSchema.parse(raw);const startedAt=new Date().toISOString();
 const result:VerificationResult={verificationId:`verification-${randomUUID()}`,request,recipeVersion:'1',hypothesisKind:request.recipe==='money'?'visible-total-mismatch':request.recipe==='focus'?'modal-focus-escape':request.issue==='clipping'?'text-clipped':'text-occluded',hasObservedViolation:null,expectedInvariant:request.expectation.statement,outcome:'inconclusive',condition:request.recipe==='money'?'The displayed total differs from the selected visible additive line items':request.recipe==='focus'?'Keyboard focus leaves the unique active modal during the initial or permitted Tab observations':request.issue==='clipping'?'Rendered text ranges extend outside effective clipping bounds':'An opaque different element intercepts hit tests at sampled rendered text or interactive-control surface positions',summary:'Verification did not complete',measurements:{},limitations:['Measurements verify only the recorded condition, not every factual claim or overall usability.'],evidenceIds:[],actionIds:[],failureAttribution:null,startedAt,endedAt:startedAt,replay:{recipe:request.recipe,version:'1',targetRefs:verificationTargets(request),allowedActionIds:request.recipe==='focus'?request.allowedActionIds:[],requiresFreshReferences:true}};
 if(request.recipe==='occlusion'&&request.targetScopes?.some(scope=>scope.scope==='control-surface')){result.hypothesisKind='element-occluded';result.condition='An opaque element covers sampled text or explicitly scoped interactive-control surface positions; inspect each target scope.';}
 if(request.recipe==='occlusion')result.targetMeasurements=[{targetRef:request.targetRef,claimIds:request.claimIds},...(request.additionalTargets??[])].map(target=>({...target,hasMeasured:false,outcome:'inconclusive',summary:'Not tested: verification prerequisites or budget have not completed.'}));
 try{
  if(!session.spec.shouldVerify)throw new PolicyError('verification-disabled','Verification must be explicitly enabled');
  const original=session.observations.find(o=>o.observationId===request.observationId);if(!original)throw new PolicyError('unknown-reference','Unknown request observation');
  if(request.evidenceIds.some(id=>!original.evidenceRefs.some(e=>e.evidenceId===id)))throw new PolicyError('unknown-evidence','Request evidence must belong to its observation');
  result.evidenceIds.push(...request.evidenceIds);
  if(!original.isStable)throw new PolicyError('unstable-observation','Original request observation was unstable');
  const targets=verificationTargets(request);if(new Set(targets).size!==targets.length)throw new PolicyError('duplicate-target','Repeated target references are not allowed');
  // Capture first, then bind by retained DOM identity, never a model supplied selector.
  const before=await session.capture();result.beforeObservationId=before.observationId;result.afterObservationId=before.observationId;result.evidenceIds.push(...before.evidenceRefs.map(e=>e.evidenceId));
  const currentRefs=await session.resolveVerificationRefs(request.observationId,targets);
  if(!before.isStable)throw new PolicyError('unstable-observation','Fresh capture was unstable');
  if(JSON.stringify(original.viewport)!==JSON.stringify(before.viewport)||original.url!==before.url||original.scrollOffset.x!==before.scrollOffset.x||original.scrollOffset.y!==before.scrollOffset.y)throw new PolicyError('stale-observation','Request page or scroll state changed before verification');
  for(let index=0;index<targets.length;index++){
   const old=original.elements.find(element=>element.elementRef===targets[index])!,fresh=before.elements.find(element=>element.elementRef===currentRefs[index])!;
   if(old.text!==fresh.text||old.tag!==fresh.tag||(['x','y','width','height'] as const).some(key=>Math.abs(old.boundingBox[key]-fresh.boundingBox[key])>1))throw new PolicyError('stale-observation','Request target text or geometry changed before verification');
  }
  await assertAncestorContinuity(session,original,before,targets,currentRefs);
  if(request.recipe==='focus'&&(JSON.stringify(original.focus?.activeElement)!==JSON.stringify(before.focus?.activeElement)||original.focus?.hasDocumentFocus!==before.focus?.hasDocumentFocus))throw new PolicyError('stale-observation','Focus changed while the model was evaluating; initial state was not restored');

  if(before.consistencyWarnings.some(w=>w.startsWith('Blocked')||w.startsWith('WebSocket')))throw new PolicyError('environment-blocked','Inspection policy blocked requests; product behavior cannot be isolated');
  if(request.recipe==='money'){
   if(hasOverlappingRefs(before,currentRefs))throw new PolicyError('ambiguous-target','Selected monetary rows overlap or contain each other');
   await assertMoneyRelationContinuity(session,original,before,targets,currentRefs);
   const bindings=await Promise.all(currentRefs.map(ref=>session.readVerificationMoneyText(before.observationId,ref)));
   const texts=bindings.map(binding=>binding.combinedText);
   const measured=measureMoney(texts[0],texts.slice(1));Object.assign(result,measured);result.measurements.bindings=bindings.map((binding,index)=>({targetRef:currentRefs[index],...binding}));result.condition='The displayed total differs from selected visible line items, including explicitly labeled discounts/taxes';
   result.limitations.push(...request.preconditions.filter(text=>text.startsWith('CTA amounts')));
   result.limitations.push('Arithmetic is conditional on the selected visible rows being complete; hidden taxes, business rules and omitted line items are not inferred.');
  }else if(request.recipe==='occlusion'){
   const scopedTargets=[{targetRef:request.targetRef,claimIds:request.claimIds},...(request.additionalTargets??[])];
   if(request.occluderRefs?.length)await assertOcclusionRoleContinuity(session,original,before,targets.slice(0,scopedTargets.length),currentRefs.slice(0,scopedTargets.length));
   for(let index=0;index<scopedTargets.length;index++){
    const measurement=await session.measureVerification(before.observationId,currentRefs[index]);
    const scope=request.targetScopes?.find(scope=>scope.targetRef===scopedTargets[index].targetRef)?.scope??'text';
    const measured=measureScopedOcclusion(measurement,request.issue,currentRefs.slice(scopedTargets.length),scope);measured.summary=`[${scope}] ${measured.summary}`;
    result.targetMeasurements![index]={...scopedTargets[index],hasMeasured:true,...measured,before:measurement};
   }
   result.measurements=result.targetMeasurements![0]!.before!;
   Object.assign(result,aggregateOcclusionTargets(result.targetMeasurements!));
   result.limitations.push('Each target outcome applies only to its recorded target and claim IDs. Other candidate facts and unselected targets are not tested.');
   result.limitations.push('DOM ranges and hit tests are not pixel visibility proofs. Transparent overlays, pseudo-elements, glyph shapes and pointer-events can differ from these measurements.');
  }else{
   const initial=await session.measureVerification(before.observationId,currentRefs[0]);result.measurements={initial,steps:[]};
   if(!initial.hasUniqueActiveModal)throw new PolicyError('unsupported-precondition','The observed scope is not the unique visible native modal or aria-modal dialog');
   if(new Set(request.allowedActionIds).size!==request.allowedActionIds.length)throw new PolicyError('duplicate-action','Tab action IDs must be unique');
   for(const id of request.allowedActionIds){const action=session.spec.allowedActions.find(a=>a.id===id);if(!action||!isVerificationTab(action))throw new PolicyError('scope-denied','Focus recipe permits only explicit body Tab actions');if(session.actions.some(a=>a.allowedActionId===id))throw new PolicyError('action-consumed','Focus action was already executed');}
   let hasEscaped=!initial.hasFocusInside;let hasDocumentFocus=Boolean(initial.hasDocumentFocus);
   for(const id of request.allowedActionIds){const action=await session.performAction(id,session.observations.at(-1)!.observationId);result.actionIds.push(action.actionId);if(action.outcome!=='success')throw new PolicyError('action-failed',action.message??'Tab action failed');const after=session.observations.at(-1)!;result.afterObservationId=after.observationId;result.evidenceIds.push(...after.evidenceRefs.map(e=>e.evidenceId));if(!after.isStable)throw new PolicyError('unstable-observation','Focus capture was unstable');const [scope]=await session.resolveVerificationRefs(request.observationId,[request.scopeRef]);const step=await session.measureVerification(after.observationId,scope);(result.measurements.steps as unknown[]).push({actionId:action.actionId,observationId:after.observationId,...step});if(!step.hasUniqueActiveModal)throw new PolicyError('unsupported-precondition','Modal closed or active scope became ambiguous during verification');hasEscaped ||= !step.hasFocusInside;hasDocumentFocus &&= Boolean(step.hasDocumentFocus);}
   result.outcome=!hasDocumentFocus?'inconclusive':hasEscaped?'reproduced':'not-reproduced';result.summary=!hasDocumentFocus?'Browser document focus was not maintained.':hasEscaped?'Active focus was outside the active modal in the initial or permitted Tab observations.':'Focus stayed within the modal in the tested Tab observations.';result.limitations.push('A bounded Tab sequence does not prove a full focus cycle, all keyboard operations, or a visible focus indicator.');
  }
  if(request.recipe!=='focus'){
   const after=await session.capture();result.afterObservationId=after.observationId;result.evidenceIds.push(...after.evidenceRefs.map(e=>e.evidenceId));
   const afterRefs=await session.resolveVerificationRefs(request.observationId,targets);await assertAncestorContinuity(session,original,after,targets,afterRefs);
   if(!after.isStable||before.url!==after.url||before.scrollOffset.x!==after.scrollOffset.x||before.scrollOffset.y!==after.scrollOffset.y)throw new PolicyError('unstable-observation','Page changed across measurement');
   for(let index=0;index<currentRefs.length;index++){const a=before.elements.find(e=>e.elementRef===currentRefs[index])!,b=after.elements.find(e=>e.elementRef===afterRefs[index])!;
    if(a.text!==b.text||(['x','y','width','height'] as const).some(key=>Math.abs(a.boundingBox[key]-b.boundingBox[key])>1))throw new PolicyError('stale-observation','Target text or geometry changed across measurement');}
   if(request.recipe==='money'){await assertMoneyRelationContinuity(session,before,after,currentRefs,afterRefs);await Promise.all(afterRefs.map(ref=>session.readVerificationMoneyText(after.observationId,ref)));}
   if(request.recipe==='occlusion'){
    if(request.occluderRefs?.length)await assertOcclusionRoleContinuity(session,before,after,currentRefs.slice(0,result.targetMeasurements!.length),afterRefs.slice(0,result.targetMeasurements!.length));
    for(let index=0;index<result.targetMeasurements!.length;index++){
     const target=result.targetMeasurements![index];const second=await session.measureVerification(after.observationId,afterRefs[index]);const next=measureScopedOcclusion(second,request.issue,afterRefs.slice(result.targetMeasurements!.length),request.targetScopes?.find(scope=>scope.targetRef===target.targetRef)?.scope??'text');target.after=second;
     if(next.outcome!==target.outcome)throw new PolicyError('unstable-observation','Measured target condition changed across captures');
    }
    result.measurements={before:result.targetMeasurements![0]!.before,after:result.targetMeasurements![0]!.after};
   }
  }
 }catch(error){if(result.targetMeasurements)for(const target of result.targetMeasurements){target.outcome='inconclusive';target.summary=target.hasMeasured?'Target evidence did not pass the complete before/after continuity check.':'Not tested: prerequisites or budget prevented measurement.';}result.outcome='inconclusive';result.summary=error instanceof Error?error.message.slice(0,500):'Verification failed';result.failureAttribution=error instanceof PolicyError&&['environment-blocked','unstable-observation'].includes(error.code)?'environment':error instanceof PolicyError?'automation':'unknown';}
 result.hasObservedViolation=result.outcome==='inconclusive'?null:result.outcome==='reproduced';
 result.endedAt=new Date().toISOString();
 const observationId=result.afterObservationId??request.observationId;
 const ref=await session.store.save(observationId,'rule',JSON.stringify(result,null,2),'application/json',result.verificationId);
 result.evidenceIds.push(ref.evidenceId);const observation=session.observations.find(o=>o.observationId===observationId);observation?.evidenceRefs.push(ref);
 return result;
}
