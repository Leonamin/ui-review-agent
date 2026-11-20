import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {mkdir, mkdtemp, readFile, rm, symlink, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {dirname, join} from 'node:path';
import test from 'node:test';
import {auditWorkspaceReportPaths} from '../src/workspace-state-audit.js';
import {ReportRepository} from '../viewer/server/repository.js';

const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=', 'base64');

function hash(value: string | Buffer) {
 return createHash('sha256').update(value).digest('hex');
}

async function writeReport(root: string, path: string, document: object) {
 const reportPath = join(root, path);
 await mkdir(dirname(reportPath), {recursive: true});
 await writeFile(reportPath, JSON.stringify(document));
 return {id: hash(path), sha256: hash(await readFile(reportPath))};
}

test('workspace migration artifact audit agrees with viewer report and capture IDs, including history and trash', async t => {
 const root = await mkdtemp(join(tmpdir(), 'workspace-artifact-audit-'));
 t.after(() => rm(root, {recursive: true, force: true}));
 const evidence = {kind: 'screenshot', evidenceId: 'capture', relativePath: 'screen.png', sha256: hash(png)};
 const managed = 'review-attempts/attempt/active/report.json';
 const focused = 'review-attempts/focused/follow-up/report.json';
 const standalone = 'historical/standalone/report.json';
 const hidden = 'historical/hidden/report.json';
 await writeReport(root, managed, {runId: 'active', status: 'completed', observations: [{evidenceRefs: [evidence]}]});
 await writeFile(join(root, dirname(managed), 'screen.png'), png);
 await writeReport(root, focused, {runId: 'follow-up', status: 'completed', focusedReview: {source: {reportId: hash(managed)}}});
 await writeReport(root, standalone, {runId: 'standalone', status: 'completed'});
 await writeReport(root, hidden, {runId: 'hidden', status: 'completed'});

 const memberships = new Map([[hash(managed), 'workspace-a'], [hash(hidden), 'workspace-b']]);
 const trashedReportIds = new Set([hash(hidden)]);
 const auditOptions = {
  reportIds: [hash(managed), hash(focused)], memberships, trashedReportIds,
  expectedPaths: new Map([[hash(managed), managed], [hash(focused), focused]]),
  expectedImageHashes: new Map([[hash(managed), new Map([[hash(evidence.evidenceId), hash(png)]])]]),
 };
 const audit = await auditWorkspaceReportPaths(root, auditOptions);
 assert.equal(audit.reportsOnDisk, 4);
 assert.equal(audit.visibleReports, 3);
 assert.equal(audit.hiddenReports, 1);
 assert.equal(audit.linkedReports, 1);
 assert.equal(audit.standaloneReports, 2);
 assert.equal(audit.focusedReports, 1);
 assert.equal(audit.managedReports, 2);
 assert.equal(audit.imageCount, 1);
 assert.equal(audit.issueCount, 0);
 assert.deepEqual(await auditWorkspaceReportPaths(root, auditOptions), audit);

 const viewer = new ReportRepository(root);
 viewer.setTrashedReportIdsLookup(() => trashedReportIds);
 assert.deepEqual(new Set((await viewer.list()).reports.map(report => report.id)), new Set([hash(managed), hash(focused), hash(standalone)]));
 assert.deepEqual(await viewer.image(hash(managed), hash(evidence.evidenceId)), png);
 await assert.rejects(viewer.detail(hash(hidden)), {status: 404});
 const afterMove = await auditWorkspaceReportPaths(root, {...auditOptions, memberships: new Map([[hash(managed), 'workspace-c'], [hash(hidden), 'workspace-b']])});
 assert.notEqual(afterMove.reportInventorySha256, audit.reportInventorySha256);
 assert.equal(afterMove.imageInventorySha256, audit.imageInventorySha256);
});

test('artifact audit remaps legacy absolute capture fallback within replica and reports safe discrepancies', async t => {
 const temp = await mkdtemp(join(tmpdir(), 'workspace-artifact-boundary-'));
 t.after(() => rm(temp, {recursive: true, force: true}));
 const root = join(temp, 'replica');
 const originalRunsRoot = join(temp, 'original');
 const privatePath = join(temp, 'outside-private-screenshot.png');
 const path = 'historical/runs/report.json';
 await mkdir(join(root, 'saved'), {recursive: true});
 await writeFile(join(root, 'saved', 'screen.png'), png);
 await writeFile(privatePath, png);
 await symlink(privatePath, join(root, 'saved', 'escaping-link.png'));
 const {id} = await writeReport(root, path, {runId: 'runs', status: 'completed', evidence: [
  {kind: 'screenshot', evidenceId: 'safe', relativePath: 'missing.png', absolutePath: join(originalRunsRoot, 'saved', 'screen.png')},
  {kind: 'screenshot', evidenceId: 'outside', relativePath: 'missing.png', absolutePath: privatePath},
  {kind: 'screenshot', evidenceId: 'escaped', relativePath: 'missing.png', absolutePath: join(originalRunsRoot, 'saved', 'escaping-link.png')},
 ]});
 const oldId = hash('historical/old/report.json');
 const audit = await auditWorkspaceReportPaths(root, {
  reportIds: [id, oldId, 'invalid-private-text'], originalRunsRoot,
  expectedPaths: new Map([[id, 'wrong/location/report.json']]),
  expectedReportHashes: new Map([[id, 'a'.repeat(64)]]),
  expectedImageHashes: new Map([[id, new Map([[hash('safe'), 'b'.repeat(64)], [hash('unavailable'), hash(png)]])]]),
 });
 assert.equal(audit.absoluteFallbackImages, 1);
 assert.equal(audit.imageCount, 1);
 assert.equal(audit.issueCount, 8);
 assert.deepEqual(audit.issues.filter(({code}) => code === 'image_unreadable').map(({imageId}) => imageId), [hash('outside'), hash('escaped')]);
 assert.equal(audit.issues.some(({code, reportId}) => code === 'report_missing' && reportId === oldId), true);
 assert.doesNotMatch(JSON.stringify(audit), /invalid-private-text|outside-private-screenshot|historical\/runs/);
});
