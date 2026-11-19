import {useLayoutEffect,useRef,useState,type ReactNode} from 'react';
import {ArrowLeft,ChevronRight} from 'lucide-react';
import {Badge} from '../../shared/goodcase/components/basic/badge';
import {Button} from '../../shared/goodcase/components/basic/button';
import {Select} from '../../shared/goodcase/components/overlays/select';
import type {FindingView,SuggestionView} from './types';

export type ResultItem =
 | {kind:'finding'; item:FindingView; key:string}
 | {kind:'suggestion'; item:SuggestionView; key:string};

export function findingResult(item:FindingView,index:number):ResultItem {
 return {kind:'finding',item,key:`finding-${item.id}-${index}`};
}

const resultKinds = {
 problem:'문제',
 candidate:'추가 확인',
 suggestion:'개선 제안',
 dismissed:'제외',
 unknown:'판정 미기록',
} as const;

function resultKind(result:ResultItem):keyof typeof resultKinds {
 if(result.kind==='suggestion')return 'suggestion';
 if(result.item.source==='automatic-rule')return 'candidate';
 if(result.item.disposition==='confirmed')return 'problem';
 if(result.item.disposition==='needs-verification')return 'candidate';
 if(result.item.disposition==='dismissed')return 'dismissed';
 return 'unknown';
}

export function resultLabel(result:ResultItem):string {
 if(result.kind==='finding'&&result.item.source==='automatic-rule')return '자동 검사 후보';
 return resultKinds[resultKind(result)];
}

export function WorkspaceResults({
 findings,suggestions,selected,onSelect,onBack,isSuggestionLink,hasFailedEvaluation,renderDetail,emptyState,
}:{
 findings:FindingView[];
 suggestions:SuggestionView[];
 selected?:ResultItem;
 onSelect:(result:ResultItem)=>boolean;
 onBack:()=>void;
 isSuggestionLink:boolean;
 hasFailedEvaluation:boolean;
 renderDetail:(result:ResultItem)=>ReactNode;
 emptyState:ReactNode;
}) {
 const [filter,setFilter]=useState(isSuggestionLink?'suggestion':'all');
 const listRef=useRef<HTMLUListElement>(null);
 const detailRef=useRef<HTMLDivElement>(null);
 const rowRefs=useRef(new Map<string,HTMLButtonElement>());
 const returnPosition=useRef<{key:string;scrollY:number;listTop:number;main:HTMLElement|null;mainTop:number}|undefined>(undefined);
 const shouldRestoreList=useRef(false);
 const entries:ResultItem[]=[
  ...findings.map(findingResult),
  ...suggestions.map((item,index):ResultItem=>({kind:'suggestion',item,key:`suggestion-${item.id}-${index}`})),
 ];
 const options=[
  {value:'all',label:'전체'},
  {value:'problem',label:resultKinds.problem},
  {value:'candidate',label:resultKinds.candidate},
  {value:'suggestion',label:resultKinds.suggestion},
  ...(['dismissed','unknown'] as const).filter(kind=>entries.some(result=>resultKind(result)===kind))
   .map(value=>({value,label:resultKinds[value]})),
 ];
 const visible=filter==='all'?entries:entries.filter(result=>resultKind(result)===filter);

 useLayoutEffect(()=>{
  if(selected){
   // A summary link can mount the selected detail directly.
   const heading=detailRef.current?.querySelector('h2');
   heading?.focus({preventScroll:true});
   detailRef.current?.firstElementChild?.scrollIntoView({block:'nearest'});
  }else if(shouldRestoreList.current){
   const position=returnPosition.current;
   if(position&&listRef.current){
    listRef.current.scrollTop=position.listTop;
    if(position.main)position.main.scrollTop=position.mainTop;
    window.scrollTo(0,position.scrollY);
    rowRefs.current.get(position.key)?.focus({preventScroll:true});
   }else{
    listRef.current?.focus({preventScroll:true});
    listRef.current?.scrollIntoView({block:'nearest'});
   }
   returnPosition.current=undefined;
  }
  shouldRestoreList.current=false;
 },[selected]);

 function openResult(result:ResultItem){
  const main=listRef.current?.closest('main')??null;
  const position={key:result.key,scrollY:window.scrollY,listTop:listRef.current?.scrollTop??0,main,mainTop:main?.scrollTop??0};
  if(onSelect(result))returnPosition.current=position;
 }

 function backToList(){
  shouldRestoreList.current=true;
  onBack();
 }

 return <section className="workspace-panel workspace-results">
  {selected?<div ref={detailRef}>
   <div className="workspace-results-header">
    <Button variant="secondary" onClick={backToList}><ArrowLeft size={16} aria-hidden/>목록으로</Button>
   </div>
   {renderDetail(selected)}
  </div>:<>
   <div className="workspace-results-header">
    <div className="workspace-results-counts">
     <h2>결과</h2>
     {hasFailedEvaluation?<Badge>AI 지적 집계 불가</Badge>:<Badge>지적 {findings.filter(item=>item.disposition!=='dismissed').length}건</Badge>}
     <Badge>개선 제안 {suggestions.length}건</Badge>
    </div>
    <Select label="유형" value={filter} options={options} onValueChange={value=>{
     setFilter(value);
     if(listRef.current)listRef.current.scrollTop=0;
    }}/>
   </div>
   {visible.length>0?<ul className="workspace-results-list" aria-label="결과 목록" ref={listRef} tabIndex={-1}>
    {visible.map(result=><li key={result.key}>
     <button type="button" className="workspace-result-row" onClick={()=>openResult(result)}
      ref={element=>{if(element)rowRefs.current.set(result.key,element);else rowRefs.current.delete(result.key);}}>
      <span className="workspace-result-row-copy">
       <span><Badge tone={resultKind(result)==='problem'?'warning':'neutral'}>{resultLabel(result)}</Badge></span>
       <strong>{result.item.title}</strong>
       <span className="workspace-result-row-evidence muted">
        {(result.kind==='finding'?result.item.facts[0]:result.item.observation)||'관찰 근거 미기록'}
       </span>
      </span>
      <ChevronRight size={16} aria-hidden/>
     </button>
    </li>)}
   </ul>:filter==='all'?emptyState:<p className="workspace-results-empty muted">이 유형에 해당하는 결과가 없습니다.</p>}
  </>}
 </section>;
}
