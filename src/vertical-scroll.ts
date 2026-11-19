import type {JSHandle,Page} from 'playwright';
import type {BrowserSession} from './browser.js';
import type {Observation,Rect,VerticalScrollPosition} from './types.js';

export type ScrollDirection='down'|'up';

const OVERLAP=0.2;
const POSITION_TOLERANCE=1;
const MAX_SWEEP_CAPTURES=6;

type ScrollOwner={handle:JSHandle<HTMLElement|null>;kind:'document'|'container'};
type ScrollSample=Omit<VerticalScrollPosition,'owner'>;

function measureOrChoose(input:HTMLElement|null|{direction:ScrollDirection|null}):ScrollSample|HTMLElement|null{
 const geometry={sample(element:HTMLElement|null):ScrollSample|null{
  if(!element?.isConnected)return null;
  const isDocument=element===document.scrollingElement;
  const box=element.getBoundingClientRect();
  const left=isDocument?0:box.left+element.clientLeft;
  const top=isDocument?0:box.top+element.clientTop;
  let clipLeft=Math.max(0,left),clipTop=Math.max(0,top);
  let clipRight=Math.min(innerWidth,left+element.clientWidth),clipBottom=Math.min(innerHeight,top+element.clientHeight);
  for(let parent=isDocument?null:element.parentElement;parent&&parent!==document.scrollingElement;parent=parent.parentElement){
   const css=getComputedStyle(parent),rect=parent.getBoundingClientRect();
   if(css.overflowX!=='visible'){
    clipLeft=Math.max(clipLeft,rect.left+parent.clientLeft);
    clipRight=Math.min(clipRight,rect.left+parent.clientLeft+parent.clientWidth);
   }
   if(css.overflowY!=='visible'){
    clipTop=Math.max(clipTop,rect.top+parent.clientTop);
    clipBottom=Math.min(clipBottom,rect.top+parent.clientTop+parent.clientHeight);
   }
  }
  const width=clipRight-clipLeft,height=clipBottom-clipTop;
  if(width<=0||height<=0)return null;
  const offset=element.scrollTop,extent=element.scrollHeight,maxOffset=Math.max(0,extent-element.clientHeight);
  const visibleStart=Math.max(0,offset+clipTop-top);
  return {offset,maxOffset,extent,visibleStart,visibleEnd:Math.min(extent,visibleStart+height),clip:{x:clipLeft,y:clipTop,width,height}};
 }};
 if(input===null||input instanceof HTMLElement)return geometry.sample(input);
 const {direction}=input;
 let best:HTMLElement|null=null,bestArea=0;
 for(const element of document.querySelectorAll<HTMLElement>('main,section,article,aside,div,ul,ol,[role]')){
  if(element===document.scrollingElement||element.clientHeight<120||element.scrollHeight<=element.clientHeight+1)continue;
  if(direction==='down'&&element.scrollTop>=element.scrollHeight-element.clientHeight-1||direction==='up'&&element.scrollTop<=1)continue;
  const css=getComputedStyle(element);
  if(!['auto','scroll'].includes(css.overflowY)||css.display==='none'||css.visibility!=='visible'||Number(css.opacity)===0)continue;
  const metrics=geometry.sample(element);
  if(!metrics)continue;
  const {width,height}=metrics.clip;
  if(width<Math.min(240,innerWidth*.5)||height<Math.min(180,innerHeight*.5))continue;
  const area=width*height;if(area<innerWidth*innerHeight*.18||area<=bestArea)continue;
  best=element;bestArea=area;
 }
 return best;
}

async function documentOwner(page:Page):Promise<ScrollOwner>{
 return {handle:await page.evaluateHandle(()=>document.scrollingElement as HTMLElement|null),kind:'document'};
}
async function containerOwner(page:Page,direction:ScrollDirection|null):Promise<ScrollOwner>{
 return {handle:await page.evaluateHandle(measureOrChoose,{direction}) as JSHandle<HTMLElement|null>,kind:'container'};
}
async function position(owner:ScrollOwner):Promise<VerticalScrollPosition|null>{
 const value=await owner.handle.evaluate(measureOrChoose) as ScrollSample|null;
 return value?{...value,owner:owner.kind}:null;
}
const canMove=(value:VerticalScrollPosition|null,direction:ScrollDirection)=>
 Boolean(value&&(direction==='down'?value.offset<value.maxOffset-POSITION_TOLERANCE:value.offset>POSITION_TOLERANCE));

export async function verticalScrollDirections(page:Page):Promise<ScrollDirection[]>{
 const owner=await documentOwner(page);
 try{
  const value=await position(owner);
  const directions:ScrollDirection[]=[];
  for(const direction of ['up','down'] as const){
   if(canMove(value,direction)){directions.push(direction);continue;}
   const container=await containerOwner(page,direction);
   try{if(canMove(await position(container),direction))directions.push(direction);}
   finally{await container.handle.dispose();}
  }
  return directions;
 }finally{await owner.handle.dispose();}
}

async function goto(owner:ScrollOwner,offset:number):Promise<void>{
 await owner.handle.evaluate((element,y)=>{element?.scrollTo({top:y,behavior:'instant'});},offset);
}
function nextOffset(value:VerticalScrollPosition,direction:ScrollDirection){
 const step=Math.max(1,Math.floor(value.clip.height*(1-OVERLAP)));
 const remaining=direction==='down'?value.maxOffset-value.offset:value.offset;
 const distance=remaining<=value.clip.height*.9?remaining:step;
 return direction==='down'?Math.min(value.maxOffset,value.offset+distance):Math.max(0,value.offset-distance);
}
function hasSamePosition(a:VerticalScrollPosition,b:VerticalScrollPosition){
 return a.owner===b.owner&&Math.abs(a.offset-b.offset)<=POSITION_TOLERANCE&&Math.abs(a.extent-b.extent)<=POSITION_TOLERANCE&&
  (['x','y','width','height'] as const).every(key=>Math.abs(a.clip[key]-b.clip[key])<=POSITION_TOLERANCE);
}
function mark(observation:Observation,value:VerticalScrollPosition){
 observation.verticalScroll=value;
}
async function captureScroll(session:BrowserSession,owner:ScrollOwner,url:string):Promise<Observation>{
 if(session.page!.url()!==url)throw new Error('스크롤 중 URL이 변경되었습니다.');
 const before=await position(owner);
 if(!before)throw new Error('스크롤 영역을 찾을 수 없습니다.');
 const observation=await session.capture();
 const after=await position(owner);
 if(!after||!hasSamePosition(before,after)||session.page!.url()!==url){
  observation.isStable=false;
  observation.consistencyWarnings.push('Scroll position or extent changed during capture.');
  return observation;
 }
 mark(observation,after);
 return observation;
}

export async function scrollFollowup(session:BrowserSession,direction:ScrollDirection,expectedUrl:string):Promise<{observation:Observation;from:VerticalScrollPosition}|null>{
 const page=session.page!;
 if(page.url()!==expectedUrl||session.budget.remainingObservations()<=1)return null;
 let owner=await documentOwner(page);
 try{
  let before=await position(owner);
  if(!canMove(before,direction)){
   await owner.handle.dispose();
   owner=await containerOwner(page,direction);
   before=await position(owner);
  }
  if(!before||!canMove(before,direction)||page.url()!==expectedUrl)return null;
  await goto(owner,nextOffset(before,direction));
  const observation=await captureScroll(session,owner,expectedUrl);
  const moved=observation.verticalScroll;
  return observation.isStable&&moved&&Math.abs(moved.offset-before.offset)>POSITION_TOLERANCE?{observation,from:before}:null;
 }finally{await owner.handle.dispose().catch(()=>{});}
}

export interface SavedScrollPosition {owner:VerticalScrollPosition['owner'];offset:number;documentY:number}

/** Replay a prior observed position before the normal URL and anchor restoration check. */
export async function restoreFollowupScroll(session:BrowserSession,saved:SavedScrollPosition,expectedUrl:string):Promise<boolean>{
 const page=session.page!;
 const maxDistance=session.spec.viewport.height*4;
 if(page.url()!==expectedUrl||!Number.isFinite(saved.offset)||!Number.isFinite(saved.documentY)||saved.offset<0||saved.documentY<0)return false;
 const initialProbe=await session.probeReadiness();
 if(initialProbe.hasVisibleModal||initialProbe.hasLoadingSignal)return false;
 const document=await documentOwner(page);
 let container:ScrollOwner|undefined;
 try{
  const initial=await position(document);
  if(!initial||Math.abs(saved.documentY-initial.offset)>maxDistance||saved.documentY>initial.maxOffset+POSITION_TOLERANCE)return false;
  await goto(document,saved.documentY);
  if(saved.owner==='container'){
   container=await containerOwner(page,null);
   const inner=await position(container);
   if(!inner||Math.abs(saved.offset-inner.offset)>maxDistance||saved.offset>inner.maxOffset+POSITION_TOLERANCE)return false;
   await goto(container,saved.offset);
  }else if(saved.owner!=='document'||Math.abs(saved.offset-saved.documentY)>POSITION_TOLERANCE)return false;
  const rendered=await session.waitForPreparedState(Math.min(3500,session.spec.stateDiscovery?.maxWaitMs??3500));
  if(!rendered.hasSettled||page.url()!==expectedUrl)return false;
  const [outer,inner]=await Promise.all([position(document),container?position(container):undefined]);
  return Boolean(outer&&Math.abs(outer.offset-saved.documentY)<=POSITION_TOLERANCE&&
   (!container||inner&&Math.abs(inner.offset-saved.offset)<=POSITION_TOLERANCE));
 }finally{
  await Promise.all([document.handle.dispose().catch(()=>{}),container?.handle.dispose().catch(()=>{})]);
 }
}

interface VerticalSweep {observations:Observation[];reason?:string;hasRestoredPosition:boolean}
function rangeLabel(value:VerticalScrollPosition){
 return `${value.owner==='document'?'문서':'본문 스크롤 영역'} ${Math.round(value.visibleEnd)} / ${Math.round(value.extent)}px`;
}

/** Sweep the document and, when present, the largest visible inner scrolling surface. */
export async function sweepVertical(session:BrowserSession,initial:Observation,signal?:AbortSignal):Promise<VerticalSweep>{
 const page=session.page!,url=page.url();
 const result:VerticalSweep={observations:[],hasRestoredPosition:true};
 const owners=[await documentOwner(page)];
 const hasInitialModal=(await session.probeReadiness()).hasVisibleModal;
 let remaining=MAX_SWEEP_CAPTURES;
 let hasMoved=false;
 try{
  // The original viewport is where the subsequent fixed actions, lease and tools expect to start.
  owners.push(await containerOwner(page,null));
  for(const owner of owners){
   const start=await position(owner);
   if(!start||start.maxOffset<=POSITION_TOLERANCE)continue;
   if(hasInitialModal||initial.state?.readiness==='loading'||initial.state?.readiness==='blocked'||!initial.isStable){
    result.reason='콘텐츠의 안정된 스크롤 상태를 확인할 수 없습니다.';break;
   }
   let last=start;
   let hasMovedOwner=false;
   try{
    if(start.offset>POSITION_TOLERANCE){
     if(session.budget.remainingObservations()<=1||remaining<=0){result.reason='첫 위치를 캡처할 수 있는 관찰 한도에 도달했습니다.';break;}
     hasMoved=hasMovedOwner=true;
     await goto(owner,0);
     remaining--;
     const observation=await captureScroll(session,owner,url);
     result.observations.push(observation);
     if(!observation.verticalScroll||!observation.isStable||observation.verticalScroll.visibleStart>POSITION_TOLERANCE){
      result.reason='스크롤 영역의 시작점을 안정적으로 확인하지 못했습니다.';break;
     }
     last=observation.verticalScroll;
    }else if(!hasMoved&&!initial.verticalScroll){
     mark(initial,start);
     result.observations.push(initial);
    }else{
     if(session.budget.remainingObservations()<=1||remaining<=0){result.reason='스크롤 영역의 시작점을 캡처할 관찰 한도에 도달했습니다.';break;}
     remaining--;
     const observation=await captureScroll(session,owner,url);
     result.observations.push(observation);
     if(!observation.verticalScroll||!observation.isStable){result.reason='스크롤 영역의 시작점을 안정적으로 확인하지 못했습니다.';break;}
     last=observation.verticalScroll;
    }
    if(last.visibleStart>POSITION_TOLERANCE){
     result.reason=`스크롤 영역의 위쪽이 현재 뷰포트에 가려져 있습니다 (${rangeLabel(last)}).`;break;
    }
    const startingExtent=last.extent;
    let hasReachedBottom=false;
    while(!signal?.aborted&&remaining>0&&session.budget.remainingObservations()>1&&session.budget.remainingMs()>2500){
     if(!canMove(last,'down')){hasReachedBottom=last.visibleEnd+POSITION_TOLERANCE>=last.extent;break;}
     hasMoved=hasMovedOwner=true;
     await goto(owner,nextOffset(last,'down'));
     remaining--;
     const observation=await captureScroll(session,owner,url);
     result.observations.push(observation);
     const current=observation.verticalScroll;
     if(!observation.isStable||!current){result.reason=`안정된 추가 스크롤 캡처를 확보하지 못했습니다 (${rangeLabel(last)}).`;break;}
     if(current.offset<=last.offset+POSITION_TOLERANCE||current.visibleStart>last.visibleEnd+POSITION_TOLERANCE){
      result.reason=`연속해서 보이는 스크롤 영역을 확인하지 못했습니다 (${rangeLabel(last)}).`;break;
     }
     last=current;
     if(last.extent>startingExtent+last.clip.height*3){result.reason=`콘텐츠 높이가 계속 늘어나 검토 범위를 제한했습니다 (${rangeLabel(last)}).`;break;}
     if(!canMove(last,'down')){
      await page.waitForTimeout(600);
      const settled=await position(owner);
      const probe=await session.probeReadiness();
      hasReachedBottom=Boolean(settled&&hasSamePosition(last,settled)&&last.visibleEnd+POSITION_TOLERANCE>=last.extent&&
       !probe.hasLoadingSignal&&!probe.hasPendingImages&&!probe.hasVisibleModal);
      if(hasReachedBottom)break;
      if(probe.hasLoadingSignal||probe.hasPendingImages||probe.hasVisibleModal){
       result.reason=`스크롤 영역 끝의 콘텐츠가 아직 준비되지 않았습니다 (${rangeLabel(last)}).`;break;
      }
      if(!settled||settled.offset!==last.offset){result.reason=`스크롤 영역의 끝 위치가 변경되었습니다 (${rangeLabel(last)}).`;break;}
      // Reloaded extent without motion. Continue from the new scroll metrics.
      last=settled;
     }
    }
    if(!hasReachedBottom&&!result.reason)result.reason=`관찰 한도 내에 스크롤 영역의 끝까지 확인하지 못했습니다 (${rangeLabel(last)}).`;
   }finally{
    if(hasMovedOwner){
     result.hasRestoredPosition=false;
     if(!signal?.aborted&&page.url()===url){
      try{
       await goto(owner,start.offset);
       const restored=await position(owner);
       result.hasRestoredPosition=Boolean(restored&&Math.abs(restored.offset-start.offset)<=POSITION_TOLERANCE);
      }catch{/* No more tool actions may use unproven positions after this sweep. */}
     }
     if(!result.hasRestoredPosition)result.reason='스크롤 캡처 후 원래 위치를 복원하지 못했습니다.';
    }
   }
   if(result.reason)break;
  }
 }finally{
  for(const owner of owners)await owner.handle.dispose().catch(()=>{});
  if(hasMoved&&result.hasRestoredPosition&&!signal?.aborted&&page.url()===url&&session.budget.remainingObservations()>0&&session.budget.remainingMs()>1000)
   await session.capture(); // Refresh the current observation and element bindings at the restored position.
  else if(hasMoved){
   result.hasRestoredPosition=false;
   result.reason??='스크롤 후 복원된 뷰포트의 새 관찰을 확보하지 못했습니다.';
  }
 }
 return result;
}
