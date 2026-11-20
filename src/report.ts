import {ledgerNotice} from './ledger-presentation.js';
import {alignmentLabels,alignmentReasonLabel,automaticStyleCoverageGroups,repeatedStyleDifferences,contrastLabels,formatMeasurement,formatViewportBounds,spacingCheckLabel,spacingCheckMeasurement,styleComparisonElementLabel,styleComparisonLabels,styleComparisonMatchLabels,styleComparisonReasons,styleComparisonRoleLabel,styleComparisonSides,themeLabels,themeStatusLabel} from './check-presentation.js';
import {recordedAutomaticStyles,type AutoStyleComparisonReport} from './automatic-style-comparison.js';
import type { ReviewFinding, ReviewResult } from './types.js';

function escapeText(value: string): string {
  return value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/[\\`*_{}\[\]()#+!|]/g, '\\$&');
}
function safePath(value: string): string | null {
  if (!value || value.startsWith('/') || value.includes('\\') || value.split('/').includes('..') || /^[a-z][a-z0-9+.-]*:/i.test(value)) return null;
  return value.split('/').map(part => encodeURIComponent(part)).join('/');
}
const statusNames = {completed: '완료', partial: '일부 완료', failed: '실패', cancelled: '취소'};
const severityNames = {critical: '심각', major: '주요', minor: '경미'};

export function renderReport(result: ReviewResult): string {
  const lines: string[] = [
    '# AI 사용성 검사 보고서', '',
    `- 실행: ${escapeText(result.runId)}`,
    `- 상태: **${statusNames[result.status]}**`,
    `- 대상: ${escapeText(result.imageSource?`이미지: ${result.imageSource.fileName}`:result.targetUrl??'입력 미확인')}`,
    `- 시작: ${escapeText(result.startedAt)}`,
    `- 종료: ${escapeText(result.endedAt)}`,
    `- 관찰: ${result.observations.length}개, 수행 동작: ${result.actions.length}개`,
    `- 보고 지적: ${result.findings.length}개, 추가 검증 후보: ${result.verificationCandidates.length}개`,
    `- 공급자: ${result.evaluation.provider ?? result.provider ?? '미확인'}`,
    `- 실제 모델: ${result.evaluation.model ? escapeText(result.evaluation.model) : '미확인 또는 규칙 전용'}`,
    '',
    '확정 지적은 이 도구의 보고 기준을 충족한 항목이며 실제 사용자 연구의 검증을 뜻하지 않습니다.', '',
  ];
  if(result.focusedReview){const focus=result.focusedReview;lines.push('## 선택 영역 집중 재검토','',`- 원본 실행: ${escapeText(focus.source.runId)}`,`- 원본 증거: ${escapeText(focus.source.evidenceId)}`,`- 원본 SHA256: ${focus.source.sha256}`,`- 선택 영역 (원본 픽셀): ${JSON.stringify(focus.region)}`,`- 사용자 질문: ${escapeText(focus.comment)}`,`- 답변 상태: ${focus.answer?.status??'미완료'}`,focus.answer?escapeText(focus.answer.answer):'답변이 완료되지 않았습니다.','');}
  if (result.terminationReason) lines.push(`종료 사유: ${escapeText(result.terminationReason)}`, '');
  lines.push(...renderAutomaticChecks(result));
  lines.push('## 우선 검토 지적', '');
  if (!result.findings.length) {
    lines.push(result.status === 'completed' ? '검사한 범위에서 보고 기준을 충족한 지적이 없습니다.' : '검사가 완료되지 않아 문제 없음으로 판단할 수 없습니다.', '');
  }
  const severityOrder = {critical: 0, major: 1, minor: 2};
  const confirmed = [...result.findings].sort((left, right) => severityOrder[left.severity] - severityOrder[right.severity]);
  for (const finding of confirmed) lines.push(...renderFinding(finding, result));
  lines.push('## 추가 검증 후보', '');
  if (!result.verificationCandidates.length) lines.push('없음. 미검사 항목은 아래 검사 범위를 확인하세요.', '');
  for (const finding of result.verificationCandidates) lines.push(...renderFinding(finding, result));
  if(result.suggestions!==undefined){
    lines.push('## 개선 제안 (결함 수 제외)','','관찰에 근거한 선택적 제안입니다. 실제 동작이나 사용자 효과를 검증한 결과가 아닙니다.','');
    if(!result.suggestions.length)lines.push('별도 개선 제안 없음.','');
    for(const suggestion of result.suggestions){
      lines.push(`### ${escapeText(suggestion.title)}`,'',`- 관찰: ${escapeText(suggestion.observation)}`,`- 제안 이유: ${escapeText(suggestion.rationale)}`,`- 예상 영향 (추정): ${escapeText(suggestion.possibleImpact)}`,`- 불확실성: ${escapeText(suggestion.uncertainty)}`,`- 제안: ${escapeText(suggestion.recommendation)}`);
      for(const evidenceId of suggestion.evidenceIds){const evidence=result.evidence.find(item=>item.evidenceId===evidenceId);const path=evidence?safePath(evidence.relativePath):null;lines.push(path?`- 증거: [${escapeText(evidenceId)}](${path})`:`- 증거 미확인: ${escapeText(evidenceId)}`);}
      lines.push('');
    }
  }
  const ledger=result.observationLedger??result.evaluation.observationLedger;
  if(ledger){
    lines.push('## 관찰 처리 기록 (실험 기능)','','등록된 관찰의 처리 여부이며 모든 문제의 발견이나 판정 정확도를 보장하지 않습니다.',
      `- 관찰 등록: ${ledger.observations.length}, 처리 기록: ${ledger.accountedCount}, 판정 완료: ${ledger.adjudicatedCount}`,
      `- 수집 상태: ${ledger.collectionStatus}, 관찰 처리 완결성: ${ledger.isObservationCoverageComplete?'충족':'미충족'}`,'');
    const notice=ledgerNotice({...ledger,hasUnreviewed:ledger.adjudicatedCount<ledger.observations.length||ledger.observations.some(note=>{const decision=ledger.resolutions.find(item=>item.noteId===note.noteId);return !decision||decision.resolution==='unreviewed';})});
    if(notice)lines.push(`**${notice.title}: ${notice.description}**`,'');
    lines.push('<details>','<summary>관찰별 근거와 처리 이유 보기</summary>','');
    for(const note of ledger.observations){
      const decision=ledger.resolutions.find(item=>item.noteId===note.noteId);
      lines.push(`### ${escapeText(note.noteId)}: ${escapeText(note.visibleFact)}`,'',`- 위치: ${escapeText(note.location)}`,`- 검토 이유: ${escapeText(note.taskRelevance)}`,`- 미확인 사항: ${note.unknowns.map(escapeText).join('; ')||'없음'}`,`- 근거: ${note.evidenceIds.map(escapeText).join(', ')}`,`- 처리: ${decision?.resolution??'unreviewed'}`,`- 처리 이유: ${escapeText(decision?.reason??'미판정')}`);
      if(decision?.mergedInto)lines.push(`- 병합 대상: ${escapeText(decision.mergedInto)}`);
      for(const ref of decision?.outputRefs??[])lines.push(`- 결과 연결: ${ref.kind} / ${escapeText(ref.id)}`);
      for(const error of decision?.errors??[])lines.push(`- 미완료 사유: ${escapeText(error)}`);
      lines.push('');
    }
    for(const rejected of ledger.rejectedObservations)lines.push(`- 등록 거절 항목 ${rejected.sourceIndex}: ${escapeText(rejected.reason)} (원본 응답 보존)`);
    for(const region of ledger.regions)lines.push(`- 영역 ${escapeText(region.label)}: ${region.status} — ${escapeText(region.reason)}`);
    for(const request of ledger.additionalObservationRequests)lines.push(`- 추가 관찰 요청 ${request.noteIds.map(escapeText).join(', ')}: ${escapeText(request.reason)}`);
    if(ledger.overflowFindings.length||ledger.overflowSuggestions.length)lines.push(`- 본문 표시 한도 외 결과: 지적 ${ledger.overflowFindings.length}, 제안 ${ledger.overflowSuggestions.length}. report.json의 observationLedger에 원문과 ID를 보존했습니다.`);
    lines.push('','</details>','');
  }
  if(result.verifications!==undefined){
    const outcomes={reproduced:'측정 조건 재현',refuted:'측정 조건 반증', 'not-reproduced':'이 실행에서 미재현',inconclusive:'판단 불가'};
    lines.push('## 등록된 실행 검증 결과','','아래 결과는 지정된 측정 조건에만 해당합니다. 원래 지적의 사용자 영향이나 휴리스틱 판단 전체를 검증한 것은 아닙니다.','');
    for(const selection of result.evaluation.verificationSelections??[])lines.push(`- 검사 선택 ${escapeText(selection.candidateId)}: ${selection.origin==='automatic'?'자동 연결':'모델 제안'}, ${selection.status}, ${selection.recipe??'미선택'}. ${escapeText(selection.reason)}`);
    if(!result.verifications.length)lines.push('실행된 검증이 없습니다. 후보 또는 적용 가능한 요청이 없을 수 있으며, 문제가 없음을 증명하지 않습니다.','');
    for(const verification of result.verifications){
      lines.push(`### ${escapeText(verification.request.candidateId)}: ${outcomes[verification.outcome]}`,'',`- 레시피: ${verification.request.recipe} v${verification.recipeVersion}`,`- 요청 출처: ${result.evaluation.verificationSelections?.find(selection=>selection.requestId===verification.request.requestId)?.origin??'model (legacy)'}`,`- 연결된 원본 주장: ${[...new Set(verification.targetMeasurements?.flatMap(target=>target.claimIds)??verification.request.claimIds)].map(escapeText).join(', ')}`,`- 결함 가설: ${escapeText(verification.condition)}`,`- 기대 불변 조건: ${escapeText(verification.expectedInvariant)}`,`- 위반 관측: ${verification.hasObservedViolation===null?'판단 불가':verification.hasObservedViolation?'관측됨':'이번 측정에서 관측되지 않음'}`,`- 결과: ${escapeText(verification.summary)}`,`- 기대 출처: ${verification.request.expectation.expectationSource}, ${escapeText(verification.request.expectation.sourceRef)}`,`- 수행 동작: ${verification.actionIds.length}회`, `- 측정 기록: ${escapeText(JSON.stringify(verification.measurements))}`);
      for(const target of verification.targetMeasurements??[])lines.push(`- 개별 피해 대상 ${escapeText(target.targetRef)}: ${target.outcome}, 연결 주장 ${target.claimIds.map(escapeText).join(', ')}. ${escapeText(target.summary)}`);
      for(const precondition of verification.request.preconditions)lines.push(`- 요청 가정(별도 확인 필요): ${escapeText(precondition)}`);
      for(const limitation of verification.limitations)lines.push(`- 한계: ${escapeText(limitation)}`);
      for(const evidenceId of verification.evidenceIds){const evidence=result.evidence.find(item=>item.evidenceId===evidenceId);const path=evidence?safePath(evidence.relativePath):null;lines.push(path?`- 증거: [${escapeText(evidenceId)}](${path})`:`- 증거 미확인: ${escapeText(evidenceId)}`);}
      lines.push('');
    }
  }
  lines.push('## 검사 범위와 한계', '', `- 정상 완료 자격: ${result.coverage.canFinish ? '충족' : '미충족'}`, `- 필수 검사: ${result.coverage.requiredChecks.length}개`, `- 관찰 충족: ${result.coverage.observedChecks.length}개`, '');
  for (const check of result.coverage.unmetChecks) lines.push(`- 미검사 ${escapeText(check.checkId)} (${check.state}): ${escapeText(check.reason)}`);
  for (const check of result.coverage.unavailableChecks??[]) lines.push(`- 이미지 입력 미검사 ${escapeText(check.checkId)}: ${escapeText(check.reason)}`);
  for (const blocker of result.coverage.completionBlockers) lines.push(`- 완료 차단: ${escapeText(blocker)}`);
  for (const limitation of new Set([...result.limitations, ...result.evaluation.limitations])) lines.push(`- ${escapeText(limitation)}`);
  lines.push('', '## 관찰 증거', '');
  for (const observation of result.observations) {
    lines.push(`### ${escapeText(observation.observationId)}`, '');
    if(observation.source?.kind==='image')lines.push(`- 입력: ${escapeText(observation.source.fileName)}`,`- 이미지 크기: ${observation.source.width}×${observation.source.height} 이미지 px`,
      `- 가져온 시각: ${escapeText(observation.source.importedAt)} (촬영 시각 아님)`,`- 원본 SHA-256: ${observation.source.sourceSha256}`,
      '- 원본 URL, CSS 뷰포트, 배율, 스크롤 위치, 촬영 시각, 페이지 안정성: 미확인',
      '- 자동 개인정보 마스킹 없음. 원본을 디코드하고 방향을 적용한 PNG를 분석했습니다.','');
    else lines.push(`- 화면: ${escapeText(observation.url)}`, `- 수집 구간: ${escapeText(observation.captureStartedAt)} ~ ${escapeText(observation.captureEndedAt)}`, `- 화면 크기: ${observation.viewport.width}×${observation.viewport.height} CSS px`, `- 안정 상태: ${observation.isStable ? '확인' : '불안정 또는 미확인'}`, '');
    for (const evidenceId of observation.screenshotRefs) {
      const evidence = result.evidence.find(item => item.evidenceId === evidenceId);
      const path = evidence ? safePath(evidence.relativePath) : null;
      if (path) lines.push(`![${escapeText(evidenceId)}](${path})`, '');
    }
    if (observation.redactionRegions?.length) lines.push(`- 개인정보 보호 마스킹: ${observation.redactionRegions.length}개 영역. 해당 색상과 가려진 값은 실제 제품 표시가 아닙니다.`, '');
  }
  lines.push('## 실행 사용량', '');
  const calls=result.evaluation.calls??[];
  lines.push(`- 실제 모델 호출: ${calls.length}회, 그중 출력 수리: ${calls.filter(call=>call.isRepair).length}회`, '');
  for(const call of calls)lines.push(`- ${escapeText(call.stage)}${call.isRepair?' (수리)':''}: ${call.status}, ${call.durationMs}ms, 요청 모델 ${escapeText(call.requestedModel??'기본값')}, 요청 추론 ${escapeText(call.requestedReasoningEffort??'기본값')}, 실제 모델 ${escapeText(call.actualModel??'미확인')}, 실제 추론 ${escapeText(call.actualReasoningEffort??'미확인')}`);
  if(calls.some(call=>!call.usage))lines.push('- 일부 호출의 사용량 미확인: 아래 합계는 확인된 사용량만 포함합니다.');
  const usage = result.evaluation.usage;
  lines.push(`- 총 입력 토큰(캐시 포함): ${usage?.inputTokens ?? '미확인'}`, `- 캐시 생성 입력 토큰: ${usage?.cacheCreationInputTokens ?? '미확인'}`, `- 캐시 읽기 입력 토큰: ${usage?.cacheReadInputTokens ?? '미확인'}`, `- 출력 토큰: ${usage?.outputTokens ?? '미확인'}`, `- 추정 비용(USD): ${usage?.estimatedCost ?? '미확인'}`, '', '비용은 실행 도구의 추정값이며 실제 청구 금액과 다를 수 있습니다. 브라우저 제어 성공과 사용성 평가 품질은 별도 지표입니다.', '');
  return lines.join('\n');
}

function renderAutomaticChecks(result:ReviewResult):string[] {
  const observations=result.observations.filter(observation=>observation.theme||observation.deterministicChecks);
  if(!observations.length)return [];
  const lines=['## 자동 검사 결과',''];
  for(const observation of observations){
    const {theme,deterministicChecks}=observation;
    lines.push(`### ${theme?themeLabels[theme.requested]:'관찰 화면'} (${escapeText(observation.observationId)})`,'');
    if(theme){
      lines.push(`- 요청 테마 ${themeStatusLabel(theme.status,theme.scope)}. ${escapeText(theme.reason)}`);
      for(const [index,region] of (theme.regions??[]).entries()){
        lines.push(`  - 배경 변화 영역 ${index+1} (${escapeText(region.role)}) · 배경 ${escapeText(region.background)} · ${formatViewportBounds(region.bounds)}`);
      }
    }
    const contrast=deterministicChecks?.contrast;
    if(contrast){
      const label=contrast.source==='visible-text'?'텍스트 대비 보완 검사':'텍스트 대비';
      lines.push(`- ${label} ${contrastLabels[contrast.status]}. 통과 ${contrast.passed}, 위반 ${contrast.violations}, 추가 확인 ${contrast.incomplete}`);
      if(contrast.hasReachedLimit)lines.push('  - 측정 한도에 도달해 일부 텍스트의 대비를 확인하지 못했습니다.');
      for(const example of contrast.examples??[]){
        if(example.observedRatio===undefined)continue;
        const ratio=` · 측정 ${formatMeasurement(example.observedRatio)}:1`;
        const expected=example.expectedRatio!==undefined?` · 기준 ${formatMeasurement(example.expectedRatio)}:1`:'';
        const target=example.target?` · ${escapeText(example.target.tag)} · ${formatViewportBounds(example.target.bounds)}`:'';
        const colors=example.foreground&&example.background?` · 전경 ${escapeText(example.foreground)} · 배경 ${escapeText(example.background)}`:'';
        lines.push(`  - ${contrastLabels[example.status]}${ratio}${expected}${target}${colors}`);
      }
    }else if(theme)lines.push('- 텍스트 대비 검사 기록 없음');
    const alignment=deterministicChecks?.alignment;
    if(alignment){
      lines.push(alignment.checks.length?`- 그룹 정렬 ${alignment.checks.length}건`:'- 그룹 정렬에 기록된 불일치 없음');
      for(const [index,check] of alignment.checks.entries()){
        const target=check.groupIndex===null?`설정 ${check.contractIndex??index+1}`:`그룹 ${check.groupIndex}`;
        const line=check.line===undefined?'':`, ${check.line}번째 ${check.axis==='column'?'열':'행'}`;
        const evidence=check.members.map(member=>`${formatMeasurement(member.visualBox.width)} × ${formatMeasurement(member.visualBox.height)}`);
        const dimensions=evidence.length?`. 외곽 크기 ${evidence.join(' / ')} CSS px`:'';
        lines.push(`  - ${target}${line} · ${alignmentLabels[check.status]}${dimensions}${check.reason?'. '+escapeText(alignmentReasonLabel(check.reason)):''}`);
      }
    }
    const spacing=deterministicChecks?.spacing;
    if(spacing){
      lines.push(`- 간격과 여백. 자동 측정 후보 ${spacing.checks.length}건 · 검사한 버튼 쌍 ${spacing.inspectedPairs}개 · 카드 ${spacing.inspectedCards}개`);
      if(spacing.isLimited)lines.push('  - 측정 한도에 도달해 나머지 영역의 간격과 여백은 확인하지 못했습니다.');
      for(const check of spacing.checks){
        lines.push(`  - ${spacingCheckLabel(check)} · ${spacingCheckMeasurement(check)} · ${formatViewportBounds(check.bounds)}`);
      }
    }
    const comparison=deterministicChecks?.styleComparison;
    if(comparison){
      lines.push(`- 화면 간 스타일 비교 · ${escapeText(comparison.label)}`);
      for(const side of [comparison.reference,comparison.comparison]){
        const capture=side.screenshotEvidenceId&&result.evidence.find(item=>item.evidenceId===side.screenshotEvidenceId);
        const path=capture&&safePath(capture.relativePath);
        const location=side.sample.status==='measured'?formatViewportBounds(side.sample.bounds):styleComparisonReasons[side.sample.reason];
        lines.push(`  - ${escapeText(side.label)} · ${escapeText(side.url)} · ${escapeText(side.selector)} · ${location}${path?` · [캡처 보기](${path})`:''}`);
      }
      for(const check of comparison.checks){
        const reference=check.reference??'미측정',comparisonValue=check.comparison??'미측정';
        const expectedReference=check.expectedReference?` (기준 ${escapeText(check.expectedReference)})`:'';
        const expectedComparison=check.expectedComparison?` (기준 ${escapeText(check.expectedComparison)})`:'';
        lines.push(`  - ${styleComparisonLabels[check.status]} · ${check.property} · ${escapeText(reference)}${expectedReference} / ${escapeText(comparisonValue)}${expectedComparison}`);
      }
      lines.push('  - 입력란은 캡처에서 가려질 수 있습니다. 값과 위치는 브라우저에서 측정했습니다.');
    }
    const automatic=recordedAutomaticStyles(deterministicChecks);
    if(automatic.length>1){
      const repeated=repeatedStyleDifferences(automatic);
      lines.push('#### 반복되는 스타일 차이','');
      if(!repeated.length)lines.push('- 측정한 범위에 반복되는 차이 없음');
      for(const {role,label,difference,targetIndexes} of repeated){
        lines.push(`- ${escapeText(styleComparisonRoleLabel(role))} · ${escapeText(styleComparisonElementLabel(label))} · ${difference.property} · ${escapeText(difference.reference)} → ${escapeText(difference.comparison)} · 비교 화면 ${targetIndexes.map(index=>index+1).join(', ')}`);
      }
    }
    for(const [index,pair] of automatic.entries()){
      if(automatic.length>1)lines.push('',`#### 비교 화면 ${index+1} · ${escapeText(pair.comparison.url)}`,'');
      lines.push(...renderAutomaticStyleComparison(pair,result.evidence));
    }
    const evidenceIds=new Set([...observation.screenshotRefs,...(deterministicChecks?[deterministicChecks.evidenceId]:[]),...(comparison?[comparison.evidenceId]:[]),...automatic.map(pair=>pair.evidenceId)]);
    for(const evidenceId of evidenceIds){
      const evidence=result.evidence.find(item=>item.evidenceId===evidenceId);
      const path=evidence&&safePath(evidence.relativePath);
      if(path)lines.push(`- [${evidence.kind==='screenshot'?'관찰 캡처':'세부 측정 근거'}](${path})`);
    }
    lines.push('');
  }
  return lines;
}

function renderAutomaticStyleComparison(report:AutoStyleComparisonReport,evidence:ReviewResult['evidence']):string[] {
  const {coverage}=report;
  const lines=[
    `- 화면 간 스타일 자동 비교 · 비교한 요소 ${coverage.matched}쌍 · 차이 후보 ${coverage.changed}쌍 · 차이 없음 ${coverage.matched-coverage.changed}쌍`,
    '  - 각 화면의 첫 뷰포트에 보이는 요소를 비교했습니다. 아래 차이는 브라우저에서 측정한 CSS 값이며 디자인 기준 위반 여부는 별도 확인이 필요합니다.',
  ];
  for(const key of ['reference','comparison'] as const){
    const side=report[key];
    const capture=evidence.find(item=>item.evidenceId===side.screenshotEvidenceId);
    const path=capture&&safePath(capture.relativePath);
    const summary=side.reason?styleComparisonReasons[side.reason]:`발견한 검사 대상 ${side.inspected}개`;
    lines.push(`  - ${styleComparisonSides[key]} · ${escapeText(side.url)} · ${summary}${path?` · [캡처 보기](${path})`:''}`);
    if(side.hasReachedLimit)lines.push('    - 탐색 한도에 도달해 일부 요소를 확인하지 못했습니다.');
  }
  if(!coverage.matched)lines.push('  - 두 화면에서 비교할 수 있는 요소 쌍을 확인하지 못했습니다.');
  for(const match of report.matches.filter(item=>item.differences.length)){
    lines.push(`  - 차이 후보 · ${escapeText(styleComparisonRoleLabel(match.role))} · ${escapeText(styleComparisonElementLabel(match.reference.label))} ↔ ${escapeText(styleComparisonElementLabel(match.comparison.label))} · ${styleComparisonMatchLabels[match.method]}`);
    for(const key of ['reference','comparison'] as const){
      const {selector,bounds}=match[key];
      lines.push(`    - ${styleComparisonSides[key]} · ${escapeText(selector)} · ${formatViewportBounds(bounds)}`);
    }
    for(const {property,reference,comparison} of match.differences)lines.push(`    - ${escapeText(property)} · A ${escapeText(reference)} / B ${escapeText(comparison)}`);
  }
  lines.push(`  - 대응 요소 없음 ${coverage.unmatched}개 · 모호함 ${coverage.ambiguous}개 · 미측정 ${coverage.unmeasured}개`);
  for(const match of report.matches.filter(item=>!item.differences.length)){
    lines.push(`    - 차이 없음 · ${escapeText(styleComparisonRoleLabel(match.role))} · ${escapeText(styleComparisonElementLabel(match.reference.label))} ↔ ${escapeText(styleComparisonElementLabel(match.comparison.label))}`);
  }
  for(const {label,elements} of automaticStyleCoverageGroups(report)){
    for(const element of elements){
      const {side,role,label:elementLabel,selector,bounds}=element;
      const reason=element.reason?` · ${styleComparisonReasons[element.reason]}`:'';
      lines.push(`    - ${label} · ${styleComparisonSides[side]} · ${escapeText(styleComparisonRoleLabel(role))} · ${escapeText(styleComparisonElementLabel(elementLabel))} · ${escapeText(selector)} · ${formatViewportBounds(bounds)}${reason}`);
    }
  }
  lines.push('  - 캡처에서 개인정보 보호를 위해 입력란이 가려질 수 있습니다.');
  return lines;
}

function renderFinding(finding: ReviewFinding, result: ReviewResult): string[] {
  const measurements=result.verifications?.filter(item=>item.request.candidateId===finding.issueId)??[];
  const hasRefutedMeasurement=measurements.some(item=>item.outcome==='refuted');
  const lines = [`### ${hasRefutedMeasurement?'[측정 반증 있음] ':''}${escapeText(finding.issueId)}: ${escapeText(finding.title)}`, '', `- 계층: ${finding.layer}`, `- 심각도: ${severityNames[finding.severity]}`, `- 확신도: ${finding.confidence}`, `- ${finding.source==='automatic-rule'?'자동 검사 후보':result.verifications!==undefined?'AI 초기 판정':'판정'}: ${finding.disposition}`, `- 판단 한계: ${escapeText(finding.confidenceRationale)}`, '', '**관찰 사실**', ''];
  if(result.verifications!==undefined&&finding.source!=='automatic-rule'){
    if(!measurements.length)lines.splice(lines.length-2,0,'실행 검증: 이 지적에 연결된 측정 없음. AI 초기 판단이며 실행으로 재현된 사실이 아닙니다.','');
    for(const measurement of measurements){
      const verdict={reproduced:'지정 조건 재현, 전체 UX 판단 검증 아님',refuted:'AI 초기 지적의 아래 측정 조건은 반증됨','not-reproduced':'이 실행에서 조건 미재현, 반증과 다름',inconclusive:'측정 판단 불가'}[measurement.outcome];
      if(measurement.targetMeasurements?.length){for(const target of measurement.targetMeasurements)lines.splice(lines.length-2,0,`**개별 대상 실행 검증: ${escapeText(target.targetRef)}, ${target.outcome}**`, `적용 주장: ${target.claimIds.map(escapeText).join(', ')}. ${escapeText(target.summary)}`,'');}
      else lines.splice(lines.length-2,0,`**실행 검증: ${verdict}**`, `적용 주장: ${measurement.request.claimIds.map(escapeText).join(', ')}. 조건: ${escapeText(measurement.condition)}. ${escapeText(measurement.summary)}`,'');
    }
  }
  for (const fact of finding.observedFacts) lines.push(`- ${escapeText(fact.text)}`);
  lines.push('', '**기대의 출처**', '');
  for (const expectation of finding.expectations) lines.push(`- ${expectation.expectationSource}: ${escapeText(expectation.statement)} (${escapeText(expectation.sourceRef)}). 적용 조건: ${escapeText(expectation.applicability)}`);
  lines.push('', `판단 근거: ${escapeText(finding.reasoning)}`, '', `예상 영향: ${escapeText(finding.userImpact)}`, '', `개선 방향: ${escapeText(finding.recommendation)}`, '');
  if (finding.hasFailureObservation) lines.push(`실패 귀속: ${finding.failureAttribution ?? 'unknown'}. ${escapeText(finding.attributionRationale ?? '원인 미확인')}`, '');
  if (finding.needsFurtherVerification) lines.push(`추가 확인: ${escapeText(finding.verificationNeeded ?? '근거와 적용 조건 확인 필요')}`, '');
  lines.push('**재현 절차**', '');
  finding.reproductionSteps.forEach((step, index) => lines.push(`${index + 1}. ${escapeText(step)}`));
  lines.push('', '**증거 연결**', '');
  for (const evidenceId of finding.evidenceIds) {
    const evidence = result.evidence.find(item => item.evidenceId === evidenceId);
    const path = evidence ? safePath(evidence.relativePath) : null;
    lines.push(path ? `- [${escapeText(evidenceId)}](${path})` : `- ${escapeText(evidenceId)}: 링크 미확인`);
  }
  for (const link of finding.claimEvidenceLinks) lines.push(`- 주장 ${escapeText(link.claimId)}: ${link.supportStatus}, 평가 주체 ${link.assessedBy}. ${escapeText(link.rationale)}`);
  lines.push('');
  return lines;
}
