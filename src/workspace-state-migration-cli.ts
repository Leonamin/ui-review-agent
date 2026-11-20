import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import { open, realpath } from 'node:fs/promises';
import { resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { auditWorkspaceReportPaths } from './workspace-state-audit.js';
import { convertWorkspaceState } from './workspace-state-converter.js';

const MAX_STATE_BYTES = 64 * 1024 * 1024;

async function readReplicaState(runsRoot: string) {
 const path = resolve(runsRoot, '.review-service', 'state.json');
 if (await realpath(path) !== path) throw new Error('unsafe-replica-state-path');
 const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
 try {
  const stat = await handle.stat();
  if (!stat.isFile() || stat.size > MAX_STATE_BYTES) throw new Error('invalid-replica-state-file');
  const bytes = Buffer.alloc(stat.size + 1);
  let offset = 0;
  while (offset < bytes.length) {
   const {bytesRead} = await handle.read(bytes, offset, bytes.length - offset, offset);
   if (!bytesRead) break;
   offset += bytesRead;
  }
  if (offset !== stat.size) throw new Error('replica-state-changed-during-read');
  return bytes.subarray(0, offset);
 } finally {
  await handle.close();
 }
}

async function main() {
 const {values} = parseArgs({options: {
  runs: {type: 'string'},
  'original-runs-root': {type: 'string'},
  help: {type: 'boolean'},
 }});
 if (values.help) {
  process.stdout.write('Usage: pnpm run workspace:migration:dry-run --runs <isolated-copy> [--original-runs-root <source-runs-root>]\n');
  return;
 }
 if (!values.runs) throw new Error('isolated-runs-copy-required');
 const runsRoot = await realpath(values.runs);
 const stateBytes = await readReplicaState(runsRoot);
 const {candidate, summary} = convertWorkspaceState(JSON.parse(stateBytes.toString('utf8')));
 const workspaceData = candidate.workspaceData;
 const reportIds = new Set(candidate.reportOwners.map(owner => owner.reportId));
 const expectedPaths = new Map<string, string>();
 const memberships = new Map(workspaceData.memberships.map(item => [item.reportId, item.workspaceId]));
 const expectedReportHashes = new Map<string, string>();
 const expectedImageHashes = new Map<string, Map<string, string>>();

 for (const owner of candidate.reportOwners) {
  if (owner.reportPath) expectedPaths.set(owner.reportId, owner.reportPath);
 }
 for (const {reportId} of workspaceData.memberships) reportIds.add(reportId);
 function rememberSourceHash(source: {reportId: string; imageId: string; sha256: string}) {
  reportIds.add(source.reportId);
  const hashes = expectedImageHashes.get(source.reportId) ?? new Map<string, string>();
  const previous = hashes.get(source.imageId);
  if (previous !== undefined && previous !== source.sha256) throw new Error('conflicting-source-image-fingerprints');
  hashes.set(source.imageId, source.sha256);
  expectedImageHashes.set(source.reportId, hashes);
 }
 for (const request of workspaceData.requests) {
  if (request.parentReportId) reportIds.add(request.parentReportId);
  if (!request.source) continue;
  reportIds.add(request.source.reportId);
  const previous = expectedReportHashes.get(request.source.reportId);
  if (previous !== undefined && previous !== request.source.reportSha256) throw new Error('conflicting-source-report-fingerprints');
  expectedReportHashes.set(request.source.reportId, request.source.reportSha256);
  if (request.source.image) rememberSourceHash(request.source.image);
 }
 for (const review of candidate.focusedReviews) rememberSourceHash(review.source);
 const trashedReportIds = new Set([
  ...Object.values(workspaceData.trash ?? {}),
  ...Object.values(workspaceData.projectTrash ?? {}),
  ...Object.values(workspaceData.pendingCleanup ?? {}),
 ].flatMap(entry => entry.reportIds));
 const artifacts = await auditWorkspaceReportPaths(runsRoot, {
  reportIds, expectedPaths, memberships, trashedReportIds, expectedReportHashes, expectedImageHashes,
  originalRunsRoot: values['original-runs-root'],
 });
 const cutoverBlockers = [
  ...(summary.activeArchivedAttempts.length ? ['archived-active-attempt'] : []),
  ...(summary.stateDiagnostics.some(issue => issue.scope === 'active') ? ['unresolved-active-reference'] : []),
  ...(summary.activeRequests.some(attempt => attempt.status === 'running') ||
    summary.activeFocusedAttempts.some(attempt => attempt.status === 'running') ? ['running-attempt'] : []),
 ];
 const hasPassed = summary.hasPreservedRequestIds && summary.hasPreservedAttemptIds && artifacts.issueCount === 0 &&
  !summary.stateDiagnostics.some(issue => issue.scope === 'active');
 process.stdout.write(JSON.stringify({
  isDryRun: true,
  sourceVersion: 1,
  candidateVersion: candidate.version,
  stateSha256: createHash('sha256').update(stateBytes).digest('hex'),
  candidateSha256: createHash('sha256').update(JSON.stringify(candidate)).digest('hex'),
  ...summary,
  artifacts,
  cutoverBlockers,
  hasPassed,
 }, null, 2) + '\n');
 if (!hasPassed) process.exitCode = 1;
}

await main().catch(error => {
 // Parse and filesystem exceptions may include snapshot paths or input content.
 const allowedCodes = /^[a-z][a-z0-9-]+$/;
 const code = error instanceof Error && allowedCodes.test(error.message) ? error.message : 'workspace-migration-dry-run-error';
 process.stderr.write(JSON.stringify({isDryRun: true, hasPassed: false, code}) + '\n');
 process.exitCode = 1;
});
