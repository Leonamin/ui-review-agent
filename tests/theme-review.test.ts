import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { inspect } from '../src/core.js';
import { validateSpec } from '../src/policy.js';
import type { EvaluationResult, RunSpec } from '../src/types.js';

const html = await readFile(new URL('./fixtures/theme-alignment.html', import.meta.url));
const evaluation: EvaluationResult = { status: 'completed', findings: [], screenMap: [], interpretations: [], limitations: [] };

async function fixture(run: (url: URL, root: string) => Promise<void>, page = html) {
  const root = await mkdtemp(join(tmpdir(), 'theme-review-'));
  const server = createServer((_req, res) => res.writeHead(200, { 'Content-Type': 'text/html' }).end(page));
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

function spec(url: URL): RunSpec {
  return {
    targetUrl: url.href, mode: 'quick', themeReview: { mode: 'both' },
    viewport: { width: 750, height: 650, deviceScaleFactor: 1 },
    allowedActions: [], allowedOrigins: [url.origin], hasMutationPermission: false, isHeaded: false,
    shouldWaitForLogin: false, evaluator: 'rules-only',
    limits: { maxDurationMs: 30_000, maxObservations: 5, maxActions: 0, maxToolCalls: 12, maxFindings: 10 },
  };
}

test('one URL request finds dark-only contrast failures and measures the painted filter group', async () => fixture(async (url, root) => {
  const runSpec = spec(url);
  runSpec.alignmentContracts = [
    { groupSelector: '[data-contract="uniform"]', crossSize: 'equal', alignment: 'center' },
    { groupSelector: '[data-contract="mixed"]', crossSize: 'mixed', alignment: 'center' },
  ];
  let evaluationCalls = 0;
  const { result, runDir } = await inspect(runSpec, root, { evaluate: async input => {
    evaluationCalls++;
    assert.deepEqual(input.observations.map(observation => observation.theme?.requested), ['light', 'dark']);
    assert.equal(input.canRequestObservation, false);
    return evaluation;
  } });
  const [light, dark] = result.observations;
  assert.equal(evaluationCalls, 1);
  assert.deepEqual(result.observations.map(observation => observation.theme?.status), ['verified', 'verified']);
  assert(!light.deterministicChecks?.contrast?.violations);
  assert(dark.deterministicChecks?.contrast?.examples?.some(item => item.observedRatio === 1 && item.status === 'violation'));
  assert(dark.deterministicChecks?.contrast?.examples?.some(item =>
    item.status === 'violation' && item.observedRatio! > 1 && item.observedRatio! < item.expectedRatio!));
  assert.equal(result.rules.filter(rule => rule.ruleId === 'color-contrast' && rule.observationId === light.observationId).length, 0);
  for (const observation of [light, dark]) {
    const alignment = observation.deterministicChecks?.alignment;
    const uniform = alignment?.checks.find(check => check.contractIndex === 1);
    const mixed = alignment?.checks.find(check => check.contractIndex === 2);
    assert.deepEqual(uniform?.differences.map(difference => difference.kind), ['cross-size']);
    assert.equal(uniform?.status, 'violation');
    assert.equal(mixed?.status, 'passed');
    assert(uniform?.members.some(member => member.visualSource === 'before' && member.visualBox.height < member.hitBox.height));
    assert(mixed?.members.some(member => member.visualBox.height !== mixed.members[0].visualBox.height));
    assert(observation.evidenceRefs.some(ref => ref.evidenceId === observation.deterministicChecks?.evidenceId));
  }
  assert.notEqual(light.screenshotRefs[0], dark.screenshotRefs[0]);
  assert(result.coverage.observedChecks.some(check => check.checkId === 'group-alignment'));
  const stored = JSON.parse(await readFile(join(runDir, 'report.json'), 'utf8'));
  assert.equal(stored.observations[1].theme.status, 'verified');
  assert.equal(stored.observations[1].deterministicChecks.contrast.status, 'violation');
}));

test('unchanged page colors are not reported as a verified dark mode', async () => fixture(async (url, root) => {
  url.searchParams.set('fixed', '1');
  const { result } = await inspect(spec(url), root);
  assert.equal(result.status, 'partial');
  assert.deepEqual(result.observations.map(observation => observation.theme?.status), ['unverified', 'unverified']);
  assert(result.coverage.unmetChecks.some(check => check.checkId === 'theme-dark'));
  assert.equal(result.observations[1].deterministicChecks?.contrast?.violations, 0);
}));

test('a root color change behind an opaque viewport is not verified as a visible palette change', async () => fixture(async (url, root) => {
  url.searchParams.set('covered', '1');
  const { result } = await inspect(spec(url), root);
  assert.deepEqual(result.observations.map(observation => observation.theme?.status), ['unverified', 'unverified']);
  const captures = result.observations.map(observation => observation.evidenceRefs.find(ref => ref.kind === 'screenshot')?.sha256);
  assert.equal(captures[0], captures[1]);
}));

test('theme markers are checked against the rendered page and preserve a separately verified light mode', async () => fixture(async (url, root) => {
  const runSpec = spec(url);
  runSpec.themeReview = { mode: 'both', selectors: { light: '[data-applied-theme="light"]', dark: '[data-applied-theme="dark"]' } };
  const verified = await inspect(runSpec, root);
  assert.deepEqual(verified.result.observations.map(observation => observation.theme?.status), ['verified', 'verified']);
  url.searchParams.set('fixed', '1');
  const fixed = await inspect({ ...runSpec, targetUrl: url.href }, root);
  assert.deepEqual(fixed.result.observations.map(observation => observation.theme?.status), ['verified', 'unverified']);
  assert(fixed.result.coverage.unmetChecks.some(check => check.checkId === 'theme-dark'));
}));

test('default URL review omits the theme pair and paired review requires a compatible quick run', async () => fixture(async (url, root) => {
  const runSpec = spec(url);
  assert.throws(() => validateSpec({ ...runSpec, shouldVerify: true }), /Theme comparison requires a quick URL review/);
  assert.throws(() => validateSpec({ ...runSpec, themeReview: { mode: 'both', selectors: { light: 'html', dark: 'html' } } }),
    /Theme comparison requires a quick URL review/);
  const { result } = await inspect({ ...runSpec, themeReview: undefined }, root);
  assert.equal(result.observations.length, 1);
  assert.equal(result.observations[0].theme, undefined);
  assert(!result.coverage.requiredChecks.some(check => check.startsWith('theme-')));
}));

test('light state discovery preserves an observation slot for the dark theme under a tight cap', async () => fixture(async (url, root) => {
  const runSpec = spec(url);
  runSpec.limits.maxObservations = 2;
  runSpec.stateDiscovery = { maxWaitMs: 0 };
  const { result } = await inspect(runSpec, root, { evaluate: async () => evaluation });
  assert.equal(result.stateDiscovery?.status, 'partial');
  assert.deepEqual(result.observations.map(observation => observation.theme?.requested), ['light', 'dark']);
  assert.equal(result.observations[1].theme?.status, 'verified');
}));


const regionHtml = await readFile(new URL('./fixtures/theme-regions.html', import.meta.url));

test('an exposed nested panel verifies theme application even with unchanged text color and fixed overflow', async () => fixture(async (url, root) => {
  for (const variant of ['failing', 'normal']) {
    url.searchParams.set('variant', variant);
    const { result } = await inspect(spec(url), root);
    const [light, dark] = result.observations;
    assert.equal(light.theme?.scope, 'region');
    assert.equal(dark.theme?.scope, 'region');
    assert.equal(light.theme.status, 'verified');
    assert.equal(dark.theme.status, 'verified');
    assert.equal(light.theme.regions?.[0].role, 'region');
    assert.equal(light.theme.regions?.[0].background, '#ffffff');
    assert.deepEqual(light.theme.regions?.[0].bounds, dark.theme.regions?.[0].bounds);
    assert.match(dark.theme.regions?.[0].background ?? '', /^#0f172[ab]$/);
    assert.equal(dark.theme.regions?.some(region => region.role === 'main'), false);
  }
}, regionHtml));

test('a tiny accent cannot verify a theme or mask an otherwise explicitly covered panel', async () => fixture(async (url, root) => {
  for (const variant of ['accent', 'covered']) {
    url.searchParams.set('variant', variant);
    const { result } = await inspect(spec(url), root);
    const [light, dark] = result.observations;
    const capture = (observation: typeof light) => observation.evidenceRefs.find(ref => ref.kind === 'screenshot')?.sha256;
    assert.notEqual(capture(light), capture(dark));
    assert.equal(light.theme?.status, 'unverified');
    assert.equal(dark.theme?.status, 'unverified');
    assert.equal(dark.theme.regions, undefined);
  }
}, regionHtml));
