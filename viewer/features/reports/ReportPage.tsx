import {ReportWorkspaceLink} from '../workspaces/ReportWorkspaceLink';
import {navigateLink,unlinkedReportsHref} from '../../app/route';
import {Tooltip} from '../../shared/Tooltip';
import {EvaluationNotice} from './EvaluationNotice';
import {AutomaticChecks} from './AutomaticChecks';
import {WorkspaceStyleCandidates} from './WorkspaceStyleCandidates';
import {themeLabels,themeStatusLabel} from '../../../src/check-presentation';
import {Disclosure} from '../../shared/Disclosure';
import {FocusedReview} from '../focus/FocusedReview';
import {LayoutOverlay,hasMatchingLayoutSize} from './LayoutOverlay';
import {CaptureImageViewer,toViewerImage} from '../../shared/CaptureImageViewer';
import {ReviewRedirectLocations,reviewLocation} from '../../shared/ReviewRedirectLocations';
import {ImageGallery} from '../../shared/goodcase/components/composed/image-gallery';
import {LayoutLayerControls,useLayoutLayerPreview,useLayoutLayerSelection} from './LayoutLayerControls';
import {ledgerNotice} from '../../../src/ledger-presentation';
import {useEffect,useRef,useState,type ReactNode} from 'react';
import {EvaluatorChips} from '../../shared/EvaluatorChips';
import {reportName,findingImageIndex,verificationSummary,severityLabels,categoryLabels,evaluationLabel,readinessWaitLabel,reportPartialCauseLabels} from './presentation';
import {ScanEye,ImageOff,ShieldCheck,ArrowLeft,ArrowRight,Info} from 'lucide-react';
import {Button} from '../../shared/goodcase/components/basic/button';
import {Badge} from '../../shared/goodcase/components/basic/badge';
import {Alert} from '../../shared/goodcase/components/basic/alert';
import {Card} from '../../shared/goodcase/components/basic/card';
import {Tabs} from '../../shared/goodcase/components/overlays/tabs';
import type {ReportDetail,FindingView,SuggestionView,CaptureContext} from './types';
import {WorkspaceResults,findingResult,resultLabel,type ResultItem} from './WorkspaceResults';
export type LoadState<T>={status:'loading'|'error'|'ready';data?:T;error?:string};
const labels:Record<string,string>={completed:'분석 완료',partial:'일부 완료',failed:'실행 실패',cancelled:'취소',unknown:'상태 미기록',confirmed:'AI 확정', 'needs-verification':'검토 후보',dismissed:'제외',reproduced:'조건 재현',refuted:'조건 반증','not-reproduced':'이번 미재현',inconclusive:'판단 불가',selected:'선택',skipped:'미선택',rejected:'요청 거절',occlusion:'가림 / 잘림',money:'표시 금액',focus:'키보드 초점'};
const label=(value:string)=>labels[value]??value;
const date=(value:string)=>value&&Number.isFinite(Date.parse(value))?new Date(value).toLocaleString('ko-KR',{month:'short',day:'numeric',hour:'2-digit',minute:'2-digit'}):'시간 미기록';
const readinessLabels:Record<string,string>={loading:'로딩 중',ready:'본문 준비 확인',unknown:'준비 상태 불명',blocked:'본문 확인 차단'};
const count=(value:number|null)=>value===null?'미기록':String(value);
function Placeholder({title,children}:{title:string;children?:React.ReactNode}){return <div className="placeholder"><ScanEye size={32} aria-hidden/><h2>{title}</h2>{children&&<p>{children}</p>}</div>;}
function EmptyFindings({report}:{report:ReportDetail}) {
 if(report.evaluation?.status==='failed')return <Placeholder title="AI 평가 결과를 확인할 수 없습니다">평가가 완료되지 않아 지적 수를 집계할 수 없습니다. 화면에 문제가 없는 것으로 판단하지 마세요.</Placeholder>;
 if(report.evaluation?.status==='partial')return <Placeholder title="채택된 지적이 없습니다">AI 평가가 일부만 완료되어 추가 확인이 필요합니다.</Placeholder>;
 return <Placeholder title="기록된 지적이 없습니다">관찰한 범위의 결과이며 화면 전체가 정상임을 뜻하지 않습니다.</Placeholder>;
}
function Suggestions({report}:{report:ReportDetail}){return <div className="panel-stack"><p className="context-note">결함 수에 포함하지 않는 선택적 개선 제안입니다. 실제 동작이나 사용자 효과를 검증한 결과가 아닙니다.</p>{(report.suggestions??[]).length?(report.suggestions??[]).map(s=><Card key={s.id} title={s.title}><p>관찰: {s.observation}</p><p>이유: {s.rationale}</p><p>예상 영향 (추정): {s.possibleImpact}</p><p>불확실성: {s.uncertainty}</p><p>제안: {s.recommendation}</p><p>근거: {s.evidenceIds.join(', ')}</p></Card>):<Placeholder title="별도 개선 제안 없음">의미 있는 제안만 표시합니다.</Placeholder>}</div>;}
function MeasurementCards({measurements}:{measurements:ReportDetail['measurements']}) {
 return measurements.map((m,i)=><Card key={`${m.id}-${i}`} title={
  <div className="row-between wrap"><strong>{label(m.recipe)}</strong>
   <Badge tone={m.outcome==='reproduced'?'warning':m.outcome==='inconclusive'?'neutral':'success'}>{label(m.outcome)}</Badge>
  </div>
 }>
  <p>{m.condition}</p><p className="muted">{m.summary}</p>
  {Boolean(m.recordedValues?.length)&&<dl className="recorded-values">{m.recordedValues!.map(value=><div key={value.label}><dt>{value.label}</dt><dd>{value.value}</dd></div>)}</dl>}
  {m.measurementJson&&m.measurementJson!=='{}'?<Disclosure title="기록된 측정값과 근거"><pre className="measurement-json">{m.measurementJson}</pre></Disclosure>:<p className="muted">구조화된 측정값 미기록</p>}
  <p className="muted">측정 전: {m.beforeObservationId||'미기록'} / 측정 후: {m.afterObservationId||'미기록'}</p>
  <Disclosure title="연결된 증거 ID"><ul>{m.evidenceIds.map(id=><li key={id}>{id}</li>)}</ul></Disclosure>
  <small>연결 후보: {m.candidateId||'미기록'}</small>
  {m.targets.map((target,j)=><div className="measurement-target" key={j}>
   <strong>{target.targetRef}</strong><Badge>{target.hasMeasured===false?'미실행':label(target.outcome)}</Badge>
   <p>{target.summary}</p><small>연결 주장: {target.claimIds.join(', ')||'미기록'}</small>
  </div>)}
  {m.limitations.length>0&&<Disclosure title="측정 한계"><ul>{m.limitations.map((text,j)=><li key={j}>{text}</li>)}</ul></Disclosure>}
 </Card>);
}

function VerificationSelections({selections}:{selections:ReportDetail['selections']}) {
 return <>
  <h3 className="section-title">검사 선택 이력</h3>
  {selections.length?selections.map((s,i)=><div className="selection" key={i}>
   <div className="row-between wrap"><strong>{s.recipe?label(s.recipe):'검사 미지정'}</strong><Badge>{label(s.status)}</Badge></div>
   <p>{s.reason}</p><small className="muted">{s.origin==='automatic'?'자동 연결':s.origin==='model'?'모델 제안':'출처 미기록'} / {s.candidateId}</small>
  </div>):<p className="muted">선택 또는 건너뛴 이유가 기록되지 않았습니다.</p>}
 </>;
}

function Measurements({report}:{report:ReportDetail}) {
 return <div className="panel-stack">
  <p className="context-note">등록된 조건의 측정 결과입니다. 후보 전체의 사용성을 확정하지 않습니다.</p>
  {!report.hasVerificationData?<Alert title="이 보고서에는 실행 검증 기록이 없습니다">이전 형식이거나 검증을 켜지 않은 실행입니다.</Alert>
   :!report.measurements.length?<Alert title="실행된 검사가 없습니다">후보가 없거나 적용 가능한 요청이 선택되지 않았습니다.</Alert>
   :<MeasurementCards measurements={report.measurements}/>}
  <VerificationSelections selections={report.selections}/>
 </div>;
}

function FindingVerification({report,finding}:{report:ReportDetail;finding:FindingView}) {
 const measurements=report.measurements.filter(item=>item.candidateId===finding.id);
 const selections=report.selections.filter(item=>item.candidateId===finding.id);
 const outcomes=[...new Set(measurements.map(item=>label(item.outcome)))];
 const status=outcomes.length?outcomes.join(', '):report.hasVerificationData?'미실행':'기록 없음';
 return <Disclosure title={`실제 검사 · ${status}`}>
  <div className="panel-stack">
   {measurements.length?<><p className="context-note">등록된 조건의 측정 결과입니다. 후보 전체의 사용성을 확정하지 않습니다.</p>
    <MeasurementCards measurements={measurements}/></>:<p className="muted">{report.hasVerificationData?'이 지적에 연결된 실제 검사 없음':'실제 검증 기록 없음'}</p>}
   {selections.length>0&&<VerificationSelections selections={selections}/>}
  </div>
 </Disclosure>;
}
export function CaptureConditions({capture}:{capture:CaptureContext|undefined}) {
 if(capture?.image)return <dl className="capture-conditions">
  <dt>입력 이미지</dt><dd>{capture.image.fileName}</dd>
  <dt>이미지 크기</dt><dd>{capture.image.width} × {capture.image.height} 이미지 px</dd>
  <dt>가져온 시각</dt><dd>{capture.image.importedAt?date(capture.image.importedAt):'미기록'} (촬영 시각 아님)</dd>
  <dt>관찰 조건</dt><dd>원본 URL·CSS 뷰포트·스크롤·페이지 안정성 미확인</dd>
  <dt>자동 마스킹</dt><dd>미적용</dd>
 </dl>;
 const {observedUrl,capturedAt,viewport,scrollOffset,isStable}=capture??{};
 return <dl className="capture-conditions">
  {capture?.state&&<><dt>화면 상태</dt><dd>{capture.state.label} ({readinessLabels[capture.state.readiness]})<p>{capture.state.reason}</p></dd></>}
  {capture?.theme&&<><dt>요청 테마</dt><dd>{themeLabels[capture.theme.requested]} ({themeStatusLabel(capture.theme.status,capture.theme.scope)})</dd></>}
  <dt>관찰 URL</dt><dd className="capture-url">{observedUrl??'미기록'}</dd>
  <dt>캡처 시각</dt><dd>{capturedAt?<time dateTime={capturedAt} title={capturedAt}>{date(capturedAt)}</time>:'미기록'}</dd>
  <dt>뷰포트</dt><dd>{viewport?<>{viewport.width} × {viewport.height} CSS px{viewport.deviceScaleFactor!==undefined&&` · 배율 ${viewport.deviceScaleFactor}×`}</>:'미기록'}</dd>
  <dt>스크롤 위치</dt><dd>{scrollOffset?`x ${scrollOffset.x}, y ${scrollOffset.y} CSS px`:'미기록'}</dd>
  <dt>캡처 안정성</dt><dd>{isStable===undefined?'미기록':isStable?'안정성 확인':'캡처 중 변화 감지'}</dd>
 </dl>;
}

function Evidence({report,imageIndex,onImageIndex,preferredFindingId}:{report:ReportDetail;imageIndex:number;onImageIndex:(index:number)=>void;preferredFindingId?:string}) {
 const [isActualSize,setIsActualSize]=useState(false);
 const [isLayoutVisible,setIsLayoutVisible]=useState(false);
 const activeIndex=Math.max(0,Math.min(imageIndex,report.images.length-1));
 const current=report.images[activeIndex];
 const storedLayout=current?.layout;
 const focus=preferredFindingId?storedLayout?.focusAreas.find(area=>area.findingId===preferredFindingId):storedLayout?.focusAreas[0];
 const selection=useLayoutLayerSelection(current,focus);
 const preview=useLayoutLayerPreview(current?.id,selection.visibleLayers);
 const layout=selection.layers.length?storedLayout:undefined;
 const captures=report.captures??[];
 const hasNamedCaptures=Boolean(report.stateDiscovery||captures.some(item=>item.theme));
 const capture=current?.observationId?captures.find(item=>item.observationId===current.observationId):captures.length===1||!current?captures[0]:undefined;
 return <section className="evidence-pane" aria-label="관찰 화면">
  <LayoutLayerControls key={current?.id} isLayoutVisible={isLayoutVisible} onLayoutVisibleChange={setIsLayoutVisible} selection={selection} preview={preview}
   heading={<h2>관찰 화면 <span className="muted">{current?activeIndex+1:0} / {report.images.length}</span></h2>}
   zoomControls={current&&<><div className="image-zoom" aria-label="캡처 확대"><button type="button" aria-pressed={!isActualSize} onClick={()=>setIsActualSize(false)}>맞춤</button><button type="button" aria-pressed={isActualSize} onClick={()=>setIsActualSize(true)}>100%</button></div><CaptureImageViewer images={report.images} initialIndex={activeIndex}/></>}/>
  {current?<><FocusedReview key={current.id} reportId={report.id} image={current} isActualSize={isActualSize}
   renderOverlay={isLayoutVisible&&layout?size=>hasMatchingLayoutSize(layout,size)?<LayoutOverlay layers={selection.visibleLayers} previewLayerId={preview.previewLayerId}/>:null:undefined}/>
   <div className="image-meta"><strong>{current.observationId||'관찰 ID 미기록'}</strong><span className="muted">{current.label}</span>{isLayoutVisible&&layout?.isEstimated&&<span className="muted">이미지에서 추정한 영역</span>}</div>
   {report.images.length>1&&<div className={`image-picker${hasNamedCaptures?' state-image-picker':''}`} aria-label="캡처 선택">{report.images.map((image,i)=>{const context=captures.find(item=>item.observationId===image.observationId);return <button type="button" key={image.id} className={i===activeIndex?'is-selected':''} aria-pressed={i===activeIndex} onClick={()=>onImageIndex(i)}>{i+1}{context?.state||context?.theme?<span> {image.label}</span>:<span className="sr-only">번 캡처 {image.observationId}</span>}</button>;})}</div>}
  </>:<div className="missing-image"><ImageOff size={32} aria-hidden/><p>캡처가 기록되지 않았습니다</p></div>}
  <Disclosure title="관찰 조건"><CaptureConditions capture={capture}/><div className="evidence-caption"><ShieldCheck size={16} aria-hidden/><span>저장된 캡처입니다. 검사 대상 사이트에 새로 접속하지 않습니다.</span></div></Disclosure>
 </section>;
}
function FocusAnswer({report}:{report:ReportDetail}) {
 const focus=report.focusedReview;if(!focus)return null;
 const answerLabels:Record<string,string>={confirmed:'문제 확인',suggestion:'개선 제안','not-supported':'현재 캡처로 지적을 뒷받침하기 어려움','needs-verification':'추가 확인 필요'};
 return <section className="focus-report-answer" aria-label="집중 재검토 답변"><h2>선택 영역 집중 재검토</h2><p><strong>질문:</strong> {focus.comment}</p><p className="muted">원본 이미지 영역: X {focus.region.x}, Y {focus.region.y}, {focus.region.width} × {focus.region.height} px</p>{focus.answer?<><h3>{answerLabels[focus.answer.status]}</h3><p className="focus-answer">{focus.answer.answer}</p></>:<p>완료된 답변이 없습니다. 실행 상태와 한계를 확인하세요.</p>}<a href={`/?report=${encodeURIComponent(focus.source.reportId)}`}>원본 보고서와 질문 이력으로 돌아가기</a><p className="muted">저장된 캡처의 재검토입니다. 실제 클릭·스크롤 동작을 검증하지 않습니다.</p></section>;
}
const modalMethodLabels:Record<string,string>={'close-button':'닫기 버튼',escape:'Escape 키',backdrop:'모달 바깥 배경',preference:'테스트 선택',continue:'진입 버튼'};
function ModalExplorationHistory({report,onObservation}:{report:ReportDetail;onObservation:(observationId:string)=>void}) {
 const exploration=report.stateDiscovery?.modalExploration;
 if(!exploration||exploration.status==='not-needed')return null;
 return <Card title={exploration.status==='gave-up'?'선택 화면 탐색 중단':'선택 화면 탐색 결과'}><p>{exploration.reason}</p><p className="muted">시도 {exploration.attempts}회, 동작 {exploration.actionCount}회. 선택은 이번 검토의 테스트 조건입니다.</p>{exploration.history.length>0&&<ol>{exploration.history.map((action,index)=><li key={`${action.actionId}-${index}`}><strong>{action.attempt}차: {modalMethodLabels[action.method]??action.method}{action.buttonLabel&&` (${action.buttonLabel})`}</strong><p>{action.hasRedirected?'다른 주소 이동 감지, 원래 URL로 복구 시도':action.outcome==='rejected'?'허용 범위를 벗어나 실행 거절':action.outcome==='error'?'동작 실패':action.hasModalDismissed===true?'모달 닫힘 확인':action.hasModalDismissed===false?'모달 유지':'닫힘 여부 미확인'}</p><div>{report.images.some(image=>image.observationId===action.beforeObservationId)&&<Button variant="secondary" onClick={()=>onObservation(action.beforeObservationId)}>동작 전 화면</Button>} {action.afterObservationId&&report.images.some(image=>image.observationId===action.afterObservationId)&&<Button variant="secondary" onClick={()=>onObservation(action.afterObservationId!)}>동작 후 화면</Button>}{!action.afterObservationId&&<small className="muted">후속 화면 미기록</small>}</div></li>)}</ol>}<p className="muted">탐색 결과와 본문 데이터 준비 여부는 별도입니다. 상태별 캡처와 수집 한계를 함께 확인하세요.</p></Card>;
}
function ReportLimits({report}:{report:ReportDetail}) {
 return <div className="panel-stack">
  <Alert title="분석 완료와 실제 검증은 다릅니다">AI 판단, 실제 검사 결과와 확인하지 못한 범위를 구분해서 읽어주세요.</Alert>
  <Card title="요청한 검사 범위"><p>{report.coverage.canFinish===null?'필수 범위 기록 없음':report.coverage.canFinish?'실행에 필요한 필수 범위가 충족되었습니다. 화면 전체의 품질 통과를 의미하지 않습니다.':'실행에 필요한 필수 범위가 충족되지 않았습니다.'}</p>{report.coverage.unmet.length>0&&<ul>{report.coverage.unmet.map((text,i)=><li key={i}>{text}</li>)}</ul>}</Card>
  <ObservationLedger report={report}/><Card title="수집과 평가 한계">{report.limitations.length?<ul>{[...new Set(report.limitations)].map((text,i)=><li key={i}>{text}</li>)}</ul>:<p>별도 한계 설명 미기록</p>}</Card>
 </div>;
}

function FindingDetail({report,finding,imageIndex,onImageIndex,workspaceLabel}:{report:ReportDetail;finding:FindingView;imageIndex:number;onImageIndex:(index:number)=>void;workspaceLabel?:string}) {
 const linkedImageIndex=findingImageIndex(report,finding);
 const measurements=report.measurements.filter(item=>item.candidateId===finding.id);
 return <article className="finding-detail-card">
  <div className="finding-top"><Badge tone={finding.disposition==='confirmed'?'warning':'neutral'}>{workspaceLabel??(finding.source==='automatic-rule'?'자동 검사 후보':label(finding.disposition))}</Badge><span>{severityLabels[finding.severity]??finding.severity} · {categoryLabels[finding.category]??finding.category}</span></div>
  <h2 tabIndex={workspaceLabel?-1:undefined}>{finding.title}</h2>
  {linkedImageIndex<0?<p className="context-note">이 지적에 연결된 캡처 기록이 없습니다. {workspaceLabel?'관찰 화면은 보고서에 저장된 캡처입니다.':'왼쪽은 보고서의 저장된 캡처입니다.'}</p>:linkedImageIndex!==imageIndex?<Button variant="secondary" onClick={()=>onImageIndex(linkedImageIndex)}>이 지적의 캡처 보기</Button>:null}
  <h3>관찰한 근거</h3>{finding.facts.length?<ul>{finding.facts.map((fact,i)=><li key={i}>{fact}</li>)}</ul>:<p className="muted">관찰 근거 미기록</p>}
  {workspaceLabel&&<FindingVerification key={finding.id} report={report} finding={finding}/>}
  {finding.impact&&<><h3>사용자에게 미치는 영향</h3><p>{finding.impact}</p></>}
  <section className="finding-proposal"><h3>{workspaceLabel?'수정 제안':'개선 제안'}</h3><p>{finding.recommendation||'개선 제안 미기록'}</p></section>
  {!workspaceLabel&&<div className="finding-verification"><Info size={17} aria-hidden/><span>{finding.source==='automatic-rule'?'자동 검사에서 측정한 결과입니다.':!report.hasVerificationData?'실제 검증 기록 없음':measurements.length?`연결된 실제 검사 ${measurements.length}건 · ${[...new Set(measurements.map(item=>label(item.outcome)))].join(', ')}`:'이 지적에 연결된 실제 검사 없음'}</span></div>}
  <Disclosure title="기대 근거와 증거 ID">{finding.expectations.length?<ul>{finding.expectations.map((text,i)=><li key={i}>{text}</li>)}</ul>:<p>기대 근거 미기록</p>}<p>후보 ID: {finding.id}</p><p>증거 ID: {finding.evidenceIds.join(', ')||'미기록'}</p></Disclosure>
 </article>;
}

function WorkspaceSuggestionDetail({report,suggestion,imageIndex,onImageIndex}:{
 report:ReportDetail;suggestion:SuggestionView;imageIndex:number;onImageIndex:(index:number)=>void;
}) {
 const linkedImageIndex=findingImageIndex(report,suggestion);
 return <article className="finding-detail-card">
  <div className="finding-top"><Badge>개선 제안</Badge></div>
  <h2 tabIndex={-1}>{suggestion.title}</h2>
  {linkedImageIndex<0?<p className="context-note">이 제안에 연결된 캡처 기록이 없습니다.</p>
   :linkedImageIndex!==imageIndex?<Button variant="secondary" onClick={()=>onImageIndex(linkedImageIndex)}>이 제안의 캡처 보기</Button>:null}
  <h3>관찰한 근거</h3><p>{suggestion.observation||'관찰 근거 미기록'}</p>
  {suggestion.rationale&&<><h3>제안 이유</h3><p>{suggestion.rationale}</p></>}
  {suggestion.possibleImpact&&<><h3>예상 영향 (추정)</h3><p>{suggestion.possibleImpact}</p></>}
  {suggestion.uncertainty&&<><h3>불확실성</h3><p>{suggestion.uncertainty}</p></>}
  {suggestion.recommendation&&<section className="finding-proposal"><h3>제안</h3><p>{suggestion.recommendation}</p></section>}
  <Disclosure title="연결된 증거 ID"><p>{suggestion.evidenceIds.join(', ')||'미기록'}</p></Disclosure>
 </article>;
}

function ReportSummaryContent({report,onFinding,onTab,hasSharedCapture=false}:{report:ReportDetail;onFinding:(finding:FindingView)=>void;onTab:(tab:string)=>void;hasSharedCapture?:boolean}) {
 const confirmedCount=report.findings.filter(f=>f.disposition==='confirmed').length;
 const candidateCount=report.findings.filter(f=>f.disposition==='needs-verification'&&f.source!=='automatic-rule').length;
 const dismissedCount=report.findings.filter(f=>f.disposition==='dismissed').length;
 return <>
  <div className="summary-metrics"><div><span>AI 지적</span><strong className={report.evaluation?.status==='failed'?'word':undefined}>{report.evaluation?.status==='failed'?'집계 불가':count(report.initialCount)}{report.evaluation?.status!=='failed'&&report.initialCount!==null&&<small>건</small>}</strong>{report.evaluation?.status==='failed'?<p>AI 평가를 완료하지 못했습니다</p>:<p>{report.evaluation?.status==='partial'&&'채택된 결과 · '}AI 확정 {confirmedCount} · 검토 후보 {candidateCount}{dismissedCount>0&&` · 제외 ${dismissedCount}`}</p>}{Boolean(report.automaticCandidateCount)&&<p>자동 검사 후보 {report.automaticCandidateCount}건</p>}</div><div><span>실제 검증</span><strong className="word">{verificationSummary(report)}</strong><Button variant="secondary" onClick={()=>onTab('measurements')}>검사 기록 보기 <ArrowRight size={15} aria-hidden/></Button></div><div><span>저장된 캡처</span><strong>{report.images.length}<small>장</small></strong><p>{report.images.length?'상세에서 화면과 근거 확인':'캡처 미기록'}</p></div></div>
  <LedgerNotice report={report}/><FocusAnswer report={report}/>
  <div className="report-summary-grid">{(!hasSharedCapture||report.evaluation?.status!=='failed'||report.findings.length>0)&&<section><div className="row-between wrap"><h2>확인할 지적</h2>{report.suggestions?.length?<Button variant="secondary" onClick={()=>onTab('suggestions')}>{hasSharedCapture?'개선 제안':'별도 개선 제안'} {report.suggestions.length}건 <ArrowRight size={16} aria-hidden/></Button>:null}</div>
   {report.findings.length?<div className="summary-findings">{report.findings.map((finding,i)=><button type="button" className="summary-finding" key={`${finding.id}-${i}`} onClick={()=>onFinding(finding)}><div className="finding-top"><Badge tone={finding.disposition==='confirmed'?'warning':'neutral'}>{finding.source==='automatic-rule'?'자동 검사 후보':label(finding.disposition)}</Badge><span>{severityLabels[finding.severity]??finding.severity} · {categoryLabels[finding.category]??finding.category}</span></div><h3>{i+1}. {finding.title}</h3><p>{finding.recommendation||finding.impact||'개선 제안 미기록'}</p><span className="finding-open">화면과 근거 보기 <ArrowRight size={17} aria-hidden/></span></button>)}</div>:<EmptyFindings report={report}/>}
  </section>}<aside className="summary-evidence">{!hasSharedCapture&&<><h2>관찰 화면</h2>{report.images[0]?<ImageGallery className="summary-evidence-gallery" label="관찰 캡처 갤러리" images={report.images.map(toViewerImage)}/>:<p className="muted">캡처 미기록</p>}</>}<h3>확인 범위와 한계</h3><p>{!report.hasVerificationData?'실제 검증 기록이 없습니다. 캡처를 기준으로 한 AI 판단과 동작 검증은 구분해야 합니다.':report.measurements.length?'실제 검사는 등록된 조건의 측정 결과입니다. 화면 전체의 동작을 보장하지 않습니다.':'검증 기록은 있으나 실행된 검사는 없습니다.'}</p>{report.coverage.canFinish===false&&<p className="scope-warning">요청한 필수 범위 미충족</p>}{report.limitations.length>0&&<p>{[...new Set(report.limitations)].length}개의 수집·평가 한계가 기록되어 있습니다.</p>}<Button variant="secondary" onClick={()=>onTab('limits')}>범위와 한계 보기 <ArrowRight size={16} aria-hidden/></Button></aside></div>
 </>;
}

interface WorkspaceReportLayout {
 imageIndex:number;
 onImageIndex:(index:number)=>boolean;
 renderEvidence:(preferredFindingId:string|undefined)=>ReactNode;
 goal:string;
 result:ReactNode;
 composer?:ReactNode;
}

const workspaceReportTabs=[
 {value:'summary',label:'요약'},
 {value:'compose',label:'검토',shouldKeepMounted:true},
 {value:'results',label:'결과'},
 {value:'limits',label:'범위와 한계'},
] as const;

export function WorkspaceReportTabs({tab,onTab,panels}:{
 tab:string;
 onTab?:(tab:string)=>void;
 panels:Partial<Record<(typeof workspaceReportTabs)[number]['value'],ReactNode>>;
}){
 return <section className="workspace-report-tabs review-pane" aria-label="검사 해석">
  <Tabs label="보고서 보기" value={tab} onValueChange={onTab} items={workspaceReportTabs.map(item=>({
   ...item,content:panels[item.value],isDisabled:!panels[item.value],
  }))}/>
 </section>;
}

function ReportRunInformation({report,workspaceGoal}:{report:ReportDetail;workspaceGoal?:string}) {
 return <Disclosure title="검토 조건과 실행 정보">
  <EvaluatorChips provider={report.provider} model={report.actualModel==='미확인'?report.requestedModel:report.actualModel}/>
  <dl className="capture-conditions">
   {workspaceGoal&&workspaceGoal!==report.purpose&&<><dt>작업 목적</dt><dd>{workspaceGoal}</dd></>}
   <dt>검토 목적</dt><dd>{report.purpose||'미기록'}</dd>
   <dt>요청 URL</dt><dd>{report.requestedUrl??'미기록'}</dd>
   <dt>관찰된 화면 제목</dt><dd>{report.screenTitle||report.pageTitle||'미기록'}</dd>
   <dt>요청 모델</dt><dd>{report.requestedModel}</dd>
   <dt>실제 모델</dt><dd>{report.actualModel}</dd>
   <dt>실행 ID</dt><dd>{report.runId}</dd>
  </dl>
 </Disclosure>;
}

export function ReportContent({report,tab,onTab,metadataEditor,workspace}:{report:ReportDetail;tab:string;onTab:(tab:string)=>void;metadataEditor?:ReactNode;workspace?:WorkspaceReportLayout}) {
 const [selectedResult,setSelectedResult]=useState<{tab:string;result:ResultItem}>();
 const [selectedFindingId,setSelectedFindingId]=useState(report.findings[0]?.id??'');
 const selectedFinding=report.findings.find(finding=>finding.id===selectedFindingId)??report.findings[0];
 const [localImageIndex,setLocalImageIndex]=useState(Math.max(0,findingImageIndex(report,selectedFinding)));
 const imageIndex=workspace?.imageIndex??localImageIndex;
 const isSummary=tab==='summary';
 const workspaceTab=tab==='suggestions'?'results':tab==='measurements'?'limits':tab;
 const isSuggestionLink=tab==='suggestions';
 const activeResult=selectedResult?.tab===tab?selectedResult.result:undefined;
 const hasPartialCause=reportPartialCauseLabels(report).length>0;
 const {stateDiscovery,stateDiscoveryWait}=report;
 const isDiscoveryPartial=stateDiscovery?.status==='partial';
 const discoveryTitle=stateDiscoveryWait?readinessWaitLabel:isDiscoveryPartial?'일부 화면 상태만 확인했습니다':'화면 상태 수집 완료';
 let discoveryReason=stateDiscovery?.reason;
 if(stateDiscoveryWait){
  const {maxWaitMs}=stateDiscoveryWait;
  discoveryReason=maxWaitMs===undefined?'대기 한도 안에 화면 준비 완료를 확인하지 못했습니다.':`최대 ${maxWaitMs/1000}초 동안 화면 준비 완료를 확인하지 못했습니다.`;
 }else if(isDiscoveryPartial){
  discoveryReason+=' 자동으로 확인하지 못한 상태는 이미지를 첨부해 보완할 수 있습니다.';
 }
 function changeImage(index:number){
  if(workspace)return workspace.onImageIndex(index);
  setLocalImageIndex(index);
  return true;
 }
 function selectWorkspaceResult(result:ResultItem,resultTab=tab){
  const index=findingImageIndex(report,result.item);
  if(index>=0&&!changeImage(index))return false;
  setSelectedResult({tab:resultTab,result});
  return true;
 }
 function selectFinding(finding:FindingView){
  if(workspace){
   if(selectWorkspaceResult(findingResult(finding,report.findings.indexOf(finding)),'results'))onTab('results');
   return;
  }
  const index=findingImageIndex(report,finding);
  if(index>=0&&!changeImage(index))return;
  setSelectedFindingId(finding.id);
  if(isSummary)onTab('findings');
 }
 function goToWorkspaceTab(nextTab:string){
  setSelectedResult(undefined);
  onTab(nextTab);
 }
 const summary=<ReportSummaryContent report={report} onFinding={selectFinding} onTab={workspace?goToWorkspaceTab:onTab} hasSharedCapture={Boolean(workspace)}/>;
 const findings=<div className="findings-detail">{report.findings.length>1&&<div className="finding-picker" aria-label="지적 선택">{report.findings.map((finding,i)=><Tooltip key={`${finding.id}-${i}`} label={`${i+1}. ${finding.title}`}><button type="button" aria-pressed={finding.id===selectedFinding?.id} onClick={()=>selectFinding(finding)}><span className="finding-picker-title">{i+1}. {finding.title}</span></button></Tooltip>)}</div>}{selectedFinding?<FindingDetail report={report} finding={selectedFinding} imageIndex={imageIndex} onImageIndex={changeImage}/>:<EmptyFindings report={report}/>}</div>;
 const detailTabs=[
  {value:'findings',label:'지적',badge:report.evaluation?.status==='failed'?undefined:report.findings.length,content:findings},
  {value:'suggestions',label:'별도 개선 제안',badge:report.suggestions?.length??0,content:<Suggestions report={report}/>},
  {value:'measurements',label:'실제 검사',content:<Measurements report={report}/>},
  {value:'limits',label:'범위와 한계',content:<ReportLimits report={report}/>},
 ];
 const preferredFindingId=workspace
  ?workspaceTab==='results'&&activeResult?.kind==='finding'?activeResult.item.id:undefined
  :tab==='findings'?selectedFinding?.id:undefined;
 const loginRedirect=report.taskContext?.loginRedirect;
 const redirectedCapture=loginRedirect&&report.captures?.find(capture=>
  capture.observedUrl&&report.images.some(image=>image.observationId===capture.observationId));
 const hasCapturedLogin=Boolean(redirectedCapture&&reviewLocation(redirectedCapture.observedUrl)===loginRedirect?.loginUrl);
 const notices=<>
  {loginRedirect&&<Alert tone="neutral" title={hasCapturedLogin?'로그인 화면을 검토했습니다':'로그인 화면 이동 후 검토'}>
   <ReviewRedirectLocations requestedUrl={report.requestedUrl} observedUrl={redirectedCapture?.observedUrl} observedLabel="캡처한 주소"/>
  </Alert>}
  <EvaluationNotice report={report}/>
  {stateDiscovery&&<Alert tone={isDiscoveryPartial?'warning':'neutral'} title={discoveryTitle}>{discoveryReason}</Alert>}
 </>;
 const modalHistory=<ModalExplorationHistory report={report} onObservation={observationId=>{
  const index=report.images.findIndex(image=>image.observationId===observationId);
  if(index>=0&&changeImage(index)){
   if(workspace)goToWorkspaceTab('results');
   else onTab('findings');
  }
 }}/>;
 if(workspace)return <>
   <WorkspaceReportTabs tab={workspaceTab} onTab={goToWorkspaceTab} panels={{
    summary:<>
     <section className="workspace-panel workspace-current-result">{workspace.result}{notices}<WorkspaceStyleCandidates report={report}/></section>
     <div className="workspace-report-tab-content">{summary}<AutomaticChecks report={report} isCollapsible shouldExcludeAutomaticStyle/></div>
    </>,
    compose:workspace.composer,
    results:<div className="workspace-report-tab-content">
     <LedgerNotice report={report}/><FocusAnswer report={report}/>
     <WorkspaceResults key={isSuggestionLink?'suggestions':'results'} findings={report.findings} suggestions={report.suggestions??[]}
      selected={activeResult} onSelect={selectWorkspaceResult} onBack={()=>setSelectedResult(undefined)}
      isSuggestionLink={isSuggestionLink} hasFailedEvaluation={report.evaluation?.status==='failed'}
      emptyState={<EmptyFindings report={report}/>}
      renderDetail={result=>result.kind==='finding'
       ?<FindingDetail key={result.key} report={report} finding={result.item} imageIndex={imageIndex} onImageIndex={changeImage} workspaceLabel={resultLabel(result)}/>
       :<WorkspaceSuggestionDetail key={result.key} report={report} suggestion={result.item} imageIndex={imageIndex} onImageIndex={changeImage}/>}/>
    </div>,
    limits:<div className="workspace-report-tab-content">
      <Disclosure title="회차 검사 이력" key={tab} shouldKeepMounted isInitiallyOpen={tab==='measurements'}>
       <Measurements report={report}/>
      </Disclosure>
      <ReportLimits report={report}/>
      <AutomaticChecks report={report} isCollapsible/>
      {modalHistory}<ReportRunInformation report={report} workspaceGoal={workspace.goal}/>
    </div>,
   }}/>
  <div className="workspace-report-evidence">{workspace.renderEvidence(preferredFindingId)}</div>
 </>;
 return <>
   <header className="report-heading">
    {report.taskContext&&<p className="report-context">{report.taskContext.taskTitle} <span>/</span> {report.taskContext.revisionNumber}차 검토</p>}
    <div className="row-between wrap"><h1>{reportName(report)}</h1><Badge tone={report.evaluation?.status==='failed'||report.status==='failed'?'danger':report.status==='partial'?'warning':'neutral'}>{hasPartialCause?label(report.status):evaluationLabel(report)??label(report.status)}</Badge></div>
    <p className="report-subline">{date(report.startedAt)} · 캡처 {report.images.length}장{report.taskContext&&` · 실행 ${report.taskContext.attemptNumber}`}</p>
    <div className="report-view-tabs" aria-label="보고서 보기"><button type="button" aria-pressed={isSummary} onClick={()=>onTab('summary')}>요약</button><button type="button" aria-pressed={!isSummary} onClick={()=>onTab('findings')}>상세</button></div>
   </header>
  {notices}
  <ReportWorkspaceLink key={report.id} reportId={report.id}/>
  {modalHistory}
   <AutomaticChecks report={report}/>
   {isSummary?summary:<>
    <LedgerNotice report={report}/><FocusAnswer report={report}/>
    <div className="report-detail-grid"><Evidence report={report} imageIndex={imageIndex} onImageIndex={changeImage} preferredFindingId={preferredFindingId}/>
     <section className="review-pane" aria-label="검사 해석"><Tabs label="상세 보고서 내용" value={tab} onValueChange={onTab} items={detailTabs}/></section>
    </div>
   </>}
  <div className="report-secondary-information">
   <ReportRunInformation report={report}/>
   {metadataEditor&&<Disclosure title="보고서 이름과 분류 편집">{metadataEditor}</Disclosure>}
  </div>
 </>;
}
export function ReportPage({detail,tab,onTab,onBack,onRetryDetail,metadataEditor}:{
 detail:LoadState<ReportDetail>;
 tab:string;
 onTab:(tab:string)=>void;
 onBack?:(href:string)=>void;
 onRetryDetail:()=>void;
 metadataEditor?:ReactNode;
}){
 const mainRef=useRef<HTMLElement>(null);
 useEffect(()=>{mainRef.current?.focus({preventScroll:true});},[]);
 return <main className="report-workspace" id="report-main" ref={mainRef} tabIndex={-1}>
  <a className="report-back" href={unlinkedReportsHref} onClick={onBack?event=>navigateLink(event,onBack):undefined}>
   <ArrowLeft size={17} aria-hidden/>미연결 보고서
  </a>
  {detail.status==='loading'?<div className="detail-loading" role="status">
   <div className="skeleton-line"/><div className="skeleton-line short"/><div className="skeleton-block"/><p>보고서를 불러오는 중입니다…</p>
  </div>:detail.status==='error'?<div className="detail-error">
   <Alert tone="danger" title="보고서를 열지 못했습니다" action={<Button variant="secondary" onClick={onRetryDetail}>다시 시도</Button>}>{detail.error}</Alert>
  </div>:detail.data?<ReportContent key={detail.data.id} report={detail.data} tab={tab} onTab={onTab} metadataEditor={metadataEditor}/>:null}
 </main>;
}

function ObservationLedger({report}:{report:ReportDetail}){const ledger=report.observationLedger;if(!ledger)return <Card title="관찰 처리 기록"><p>이 보고서에는 관찰별 처리 기록이 없습니다.</p></Card>;return <Card title="관찰 처리 기록 (실험)"><LedgerNotice report={report}/><p>수집 상태: {ledger.collectionStatus}</p><p>처리 기록 {ledger.accountedCount}/{ledger.notes.length} · 판정 완료 {ledger.adjudicatedCount}/{ledger.notes.length} · 등록 거절 {ledger.rejectedCount}</p><p className="muted">등록된 관찰의 추적 기록이며 모든 문제의 발견이나 판정 정확도를 보장하지 않습니다.</p><Disclosure title="관찰별 근거와 처리 이유">{ledger.notes.map(note=><div key={note.id}><h4>{note.id}: {note.fact}</h4><p>{note.location}</p><p>{note.status}: {note.reason}</p><ul>{note.references.map((ref,i)=><li key={i}>{ref}</li>)}{note.errors.map((error,i)=><li key={'error-'+i}>{error}</li>)}</ul></div>)}{ledger.overflow.length>0&&<><h4>본문 표시 한도 외 보존 결과</h4><ul>{ledger.overflow.map(item=><li key={item.kind+item.id}>{item.id} · {item.kind} · {item.title}</li>)}</ul></>}</Disclosure></Card>;}

function LedgerNotice({report}:{report:ReportDetail}) {
 const ledger=report.observationLedger;
 if(!ledger)return null;
 const notice=ledgerNotice({...ledger,hasUnreviewed:ledger.adjudicatedCount<ledger.notes.length||ledger.notes.some(note=>note.status==='unreviewed')});
 return notice?<Alert title={notice.title}>관찰 {ledger.notes.length}건 중 {ledger.adjudicatedCount}건을 판정했습니다. {notice.description}</Alert>:null;
}
