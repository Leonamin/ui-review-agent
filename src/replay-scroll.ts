/** Page-owned scroll geometry only. The caller supplies the remaining run-wide budget. */
export function scrollForReplay({target,remainingPx,maxStepPx,direction,expectedUrl}:{target:Element|null;remainingPx:number;maxStepPx:number;direction:1|-1|0;expectedUrl:string}):{distancePx:number;direction:1|-1|0;hadOvershoot:boolean;didNavigate?:boolean}{
 if(location.href!==expectedUrl)return {distancePx:0,direction,hadOvershoot:false,didNavigate:true};
 const root=document.scrollingElement;
 const ancestors:Element[]=[];
 if(target){
  for(let node=target.parentElement;node;node=node.parentElement)ancestors.push(node);
 }else{
  for(const y of [.65,.86,.42]){
   let node=document.elementFromPoint(innerWidth*.5,innerHeight*y);
   while(node){if(!ancestors.includes(node))ancestors.push(node);node=node.parentElement;}
  }
 }
 if(root&&!ancestors.includes(root))ancestors.push(root);
 const targetBox=target?.getBoundingClientRect();
 const limit=Math.floor(Math.min(remainingPx,maxStepPx));
 if(limit<1)return {distancePx:0,direction,hadOvershoot:false};
 for(const node of ancestors){
  const style=getComputedStyle(node),isRoot=node===root;
  if((!isRoot&&!/^(auto|scroll|overlay)$/.test(style.overflowY))||style.scrollSnapType!=='none'||node.clientHeight<=0||node.scrollHeight<=node.clientHeight+1)continue;
  const box=node.getBoundingClientRect();
  const top=isRoot?0:Math.max(0,box.top+node.clientTop);
  const bottom=isRoot?innerHeight:Math.min(innerHeight,box.top+node.clientTop+node.clientHeight);
  if(bottom<=top)continue;
  const hasDown=node.scrollHeight-node.clientHeight-node.scrollTop>=1;
  const hasUp=node.scrollTop>=1;
  let dy=0;
  if(targetBox){
   const center=(targetBox.top+targetBox.bottom)/2,aim=(top+bottom)/2;
   if(targetBox.bottom>bottom||targetBox.top<top||Math.abs(center-aim)>35)dy=Math.round(center-aim);
  }else{
   const searchDirection=direction||(hasDown?1:hasUp?-1:0);
   if(!searchDirection)continue;
   dy=searchDirection*limit;
  }
  if(!dy||dy>0&&!hasDown||dy<0&&!hasUp)continue;
  const old=ancestors.map(element=>element.scrollTop);
  node.scrollBy({top:Math.max(-limit,Math.min(dy,limit)),behavior:'instant'});
  const distancePx=ancestors.reduce((sum,element,index)=>sum+Math.abs(element.scrollTop-old[index]),0);
  return{distancePx,direction:target?direction:dy>0?1:-1,hadOvershoot:distancePx>remainingPx};
 }
 return {distancePx:0,direction,hadOvershoot:false};
}
