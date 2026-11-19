import {alignmentLabels,alignmentReasonLabel,automaticStyleCoverageGroups,contrastLabels,formatMeasurement,formatViewportBounds,spacingCheckLabel,spacingCheckMeasurement,styleComparisonElementLabel,styleComparisonLabels,styleComparisonMatchLabels,styleComparisonReasons,styleComparisonRoleLabel,styleComparisonSides,themeLabels,themeStatusLabel} from '../../../src/check-presentation';
import type {AutoStyleComparisonReport} from '../../../src/automatic-style-comparison';
import type {GroupAlignmentCheck} from '../../../src/group-alignment';
import type {StyleComparisonReport} from '../../../src/style-comparison';
import {Badge} from '../../shared/goodcase/components/basic/badge';
import {Card} from '../../shared/goodcase/components/basic/card';
import {Disclosure} from '../../shared/Disclosure';
import type {CaptureContext,ReportDetail} from './types';
import './automatic-checks.css';

const tone = {passed:'success',violation:'danger',candidate:'warning',unverified:'neutral',incomplete:'warning',inapplicable:'neutral'} as const;

function AlignmentChecks({checks}:{checks:GroupAlignmentCheck[]}) {
 const counts = Object.keys(alignmentLabels).flatMap(status=>{
  const count=checks.filter(check=>check.status===status).length;
  return count>0?[`${alignmentLabels[status as keyof typeof alignmentLabels]} ${count}`]:[];
 });
 return <div>
  <p><strong>그룹 정렬</strong> {counts.length?counts.join(' · '):'기록된 불일치 없음'}</p>
  {checks.length>0&&<Disclosure title="그룹별 정렬과 크기 측정">
   <ul className="automatic-check-list">{checks.map((check,index)=><li key={index}>
    <Badge tone={tone[check.status]}>{alignmentLabels[check.status]}</Badge>{' '}
    {check.groupIndex!==null?`그룹 ${check.groupIndex}`:`설정 ${check.contractIndex??index+1}`}
    {check.line!==undefined&&` · ${check.line}번째 ${check.axis==='column'?'열':'행'}`}
    {check.differences.map(difference=><p key={difference.kind}>
     {difference.kind==='cross-size'?(check.axis==='column'?'외곽 너비 차이':'외곽 높이 차이'):'정렬 위치 차이'} {formatMeasurement(difference.spread)} CSS px
    </p>)}
    {check.members.length>0&&<p className="muted">외곽 크기 (너비 × 높이, CSS px){' '}{check.members.map(({visualBox})=>`${formatMeasurement(visualBox.width)} × ${formatMeasurement(visualBox.height)}`).join(' / ')}</p>}
    {check.reason&&<p>{alignmentReasonLabel(check.reason)}</p>}
   </li>)}</ul>
  </Disclosure>}
 </div>;
}

type SpacingReport = NonNullable<NonNullable<CaptureContext['deterministicChecks']>['spacing']>;

function SpacingChecks({spacing}:{spacing:SpacingReport}) {
 return <div>
  <p><strong>간격과 여백</strong>{' '}
   <Badge tone={spacing.checks.length?'warning':'neutral'}>자동 측정 후보 {spacing.checks.length}건</Badge>
  </p>
  <p className="muted">검사한 버튼 쌍 {spacing.inspectedPairs}개 · 카드 {spacing.inspectedCards}개</p>
  {spacing.isLimited&&<p className="muted">측정 한도에 도달해 나머지 영역의 간격과 여백은 확인하지 못했습니다.</p>}
  {spacing.checks.length>0&&<Disclosure title="간격과 여백 측정">
   <ul className="automatic-check-list">{spacing.checks.map((check,index)=><li key={index}>
    <strong>{spacingCheckLabel(check)}</strong>
    <p>{spacingCheckMeasurement(check)}</p>
    <p className="muted">{formatViewportBounds(check.bounds)}</p>
   </li>)}</ul>
  </Disclosure>}
 </div>;
}

function StyleComparisonChecks({comparison,images}:{comparison:StyleComparisonReport;images:ReportDetail['images']}) {
 return <div>
  <p><strong>화면 간 스타일 비교</strong> · {comparison.label}</p>
  <ul className="automatic-check-list">{[comparison.reference,comparison.comparison].map((side,index)=>{
   const image=side.screenshotEvidenceId&&images.find(item=>item.observationId===side.observationId);
   const location=side.sample.status==='measured'?formatViewportBounds(side.sample.bounds):styleComparisonReasons[side.sample.reason];
   return <li key={index}>
    <strong>{side.label}</strong>{' '}
    {image&&<a className="text-link" href={image.url} target="_blank" rel="noreferrer">캡처 보기</a>}
    <p className="muted style-comparison-target">{side.url} · <code>{side.selector}</code></p>
    <p className="muted">{location}</p>
   </li>;
  })}</ul>
  <ul className="automatic-check-list">{comparison.checks.map(check=><li key={check.property}>
   <Badge tone={tone[check.status]}>{styleComparisonLabels[check.status]}</Badge>{' '}
   <strong>{check.property}</strong>
   <p>{comparison.reference.label} {check.reference??'미측정'}{check.expectedReference&&` (기준 ${check.expectedReference})`}</p>
   <p>{comparison.comparison.label} {check.comparison??'미측정'}{check.expectedComparison&&` (기준 ${check.expectedComparison})`}</p>
  </li>)}</ul>
  <p className="muted">입력란은 캡처에서 가려질 수 있습니다. 값과 위치는 브라우저에서 측정했습니다.</p>
 </div>;
}

export function changedStyleMatches(report:AutoStyleComparisonReport){
 return report.matches.filter(match=>match.differences.length>0);
}

export function automaticStyleComparisonImage(
 side:AutoStyleComparisonReport['reference'],
 images:ReportDetail['images'],
){
 const {observationId,screenshotEvidenceId}=side;
 if(!screenshotEvidenceId)return;
 return images.find(image=>image.evidenceId===screenshotEvidenceId&&(!observationId||image.observationId===observationId))
  ?? images.find(image=>!image.evidenceId&&image.observationId===observationId&&
   (image.id===screenshotEvidenceId||image.label===screenshotEvidenceId));
}

export function AutomaticStyleComparisonSources({report,images}:{report:AutoStyleComparisonReport;images:ReportDetail['images']}){
 return <ul className="automatic-check-list">{(['reference','comparison'] as const).map(key=>{
   const side=report[key];
   const image=automaticStyleComparisonImage(side,images);
   return <li key={key}>
    <strong>{styleComparisonSides[key]}</strong>{' '}
    {image&&<a className="text-link" href={image.url} target="_blank" rel="noreferrer">{styleComparisonSides[key]} 캡처 보기</a>}
    <p className="muted">{side.url}</p>
    <p>{side.reason?styleComparisonReasons[side.reason]:`발견한 검사 대상 ${side.inspected}개`}</p>
    {side.hasReachedLimit&&<p>탐색 한도에 도달해 일부 요소를 확인하지 못했습니다.</p>}
   </li>;
  })}</ul>;
}

export function AutomaticStyleComparisonScope({report}:{report:AutoStyleComparisonReport}){
 const {coverage}=report;
 const unchanged=report.matches.filter(match=>!match.differences.length);
 const unpairedGroups=automaticStyleCoverageGroups(report);
 return <>
  <p className="muted">대응 요소 없음 {coverage.unmatched}개 · 모호함 {coverage.ambiguous}개 · 미측정 {coverage.unmeasured}개</p>
  {(unchanged.length>0||unpairedGroups.some(group=>group.elements.length>0))&&<Disclosure title="검사 범위 상세">
   {unchanged.length>0&&<>
    <h4>측정한 스타일 차이 없음</h4>
    <ul className="automatic-check-list">{unchanged.map((match,index)=><li key={index}>
     {styleComparisonRoleLabel(match.role)} · {styleComparisonElementLabel(match.reference.label)} ↔ {styleComparisonElementLabel(match.comparison.label)}
    </li>)}</ul>
   </>}
   {unpairedGroups.filter(group=>group.elements.length>0).map(group=><div key={group.label}>
    <h4>{group.label}</h4>
    <ul className="automatic-check-list">{group.elements.map((element,index)=><li key={index}>
     {styleComparisonSides[element.side]} · {styleComparisonRoleLabel(element.role)} · {styleComparisonElementLabel(element.label)}
     <p className="muted"><code>{element.selector}</code> · {formatViewportBounds(element.bounds)}</p>
     {element.reason&&<p>{styleComparisonReasons[element.reason]}</p>}
    </li>)}</ul>
   </div>)}
  </Disclosure>}
 </>;
}

function AutomaticStyleComparisonChecks({report,images}:{report:AutoStyleComparisonReport;images:ReportDetail['images']}) {
 const {coverage}=report;
 const changed=changedStyleMatches(report);
 return <section className="automatic-style-comparison" aria-label="화면 간 스타일 자동 비교">
  <p><strong>화면 간 스타일 자동 비교</strong>{' '}
   <Badge tone={coverage.changed?'warning':'neutral'}>차이 후보 {coverage.changed}쌍</Badge>
  </p>
  <p>비교한 요소 {coverage.matched}쌍 · 차이 없음 {coverage.matched-coverage.changed}쌍</p>
  <AutomaticStyleComparisonSources report={report} images={images}/>
  <p className="muted">각 화면의 첫 뷰포트에 보이는 요소를 비교했습니다. 아래 차이는 브라우저에서 측정한 CSS 값이며 디자인 기준 위반 여부는 별도 확인이 필요합니다.</p>
  {!coverage.matched&&<p>두 화면에서 비교할 수 있는 요소 쌍을 확인하지 못했습니다.</p>}
  {changed.map((match,index)=><Disclosure key={index} title={
   `${styleComparisonRoleLabel(match.role)} · ${styleComparisonElementLabel(match.reference.label)} ↔ ${styleComparisonElementLabel(match.comparison.label)} · 차이 ${match.differences.length}개`
  }>
   <p>{styleComparisonMatchLabels[match.method]}</p>
   <ul className="automatic-check-list">{(['reference','comparison'] as const).map(key=><li key={key}>
    <strong>{styleComparisonSides[key]} · {styleComparisonElementLabel(match[key].label)}</strong>
    <p className="muted"><code>{match[key].selector}</code> · {formatViewportBounds(match[key].bounds)}</p>
   </li>)}</ul>
   <ul className="automatic-check-list">{match.differences.map(difference=><li key={difference.property}>
    <strong>{difference.property}</strong>
    <p>화면 A <code>{difference.reference}</code> · 화면 B <code>{difference.comparison}</code></p>
   </li>)}</ul>
  </Disclosure>)}
  <AutomaticStyleComparisonScope report={report}/>
  <p className="muted">캡처에서 개인정보 보호를 위해 입력란이 가려질 수 있습니다.</p>
 </section>;
}

export function AutomaticChecks({report,isCollapsible=false,shouldExcludeAutomaticStyle=false}:{
 report:Pick<ReportDetail,'captures'|'images'|'requestedThemeReview'>;
 isCollapsible?:boolean;
 shouldExcludeAutomaticStyle?:boolean;
}) {
 const captures=(report.captures??[]).filter(({theme,deterministicChecks:checks})=>{
  if(theme||!shouldExcludeAutomaticStyle)return Boolean(theme||checks);
  return Boolean(checks?.contrast||checks?.alignment||checks?.spacing||checks?.styleComparison);
 });
 const missingThemes = report.requestedThemeReview==='both'
  ? (['light','dark'] as const).filter(theme=>!captures.some(capture=>capture.theme?.requested===theme))
  : [];
 if(!captures.length&&!missingThemes.length)return null;
 const content=<div className="automatic-checks">
   {captures.map((capture,index)=>{
    const {theme,deterministicChecks}=capture;
    const contrast=deterministicChecks?.contrast;
    const measuredExamples=contrast?.examples?.filter(example=>example.observedRatio!==undefined)??[];
    const alignment=deterministicChecks?.alignment;
    const spacing=deterministicChecks?.spacing;
    const image=report.images.find(item=>item.observationId===capture.observationId);
    return <article key={capture.observationId??index}>
     <div className="row-between wrap">
      <div className="automatic-check-title"><h3>{theme?themeLabels[theme.requested]:'관찰 화면'}</h3>{theme&&<Badge tone={theme.status==='verified'?'success':'warning'}>{themeStatusLabel(theme.status,theme.scope)}</Badge>}</div>
      {image&&<a className="text-link" href={image.url} target="_blank" rel="noreferrer">{theme?`${themeLabels[theme.requested]} 캡처 보기`:'캡처 보기'}</a>}
     </div>
     {theme?.reason&&<p className="muted">{theme.reason}</p>}
     {!!theme?.regions?.length&&<ul className="automatic-check-list">{theme.regions.map((region,regionIndex)=><li key={regionIndex}>
      배경 변화 영역 {regionIndex+1} ({region.role}) · 배경 {region.background} · {formatViewportBounds(region.bounds)}
     </li>)}</ul>}
     {contrast?<div>
      <p><strong>{contrast.source==='visible-text'?'텍스트 대비 보완 검사':'텍스트 대비'}</strong> <Badge tone={tone[contrast.status]}>{contrastLabels[contrast.status]}</Badge>{' '}
       통과 {contrast.passed} · 위반 {contrast.violations} · 추가 확인 {contrast.incomplete}</p>
      {contrast.hasReachedLimit&&<p className="muted">측정 한도에 도달해 일부 텍스트의 대비를 확인하지 못했습니다.</p>}
      {measuredExamples.length>0&&<ul className="automatic-check-list">{measuredExamples.map((example,exampleIndex)=><li key={exampleIndex}>
       {contrastLabels[example.status]}{example.observedRatio!==undefined&&` · 측정 ${formatMeasurement(example.observedRatio)}:1`}{example.expectedRatio!==undefined&&` · 기준 ${formatMeasurement(example.expectedRatio)}:1`}
       {example.target&&` · ${example.target.tag} · ${formatViewportBounds(example.target.bounds)}`}
       {example.foreground&&example.background&&` · 전경 ${example.foreground} · 배경 ${example.background}`}
      </li>)}</ul>}
     </div>:theme&&<p>텍스트 대비 검사 기록 없음</p>}
     {alignment&&<AlignmentChecks checks={alignment.checks}/>}
     {spacing&&<SpacingChecks spacing={spacing}/>}
     {deterministicChecks?.styleComparison&&<StyleComparisonChecks comparison={deterministicChecks.styleComparison} images={report.images}/>}
     {!shouldExcludeAutomaticStyle&&deterministicChecks?.autoStyleComparison&&<AutomaticStyleComparisonChecks report={deterministicChecks.autoStyleComparison} images={report.images}/>}
    </article>;
   })}
   {missingThemes.map(theme=><article key={theme}><h3>{themeLabels[theme]}</h3><p>캡처와 검사 결과를 확인하지 못했습니다.</p></article>)}
  </div>;
 return isCollapsible?<Disclosure title="자동 검사 결과">{content}</Disclosure>:<Card title={<h2>자동 검사 결과</h2>}>{content}</Card>;
}
