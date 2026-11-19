import type { EvaluationResult, ReviewFinding, RuleFinding } from './types.js';

export function isActionableRule(rule: RuleFinding): boolean {
  return rule.result === 'violation' || rule.result === 'potential';
}

export function ruleReviewCandidate(rule: RuleFinding, issueId: string): ReviewFinding {
  const factId = `fact-${issueId}`;
  const expectationId = `expectation-${issueId}`;
  return {
    issueId, layer: 'L1', category: ['horizontal-overflow','group-alignment','control-gap','card-inset'].includes(rule.ruleId) ? 'layout' : 'accessibility',
    title: rule.title, disposition: 'needs-verification', observedFacts: [{factId, text: rule.description}],
    expectations: [{expectationId, expectationSource: 'rule', sourceRef: `rule:${rule.ruleFindingId}`, statement: rule.title, applicability: `Rule ${rule.ruleId}, version ${rule.ruleVersion}; applicability requires review.`}],
    reasoning: 'A deterministic rule reported this candidate. User impact and design intent have not been evaluated by an AI or person.',
    userImpact: 'Requires contextual review.', severity: rule.impact === 'critical' || rule.impact === 'serious' ? 'major' : 'minor',
    confidence: 'low', confidenceRationale: 'Rule result only; semantic usability judgement is unverified.',
    evidenceIds: rule.evidenceIds, observationIds: [rule.observationId], reproductionSteps: ['Open the target at the recorded viewport.', 'Inspect the cited observation and rule output.'],
    recommendation: 'Review the cited rule and element in context before changing the interface.',
    hasFailureObservation: false, failureAttribution: null, attributionEvidenceIds: [], needsFurtherVerification: true,
    verificationNeeded: 'Verify applicability, evidence support, and user impact.',
    claimEvidenceLinks: [
      {claimId: factId, evidenceIds: rule.evidenceIds, sourceRefs: [], supportStatus: 'unassessed', assessedBy: 'rule', rationale: 'Deterministic measurement; semantic evidence support has not been independently assessed.'},
      {claimId: expectationId, evidenceIds: [], sourceRefs: [`rule:${rule.ruleFindingId}`], supportStatus: 'unassessed', assessedBy: 'rule', rationale: 'Rule applicability requires contextual review.'},
    ],
  };
}

function reportsRule(finding: ReviewFinding, rule: RuleFinding): boolean {
  return finding.disposition !== 'dismissed' &&
    finding.observationIds.includes(rule.observationId) &&
    finding.expectations.some(expectation =>
      expectation.expectationSource === 'rule' && expectation.sourceRef === `rule:${rule.ruleFindingId}`) &&
    finding.observedFacts.some(fact => finding.claimEvidenceLinks.some(link =>
      link.claimId === fact.factId && link.supportStatus === 'supported' &&
      link.evidenceIds.some(evidenceId => rule.evidenceIds.includes(evidenceId))));
}

/** Keep measured candidates visible even when the model reports nothing or uses its finding budget. */
export function unreportedRuleCandidates(rules: RuleFinding[], evaluation: Pick<EvaluationResult, 'findings' | 'omittedFindings'>): ReviewFinding[] {
  const issueIds = new Set([...evaluation.findings, ...(evaluation.omittedFindings ?? [])].map(finding => finding.issueId));
  const candidates: ReviewFinding[] = [];
  for (const rule of new Map(rules.map(rule => [rule.ruleFindingId, rule])).values()) {
    if (!isActionableRule(rule) || evaluation.findings.some(finding => reportsRule(finding, rule))) continue;
    const id = `automatic-rule:${rule.ruleFindingId}`;
    let issueId = id;
    for (let index = 2; issueIds.has(issueId); index++) issueId = `${id}:${index}`;
    issueIds.add(issueId);
    const candidate = ruleReviewCandidate(rule, issueId);
    candidates.push({
      ...candidate,
      source: 'automatic-rule',
      observedFacts: rule.result === 'violation'
        ? candidate.observedFacts.map(fact => ({...fact, text: `측정 기준 위반. ${fact.text}`}))
        : candidate.observedFacts,
      expectations: candidate.expectations.map(expectation => ({
        ...expectation,
        applicability: `자동 검사 ${rule.ruleId} v${rule.ruleVersion}. 사용자 과업에 이 기준을 적용할 수 있는지 확인이 필요합니다.`,
      })),
      reasoning: rule.result === 'violation' ? '자동 검사에서 기준 위반을 확인했습니다.' : '자동 검사에서 확인할 차이를 측정했습니다.',
      userImpact: '사용자 영향은 확인이 필요합니다.',
      confidenceRationale: '자동 검사 근거이며, 사용성 영향과 디자인 의도는 추가 확인 대상입니다.',
      recommendation: '측정 결과와 요소의 역할, 디자인 기준을 함께 확인하세요.',
      reproductionSteps: ['기록된 뷰포트에서 검토 대상을 엽니다.', '연결된 화면과 자동 검사 결과를 확인합니다.'],
      verificationNeeded: '측정 기준의 적용 여부와 사용자에게 미치는 영향을 확인하세요.',
    });
  }
  return candidates;
}
