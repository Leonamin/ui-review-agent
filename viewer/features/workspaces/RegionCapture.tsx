import {useEffect,useRef,useState,type CSSProperties,type MouseEvent,type PointerEvent} from 'react';
import {Maximize2,ScanEye,X} from 'lucide-react';
import {Button} from '../../shared/goodcase/components/basic/button';
import {Input} from '../../shared/goodcase/components/basic/input';
import {ImageViewer} from '../../shared/goodcase/components/composed/image-viewer';
import {Disclosure} from '../../shared/Disclosure';
import {toViewerImage} from '../../shared/CaptureImageViewer';
import {imagePoint,isValidRegion,regionBetween,type ImageRegion,type ImagePoint} from '../focus/geometry';
import {LayoutLayerControls,useLayoutLayerPreview,useLayoutLayerSelection} from '../reports/LayoutLayerControls';
import {LayoutOverlay,hasMatchingLayoutSize} from '../reports/LayoutOverlay';
import type {ReportImage} from '../reports/types';
import type {FocusSource} from '../../../src/focused-review-contract';
import {workspaceRequest} from './api';

export interface CaptureSelection {imageId:string;sourceSha256:string;region:ImageRegion;source:FocusSource}

export function RegionCapture({reportId,images,imageIndex,onChange,resetKey=0,selectionRequest=0,isSelectionDisabled=false,previewRegion,onClearPreview,preferredFindingId}:{
 reportId:string;images:ReportImage[];imageIndex:number;resetKey?:number;onChange:(selection:CaptureSelection|null)=>void;
 selectionRequest?:number;isSelectionDisabled?:boolean;previewRegion?:ImageRegion|null;onClearPreview?:()=>void;preferredFindingId?:string;
}) {
 const image=images[imageIndex];
 const [source,setSource]=useState<FocusSource>();
 const [imageSize,setImageSize]=useState<{width:number;height:number}>();
 const [region,setRegion]=useState<ImageRegion|null>(null);
 const [isSelecting,setIsSelecting]=useState(false);
 const [layoutVisibility,setLayoutVisibility]=useState<boolean>();
 const [hasImageError,setHasImageError]=useState(false);
 const [error,setError]=useState('');
 const [isViewerOpen,setIsViewerOpen]=useState(false);
 const [viewerIndex,setViewerIndex]=useState(imageIndex);
 const viewerTrigger=useRef<HTMLButtonElement>(null);
 const imageRef=useRef<HTMLImageElement>(null);
 const selectButtonRef=useRef<HTMLButtonElement>(null);
 const lastSelectionRequest=useRef(selectionRequest);
 const drag=useRef<{pointerId:number;start:ImagePoint;previous:ImageRegion|null}|null>(null);
 const layout=image.layout;
 const focus=preferredFindingId?layout?.focusAreas.find(area=>area.findingId===preferredFindingId):layout?.focusAreas[0];
 const layoutSelection=useLayoutLayerSelection(image,focus);
 const isLayoutVisible=layoutVisibility??Boolean(preferredFindingId&&focus);
 const visibleLayers=layoutVisibility===undefined?layoutSelection.visibleLayers.filter(layer=>layer.isFocus):layoutSelection.visibleLayers;
 const layoutPreview=useLayoutLayerPreview(image.id,visibleLayers);
 const canShowLayout=Boolean(layout&&imageSize&&hasMatchingLayoutSize(layout,imageSize));
 const hasLayoutSizeMismatch=Boolean(layout&&imageSize&&!canShowLayout);
 const hasMatchingSourceSize=Boolean(source&&imageSize&&imageSize.width===source.width&&imageSize.height===source.height);
 const canSelect=hasMatchingSourceSize&&!hasImageError&&!isSelectionDisabled;
 const frameStyle=imageSize?{
  '--workspace-capture-width':`${imageSize.width}px`,
  '--workspace-capture-ratio':imageSize.width/imageSize.height,
 } as CSSProperties:undefined;

 useEffect(()=>{
  const controller=new AbortController();
  workspaceRequest<{source:FocusSource}>(`/api/reports/${encodeURIComponent(reportId)}/images/${encodeURIComponent(image.id)}/context`,undefined,controller.signal)
   .then(context=>setSource(context.source))
   .catch(cause=>{if(!controller.signal.aborted)setError(cause.message);});
  return ()=>controller.abort();
 },[reportId,image.id]);
 useEffect(()=>{
  const element=imageRef.current;
  if(!element)return;
  const observer=new ResizeObserver(()=>{
   if(drag.current){
    setRegion(null);
    drag.current=null;
    onChange(null);
    setError('화면 크기가 바뀌어 영역 선택을 중단했습니다. 다시 선택하세요.');
   }
  });
  observer.observe(element);
  return ()=>observer.disconnect();
 },[]);
 useEffect(()=>{setRegion(null);drag.current=null;},[resetKey]);
 useEffect(()=>{
  if(selectionRequest===lastSelectionRequest.current)return;
  lastSelectionRequest.current=selectionRequest;
  setIsSelecting(true);
  selectButtonRef.current?.focus({preventScroll:true});
 },[selectionRequest]);
 function regionStyle(value:ImageRegion,dimensions:FocusSource){
  return {left:`${100*value.x/dimensions.width}%`,top:`${100*value.y/dimensions.height}%`,width:`${100*value.width/dimensions.width}%`,height:`${100*value.height/dimensions.height}%`};
 }

 function publish(next:ImageRegion|null){
  const isValid=next&&source&&isValidRegion(next,source);
  setError(next&&source&&!isValid?'이미지 범위 안에서 영역을 지정하세요.':'');
  setRegion(next);
  onChange(isValid?{imageId:image.id,sourceSha256:source.sha256,region:next,source}:null);
 }
 function point(event:PointerEvent){
  return source&&imageRef.current?imagePoint({x:event.clientX,y:event.clientY},imageRef.current.getBoundingClientRect(),source):null;
 }
 function pointerDown(event:PointerEvent<HTMLDivElement>){
  if(!isSelecting||!canSelect||event.button!==0||!event.isPrimary)return;
  const start=point(event);
  if(!start)return;
  event.preventDefault();
  event.currentTarget.setPointerCapture(event.pointerId);
  drag.current={pointerId:event.pointerId,start,previous:region};
  setError('');
 }
 function pointerMove(event:PointerEvent<HTMLDivElement>){
  if(drag.current?.pointerId!==event.pointerId)return;
  const end=point(event);
  if(end)setRegion(regionBetween(drag.current.start,end));
 }
 function pointerUp(event:PointerEvent<HTMLDivElement>){
  if(drag.current?.pointerId!==event.pointerId)return;
  const start=drag.current.start,end=point(event);
  drag.current=null;
  if(event.currentTarget.hasPointerCapture(event.pointerId))event.currentTarget.releasePointerCapture(event.pointerId);
  publish(end?regionBetween(start,end):null);
 }
 function cancel(event:PointerEvent<HTMLDivElement>){
  if(drag.current?.pointerId!==event.pointerId)return;
  const {previous}=drag.current;
  drag.current=null;
  publish(previous);
 }
 function openViewer(event:MouseEvent<HTMLButtonElement>){
  viewerTrigger.current=event.currentTarget;
  setViewerIndex(imageIndex);
  setIsViewerOpen(true);
 }

 return <section className="workspace-capture">
  <LayoutLayerControls
   heading={<h2>관찰 화면 <span className="muted">{imageIndex+1} / {images.length}</span></h2>}
   zoomControls={<>
    <Button variant="secondary" className="capture-viewer-trigger" aria-haspopup="dialog" onClick={openViewer}>
     <Maximize2 size={15} aria-hidden/>크게 보기
    </Button>
    <Button ref={selectButtonRef} variant="secondary" disabled={!canSelect} aria-pressed={isSelecting} onClick={()=>setIsSelecting(value=>!value)}>
     <ScanEye size={15} aria-hidden/>{isSelecting?'선택 종료':'영역 선택'}
    </Button>
   </>}
   isLayoutVisible={isLayoutVisible} onLayoutVisibleChange={setLayoutVisibility} selection={layoutSelection} preview={layoutPreview}
  />
  <div className={`workspace-capture-image${isSelecting?' is-selecting':''}`}>
   <div className="workspace-capture-frame" style={frameStyle} onPointerDown={pointerDown} onPointerMove={pointerMove} onPointerUp={pointerUp} onPointerCancel={cancel}>
    <img ref={imageRef} src={image.url} alt={image.label||'검토 캡처'} draggable={false}
     onLoad={event=>setImageSize({width:event.currentTarget.naturalWidth,height:event.currentTarget.naturalHeight})}
     onError={()=>setHasImageError(true)}/>
    {isLayoutVisible&&canShowLayout&&<LayoutOverlay layers={visibleLayers} previewLayerId={layoutPreview.previewLayerId}/>}
    {region&&source&&<div className="workspace-selected-region" aria-hidden style={regionStyle(region,source)}/>}
    {previewRegion&&source&&<div className="workspace-previewed-region" aria-hidden style={regionStyle(previewRegion,source)}/>}
    {!isSelecting&&imageSize&&!hasImageError&&<button type="button" className="workspace-capture-open" aria-label="캡처 이미지 크게 보기" aria-haspopup="dialog" onClick={openViewer}/>}
   </div>
  </div>
  {!layoutSelection.layers.length&&<p className="workspace-layout-note muted">저장된 레이아웃 영역 없음</p>}
  {isLayoutVisible&&hasLayoutSizeMismatch&&<p className="workspace-layout-note muted">캡처 크기가 달라 저장된 레이아웃을 표시할 수 없습니다.</p>}
  {isLayoutVisible&&canShowLayout&&layout?.isEstimated&&<p className="workspace-layout-note muted">이미지에서 추정한 레이아웃</p>}
  {region&&<div className="workspace-selection-caption"><span>선택 영역</span><Button variant="secondary" disabled={isSelectionDisabled} onClick={()=>publish(null)} aria-label="선택 영역 해제"><X size={14}/></Button></div>}
  {previewRegion&&<div className="workspace-selection-caption"><span>집중 재검토 이력의 영역</span><Button variant="secondary" onClick={onClearPreview} aria-label="이력 영역 숨기기"><X size={14}/></Button></div>}
  {isSelecting&&source&&<Disclosure title="좌표로 영역 지정" className="workspace-coordinate-disclosure">
   <fieldset className="workspace-coordinates" disabled={isSelectionDisabled}><legend>원본 이미지 좌표</legend>
    {(['x','y','width','height'] as const).map(key=><label key={key}>{{x:'왼쪽 X',y:'위쪽 Y',width:'너비',height:'높이'}[key]}
     <Input type="number" min={key==='x'||key==='y'?0:1} value={region?.[key]??''} onChange={event=>publish({...region??{x:0,y:0,width:0,height:0},[key]:Number(event.target.value)})}/>
    </label>)}
   </fieldset>
  </Disclosure>}
  {(error||hasImageError||Boolean(source&&imageSize&&!hasMatchingSourceSize))&&<p role="alert" className="workspace-error">{error||(hasImageError?'캡처를 불러오지 못했습니다.':'캡처 크기가 원본과 달라 영역을 선택할 수 없습니다.')}</p>}
  <ImageViewer images={images.map(toViewerImage)} index={viewerIndex} isOpen={isViewerOpen}
   onIndexChange={setViewerIndex} onOpenChange={setIsViewerOpen} returnFocusRef={viewerTrigger}/>
 </section>;
}
