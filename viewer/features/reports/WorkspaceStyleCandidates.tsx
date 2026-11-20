import {useId,useRef,useState} from 'react';
import {Columns2} from 'lucide-react';
import type {AutoStyleComparisonReport} from '../../../src/automatic-style-comparison';
import {repeatedStyleDifferences,styleComparisonElementLabel,styleComparisonReasons,styleComparisonRoleLabel,styleComparisonSides} from '../../../src/check-presentation';
import {Disclosure} from '../../shared/Disclosure';
import {Button} from '../../shared/goodcase/components/basic/button';
import {Image} from '../../shared/goodcase/components/basic/image';
import {Dialog} from '../../shared/goodcase/components/overlays/dialog';
import {Select} from '../../shared/goodcase/components/overlays/select';
import {AutomaticStyleComparisonScope,AutomaticStyleComparisonSources,automaticStyleComparisonImage,changedStyleMatches} from './AutomaticChecks';
import type {ReportDetail} from './types';
import './workspace-style-candidates.css';

type StyleMatch=AutoStyleComparisonReport['matches'][number];
type StyleSide=keyof typeof styleComparisonSides;

const sides=['reference','comparison'] as const;
const propertyLabels:Record<StyleMatch['differences'][number]['property'],string>={
 height:'높이',
 'min-height':'최소 높이',
 'font-size':'글자 크기',
 'font-weight':'글자 굵기',
 'line-height':'줄 높이',
 'padding-left':'왼쪽 안쪽 여백',
 'padding-right':'오른쪽 안쪽 여백',
 'border-top-left-radius':'왼쪽 위 모서리 반경',
 'border-top-color':'위쪽 테두리 색',
 'border-top-width':'위쪽 테두리 두께',
 'background-color':'배경색',
 color:'글자 색',
};

function pairName(match:StyleMatch){
 const a=styleComparisonElementLabel(match.reference.label);
 const b=styleComparisonElementLabel(match.comparison.label);
 return `${styleComparisonRoleLabel(match.role)} · ${a===b?a:`${a} ↔ ${b}`}`;
}

function PairCapture({side,comparison,match,report,labels=styleComparisonSides}:{
 side:StyleSide;
 comparison:AutoStyleComparisonReport;
 match?:StyleMatch;
 labels?:Record<StyleSide,string>;
 report:Pick<ReportDetail,'captures'|'images'>;
}){
 const label=labels[side];
 const image=automaticStyleComparisonImage(comparison[side],report.images);
 const viewport=image&&report.captures?.find(capture=>capture.observationId===image.observationId)?.viewport;
 const imageSize=image?.layout?.imageSize??viewport;
 return <figure className="style-candidate-capture">
  <figcaption>
   <strong>{label}</strong>
   {image&&<a className="text-link" href={image.url} target="_blank" rel="noreferrer" aria-label={label+' 원본 열기'}>원본 열기</a>}
  </figcaption>
  {image
   ? <Image key={image.id} src={image.url} alt={match?`${label}의 ${styleComparisonElementLabel(match[side].label)} 캡처`:`${label} 캡처`}
      aspectRatio={imageSize?`${imageSize.width} / ${imageSize.height}`:'16 / 10'}/>
   : <p className="style-candidate-no-capture">저장된 캡처가 없습니다.</p>}
 </figure>;
}

function CandidateDetail({comparison,match,report}:{
 comparison:AutoStyleComparisonReport;
 match:StyleMatch;
 report:Pick<ReportDetail,'captures'|'images'>;
}){
 return <>
  <h3>{pairName(match)}</h3>
  <div className="style-candidate-captures">
   {sides.map(side=><PairCapture key={side} side={side} comparison={comparison} match={match} report={report}/>)}
  </div>
  <table className="style-candidate-measurements">
   <caption>차이가 기록된 속성 {match.differences.length}개</caption>
   <thead><tr>
    <th scope="col">속성</th>
    {sides.map(side=><th scope="col" key={side}>{styleComparisonSides[side]}</th>)}
   </tr></thead>
   <tbody>{match.differences.map(difference=><tr key={difference.property}>
    <th scope="row">{propertyLabels[difference.property]}</th>
    {sides.map(side=><td key={side}>{difference[side]}</td>)}
   </tr>)}</tbody>
  </table>
  <p className="muted style-candidate-masking">자동 측정값을 표시합니다. 캡처에서 입력란은 가려질 수 있습니다.</p>
 </>;
}

type StyleReportView=Pick<ReportDetail,'captures'|'images'>;

function LegacyStyleCandidates({report}:{report:StyleReportView}){
 const headingId=useId();
 const pickerId=useId();
 const triggerRef=useRef<HTMLButtonElement>(null);
 const [selectedIndex,setSelectedIndex]=useState(0);
 const comparisons=(report.captures??[]).flatMap(capture=>
  capture.deterministicChecks?.autoStyleComparison??[]
 );
 if(!comparisons.length)return null;
 const candidates=comparisons.flatMap(comparison=>changedStyleMatches(comparison).map(match=>({comparison,match})));
 const {length:count}=candidates;
 const hasPicker=count>1;
 const currentIndex=candidates[selectedIndex]?selectedIndex:0;
 const selected=candidates[currentIndex];
 const hasComparablePair=comparisons.some(comparison=>comparison.coverage.matched>0);
 const emptyLabel=hasComparablePair?'측정한 스타일 차이 없음':'비교할 요소 쌍을 확인하지 못함';
 const candidateOptions=candidates.map(({match},index)=>({value:String(index),label:`${index+1}. ${pairName(match)}`}));

 return <section className="workspace-style-candidate-summary" aria-labelledby={headingId}>
  <h3 id={headingId}>{count?`자동 스타일 차이 후보 ${count}쌍`:emptyLabel}</h3>
  <Dialog
   className="style-candidate-dialog"
   title={count?'스타일 차이 후보':'자동 스타일 비교 범위'}
   description={count?`${count}쌍`:undefined}
   returnFocusRef={triggerRef}
   onOpenChange={isOpen=>{if(isOpen)setSelectedIndex(0);}}
   trigger={<Button ref={triggerRef} variant="secondary">
    <Columns2 size={16} aria-hidden/>
    {hasPicker?'후보 보기':count?'A/B 캡처 보기':'검사 범위 보기'}
   </Button>}
  >
   {selected&&<div className={`style-candidate-body${hasPicker?' has-picker':''}`}>
    {hasPicker&&<div>
     <fieldset className="style-candidate-hub">
      <legend>후보 선택</legend>
      <div className="style-candidate-list">{candidateOptions.map(({value,label},index)=><label key={value}>
       <input type="radio" name={pickerId} checked={index===currentIndex} onChange={()=>setSelectedIndex(index)}/>
       <span>{label}</span>
      </label>)}</div>
     </fieldset>
     <div className="style-candidate-select">
      <Select label="후보 선택" value={String(currentIndex)} options={candidateOptions}
       onValueChange={value=>setSelectedIndex(Number(value))}
       triggerClassName="gc-dropdown-trigger" contentClassName="style-candidate-options"/>
     </div>
    </div>}
    <div className="style-candidate-detail">
     <CandidateDetail comparison={selected.comparison} match={selected.match} report={report}/>
    </div>
   </div>}
   <Disclosure title="검사 범위">
    {(selected?[selected.comparison]:comparisons).map((comparison,index)=><section
     key={comparison.evidenceId+'-'+index} className="automatic-style-comparison">
     <p>비교한 요소 {comparison.coverage.matched}쌍 · 차이 없음 {comparison.coverage.matched-comparison.coverage.changed}쌍</p>
     <p className="muted">각 화면의 첫 뷰포트에 보이는 요소를 비교했습니다.</p>
     <AutomaticStyleComparisonSources report={comparison} images={report.images}/>
     <AutomaticStyleComparisonScope report={comparison}/>
    </section>)}
   </Disclosure>
  </Dialog>
 </section>;
}

export function WorkspaceStyleCandidates({report,shouldShowSingle=true}:{report:StyleReportView;shouldShowSingle?:boolean}){
 const headingId=useId();
 const comparisons=(report.captures??[]).flatMap(capture=>capture.deterministicChecks?.autoStyleComparisons??[]);
 if(!comparisons.length)return shouldShowSingle?<LegacyStyleCandidates report={report}/>:null;
 const repeated=repeatedStyleDifferences(comparisons);
 const changed=comparisons.filter(pair=>pair.coverage.changed>0).length;
 const unmeasured=comparisons.filter(pair=>!pair.coverage.matched).length;
 return <section className="style-comparison-batch" aria-labelledby={headingId}>
  <h3 id={headingId}>화면별 스타일 비교</h3>
  <p>비교 화면 {comparisons.length}개 · 차이 후보 있음 {changed}개 · 비교 미확인 {unmeasured}개</p>
  <div>
   <h4>반복되는 스타일 차이</h4>
   {repeated.length>0?<ul className="automatic-check-list">{repeated.map(({key,role,label,difference,targetIndexes})=><li key={key}>
    <strong>{styleComparisonRoleLabel(role)} · {styleComparisonElementLabel(label)} · {propertyLabels[difference.property]}</strong>
    <p><code>{difference.reference}</code> → <code>{difference.comparison}</code> · 비교 화면 {targetIndexes.map(index=>index+1).join(', ')}</p>
   </li>)}</ul>:<p className="muted">측정한 범위에 반복되는 차이가 없습니다.</p>}
  </div>
  {comparisons.map((pair,index)=>{
   const {matched,changed}=pair.coverage;
   const differences=changedStyleMatches(pair);
   const reason=pair.reference.reason??pair.comparison.reason;
   const labels={reference:'기준 화면',comparison:`비교 화면 ${index+1}`};
   const path=URL.parse(pair.comparison.url)?.pathname??pair.comparison.url;
   const status=!matched?'비교 미확인':changed?`차이 후보 ${changed}쌍`:'측정한 차이 없음';
   return <Disclosure key={pair.evidenceId} title={`${labels.comparison} · ${path} · ${status}`}>
    <div className="style-comparison-batch-detail">
     <p>비교한 요소 {matched}쌍 · 차이 없음 {matched-changed}쌍</p>
     {reason&&<p>{styleComparisonReasons[reason]}</p>}
     {(pair.reference.hasReachedLimit||pair.comparison.hasReachedLimit)&&<p>탐색 한도에 도달해 일부 요소를 확인하지 못했습니다.</p>}
     {differences.length>0&&<ul className="automatic-check-list">{differences.map(match=><li key={match.reference.selector}>
      <strong>{pairName(match)}</strong>
      <ul>{match.differences.map(difference=><li key={difference.property}>
       {propertyLabels[difference.property]} <code>{difference.reference}</code> → <code>{difference.comparison}</code>
      </li>)}</ul>
     </li>)}</ul>}
     <div className="style-candidate-captures">
      {sides.map(side=><PairCapture key={side} side={side} comparison={pair} report={report} labels={labels}/>)}
     </div>
     <AutomaticStyleComparisonScope report={pair}/>
    </div>
   </Disclosure>;
  })}
 </section>;
}
