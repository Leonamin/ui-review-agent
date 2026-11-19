/** Presentation only: never changes stored coverage, decisions, or run status. */
export function ledgerNotice(input: {
  isObservationCoverageComplete: boolean;
  hasUnreviewed: boolean;
  collectionStatus: string;
}): {title: string; description: string} | null {
  if (input.hasUnreviewed) return {title: '관찰 판정 미완료', description: '관찰 판정이 완료되지 않았습니다. 미판정을 정상 또는 제품의 추가 확인으로 해석하지 마세요.'};
  if (input.collectionStatus !== 'completed') return {title: '관찰 수집 범위 제한', description: '등록된 관찰에 미판정 항목은 없지만 수집 범위에 제한이 있습니다. 범위와 한계에서 수집 상태와 제한 사항을 확인하세요.'};
  if (!input.isObservationCoverageComplete) return {title: '관찰 처리 완결성 미충족', description: '미판정 항목 외의 처리 완결성 조건이 충족되지 않았습니다. 범위와 한계에서 처리 기록을 확인하세요.'};
  return null;
}
