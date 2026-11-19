import {z} from 'zod';
import {createHash} from 'node:crypto';
import type {EvaluationInput,EvaluationResult,ReviewFinding,FindingAssessment,Observation} from './types.js';
import type {VerificationRequest,VerificationResult} from './verification-types.js';
const text=z.string().trim().min(1).max(6000);
const id=z.string().min(1).max(200);
const base={requestId:id,candidateId:id,claimIds:z.array(id).min(1).max(5),observationId:id,expectation:z.object({expectationId:id,expectationSource:z.enum(['user-goal','visible-promise','rule','heuristic']),sourceRef:text,statement:text,applicability:text}).strict(),evidenceIds:z.array(id).min(1).max(20),preconditions:z.array(text).max(8)};
export const verificationRequestSchema=z.discriminatedUnion('recipe',[
 z.object({...base,recipe:z.literal('occlusion'),targetRef:id,issue:z.enum(['clipping','occlusion']),targetScopes:z.array(z.object({targetRef:id,scope:z.enum(['text','control-surface'])}).strict()).max(3).optional(),additionalTargets:z.array(z.object({targetRef:id,claimIds:z.array(id).min(1).max(5)}).strict()).max(2).optional(),occluderRefs:z.array(id).max(3).optional()}).strict(),
 z.object({...base,recipe:z.literal('focus'),scopeRef:id,allowedActionIds:z.array(id).min(1).max(3)}).strict(),
 z.object({...base,recipe:z.literal('money'),totalRef:id,itemRefs:z.array(id).min(1).max(8)}).strict(),
]);
function candidateScopeRefs(candidate:ReviewFinding,observation:Observation,recipe:VerificationRequest['recipe'],shouldExpand:boolean):Set<string>{
 const direct=new Set(candidate.visualEvidence?.filter(visual=>visual.observationId===observation.observationId&&!visual.hasMaskedContentDependency).flatMap(visual=>visual.elementRefs)??[]);
 const refs=new Set(direct);if(!shouldExpand)return refs;
 if(recipe==='occlusion')for(const element of observation.elements.filter(element=>direct.has(element.elementRef)))for(const ancestor of element.ancestorRefs??[])if(observation.elements.some(item=>item.elementRef===ancestor&&item.isPaintContainer))refs.add(ancestor);
 if(recipe==='money')for(const element of observation.elements){
  const relation=element.moneyLabelRelation;if(relation?.status!=='resolved')continue;
  const normalized=(text:string)=>text.replace(/\s+/g,'').toLowerCase();
  const hasExactRowScope=element.ancestorRefs?.some(ref=>direct.has(ref)&&observation.elements.some(parent=>parent.elementRef===ref&&normalized(parent.text)===normalized(`${relation.labelText??''}${element.text}`)))===true;
  if(relation.labelRefs.some(ref=>direct.has(ref))||hasExactRowScope)refs.add(element.elementRef);
 }
 return refs;
}
export function validateVerificationRequests(raw:unknown[],input:EvaluationInput,findings:ReviewFinding[],validEvidence:Set<string>,options:{shouldAllowAutomaticTargets?:boolean}={}):{requests:VerificationRequest[];limitations:string[];selections:VerificationSelection[]}{
 const requests:VerificationRequest[]=[];const limitations:string[]=[];const selections:VerificationSelection[]=[];
 if(!raw.length)return {requests,limitations,selections};
 if(!input.spec.shouldVerify)return {requests,limitations:['Verification proposals ignored: executable verification is disabled.'],selections};
 const seenCandidates=new Set<string>();const seenIds=new Set<string>();
 for(const value of raw){
  const parsed=verificationRequestSchema.safeParse(value);
  if(!parsed.success){const reason='Rejected verification request: unsupported recipe, arbitrary parameters, or invalid request schema.';limitations.push(reason);selections.push({candidateId:'unparsed',origin:'model',status:'rejected',reason});continue;}
  const request=parsed.data;const candidate=findings.find(f=>f.issueId===request.candidateId);const observation=input.observations.find(o=>o.observationId===request.observationId);
  const targets=request.recipe==='occlusion'?[request.targetRef,...(request.additionalTargets??[]).map(target=>target.targetRef),...(request.occluderRefs??[])]:request.recipe==='focus'?[request.scopeRef]:[request.totalRef,...request.itemRefs];
  const isExpectationBound=candidate?.expectations.some(expectation=>(Object.keys(expectation) as (keyof typeof expectation)[]).every(key=>expectation[key]===request.expectation[key]));
  const allClaimIds=[...request.claimIds,...(request.recipe==='occlusion'?request.additionalTargets?.flatMap(target=>target.claimIds)??[]:[])];
  const hasValidClaims=candidate&&allClaimIds.every(claim=>candidate.observedFacts.some(fact=>fact.factId===claim)&&candidate.claimEvidenceLinks.some(link=>link.claimId===claim&&!link.hasMaskedContentDependency));
  const claimEvidence=new Set(candidate?.claimEvidenceLinks.filter(link=>allClaimIds.includes(link.claimId)).flatMap(link=>link.evidenceIds)??[]);
  const candidateTargets=candidate&&observation?candidateScopeRefs(candidate,observation,request.recipe,Boolean(options.shouldAllowAutomaticTargets)):new Set<string>();
  const hasValidEvidence=request.evidenceIds.every(id=>validEvidence.has(id)&&claimEvidence.has(id)&&input.evidence.some(e=>e.evidenceId===id&&e.observationId===request.observationId));
  const hasValidTargets=observation&&targets.every(ref=>candidateTargets.has(ref)&&observation.elements.some(element=>element.elementRef===ref));
  const hasValidActions=request.recipe!=='focus'||(new Set(request.allowedActionIds).size===request.allowedActionIds.length&&request.allowedActionIds.every(id=>input.spec.allowedActions.some(action=>action.id===id&&action.type==='press'&&action.selector==='body'&&action.value==='Tab')));
  const hasMaskedMoney=request.recipe==='money'&&targets.some(ref=>observation?.redactionRegions?.some(region=>region.elementRef===ref));
  const hasInvalidTargetScope=request.recipe==='occlusion'&&request.targetScopes?.some(scope=>![request.targetRef,...(request.additionalTargets??[]).map(item=>item.targetRef)].includes(scope.targetRef));
  const hasForbiddenExtension=request.recipe==='occlusion'&&!options.shouldAllowAutomaticTargets&&(request.additionalTargets!==undefined||request.occluderRefs!==undefined||request.targetScopes!==undefined);
  if(hasInvalidTargetScope||hasForbiddenExtension||!candidate||candidate.disposition==='dismissed'||!candidate.observationIds.includes(request.observationId)||!isExpectationBound||!hasValidClaims||!hasValidEvidence||!hasValidTargets||!hasValidActions||hasMaskedMoney||new Set(request.claimIds).size!==request.claimIds.length||new Set(targets).size!==targets.length||seenCandidates.has(request.candidateId)||seenIds.has(request.requestId)){
   const reason=`Rejected verification request ${request.requestId}: candidate/claim/expectation/evidence/target/permission/privacy binding failed or duplicate request.`;limitations.push(reason);selections.push({candidateId:request.candidateId,origin:'model',status:'rejected',recipe:request.recipe,requestId:request.requestId,reason});continue;
  }
  if(requests.length>=3){const reason=`Verification request ${request.requestId} exceeds the maximum of three candidates.`;limitations.push(reason);selections.push({candidateId:request.candidateId,origin:'model',status:'rejected',recipe:request.recipe,requestId:request.requestId,reason});continue;}
  seenCandidates.add(request.candidateId);seenIds.add(request.requestId);requests.push(request);selections.push({candidateId:request.candidateId,origin:'model',status:'selected',recipe:request.recipe,requestId:request.requestId,reason:'Model proposal passed candidate, evidence, target and permission bindings.'});
 }
 return {requests,limitations,selections};
}
export function retainVerificationRequests(result:EvaluationResult):EvaluationResult {
 const candidates=new Set(result.findings.map(finding=>finding.issueId));const seen=new Set<string>();
 result.verificationRequests=(result.verificationRequests??[]).filter(request=>{if(!candidates.has(request.candidateId)||seen.has(request.candidateId)||seen.size>=3)return false;seen.add(request.candidateId);return true;});
 const retained=new Set(result.verificationRequests.map(request=>request.requestId));
 result.verificationSelections=result.verificationSelections?.map(selection=>selection.status==='selected'&&selection.requestId&&!retained.has(selection.requestId)?{...selection,status:'skipped' as const,reason:'Candidate or request omitted by final findings, strategy or request limits.'}:selection);
 return result;
}
export const VERIFICATION_PROMPT={
 task:'Optionally propose a registered measurement to test a specific existing candidate. Do not invent findings in order to use a recipe. Zero requests is valid. At most three requests, one per accepted candidate. Copy an existing expectation exactly, link actual observed fact IDs and their evidence IDs. Every recipe target/scope/item/total reference must be listed in the candidate visualEvidence for that same observation, without masked-content dependence; include all relevant measured elements there. A request is a hypothesis, not a successful measurement. Never output code, selectors, SQL, scripts, numeric amounts or formulas.',
 recipes:{occlusion:'targetRef and issue clipping/occlusion. Measures clipping geometry or hit-test coverage; it does not prove user confusion or subjective readability.',focus:'scopeRef must be a currently visible modal dialog (aria-modal=true or native modal). Use supplied allowedActionIds only, up to three body Tab actions. Measures modal focus containment only, not focus style or general tab order.',money:'totalRef plus up to eight itemRefs for explicit visible monetary line items contributing to that total. No masked values. Requires a complete visible breakdown, clear currency, quantities and discount/tax semantics. Parser determines numeric values; never invent a formula or a missing amount.'},
 preconditions:'Describe assumptions to be checked. This text never grants permissions. Omit a recipe if applicability or corresponding candidate is absent. Original semantic findings are never automatically promoted by a measurement.'
};

export function buildFindingAssessments(findings:ReviewFinding[],verifications:VerificationResult[]):FindingAssessment[]{
 return findings.map(finding=>({candidateId:finding.issueId,initialDisposition:finding.disposition,hasWholeFindingVerification:false,measurements:verifications.filter(result=>result.request.candidateId===finding.issueId).flatMap(result=>result.targetMeasurements?.length?result.targetMeasurements.map(target=>({verificationId:result.verificationId,claimIds:[...target.claimIds],outcome:target.outcome,condition:`${result.condition} [target: ${target.targetRef}]`} )):[{verificationId:result.verificationId,claimIds:[...result.request.claimIds],outcome:result.outcome,condition:result.condition}])}));
}

/** Conservative routing only: this never evaluates whether the alleged defect is true. */
export interface VerificationSelection {
 candidateId:string;origin:'model'|'automatic';status:'selected'|'skipped'|'rejected';
 recipe?:VerificationRequest['recipe'];requestId?:string;reason:string;
}
const hypothesisPatterns={
 clipping: /clip(?:ped|ping)?|truncat|잘[리림려립]|잘렸|잘린|말줄임|텍스트.{0,20}넘[치침]/i,
 occlusion: /occlu|obscur|overlap|가려|가림|가린|가립|겹[치침쳐칩]/i,
 focus: /focus|tab\b|keyboard|포커스|초점|키보드/i,
 money: /total|sum|subtotal|합계|총액|금액|가격|결제/i,
 mismatch: /mismatch|incorrect|inconsisten|does not (?:match|equal)|differs|difference|차액|차이|불일치|일치하지|맞지|다[르름릅]|틀[리림립]|오류/i,
};
/** Text routes an alleged arithmetic mismatch; numbers remain exclusively browser-measured. */
function hasMonetaryMismatch(text:string):boolean {
 const hasTotal=/\btotal\b|amount (?:due|charged|payable)|charg(?:ed|e)|총액|총\s*금액|총\s*결제|결제\s*금액|청구|표시.{0,8}합계/i.test(text);
 const hasAdditiveContext=/\bsum\b|line[- ]items?|item amounts?|합산|합계|항목.{0,10}(?:금액|합)|상품.{0,8}(?:금액|합)/i.test(text);
 const koreanComparative=/(?:크(?:다|며|고|지만|지)|큽니다|커(?:요|서|도)|큰|작(?:다|습니다|아요|으며|고|지)|적(?:다|습니다|어요|으며|고|지)|높(?:다|습니다|아요|으며|고|지)|낮(?:다|습니다|아요|으며|고|지)|많(?:다|습니다|아요|으며|고|지))/;
 const hasComparison=koreanComparative.test(text)||/(?:greater|higher|larger|less|lower|smaller)\s+than|exceed|overcharg|undercharg|(?:크|적|많|작|높|낮|더).{0,8}(?:다|게|청구|결제)|차이|초과/i.test(text);
 const hasKoreanNegation=/(?:크|큽|커|큰|작|적|높|낮|많).{0,14}(?:않|아니|아닙|없)/.test(text);
 const hasNegatedMismatch=hasKoreanNegation||/(?:not|never)\s+(?:greater|higher|larger|less|lower|smaller|different|incorrect|overcharg)|no\s+(?:mismatch|difference|overcharge)|차액(?:은|는|이|가)?\s*(?:전혀\s*)?없|차액.{0,8}발생하지|(?:차이|불일치|오류).{0,6}없|(?:크|적|많|작|높|낮|다르|초과).{0,8}(?:않|아니)|정상|정확히\s*일치/i.test(text);
 const hasUnrelatedComparison=/yesterday|previous (?:order|month|year)|other (?:product|order|plan)|어제|지난달|이전\s*주문|다른\s*(?:상품|주문|요금제)/i.test(text);
 const hasTypographyContext=/글자|글씨|서체|폰트|색상|\bfont\b|typograph|\bcolou?r\b/i.test(text);
 const hasExplainedDifference=/because|due to|includes?|including|포함|때문|반영|원래|원칙상|예정된|expected|intended/i.test(text);
 return !hasNegatedMismatch&&!hasUnrelatedComparison&&!hasExplainedDifference&&!hasTypographyContext&&hasTotal&&hasAdditiveContext&&(hypothesisPatterns.mismatch.test(text)||hasComparison);
}
function matchingRecipe(text:string):{recipe:VerificationRequest['recipe'];issue?:'clipping'|'occlusion'}|null {
 // Conservative sentence-level abstention, never reinterpret a negated observation as a defect.
 if(/(?:not|never|no)\s+(?:visibly\s+)?(?:clipp|truncat|occlud|obscur|overlap)|(?:잘|가리|가려|겹).{0,12}(?:않|아니)|(?:잘림|가림|겹침).{0,8}없|(?:focus|포커스|초점).{0,30}(?:remains? inside|stays? within|유지)/i.test(text))return null;
 const matches:({recipe:VerificationRequest['recipe'];issue?:'clipping'|'occlusion'})[]=[];
 if(hypothesisPatterns.clipping.test(text))matches.push({recipe:'occlusion',issue:'clipping'});
 if(hypothesisPatterns.occlusion.test(text))matches.push({recipe:'occlusion',issue:'occlusion'});
 if(hypothesisPatterns.focus.test(text)&&/escap|outside|leav|not (?:enter|move|reach)|이탈|밖|벗어|이동하지|들어가지|가지 않/i.test(text))matches.push({recipe:'focus'});
 if(hasMonetaryMismatch(text))matches.push({recipe:'money'});
 return matches.length===1?matches[0]!:null;
}
export function applyAutomaticVerificationRequests(input:EvaluationInput,result:EvaluationResult):EvaluationResult {
 if(!input.spec.shouldVerify)return result;
 const requests=[...(result.verificationRequests??[])];
 const selections:VerificationSelection[]=[...(result.verificationSelections??[])];
 for(const request of requests)if(!selections.some(selection=>selection.requestId===request.requestId))selections.push({candidateId:request.candidateId,origin:'model',status:'selected',recipe:request.recipe,requestId:request.requestId,reason:'Accepted model proposal passed candidate, evidence, target and permission bindings.'});
 for(const candidate of result.findings){
  if(candidate.disposition==='dismissed'||requests.some(request=>request.candidateId===candidate.issueId))continue;
  const skip=(reason:string,recipe?:VerificationRequest['recipe'])=>selections.push({candidateId:candidate.issueId,origin:'automatic',status:'skipped',...(recipe?{recipe}:{}),reason});
  if(requests.length>=3){skip('Registered verification request budget (3) exhausted.');continue;}
  let facts=candidate.observedFacts.map(fact=>({fact,match:matchingRecipe(fact.text)})).filter(item=>item.match&&candidate.claimEvidenceLinks.some(link=>link.claimId===item.fact.factId&&!link.hasMaskedContentDependency&&link.supportStatus!=='unsupported'&&link.supportStatus!=='unassessed'));
  // A single arithmetic claim may be expressed in several supported facts. Join only
  // the same candidate's monetary context with a shared, single-observation source.
  const monetaryFacts=candidate.observedFacts.filter(fact=>/total|sum|subtotal|charg|amount|price|line[- ]items?|difference|mismatch|합계|합산|총액|총\s*금액|결제|청구|금액|배송|상품|차액|차이|불일치/i.test(fact.text)&&candidate.claimEvidenceLinks.some(link=>link.claimId===fact.factId&&!link.hasMaskedContentDependency&&link.supportStatus!=='unsupported'&&link.supportStatus!=='unassessed'));
  if(!facts.some(item=>item.match?.recipe==='money')&&monetaryFacts.length>=2&&monetaryFacts.length<=5&&candidate.observationIds.length===1){
   const links=monetaryFacts.map(fact=>candidate.claimEvidenceLinks.find(link=>link.claimId===fact.factId)!);
   const hasSharedEvidence=links[0]!.evidenceIds.some(id=>links.every(link=>link.evidenceIds.includes(id)));
   const hasSingleOwner=links.every(link=>link.evidenceIds.length>0&&link.evidenceIds.every(id=>input.evidence.some(evidence=>evidence.evidenceId===id&&evidence.observationId===candidate.observationIds[0])));
   const joined=monetaryFacts.map(fact=>fact.text).join(' ');
   const currencies=[/\$|\bUSD\b/i,/€|\bEUR\b/i,/₩|\bKRW\b|\d\s*원/i].filter(pattern=>pattern.test(joined));
   const hasMultipleOrders=/다른\s*(?:주문|상품)|첫(?:번째|째).{0,8}주문|두(?:번째|째).{0,8}주문|order\s*(?:A|B|#|\d)|another order|different order/i.test(joined);
   if(hasSharedEvidence&&hasSingleOwner&&currencies.length<=1&&!hasMultipleOrders&&hasMonetaryMismatch(joined))facts=[...facts,...monetaryFacts.map(fact=>({fact,match:{recipe:'money' as const}}))];
  }
  const recipeKeys=new Set(facts.map(item=>item.match!.recipe+':'+(item.match!.issue??'')));
  if(recipeKeys.size!==1){skip('No single explicit, evidence-linked registered defect hypothesis in observed facts.');continue;}
  const match=facts[0]!.match!;
  const visuals=candidate.visualEvidence?.filter(visual=>!visual.hasMaskedContentDependency&&candidate.observationIds.includes(visual.observationId))??[];
  const observationIds=[...new Set(visuals.map(visual=>visual.observationId))];
  if(observationIds.length!==1){skip('Candidate does not identify one unmasked observation scope.',match.recipe);continue;}
  const observation=input.observations.find(item=>item.observationId===observationIds[0]);
  if(!observation){skip('Candidate observation is unavailable.',match.recipe);continue;}
  const refs=candidateScopeRefs(candidate,observation,match.recipe,true);
  const directRefs=new Set(visuals.flatMap(visual=>visual.elementRefs));
  const targets=observation.elements.filter(element=>refs.has(element.elementRef)&&element.isVisible&&!observation.redactionRegions?.some(region=>region.elementRef===element.elementRef));
  const expectations=candidate.expectations.filter(expectation=>candidate.claimEvidenceLinks.some(link=>link.claimId===expectation.expectationId&&!link.hasMaskedContentDependency&&link.supportStatus!=='unsupported'&&link.supportStatus!=='unassessed'));
  if(expectations.length!==1){skip('No unique supported original expectation; automatic routing does not invent or choose among competing expectations.',match.recipe);continue;}
  const claimIds=facts.map(item=>item.fact.factId).slice(0,5);
  const selectedLinks=candidate.claimEvidenceLinks.filter(link=>claimIds.includes(link.claimId));
  if(selectedLinks.some(link=>!link.evidenceIds.length||link.evidenceIds.some(id=>!input.evidence.some(evidence=>evidence.evidenceId===id&&evidence.observationId===observation.observationId)))){skip('Selected facts do not share evidence owned by the candidate observation.',match.recipe);continue;}
  const evidenceIds=[...new Set(candidate.claimEvidenceLinks.filter(link=>claimIds.includes(link.claimId)).flatMap(link=>link.evidenceIds))].filter(id=>input.evidence.some(evidence=>evidence.evidenceId===id&&evidence.observationId===observation.observationId));
  const base={requestId:`auto-${createHash('sha256').update(candidate.issueId).digest('hex')}`,candidateId:candidate.issueId,claimIds,observationId:observation.observationId,expectation:expectations[0]!,evidenceIds,preconditions:['The original candidate and selected elements refer to the same current state. Only the registered measurable hypothesis is tested, not the entire UX opinion.']};
  let request:VerificationRequest|undefined;
  if(match.recipe==='occlusion'){
   if(targets.length===1){request={...base,recipe:'occlusion',targetRef:targets[0]!.elementRef,issue:match.issue!};}
   else{
    if(match.issue==='clipping'){skip('Multiple clipping targets have no independently observed affected/container direction.',match.recipe);continue;}
    const normalized=(value:string)=>value.toLowerCase().replace(/\s+/g,'').trim();
    const boundFacts=(element:typeof targets[number])=>facts.filter(({fact})=>[element.text,element.accessibleName].some(name=>normalized(name).length>=4&&normalized(fact.text).includes(normalized(name)))||fact.text.split(/[^\p{L}\p{N}_-]+/u).includes(element.elementRef)).map(({fact})=>fact.factId);
    const covering=new Set(targets.flatMap(element=>element.occlusionEvidence?.coveringElementRefs??[]));
    const isCoverContext=(element:typeof targets[number])=>covering.has(element.elementRef)||element.ancestorRefs?.some(ref=>covering.has(ref))===true;
    const hasConflictingExplicitTarget=targets.some(element=>boundFacts(element).length>0&&!isCoverContext(element)&&!element.occlusionEvidence?.coveringElementRefs.some(ref=>refs.has(ref)));
    const canUseRelationScope=candidate.observedFacts.length===1&&facts.length===1&&!hasConflictingExplicitTarget;
    const scopedFacts=(element:typeof targets[number])=>{const explicit=boundFacts(element);return explicit.length?explicit:canUseRelationScope?[facts[0]!.fact.factId]:[];};
    const affected=targets.filter(element=>directRefs.has(element.elementRef)).map(element=>({element,claimIds:scopedFacts(element)})).filter(item=>item.claimIds.length>0&&!covering.has(item.element.elementRef)&&item.element.occlusionEvidence&&!item.element.occlusionEvidence.hasUncertainCover&&(match.issue==='occlusion'?item.element.occlusionEvidence.coveringElementRefs.some(ref=>refs.has(ref)):item.element.occlusionEvidence.textRects.length>0));
    const hasUnboundAffected=targets.some(element=>!covering.has(element.elementRef)&&element.occlusionEvidence?.coveringElementRefs.some(ref=>refs.has(ref))&&!scopedFacts(element).length);
    if(!affected.length||affected.length>3||hasUnboundAffected){skip('Multiple visual references lack unambiguous fact-bound affected/covering roles, or exceed three affected targets.',match.recipe);continue;}
    const occluderRefs=[...new Set(affected.flatMap(item=>item.element.occlusionEvidence!.coveringElementRefs))];
    if(occluderRefs.length>3||occluderRefs.some(ref=>!refs.has(ref))){skip('Covering elements are not completely linked to the candidate scope.',match.recipe);continue;}
    request={...base,recipe:'occlusion',targetRef:affected[0]!.element.elementRef,claimIds:affected[0]!.claimIds,issue:match.issue!,additionalTargets:affected.slice(1).map(item=>({targetRef:item.element.elementRef,claimIds:item.claimIds})),occluderRefs};
   }
  }else if(match.recipe==='focus'){
   const scopes=targets.filter(element=>element.role==='dialog'||element.tag==='dialog');
   const actions=input.spec.allowedActions.filter(action=>action.type==='press'&&action.selector==='body'&&action.value==='Tab').slice(0,3);
   if(scopes.length!==1||!actions.length){skip('No unique candidate-linked dialog or explicitly allowed body Tab actions.',match.recipe);continue;}
   request={...base,recipe:'focus',scopeRef:scopes[0]!.elementRef,allowedActionIds:actions.map(action=>action.id)};
  }else{
   const isCTA=(element:typeof targets[number])=>element.tag==='button'||element.role==='button';
   const valueTargets=targets.filter(element=>/(?:₩|\$|€|\bKRW\b|\bUSD\b|\bEUR\b|\d\s*원)/i.test(element.text)&&/\d/.test(element.text));
   const excludedCTA=valueTargets.filter(isCTA);
   const normalized=(text:string)=>text.replace(/\s+/g,'').toLowerCase();
   const canonical=valueTargets.filter(element=>!isCTA(element)&&!valueTargets.some(child=>child.elementRef!==element.elementRef&&child.ancestorRefs?.includes(element.elementRef)&&child.moneyLabelRelation?.status==='resolved'&&normalized(element.text)===normalized(`${child.moneyLabelRelation.labelText??''}${child.text}`)));
   const monetary=canonical.map(element=>({element,label:element.moneyLabelRelation?.status==='resolved'?`${element.moneyLabelRelation.labelText??''} ${element.text}`:element.text}));
   if(excludedCTA.length)base.preconditions.push(`CTA amounts (${excludedCTA.map(element=>element.elementRef).join(', ')}) are context only and are not tested by the additive-total recipe. Only the row arithmetic subclaim is measured; CTA/total agreement remains unverified.`);
   const expanded=canonical.filter(element=>!directRefs.has(element.elementRef));
   if(expanded.length)base.preconditions.push(`Money target references ${expanded.map(element=>element.elementRef).join(', ')} are bound through observed label/value or ancestor relations in this observation, not invented selectors.`);
   const totals=monetary.filter(item=>/합계|총액|총\s*결제|결제\s*금액|\btotal\b/i.test(item.label)&&!/소계|상품\s*합계|subtotal/i.test(item.label));
   const items=monetary.filter(item=>!totals.includes(item)&&/소계|상품|서비스|배송|세금|부가세|할인|쿠폰|수수료|subtotal|shipping|tax|discount|fee|coupon|items?/i.test(item.label));
   if(totals.length!==1||items.length<1||items.length>8||monetary.length!==totals.length+items.length){skip('No unique total and explicit additive line-item roles across candidate-linked monetary elements.',match.recipe);continue;}
   request={...base,recipe:'money',totalRef:totals[0]!.element.elementRef,itemRefs:items.map(item=>item.element.elementRef)};
  }
  if(request.recipe==='occlusion'&&request.issue==='occlusion')request.targetScopes=[{targetRef:request.targetRef,claimIds:request.claimIds},...(request.additionalTargets??[])].map(target=>{
   const element=observation.elements.find(element=>element.elementRef===target.targetRef)!;const text=candidate.observedFacts.filter(fact=>target.claimIds.includes(fact.factId)).map(fact=>fact.text).join(' ');
   const canMeasureSurface=(element.tag==='button'||element.tag==='a'||element.role==='button'||element.role==='link')&&/버튼|button|control|링크|link/i.test(text)&&!/글자|문구|텍스트|label|text/i.test(text);
   return{targetRef:target.targetRef,scope:canMeasureSurface?'control-surface' as const:'text' as const};
  });
  const validated=validateVerificationRequests([request],input,result.findings,new Set(input.evidence.map(evidence=>evidence.evidenceId)),{shouldAllowAutomaticTargets:true});
  if(!validated.requests.length){skip(validated.limitations.join(' ')||'Automatic proposal failed binding validation.',match.recipe);continue;}
  if(requests.some(existing=>existing.requestId===request.requestId)){skip('Generated request identifier conflicts with an existing model proposal.',match.recipe);continue;}
  requests.push(validated.requests[0]!);
  selections.push({candidateId:candidate.issueId,origin:'automatic',status:'selected',recipe:request.recipe,requestId:request.requestId,reason:'One explicit observed-fact hypothesis, supported original expectation and candidate-linked targets matched a registered recipe. Measurement truth remains unknown.'});
 }
 return {...result,verificationRequests:requests,verificationSelections:selections};
}
