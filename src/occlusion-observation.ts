import type {ElementObservation,OcclusionEvidence} from './types.js';

/** Runs in the page. Records bounded geometry only, never text or arbitrary selectors. */
export function collectOcclusionEvidence(data:{candidateElements:Element[];elements:ElementObservation[]}):Record<string,OcclusionEvidence>{
 const output:Record<string,OcclusionEvidence>={};
 const sensitive='input,textarea,select,[contenteditable]:not([contenteditable="false"])';
 const observed=new Set(data.elements.map(element=>element.elementRef));
 for(const element of data.elements.slice(0,200)){
  const target=data.candidateElements[Number(element.elementRef.slice(1))];
  if(!target||target.closest(sensitive)||target.querySelector(sensitive))continue;
  let hasUnsupportedPainting=false;
  for(let parent:Element|null=target;parent;parent=parent.parentElement){const css=getComputedStyle(parent);if(css.pointerEvents==='none'||css.visibility!=='visible'||Number(css.opacity)!==1||css.transform!=='none'||css.filter!=='none'||css.clipPath!=='none'||css.mixBlendMode!=='normal')hasUnsupportedPainting=true;}
  if(hasUnsupportedPainting)continue;
  const textRects:{x:number;y:number;width:number;height:number}[]=[];
  const walker=document.createTreeWalker(target,NodeFilter.SHOW_TEXT);let node:Node|null;let count=0;
  while((node=walker.nextNode())&&count++<40){
   if(!node.textContent?.trim())continue;const parent=node.parentElement;if(!parent)continue;
   let hasHiddenAncestor=false;for(let el:Element|null=parent;el;el=el.parentElement){const css=getComputedStyle(el);if(css.display==='none'||css.visibility!=='visible'||Number(css.opacity)!==1||el.hasAttribute('hidden'))hasHiddenAncestor=true;if(el===target)break;}
   if(hasHiddenAncestor)continue;
   const range=document.createRange();range.selectNodeContents(node);for(const rect of range.getClientRects())if(rect.width>0&&rect.height>0&&textRects.length<12)textRects.push({x:rect.x,y:rect.y,width:rect.width,height:rect.height});
  }
  if(!textRects.length)continue;
  const coveringElementRefs=new Set<string>();let hasUncertainCover=false;
  const points=textRects.slice(0,12).flatMap(rect=>[Math.min(0.5/rect.width,0.1),0.02,0.2,0.5,0.8,0.98,1-Math.min(0.5/rect.width,0.1)].map(fraction=>({x:rect.x+rect.width*fraction,y:rect.y+rect.height/2})));
  if(target.matches('button,a,input,select,[role=button],[role=link]')){const box=target.getBoundingClientRect();points.push({x:box.left+Math.min(1,box.width/4),y:box.top+box.height/2},{x:box.right-Math.min(1,box.width/4),y:box.top+box.height/2});}
  for(const {x,y} of points){
   if(x<0||x>=innerWidth||y<0||y>=innerHeight)continue;
   const top=document.elementFromPoint(x,y);if(top&&(top===target||target.contains(top)))continue;
   let cover:Element|null=null;
   for(let el=top;el&&!el.contains(target);el=el.parentElement){
    const css=getComputedStyle(el),color=css.backgroundColor;
    const alpha=color.startsWith('rgba')?Number(color.split(',').at(-1)?.replace(')','')):color.startsWith('rgb')?1:0;
    let hasOpaqueChain=true;for(let ancestor:Element|null=el;ancestor;ancestor=ancestor.parentElement){const ac=getComputedStyle(ancestor);if(Number(ac.opacity)!==1||ac.filter!=='none'||ac.mixBlendMode!=='normal'||ac.transform!=='none'||ac.clipPath!=='none')hasOpaqueChain=false;}
    if(alpha>=0.99&&hasOpaqueChain&&css.visibility==='visible'){cover=el;break;}
   }
   if(!cover){hasUncertainCover=true;continue;}
   // A reference must identify the actual opaque painted node, not an arbitrary ancestor.
   const ref=`e${data.candidateElements.indexOf(cover)}`;
   if(observed.has(ref))coveringElementRefs.add(ref);else hasUncertainCover=true;
  }
  output[element.elementRef]={textRects,coveringElementRefs:[...coveringElementRefs],hasUncertainCover};
 }
 return output;
}
