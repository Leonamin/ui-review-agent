import {useEffect,useId,useRef,useState,type KeyboardEvent,type ReactNode} from 'react';
import {ChevronDown,Layers,X} from 'lucide-react';
import {Button,IconButton} from '../../shared/goodcase/components/basic/button';
import {Tooltip} from '../../shared/Tooltip';
import type {LayoutLayer} from './LayoutOverlay';
import type {ReportImage} from './types';

type LayerPreviewSource = 'focusedLayerId'|'hoveredLayerId'|'touchedLayerId';
type LayerPreview = Partial<Record<LayerPreviewSource,string>> & {
 imageId?: string;
 lastSource?: LayerPreviewSource;
};

export function useLayoutLayerPreview(imageId:string|undefined,visibleLayers:LayoutLayer[]) {
 const [preview,setPreview]=useState<LayerPreview>({imageId});
 const touchTimer=useRef<number|undefined>(undefined);

 // Reset temporary interactions when a different capture replaces the current one.
 if (preview.imageId!==imageId) setPreview({imageId});
 useEffect(()=>()=>window.clearTimeout(touchTimer.current),[imageId]);

 function setPreviewLayer(source:LayerPreviewSource,layerId?:string) {
  setPreview(previous=>({...previous,[source]:layerId,lastSource:layerId?source:previous.lastSource}));
 }

 function setTouchPreview(layerId?:string) {
  window.clearTimeout(touchTimer.current);
  setPreviewLayer('touchedLayerId',layerId);
  if (layerId) touchTimer.current=window.setTimeout(()=>setPreviewLayer('touchedLayerId'),1500);
 }

 function clearPreview() {
  window.clearTimeout(touchTimer.current);
  setPreview({imageId});
 }

 const recentLayerId=preview.lastSource&&preview[preview.lastSource];
 const previewLayerId=[recentLayerId,preview.focusedLayerId,preview.hoveredLayerId,preview.touchedLayerId]
  .find(id=>visibleLayers.some(layer=>layer.id===id));
 return {previewLayerId,setPreviewLayer,setTouchPreview,clearPreview};
}

export function useLayoutLayerSelection(image:ReportImage|undefined,focus:NonNullable<ReportImage['layout']>['focusAreas'][number]|undefined) {
 const [hiddenLayerIdsByImage,setHiddenLayerIdsByImage]=useState(new Map<string,ReadonlySet<string>>());
 const layers:LayoutLayer[]=image?.layout?.regions.map((region,index)=>({...region,id:`region-${index}`}))??[];
 if (focus) layers.push({id:`focus-${focus.findingId}`,label:'주목 영역',bounds:focus.bounds,isFocus:true});
 const hiddenLayerIds=image?hiddenLayerIdsByImage.get(image.id):undefined;
 const visibleLayers=layers.filter(layer=>!hiddenLayerIds?.has(layer.id));

 function setLayersVisible(ids:string[],isVisible:boolean) {
  if (!image) return;
  setHiddenLayerIdsByImage(previous=>{
   const next=new Map(previous);
   const hidden=new Set(previous.get(image.id));
   for (const id of ids) {
    if (isVisible) hidden.delete(id);
    else hidden.add(id);
   }
   if (hidden.size) next.set(image.id,hidden);
   else next.delete(image.id);
   return next;
  });
 }

 return {layers,hiddenLayerIds,visibleLayers,setLayersVisible};
}

export function LayoutLayerControls({heading,zoomControls,isLayoutVisible,onLayoutVisibleChange,selection,preview}:{
 heading:ReactNode;
 zoomControls:ReactNode;
 isLayoutVisible:boolean;
 onLayoutVisibleChange:(isVisible:boolean)=>void;
 selection:ReturnType<typeof useLayoutLayerSelection>;
 preview:ReturnType<typeof useLayoutLayerPreview>;
}) {
 const [isOpen,setIsOpen]=useState(false);
 const listTrigger=useRef<HTMLButtonElement>(null);
 const touchActivation=useRef<string|undefined>(undefined);
 const checklistId=useId();
 const headingId=`${checklistId}-heading`;
 const {layers,hiddenLayerIds,visibleLayers,setLayersVisible}=selection;
 const isAllVisible=visibleLayers.length===layers.length;
 const isPartiallyVisible=!isAllVisible&&visibleLayers.length>0;

 function closeChecklist() {
  setIsOpen(false);
  preview.clearPreview();
  listTrigger.current?.focus();
 }

 function handleEscape(event:KeyboardEvent<HTMLElement>) {
  if (!isOpen||event.key!=='Escape') return;
  event.stopPropagation();
  closeChecklist();
 }

 function clearTouchInteraction() {
  touchActivation.current=undefined;
  preview.setTouchPreview();
 }

 const hasLayers=layers.length>0;
 return <>
  <div className="row-between wrap evidence-toolbar">
   {heading}
   {(hasLayers||zoomControls)&&<div className="evidence-controls">
    {hasLayers&&<div className="layout-tools" onKeyDown={handleEscape}>
     <Button className="layout-toggle" variant={isLayoutVisible?'primary':'secondary'} aria-pressed={isLayoutVisible}
      onClick={()=>{
       if (isLayoutVisible) {
        setIsOpen(false);
        preview.clearPreview();
       }
       onLayoutVisibleChange(!isLayoutVisible);
      }}>
      <Layers size={15} aria-hidden/>레이아웃 보기
     </Button>
     <Tooltip label="레이아웃 목록">
      <IconButton ref={listTrigger} className="layout-list-trigger" label="레이아웃 목록" variant="secondary"
       aria-expanded={isOpen} aria-controls={checklistId}
       onClick={()=>{
        setIsOpen(!isOpen);
        if (isOpen) preview.clearPreview();
        else onLayoutVisibleChange(true);
       }}>
       <ChevronDown size={16} aria-hidden/>
      </IconButton>
     </Tooltip>
    </div>}
    {zoomControls}
   </div>}
  </div>
  {hasLayers&&<section className="layout-layer-panel" id={checklistId} aria-labelledby={headingId} hidden={!isOpen}
   onPointerDownCapture={event=>{
    clearTouchInteraction();
    if (event.pointerType==='touch') preview.clearPreview();
   }}
   onPointerCancel={()=>{touchActivation.current=undefined;}}
   onKeyDown={event=>{clearTouchInteraction();handleEscape(event);}}>
   <div className="layout-layer-heading">
    <h3 id={headingId}>표시 영역</h3>
    <IconButton className="layout-layer-close" label="레이아웃 목록 닫기" variant="secondary" onClick={closeChecklist}><X size={16} aria-hidden/></IconButton>
   </div>
   <label className="layout-layer-choice layout-layer-master">
    <input type="checkbox" checked={isAllVisible} ref={input=>{if(input)input.indeterminate=isPartiallyVisible;}}
     onChange={event=>setLayersVisible(layers.map(layer=>layer.id),event.currentTarget.checked)}/>
    <span>전체 선택</span>
    <span className="layout-layer-count" aria-hidden>{visibleLayers.length}/{layers.length}</span>
   </label>
   <ul className="layout-layer-list">
    {layers.map(layer=><li key={layer.id}>
     <label className="layout-layer-choice"
      onPointerEnter={event=>{if (event.pointerType!=='touch') preview.setPreviewLayer('hoveredLayerId',layer.id);}}
      onPointerLeave={event=>{if (event.pointerType!=='touch') preview.setPreviewLayer('hoveredLayerId');}}
      onPointerDown={event=>{if (event.pointerType==='touch') touchActivation.current=layer.id;}}>
      <input type="checkbox" checked={!hiddenLayerIds?.has(layer.id)}
       onFocus={event=>{
        if (!touchActivation.current&&event.currentTarget.matches(':focus-visible')) preview.setPreviewLayer('focusedLayerId',layer.id);
       }}
       onBlur={()=>preview.setPreviewLayer('focusedLayerId')}
       onChange={event=>{
        const isVisible=event.currentTarget.checked;
        if (isVisible&&touchActivation.current===layer.id) preview.setTouchPreview(layer.id);
        touchActivation.current=undefined;
        setLayersVisible([layer.id],isVisible);
       }}/>
      <span className="layout-layer-swatch" data-kind={layer.isFocus?'focus':'region'} aria-hidden/>
      <span>{layer.label}</span>
     </label>
    </li>)}
   </ul>
  </section>}
 </>;
}
