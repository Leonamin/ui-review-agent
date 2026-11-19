import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ruleReviewCandidate, unreportedRuleCandidates } from '../src/rule-findings.js';
import type { RuleFinding } from '../src/types.js';

const gap: RuleFinding = {
  ruleFindingId: 'obs-001-control-gap-1', observationId: 'obs-001', ruleId: 'control-gap', ruleVersion: '1',
  result: 'potential', title: 'Nearby control gap', description: 'Gap is 1 CSS px.',
  evidenceIds: ['obs-001-rule', 'obs-001-screenshot'], elementRefs: [], impact: null,
};
const alignment: RuleFinding = {
  ...gap, ruleFindingId: 'obs-001-group-alignment-1', ruleId: 'group-alignment', result: 'violation',
  title: 'Control group alignment', description: 'Visible heights differ by 8 CSS px.',
};

test('a linked AI finding covers its exact rule, while another rule with the same evidence stays visible', () => {
  const modelFinding = ruleReviewCandidate(gap, 'model-gap');
  modelFinding.claimEvidenceLinks[0].supportStatus = 'supported';
  modelFinding.claimEvidenceLinks[0].assessedBy = 'model';
  const candidates = unreportedRuleCandidates([gap, alignment, alignment], { findings: [modelFinding] });
  assert.deepEqual(candidates.map(finding => finding.expectations[0].sourceRef), [`rule:${alignment.ruleFindingId}`]);
  assert.equal(candidates[0].observedFacts[0].text, `측정 기준 위반. ${alignment.description}`);
  assert.equal(candidates[0].disposition, 'needs-verification');
  assert(candidates[0].claimEvidenceLinks.every(link => link.assessedBy === 'rule'));
});

test('pass and incomplete produce no candidate, and a dismissed or limit-omitted finding cannot hide a measured gap', () => {
  const pass = { ...alignment, result: 'pass' as const };
  const incomplete = { ...alignment, ruleFindingId: 'obs-001-extra', result: 'incomplete' as const };
  const modelFinding = ruleReviewCandidate(gap, `automatic-rule:${gap.ruleFindingId}`);
  modelFinding.claimEvidenceLinks[0].supportStatus = 'supported';
  const [fromLimit] = unreportedRuleCandidates([gap, pass, incomplete], { findings: [], omittedFindings: [modelFinding] });
  assert.equal(fromLimit.issueId, `automatic-rule:${gap.ruleFindingId}:2`);
  assert.equal(fromLimit.observedFacts[0].text, gap.description);
  const dismissed = { ...modelFinding, disposition: 'dismissed' as const };
  assert.deepEqual(unreportedRuleCandidates([gap, pass, incomplete], { findings: [dismissed] }), [fromLimit]);
  assert.deepEqual(unreportedRuleCandidates([pass, incomplete], { findings: [] }), []);
});
