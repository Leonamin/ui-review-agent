import type {Rect} from '../../../src/types';
import type {ReportImageLayout} from './types';
import './layout-overlay.css';

const percent = (value: number) => `${value * 100}%`;

export function hasMatchingLayoutSize(layout:ReportImageLayout,size:{width:number;height:number}) {
 // A browser crop can round the CSS bounds by one CSS pixel.
 const tolerance=layout.isEstimated?0:Math.max(1,layout.imageSize.deviceScaleFactor);
 return Math.abs(size.width-layout.imageSize.width)<=tolerance&&Math.abs(size.height-layout.imageSize.height)<=tolerance;
}

export interface LayoutLayer {
 id: string;
 label: string;
 bounds: Rect;
 isFocus?: boolean;
}

function Annotation({bounds,label,isFocus=false,isPreviewed,hasLabel}:LayoutLayer&{isPreviewed:boolean;hasLabel:boolean}) {
 const labelX = isFocus ? bounds.x + bounds.width : bounds.x;
 const labelY = isFocus ? bounds.y + bounds.height : bounds.y;
 return <div className={`layout-annotation${isFocus?' is-focus':''}${isPreviewed?' is-previewed':''}`}>
  <div className="layout-annotation-box" aria-hidden style={{
   left:percent(bounds.x), top:percent(bounds.y), width:percent(bounds.width), height:percent(bounds.height),
  }}/>
  {hasLabel&&<span className="layout-annotation-label" style={{
   left:percent(labelX), top:percent(labelY), transform:`translate(-${percent(labelX)}, -${percent(labelY)})`,
  }}>{label}</span>}
 </div>;
}

export function LayoutOverlay({layers,previewLayerId}:{layers:LayoutLayer[];previewLayerId?:string}) {
 if (!layers.length) return null;
 return <div className="layout-overlay" role="group" aria-label="화면 레이아웃">
  {layers.map(layer=>{
   const isPreviewed=layer.id===previewLayerId;
   return <Annotation key={layer.id} {...layer} isPreviewed={isPreviewed} hasLabel={layers.length===1||isPreviewed}/>;
  })}
 </div>;
}
