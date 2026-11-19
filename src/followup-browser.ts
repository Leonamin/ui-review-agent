import type {ElementHandle,JSHandle,Page} from 'playwright';
import type {BrowserSession} from './browser.js';
import {PolicyError,assertOrigin} from './policy.js';
import type {ActionRecord,Observation,Rect} from './types.js';
import type {FollowupReplayStep,ReplayScrollOutcome,ReplayScrollSearch} from './followup-types.js';
import {scrollForReplay} from './replay-scroll.js';

export interface FollowupCandidate {elementRef:string;role:string;label:string;options:string[];selectedLabels:string[];isSelected:boolean;hasPopup?:boolean;scopeLabel?:string;dismissMethod?:'close-button'|'escape'}
function readControl(element:Element){
 const label=(element.getAttribute('aria-label')||element.getAttribute('title')||(element instanceof HTMLSelectElement||element instanceof HTMLInputElement?Array.from(element.labels??[]).map(label=>{const clone=label.cloneNode(true) as Element;clone.querySelectorAll('select,input,textarea').forEach(control=>control.remove());return clone.textContent??'';}).join(' '):'')||element.textContent||'').replace(/\s+/g,' ').trim().slice(0,240);
 const role=element.getAttribute('role')||(element.tagName==='SELECT'?'combobox':element.tagName==='A'?'link':element.tagName==='BUTTON'?'button':element.tagName==='DIALOG'?'dialog':element instanceof HTMLInputElement&&['radio','checkbox'].includes(element.type)?element.type:'');
 const dangerous=/로그인|로그아웃|회원가입|결제|구매|주문|삭제|저장|동의|권한|전송|구독|탈퇴|업로드|초대|제거|취소|\b(?:log\s?(?:in|out)|sign\s?(?:in|up|out)|pay|payment|purchase|order|delete|remove|save|consent|permission|send|subscribe|reset|account|upload|invite|cancel)\b/i;
 const hasDangerousLabel=dangerous.test(label)||!(element instanceof HTMLSelectElement)&&dangerous.test(element.textContent??'');
 const explicitDismissLabel=(element.getAttribute('aria-label')||element.getAttribute('title')||'').trim();
 const canDismissByButton=['button'].includes(role)&&/^(?:close|dismiss|x|×|✕|✖|닫기|팝업\s*닫기|모달\s*닫기)$/i.test(explicitDismissLabel)&&!hasDangerousLabel&&!element.closest('a[href]');
 const canDismissByEscape=element.matches('dialog,[role="dialog"],[aria-modal="true"]');
 const form=element.closest('form');const modal=element.closest('dialog,[role="dialog"],[aria-modal="true"]');
 const hasSensitiveContext=Boolean(form?.querySelector('input[type="password"],input[type="email"],input[autocomplete="username"],input[autocomplete="cc-number"]'))||Boolean(form&&dangerous.test((form.textContent??'')+' '+(form.getAttribute('action')??'')))||Boolean(modal&&dangerous.test(modal.textContent??''));
 const hasNativeSubmission=element instanceof HTMLButtonElement&&element.form!==null&&['submit','reset'].includes(element.type);
 const href=element instanceof HTMLAnchorElement?element.href:null;
 const hasDangerousHref=Boolean(href&&/(?:^|[\/?#&=_-])(?:logout|signout|sign-out|delete|remove|checkout|payment|subscribe|unsubscribe|invite|consent|reset|account)(?:$|[\/?#&=_-])/i.test(new URL(href,location.href).pathname+new URL(href,location.href).search));
 const box=element.getBoundingClientRect(),style=getComputedStyle(element),hit=document.elementFromPoint(box.x+box.width/2,box.y+box.height/2);
 const isRendered=element.isConnected&&box.width>0&&box.height>0&&style.display!=='none'&&style.visibility==='visible'&&Number(style.opacity)>0&&!element.closest('[aria-hidden="true"],[hidden]');
 const isVisible=isRendered&&box.x>=0&&box.y>=0&&box.right<=innerWidth&&box.bottom<=innerHeight&&Boolean(hit&&element.contains(hit));
 const isSafe=(canDismissByEscape||!hasDangerousLabel&&(!hasSensitiveContext||canDismissByButton))&&!hasDangerousHref&&!hasNativeSubmission&&!element.matches(':disabled,[disabled],[aria-disabled="true"],[inert]')&&!element.closest('[inert]')&&!element.hasAttribute('download')&&!element.hasAttribute('formaction')&&(!href||new URL(href).origin===location.origin)&&(['button','link','tab','radio','checkbox','option','combobox'].includes(role)||canDismissByEscape);
 let scopeLabel='';
 for(let parent=element.parentElement,depth=0;parent&&depth<12;parent=parent.parentElement,depth++){
  if(!parent.matches('section,article,fieldset,form,aside,nav,main,dialog,[role="group"],[role="region"],[role="tablist"],[role="dialog"]'))continue;
  const by=parent.getAttribute('aria-labelledby')?.split(/\s+/).map(id=>document.getElementById(id)?.textContent??'').join(' ');
  scopeLabel=(parent.getAttribute('aria-label')||by||parent.querySelector(':scope > legend,:scope > h1,:scope > h2,:scope > h3,:scope > [role="heading"]')?.textContent||'').replace(/\s+/g,' ').trim().slice(0,120);
  if(scopeLabel)break;
 }
 const options=element instanceof HTMLSelectElement?Array.from(element.options).filter(option=>!option.disabled&&!option.hidden&&!dangerous.test(option.label)).map(option=>option.label):[];
 const selectedLabels=element instanceof HTMLSelectElement?Array.from(element.selectedOptions).map(option=>option.label):[];
 const isSelected=element instanceof HTMLInputElement&&['checkbox','radio'].includes(element.type)?element.checked:['true','checked'].includes(element.getAttribute('aria-selected')??element.getAttribute('aria-checked')??element.getAttribute('aria-pressed')??'');
 const controls=(element.getAttribute('aria-controls')||element.getAttribute('aria-owns')||'').split(/\s+/).filter(Boolean);
 const hasPopup=Boolean(element.getAttribute('aria-haspopup')&&element.getAttribute('aria-haspopup')!=='false')||controls.some(id=>Boolean(document.getElementById(id)?.matches('[role="listbox"],[role="menu"],dialog,[role="dialog"]')));
 const dismissMethod=canDismissByEscape?'escape' as const:canDismissByButton?'close-button' as const:undefined;
 return{label:canDismissByEscape?'Close modal (Escape)':label,role,options,selectedLabels,isSelected,controls,hasPopup,dismissMethod,scopeLabel,isAllowed:isVisible&&isSafe,canReveal:isRendered&&isSafe,signature:JSON.stringify({label,role,options,selectedLabels,isSelected,dismissMethod,scopeLabel,href,box:{x:box.x,y:box.y,width:box.width,height:box.height}})};
}
export class FollowupBrowser {
 private bindings=new Map<string,{handle:JSHandle<Element>;signature:string;candidate:FollowupCandidate}>();
 private popupIds:string[]=[];
 constructor(readonly session:BrowserSession){}
 async clear(){for(const binding of this.bindings.values())await binding.handle.dispose().catch(()=>{});this.bindings.clear();}
 async candidates(observation:Observation,region?:Rect):Promise<FollowupCandidate[]>{
  this.session.budget.takeTool();await this.clear();const candidates:FollowupCandidate[]=[];
  for(const element of observation.elements){
   if(!['button','a','select','input','dialog'].includes(element.tag)&&!['button','link','tab','radio','checkbox','option','combobox','dialog'].includes(element.role))continue;
   const handle=await this.session.observedHandle(observation.observationId,element.elementRef);const data=await handle.evaluate(readControl);
   const hasObservedGeometry=(['x','y','width','height'] as const).every(key=>Math.abs(JSON.parse(data.signature).box[key]-element.boundingBox[key])<=1);
   const box=element.boundingBox;const isInRegion=!region||box.x+box.width>region.x&&box.x<region.x+region.width&&box.y+box.height>region.y&&box.y<region.y+region.height;
   const isOwnedPopup=region&&!isInRegion&&await handle.evaluate((element,ids)=>ids.some(id=>document.getElementById(id)?.contains(element)),this.popupIds);
   if(!data.isAllowed||!data.label||!hasObservedGeometry||!isInRegion&&!isOwnedPopup){await handle.dispose();continue;}
   const candidate={elementRef:element.elementRef,role:data.role,label:data.label,options:data.options,selectedLabels:data.selectedLabels,isSelected:data.isSelected,hasPopup:data.hasPopup,scopeLabel:data.scopeLabel?this.session.safeReplayScope(data.scopeLabel):undefined,dismissMethod:data.dismissMethod};
   this.bindings.set(element.elementRef,{handle,signature:data.signature,candidate});candidates.push(candidate);if(candidates.length>=60)break;
  }
  return candidates;
 }
 private matchesReplay(candidate:Pick<FollowupCandidate,'role'|'label'|'options'|'scopeLabel'|'dismissMethod'>,step:FollowupReplayStep){
  return candidate.role===step.role&&candidate.label===step.label&&candidate.dismissMethod===step.dismissMethod&&(!step.scopeLabel||candidate.scopeLabel===step.scopeLabel)&&(step.optionLabel===undefined||candidate.options.includes(step.optionLabel));
 }
 async replayCandidates(observation:Observation,step:FollowupReplayStep){
  return (await this.candidates(observation)).filter(item=>this.matchesReplay(item,step));
 }
 private async mountedReplayControl(step:FollowupReplayStep):Promise<{kind:'found';handle:ElementHandle<Element>;isVisible:boolean}|{kind:'absent'|'ambiguous'|'unsafe'}>{
  const locator=this.session.page!.getByRole(step.role as Parameters<Page['getByRole']>[0],{name:step.label,exact:true});
  if(await locator.count()>32)return {kind:'ambiguous'};
  const handles=await locator.elementHandles() as ElementHandle<Element>[];
  let winner:ElementHandle<Element>|undefined;
  try{
   const same=[];
   for(const handle of handles){
    const data=await handle.evaluate(readControl);
    if(this.matchesReplay({...data,scopeLabel:this.session.safeReplayScope(data.scopeLabel)},step))same.push({data,handle});
   }
   if(same.length>1)return {kind:'ambiguous'};
   if(!same.length)return {kind:'absent'};
   if(!same[0].data.canReveal)return {kind:'unsafe'};
   winner=same[0].handle;
   return {kind:'found',handle:winner,isVisible:same[0].data.isAllowed};
  }finally{
   await Promise.all(handles.filter(handle=>handle!==winner).map(handle=>handle.dispose().catch(()=>{})));
  }
 }
 async restoreControl(observation:Observation,step:FollowupReplayStep,replayIndex:number,remainingPx:number,signal?:AbortSignal):Promise<{kind:'ready';observation:Observation;candidate:FollowupCandidate;search?:ReplayScrollSearch}|{kind:'skip'}|{kind:'stopped';search?:ReplayScrollSearch;outcome:ReplayScrollOutcome;observation:Observation}>{
  const present=await this.replayCandidates(observation,step);
  if(present.length>1)return {kind:'stopped',outcome:'ambiguous',observation};
  if(step.dismissMethod){
   if(present.length===1)return {kind:'ready',observation,candidate:present[0]};
   return (await this.session.probeReadiness()).hasVisibleModal?{kind:'stopped',outcome:'not-found',observation}:{kind:'skip'};
  }
  const page=this.session.page!,url=page.url(),maxStepPx=this.session.spec.viewport.height;
  let current=observation;
  const search:ReplayScrollSearch={replayIndex,label:step.label,distancePx:0,steps:0,outcome:'not-found',beforeObservationId:observation.observationId};
  let direction:1|-1|0=0;
  const stop=async(outcome:ReplayScrollOutcome)=>{
   search.outcome=outcome;
   if(search.distancePx>0&&current===observation&&!signal?.aborted&&page.url()===url&&this.session.budget.remainingMs()>750&&this.session.budget.remainingObservations()>0){
    try{current=await this.session.capture();}catch{/* Keep the last proven viewport and search trace if capture cannot finish. */}
   }
   search.afterObservationId=current.observationId;
   return {kind:'stopped' as const,search:search.steps>0?search:undefined,outcome,observation:current};
  };
  try{for(let i=0;i<=12;i++){
   if(signal?.aborted)return stop('cancelled');
   if(page.url()!==url)return stop('navigation');
   this.session.budget.assertTime();assertOrigin(page.url(),this.session.spec);
   const match=await this.mountedReplayControl(step);
   try{
    if(match.kind==='ambiguous'||match.kind==='unsafe')return stop(match.kind);
    if(match.kind==='found'&&match.isVisible){
     if(signal?.aborted)return stop('cancelled');
     if(page.url()!==url)return stop('navigation');
     if(search.steps===0&&present.length===1)return {kind:'ready',observation,candidate:present[0]};
     if(this.session.budget.remainingObservations()<2)return stop('limit');
     current=await this.session.capture(match.handle);
     search.afterObservationId=current.observationId;
     const recheck=await this.mountedReplayControl(step);
     try{
      if(recheck.kind!=='found'||!recheck.isVisible)return stop(recheck.kind==='ambiguous'?'ambiguous':'unobserved');
     }finally{if(recheck.kind==='found')await recheck.handle.dispose();}
     const now=await this.replayCandidates(current,step);
     if(signal?.aborted)return stop('cancelled');
     if(page.url()!==url)return stop('navigation');
     if(now.length!==1)return stop(now.length>1?'ambiguous':'unobserved');
     search.outcome='found';return {kind:'ready',observation:current,candidate:now[0],search:search.steps>0?search:undefined};
    }
    if(search.steps===0&&present.length===1&&match.kind==='absent')return stop('unobserved');
    if((await this.session.probeReadiness()).hasVisibleModal)return stop('unsafe');
    if(i===12||search.distancePx>=remainingPx||this.session.budget.remainingMs()<750||this.session.budget.remainingObservations()<3)return stop('limit');
    if(search.steps===0)this.session.budget.takeTool();
    if(signal?.aborted)return stop('cancelled');
    if(page.url()!==url)return stop('navigation');
    const movement:ReturnType<typeof scrollForReplay>=await page.evaluate(scrollForReplay,{target:match.kind==='found'?match.handle:null,remainingPx:remainingPx-search.distancePx,maxStepPx,direction,expectedUrl:url});
    if(movement.didNavigate)return stop('navigation');
    direction=movement.direction;search.steps++;search.distancePx+=movement.distancePx;
    if(movement.hadOvershoot)return stop('limit');
    if(movement.distancePx<1)return stop('no-progress');
    await page.waitForTimeout(Math.min(300,this.session.budget.remainingMs()));
   }finally{if(match.kind==='found')await match.handle.dispose();}
  }}catch{
   return stop(signal?.aborted?'cancelled':page.url()!==url?'navigation':this.session.budget.remainingMs()<=0?'limit':'unobserved');
  }
  return stop('limit');
 }
 async perform(observation:Observation,elementRef:string,optionLabel?:string,expectedReplayUrl?:string):Promise<{record:ActionRecord;replay:FollowupReplayStep}>{
  this.session.budget.takeTool();assertOrigin(this.session.page!.url(),this.session.spec);const binding=this.bindings.get(elementRef);if(!binding)throw new PolicyError('scope-denied','Unregistered follow-up action');
  if(this.session.observations.at(-1)?.observationId!==observation.observationId)throw new PolicyError('stale-observation','Follow-up action requires current evidence');
  const data=await binding.handle.evaluate(readControl);if(!data.isAllowed||data.signature!==binding.signature)throw new PolicyError('stale-observation','Follow-up control changed during model inference');
  if(data.role==='combobox'&&!data.options.length)throw new PolicyError('unsupported-control','Custom combobox must be opened with a registered button');
  if(optionLabel!==undefined&&!data.options.includes(optionLabel))throw new PolicyError('missing-option','The explicitly requested option does not exist');
  if(data.role==='combobox'&&optionLabel===undefined)throw new PolicyError('missing-option','A select action requires a visible option label');
  if(expectedReplayUrl!==undefined&&this.session.page!.url()!==expectedReplayUrl)throw new PolicyError('stale-observation','The page changed before replay');
  this.popupIds=data.controls;
  const record:ActionRecord={actionId:`action-${this.session.actions.length+1}`,allowedActionId:'followup-current-control',type:optionLabel===undefined?'click':'select-option',beforeObservationId:observation.observationId,outcome:'error',failureAttribution:'unknown'};this.session.actions.push(record);
  const replay:FollowupReplayStep={type:data.dismissMethod==='escape'?'press-escape':optionLabel===undefined?'click':'select-option',role:data.role,label:data.label,...(data.scopeLabel?{scopeLabel:this.session.safeReplayScope(data.scopeLabel)}:{}),...(data.dismissMethod?{dismissMethod:data.dismissMethod}:{}),...(optionLabel===undefined?{}:{optionLabel})};
  try{
   const element=binding.handle.asElement();if(!element)throw new PolicyError('stale-observation','Follow-up target detached');
   this.session.actionNetwork.begin(record.actionId,this.session.budget.remainingMs());
   if(data.dismissMethod==='escape'){record.type='press';await this.session.page!.keyboard.press('Escape');}else if(optionLabel===undefined)await element.click({timeout:Math.min(4000,this.session.budget.remainingMs())});else await element.selectOption({label:optionLabel},{timeout:Math.min(4000,this.session.budget.remainingMs())});
   assertOrigin(this.session.page!.url(),this.session.spec);const after=await this.session.capture();record.afterObservationId=after.observationId;record.outcome='success';record.failureAttribution=null;
  }catch(error){record.outcome=error instanceof PolicyError?'rejected':'error';record.failureAttribution='automation';record.message=error instanceof Error?error.message.slice(0,300):'Follow-up action failed';}
  return{record,replay};
 }
}
