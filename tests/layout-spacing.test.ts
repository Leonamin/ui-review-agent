import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { inspect } from '../src/core.js';
import type { ReviewResult, RunSpec } from '../src/types.js';
import { ReportRepository } from '../viewer/server/repository.js';

const html = await readFile(new URL('./fixtures/workspace-spacing.html', import.meta.url));
const spacingRules = new Set(['control-gap', 'card-inset']);

async function runFixture(run: (url: URL, root: string) => Promise<void>) {
  const root = await mkdtemp(join(tmpdir(), 'layout-spacing-'));
  const server = createServer((_request, response) => {
    response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' }).end(html);
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  assert(address && typeof address !== 'string');
  try {
    await run(new URL(`http://127.0.0.1:${address.port}/`), root);
  } finally {
    server.closeAllConnections();
    await new Promise<void>(resolve => server.close(() => resolve()));
    await rm(root, { recursive: true, force: true });
  }
}

function spec(url: URL, viewport: RunSpec['viewport']): RunSpec {
  return {
    targetUrl: url.href,
    mode: 'quick',
    viewport,
    allowedActions: [],
    allowedOrigins: [url.origin],
    hasMutationPermission: false,
    isHeaded: false,
    shouldWaitForLogin: false,
    evaluator: 'rules-only',
    limits: { maxDurationMs: 30_000, maxObservations: 2, maxActions: 0, maxToolCalls: 10, maxFindings: 15 },
  };
}

for (const viewport of [
  { width: 1440, height: 900, deviceScaleFactor: 1 },
  { width: 390, height: 844, deviceScaleFactor: 2 },
]) {
  test(`measures and saves workspace spacing candidates at ${viewport.width}px`, async () => runFixture(async (url, root) => {
    const { result, runDir } = await inspect(spec(url, viewport), root);
    assert.equal(result.status, 'completed', result.limitations.join('\n'));
    const stored: ReviewResult = JSON.parse(await readFile(join(runDir, 'report.json'), 'utf8'));
    const measured = stored.observations[0];
    const checkSet = measured.deterministicChecks;
    const spacing = checkSet?.spacing;
    assert(spacing);
    assert.equal(measured.isStable, true);
    assert.equal(spacing.inspectedPairs, 1);

    const isStacked = viewport.width < 620;
    const gaps = spacing.checks.filter(check => check.kind === 'control-gap');
    assert.deepEqual(gaps.map(check => [check.axis, check.observed, check.threshold]), [[isStacked ? 'column' : 'row', 0, 2]]);
    const [gap] = gaps;
    assert.equal(gap.targetBounds.length, 2);
    const [first, second] = gap.targetBounds;
    assert.equal(isStacked ? first.y + first.height : first.x + first.width, isStacked ? second.y : second.x);

    const insets = spacing.checks.filter(check => check.kind === 'card-inset');
    assert(insets.length > 0);
    assert(insets.every(check => check.observed < check.threshold && check.threshold === 4));
    assert(insets.some(check => check.edge === 'left' && check.observed === 0));
    const edge = insets.find(check => check.edge === 'left')!;
    assert.equal(edge.targetBounds[0].x, edge.bounds.x + 1, 'the inset starts at the painted inner border');

    const rules = stored.rules.filter(rule => spacingRules.has(rule.ruleId));
    assert.deepEqual([...new Set(rules.map(rule => rule.ruleId))].sort(), ['card-inset', 'control-gap']);
    assert(rules.every(rule => rule.result === 'potential' && rule.observationId === measured.observationId));
    const ruleEvidence = stored.evidence.find(item => item.evidenceId === checkSet.evidenceId);
    const screenshot = stored.evidence.find(item => item.evidenceId === measured.screenshotRefs[0]);
    assert(ruleEvidence?.kind === 'rule' && screenshot?.kind === 'screenshot');
    assert.equal(ruleEvidence.observationId, measured.observationId);
    assert.equal(screenshot.observationId, measured.observationId);
    assert.deepEqual(screenshot.screenshot?.clip, { x: 0, y: 0, width: viewport.width, height: viewport.height });
    assert.equal(screenshot.screenshot?.deviceScaleFactor, viewport.deviceScaleFactor);
    for (const item of [ruleEvidence, screenshot]) {
      const bytes = await readFile(join(runDir, item.relativePath));
      assert.equal(createHash('sha256').update(bytes).digest('hex'), item.sha256);
    }
    const ruleJson = JSON.parse(await readFile(join(runDir, ruleEvidence.relativePath), 'utf8'));
    assert.deepEqual(ruleJson.spacing, spacing);
    const markdown = await readFile(join(runDir, 'report.md'), 'utf8');
    assert(markdown.includes(isStacked ? '버튼 사이 세로 간격' : '버튼 사이 가로 간격'));
    assert(markdown.includes('카드 왼쪽 안쪽 여백'));
    for (const rule of rules) {
      assert(rule.evidenceIds.includes(ruleEvidence.evidenceId) && rule.evidenceIds.includes(screenshot.evidenceId));
      const finding = stored.verificationCandidates.find(item => item.expectations.some(expectation => expectation.sourceRef === `rule:${rule.ruleFindingId}`));
      assert.equal(finding?.category, 'layout');
      assert.equal(finding?.disposition, 'needs-verification');
      assert(markdown.includes(rule.title));
    }
    assert(markdown.includes(ruleEvidence.relativePath));
    assert(markdown.includes(screenshot.relativePath));
    const repository = new ReportRepository(root);
    const [report] = (await repository.list()).reports;
    const detail = await repository.detail(report.id);
    assert.deepEqual(detail.captures?.[0].deterministicChecks?.spacing, spacing);

    url.searchParams.set('repaired', '1');
    const repaired = await inspect(spec(url, viewport), root);
    assert.equal(repaired.result.status, 'completed');
    const repairedSpacing = repaired.result.observations[0].deterministicChecks?.spacing;
    assert(repairedSpacing);
    assert.equal(repairedSpacing.inspectedPairs, spacing.inspectedPairs);
    assert.equal(repairedSpacing.inspectedCards, spacing.inspectedCards);
    assert.deepEqual(repairedSpacing.checks, [], 'repaired spacing, connected controls and full-bleed media should stay clear');
    assert(!repaired.result.rules.some(rule => spacingRules.has(rule.ruleId)));
  }));
}

test('URL report and dashboard keep automatic spacing candidates when AI omits them', async () => runFixture(async (url, root) => {
  const runSpec: RunSpec = {
    ...spec(url, { width: 1440, height: 900, deviceScaleFactor: 1 }),
    evaluator: 'antigravity',
  };
  runSpec.limits.maxFindings = 1;
  const evaluate: typeof import('../src/evaluator.js').evaluate = async () => ({
    status: 'failed', findings: [], screenMap: [], interpretations: [], limitations: ['Evaluation unavailable.'],
  });
  const { result, runDir } = await inspect(runSpec, root, { evaluate });
  assert.equal(result.status, 'partial');
  assert.equal(result.evaluation.status, 'failed');
  assert.deepEqual(result.evaluation.findings, []);
  const rules = result.rules.filter(rule => spacingRules.has(rule.ruleId));
  assert(rules.length > runSpec.limits.maxFindings);
  const candidates = result.verificationCandidates.filter(finding => finding.source === 'automatic-rule');
  assert(rules.every(rule => candidates.some(candidate =>
    candidate.disposition === 'needs-verification' &&
    candidate.expectations[0].sourceRef === `rule:${rule.ruleFindingId}` &&
    candidate.observedFacts[0].text === rule.description &&
    rule.evidenceIds.every(evidenceId => candidate.evidenceIds.includes(evidenceId)))));
  const markdown = await readFile(join(runDir, 'report.md'), 'utf8');
  const candidateSection = markdown.split('## 추가 검증 후보')[1].split('## 검사 범위와 한계')[0];
  assert.match(candidateSection, /자동 검사 후보: needs-verification/);
  assert(candidates.every(candidate => candidateSection.includes(candidate.issueId)));

  const repository = new ReportRepository(root);
  const record = (await repository.list()).reports.find(report => report.runId === result.runId)!;
  assert.equal(record.initialCount, null);
  assert.equal(record.automaticCandidateCount, candidates.length);
  const detail = await repository.detail(record.id);
  assert.deepEqual(detail.findings.map(finding => finding.id), candidates.map(finding => finding.issueId));
  assert(detail.findings.every(finding => finding.source === 'automatic-rule'));

  url.searchParams.set('repaired', '1');
  const repaired = await inspect({ ...runSpec, targetUrl: url.href }, root, { evaluate });
  assert(!repaired.result.verificationCandidates.some(finding =>
    finding.expectations.some(expectation => /control-gap|card-inset/.test(expectation.sourceRef))));
}));
